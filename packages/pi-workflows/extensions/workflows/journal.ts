/**
 * Agent-call journal backing workflow resume.
 *
 * Every `agent()` call appends one line recording its call index, a hash of the
 * (prompt, options) that produced it, and the settled result. A resumed run
 * replays the longest unchanged prefix: call N is served from the journal only
 * if every call before it also matched, so the first edited or new call — and
 * everything after it — runs live.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { toSerializable } from "./serialization.ts";

/** One line per entry: safeStringify pretty-prints, which JSONL cannot use. */
function compactJson(value: unknown, maxBytes: number): string {
  return JSON.stringify(toSerializable(value, { maxBytes })) ?? "null";
}

export const JOURNAL_FILENAME = "journal.jsonl";

export interface JournalEntry {
  index: number;
  /** Hash of the call's prompt and options; a change here breaks the prefix. */
  key: string;
  label: string;
  phase?: string;
  result: unknown;
}

/** Stable across runs: option key order must not affect the hash. */
export function callKey(prompt: string, options: unknown): string {
  const canonical = compactJson(
    { prompt, options: sortKeys(options) },
    256 * 1024,
  );
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort())
    sorted[key] = sortKeys(source[key]);
  return sorted;
}

export function appendJournalEntry(runDir: string, entry: JournalEntry): void {
  try {
    fs.appendFileSync(
      path.join(runDir, JOURNAL_FILENAME),
      `${compactJson(entry, 512 * 1024)}\n`,
      "utf8",
    );
  } catch {
    // A journal write failure costs resumability, not correctness.
  }
}

export function readJournal(runDir: string): JournalEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(runDir, JOURNAL_FILENAME), "utf8");
  } catch {
    return [];
  }
  const entries: JournalEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as JournalEntry).index === "number" &&
        typeof (parsed as JournalEntry).key === "string"
      ) {
        entries.push(parsed as JournalEntry);
      }
    } catch {
      // A torn final line just shortens the replayable prefix.
    }
  }
  entries.sort((a, b) => a.index - b.index);
  return entries;
}

/**
 * Serves cached results while the replay stays on the recorded prefix. The
 * first mismatch — different key, missing entry, or out-of-order index —
 * permanently ends replay for the rest of the run.
 */
export function createResumePlan(entries: JournalEntry[]) {
  let broken = entries.length === 0;
  let served = 0;
  return {
    /** Cached result for this call, or undefined to run it live. */
    take(
      index: number,
      key: string,
    ): { hit: true; result: unknown } | undefined {
      if (broken) return undefined;
      const entry = entries[index];
      if (!entry || entry.index !== index || entry.key !== key) {
        broken = true;
        return undefined;
      }
      served++;
      return { hit: true, result: entry.result };
    },
    get servedCount() {
      return served;
    },
    get available() {
      return entries.length;
    },
  };
}
