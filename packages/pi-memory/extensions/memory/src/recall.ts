/**
 * The per-turn recall orchestration: Claude Code's `startRelevantMemoryPrefetch`
 * (`Vxs`) → `Z2y` (list → select → read → attach) from the bundled CLI
 * (2.1.220, ~byte 237.7M), minus the team-store tier.
 *
 * List candidates → drop ones already surfaced this session → have the selector
 * pick up to five → read their bodies → format for injection, honoring a
 * per-session byte budget. Any selector failure returns undefined (fail open):
 * a turn never breaks or stalls because recall could not run.
 */

import { readFile } from "node:fs/promises";
import { listMemoryCandidates, type MemoryCandidate } from "./candidates.ts";
import { formatRecalledMemories, type RecalledMemory } from "./injection.ts";
import { selectMemories, type SelectorComplete } from "./selector.ts";

/** Claude Code's per-session injection budget (`MAX_SESSION_BYTES`). */
export const MAX_SESSION_BYTES = 60_000;

/** CJK symbols/punctuation, kana, Han (incl. Ext-A), compatibility, fullwidth. */
const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;

/**
 * Claude Code skips recall for a single bare token — a lone word carries too
 * little intent to match on. CJK text has no spaces, so it is exempt.
 */
export function hasSelectableQuery(query: string) {
  const trimmed = query.trim();
  if (!trimmed) return false;
  return /\s/.test(trimmed) || CJK.test(trimmed);
}

export interface RecallResult {
  /** The message body to inject, one `<system-reminder>` block per memory. */
  readonly content: string;
  /** Absolute paths surfaced this turn, to add to the session dedupe set. */
  readonly injectedPaths: string[];
  /** Bytes added this turn, to add to the running session budget. */
  readonly bytes: number;
}

export interface RunRecallOptions {
  readonly query: string;
  readonly dir: string;
  readonly complete: SelectorComplete;
  /** Absolute paths already surfaced this session. */
  readonly alreadyInjected: ReadonlySet<string>;
  /** Bytes already surfaced this session. */
  readonly sessionBytes: number;
  /** Reference time for staleness; injected for deterministic tests. */
  readonly now: number;
  readonly maxSessionBytes?: number;
  readonly cite?: boolean;
  readonly signal?: AbortSignal;
  /** Overridable I/O, so the orchestration can be tested without a filesystem. */
  readonly listCandidates?: (dir: string) => Promise<MemoryCandidate[]>;
  readonly readBody?: (path: string) => Promise<string>;
}

export async function runRecall(
  options: RunRecallOptions,
): Promise<RecallResult | undefined> {
  const maxBytes = options.maxSessionBytes ?? MAX_SESSION_BYTES;
  if (!hasSelectableQuery(options.query)) return undefined;
  if (options.sessionBytes >= maxBytes) return undefined;

  const list = options.listCandidates ?? listMemoryCandidates;
  const readBody =
    options.readBody ?? ((path: string) => readFile(path, "utf8"));

  const candidates = (await list(options.dir).catch(() => [])).filter(
    (candidate) => !options.alreadyInjected.has(candidate.path),
  );
  if (candidates.length === 0) return undefined;

  let selected: MemoryCandidate[];
  try {
    selected = await selectMemories(
      candidates,
      options.query,
      options.complete,
      options.signal,
    );
  } catch {
    return undefined;
  }

  const memories: RecalledMemory[] = [];
  const injectedPaths: string[] = [];
  let addedBytes = 0;
  for (const candidate of selected) {
    if (options.alreadyInjected.has(candidate.path)) continue;
    const body = (
      await readBody(candidate.path).catch(() => undefined)
    )?.trim();
    if (!body) continue;
    const size = Buffer.byteLength(body, "utf8");
    // Always surface at least one; stop before a memory that blows the budget.
    if (
      options.sessionBytes + addedBytes + size > maxBytes &&
      memories.length > 0
    ) {
      break;
    }
    memories.push({ path: candidate.path, mtimeMs: candidate.mtimeMs, body });
    injectedPaths.push(candidate.path);
    addedBytes += size;
  }
  if (memories.length === 0) return undefined;

  const content = formatRecalledMemories(memories, {
    now: options.now,
    cite: options.cite,
  });
  return { content, injectedPaths, bytes: addedBytes };
}
