/**
 * Finds the session transcripts touched since the last consolidation and turns
 * them into bounded, secret-redacted text for the dream to read.
 *
 * pi stores transcripts at `<agentDir>/sessions/<cwd-slug>/<flat-iso>_<uuid>.jsonl`
 * using the same slug `paths.ts` computes. Subagent and `/btw` runs write real
 * session files into the same directory, each marked near the top with a
 * `session_info` entry named `subagent: …` / `btw: …`. Only `kind: "main"`
 * sessions count toward the trigger; subagent runs ride along in serialization
 * so their discovered facts are not lost. btw sessions are excluded from the
 * pipeline entirely — a side-question answer is user-facing output, not
 * background work to consolidate, and its file duplicates the main
 * conversation.
 *
 * The JSONL→entries bridge is `parseSessionEntries` + `migrateSessionEntries`
 * (the root-exported equivalent of the SDK's `loadEntriesFromFile`). Everything
 * a transcript yields passes through `redactSecrets` before it leaves this
 * module — an unredacted credential would become a permanent memory.
 */

import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  getAgentDir,
  migrateSessionEntries,
  parseSessionEntries,
  type FileEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  redactSecrets,
  serializeRunTranscript,
} from "../../../shared/transcript.ts";
import { projectSlug } from "../paths.ts";

export interface SessionRef {
  readonly id: string;
  readonly path: string;
  readonly mtime: number;
  readonly startedAt?: string;
  readonly kind: "main" | "subagent";
}

const HEAD_BYTES = 8192;

export function sessionsDir(cwd: string, agentDir = getAgentDir()): string {
  return join(agentDir, "sessions", projectSlug(cwd));
}

/** `<flat-iso>_<uuid>.jsonl` — the uuid is the session id (matches the header id). */
function idFromFilename(name: string): string | undefined {
  const match = name.match(/_([0-9a-f-]{36})\.jsonl$/i);
  return match?.[1];
}

interface HeadInfo {
  headerId?: string;
  startedAt?: string;
  kind: "main" | "subagent" | "btw";
}

/** Classify from the first ~8KB: header id/timestamp and any subagent/btw marker. */
async function readHead(path: string): Promise<HeadInfo> {
  let text = "";
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return { kind: "main" };
  }

  const info: HeadInfo = { kind: "main" };
  const lines = text.split("\n");
  // Drop a trailing partial line from the byte-bounded read.
  if (!text.endsWith("\n")) lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "session") {
      if (typeof entry.id === "string") info.headerId = entry.id;
      if (typeof entry.timestamp === "string") info.startedAt = entry.timestamp;
    } else if (
      entry.type === "session_info" &&
      typeof entry.name === "string"
    ) {
      if (/^\s*btw\s*:/i.test(entry.name)) info.kind = "btw";
      else if (/^\s*subagent\s*:/i.test(entry.name)) info.kind = "subagent";
    }
  }
  return info;
}

export async function sessionsTouchedSince(
  cwd: string,
  since: number,
  excludeIds: readonly string[],
  agentDir = getAgentDir(),
): Promise<SessionRef[]> {
  const dir = sessionsDir(cwd, agentDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const exclude = new Set(excludeIds);
  const refs: SessionRef[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);

    let mtime: number;
    try {
      mtime = (await stat(path)).mtimeMs;
    } catch {
      continue;
    }
    if (mtime <= since) continue;

    const head = await readHead(path);
    // btw sessions are not dream material: their files duplicate the main
    // conversation and their answers are already user-facing.
    if (head.kind === "btw") continue;
    const id = idFromFilename(name) ?? head.headerId;
    if (!id || exclude.has(id)) continue;

    refs.push({
      id,
      path,
      mtime,
      ...(head.startedAt ? { startedAt: head.startedAt } : {}),
      kind: head.kind,
    });
  }

  return refs.sort((a, b) => b.mtime - a.mtime);
}

async function loadEntries(path: string): Promise<SessionEntry[]> {
  let parsed: FileEntry[];
  try {
    parsed = parseSessionEntries(await readFile(path, "utf8"));
  } catch {
    return [];
  }
  migrateSessionEntries(parsed);
  // Drop the SessionHeader; keep the SessionEntry stream.
  return parsed.filter(
    (entry): entry is SessionEntry => entry.type !== "session",
  );
}

function label(ref: SessionRef): string {
  const started = ref.startedAt ? ` started ${ref.startedAt}` : "";
  const tag = ref.kind === "subagent" ? "SUBAGENT SESSION" : "SESSION";
  return `## ${tag} ${ref.id}${started}`;
}

/**
 * Two-tier budgeting: main sessions first (newest first), then subagent
 * sessions fill whatever budget remains (newest first, each labeled). Mains
 * carry the user's corrections and decisions — the highest-value signal — but
 * subagent-heavy workflows put the discovered facts in child transcripts, so
 * leftover budget lets them in. Blocks are added newest-first and the loop
 * stops once the budget is full, so the oldest are dropped first within a tier.
 * At least the newest session always appears, even under a tiny budget.
 */
export async function serializeSessions(
  refs: readonly SessionRef[],
  budgetBytes: number,
): Promise<string> {
  const byMtimeDesc = (a: SessionRef, b: SessionRef) => b.mtime - a.mtime;
  const mains = refs.filter((r) => r.kind === "main").sort(byMtimeDesc);
  const subs = refs.filter((r) => r.kind === "subagent").sort(byMtimeDesc);

  const parts: string[] = [];
  let used = 0;
  for (const ref of [...mains, ...subs]) {
    const entries = await loadEntries(ref.path);
    const body = redactSecrets(serializeRunTranscript(entries));
    const block = `${label(ref)}\n\n${body}`;
    const blockBytes = Buffer.byteLength(block, "utf8");
    if (parts.length > 0 && used + blockBytes > budgetBytes) break;
    parts.push(block);
    used += blockBytes;
  }

  return parts.join("\n\n---\n\n");
}
