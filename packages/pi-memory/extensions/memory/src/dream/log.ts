/**
 * The dream run log — a permanent, append-only record of every dream attempt,
 * persisted as JSONL at `dreams.jsonl` in the memory directory so it survives
 * restarts and lives beside the memory files the dreams maintain.
 *
 * Fired dreams are logged in detail: status, turns, cost, tokens, files
 * touched, and the dream's own summary. Gated attempts are logged as
 * `skipped` with the gate reason, so the log reads as the complete history of
 * what ran and why. The dream's confined tools cannot delete it (`rm` only
 * accepts `.md` operands) and nothing in the dream prompt tells it to edit it.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DreamOutcome } from "./index.ts";

export const DREAM_LOG_FILENAME = "dreams.jsonl";

export type DreamTrigger = "idle" | "manual";
export type DreamLogStatus = "completed" | "aborted" | "failed" | "skipped";

export interface DreamLogEntry {
  ts: string;
  trigger: DreamTrigger;
  status: DreamLogStatus;
  /** Present only on skipped (gated) attempts — the gate reason. */
  reason?: string;
  /** The configured dream model, for fired dreams. */
  model?: string;
  durationMs?: number;
  turns?: number;
  costUsd?: number;
  tokens?: number;
  filesTouched?: string[];
  /** Per-file outcomes (new entries). Older entries only have filesTouched. */
  filesCreated?: string[];
  filesEdited?: string[];
  filesRemoved?: string[];
  /** The dream's own summary of what it did (or the failure message). */
  summary?: string;
}

export function dreamLogPath(memoryDir: string): string {
  return join(memoryDir, DREAM_LOG_FILENAME);
}

export function buildDreamLogEntry(
  outcome: DreamOutcome,
  meta: { trigger: DreamTrigger; model?: string; durationMs?: number },
): DreamLogEntry {
  const entry: DreamLogEntry = {
    ts: new Date().toISOString(),
    trigger: meta.trigger,
    status: "skipped",
  };
  if (!outcome.fired) {
    if (outcome.reason) entry.reason = outcome.reason;
    return entry;
  }
  const result = outcome.result;
  if (!result) {
    entry.status = "failed";
    return entry;
  }
  entry.status = result.status;
  if (meta.model) entry.model = meta.model;
  if (meta.durationMs !== undefined) entry.durationMs = meta.durationMs;
  if (result.turns > 0) entry.turns = result.turns;
  if (result.costUsd !== undefined) entry.costUsd = result.costUsd;
  if (result.usage?.tokens !== undefined) entry.tokens = result.usage.tokens;
  if (result.filesTouched.length > 0) entry.filesTouched = result.filesTouched;
  if (result.fileOps) {
    if (result.fileOps.created.length > 0)
      entry.filesCreated = result.fileOps.created;
    if (result.fileOps.edited.length > 0)
      entry.filesEdited = result.fileOps.edited;
    if (result.fileOps.removed.length > 0)
      entry.filesRemoved = result.fileOps.removed;
  }
  if (result.summary) entry.summary = result.summary;
  return entry;
}

export async function appendDreamLog(
  dir: string,
  entry: DreamLogEntry,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await appendFile(dreamLogPath(dir), `${JSON.stringify(entry)}\n`, "utf8");
}

const STATUSES = new Set<DreamLogStatus>([
  "completed",
  "aborted",
  "failed",
  "skipped",
]);

/** Tolerant read: corrupt or hand-edited lines are skipped, never fatal. */
export async function readDreamLog(dir: string): Promise<DreamLogEntry[]> {
  const raw = await readFile(dreamLogPath(dir), "utf8").catch(() => "");
  const entries: DreamLogEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<DreamLogEntry> | null;
      if (
        parsed &&
        typeof parsed.ts === "string" &&
        parsed.status !== undefined &&
        STATUSES.has(parsed.status)
      ) {
        entries.push(parsed as DreamLogEntry);
      }
    } catch {
      // Not JSON — skip the line.
    }
  }
  return entries;
}
