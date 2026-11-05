import * as fs from "node:fs";
import * as path from "node:path";
import { losslessJsonStringify } from "./serialization.ts";

export const JOURNAL_FILENAME = "journal.jsonl";
export const JOURNAL_VERSION = 2;
const MAX_JOURNAL_ENTRY_BYTES = 512 * 1024;

interface JournalBase {
  version: typeof JOURNAL_VERSION;
  index: number;
  key: string;
  label: string;
  phase?: string;
  attempt: number;
}

export interface StartedJournalEntry extends JournalBase {
  type: "started";
}

export interface FailedJournalEntry extends JournalBase {
  type: "failed";
  error: string;
  failureKind?: "stall" | "aborted" | "error";
  skipped?: true;
}

export interface ResultJournalEntry extends JournalBase {
  type: "result";
  result: unknown;
}

export type JournalEntry =
  StartedJournalEntry | FailedJournalEntry | ResultJournalEntry;

export interface LegacyJournalEntry {
  index: number;
  key: string;
  label?: string;
  phase?: string;
  attempt?: number;
  error?: string;
  skipped?: true;
  result: unknown;
}

export type JournalRecord = JournalEntry | LegacyJournalEntry;

interface CachedResult {
  key: string;
  result: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAttempt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validateEntry(value: unknown): value is JournalEntry {
  if (!isRecord(value) || value.version !== JOURNAL_VERSION) return false;
  if (
    !Number.isSafeInteger(value.index) ||
    (value.index as number) < 0 ||
    typeof value.key !== "string" ||
    value.key.length === 0 ||
    typeof value.label !== "string" ||
    !isAttempt(value.attempt) ||
    (value.phase !== undefined && typeof value.phase !== "string")
  ) {
    return false;
  }
  if (value.type === "started") {
    return Object.keys(value).every((key) =>
      ["version", "type", "index", "key", "label", "phase", "attempt"].includes(
        key,
      ),
    );
  }
  if (value.type === "failed") {
    return (
      typeof value.error === "string" &&
      (value.failureKind === undefined ||
        value.failureKind === "stall" ||
        value.failureKind === "aborted" ||
        value.failureKind === "error") &&
      (value.skipped === undefined || value.skipped === true) &&
      Object.keys(value).every((key) =>
        [
          "version",
          "type",
          "index",
          "key",
          "label",
          "phase",
          "attempt",
          "error",
          "failureKind",
          "skipped",
        ].includes(key),
      )
    );
  }
  if (value.type === "result") {
    return (
      Object.hasOwn(value, "result") &&
      Object.keys(value).every((key) =>
        [
          "version",
          "type",
          "index",
          "key",
          "label",
          "phase",
          "attempt",
          "result",
        ].includes(key),
      )
    );
  }
  return false;
}

function validateLegacyEntry(value: unknown): value is LegacyJournalEntry {
  return (
    isRecord(value) &&
    !Object.hasOwn(value, "version") &&
    !Object.hasOwn(value, "type") &&
    Number.isSafeInteger(value.index) &&
    (value.index as number) >= 0 &&
    typeof value.key === "string" &&
    value.key.length > 0 &&
    (value.label === undefined || typeof value.label === "string") &&
    (value.phase === undefined || typeof value.phase === "string") &&
    (value.attempt === undefined || isAttempt(value.attempt)) &&
    (value.error === undefined || typeof value.error === "string") &&
    (value.skipped === undefined || value.skipped === true) &&
    Object.hasOwn(value, "result")
  );
}

export function appendJournalEntry(
  runDir: string,
  entry: JournalEntry,
): boolean {
  try {
    if (!validateEntry(entry)) return false;
    const line = losslessJsonStringify(entry, MAX_JOURNAL_ENTRY_BYTES);
    fs.appendFileSync(path.join(runDir, JOURNAL_FILENAME), `${line}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

function parseJournalLine(line: string, lineNumber: number): JournalRecord {
  if (Buffer.byteLength(line, "utf8") > MAX_JOURNAL_ENTRY_BYTES) {
    throw new Error(
      `Workflow journal is unreadable: line ${lineNumber} exceeds the size limit`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(
      `Workflow journal is torn or invalid at line ${lineNumber}`,
    );
  }
  if (validateEntry(value) || validateLegacyEntry(value)) return value;
  throw new Error(
    `Workflow journal is unreadable: invalid record at line ${lineNumber}`,
  );
}

export function readJournal(runDir: string): JournalRecord[] {
  const file = path.join(runDir, JOURNAL_FILENAME);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      throw new Error(`Workflow journal is missing at ${file}`);
    throw new Error(`Workflow journal is unreadable at ${file}`);
  }
  if (raw.length === 0) return [];
  if (!raw.endsWith("\n"))
    throw new Error("Workflow journal has a torn final line");
  return raw
    .slice(0, -1)
    .split("\n")
    .map((line, index) => parseJournalLine(line, index + 1));
}

function hasLossMarker(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") {
    return /\[(?:truncated|undefined|number:|symbol:|function:|circular:|unreadable)/i.test(
      value,
    );
  }
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value))
    return value.some((item) => hasLossMarker(item, seen));
  if (
    Object.hasOwn(value, "truncated") &&
    (value as Record<string, unknown>).truncated === true
  )
    return true;
  return Object.values(value).some((item) => hasLossMarker(item, seen));
}

function isCompleteResult(value: unknown): boolean {
  if (value === null || hasLossMarker(value)) return false;
  try {
    losslessJsonStringify(value, MAX_JOURNAL_ENTRY_BYTES);
    return true;
  } catch {
    return false;
  }
}

function isLegacy(record: JournalRecord): record is LegacyJournalEntry {
  return !Object.hasOwn(record, "version") && !Object.hasOwn(record, "type");
}

/**
 * Replay state built from a journal: successful results, attempted keys, and
 * failed keys, each keyed by the lossless call key that produced them. `take`
 * serves only keys the journal records, and breaks the run once a call is new
 * or failed so nothing derived from that call is reused.
 */
export function createResumePlan(records: JournalRecord[]) {
  const results = new Map<string, CachedResult>();
  const started = new Set<string>();
  const failed = new Set<string>();

  for (const record of records) {
    if (isLegacy(record)) {
      const key = record.key;
      const reusable =
        !results.has(key) &&
        !failed.has(key) &&
        record.error === undefined &&
        record.skipped !== true &&
        isCompleteResult(record.result);
      started.add(key);
      if (reusable) {
        results.set(key, { key, result: record.result });
      } else {
        results.delete(key);
        failed.add(key);
      }
      continue;
    }

    if (record.type === "started") {
      started.add(record.key);
      continue;
    }
    if (record.type === "failed") {
      started.add(record.key);
      failed.add(record.key);
      continue;
    }

    started.add(record.key);
    if (isCompleteResult(record.result)) {
      results.set(record.key, { key: record.key, result: record.result });
    } else {
      // A null or lossy result is a failure, not a cached value.
      results.delete(record.key);
      failed.add(record.key);
    }
  }

  let broken = false;
  let served = 0;
  let nextIndex = 0;
  return {
    /**
     * Cached result for this call key, or undefined to run it live. The key of
     * an older journal entry is accepted only when it verifies against the
     * live call.
     */
    take(
      index: number,
      key: string,
      legacyKey?: string,
    ): { hit: true; result: unknown } | undefined {
      if (index !== nextIndex) {
        broken = true;
        return undefined;
      }
      nextIndex++;
      if (broken) return undefined;
      const entry =
        results.get(key) ??
        (legacyKey === undefined ? undefined : results.get(legacyKey));
      if (entry !== undefined) {
        served++;
        return { hit: true, result: entry.result };
      }
      const attempted =
        started.has(key) || (legacyKey !== undefined && started.has(legacyKey));
      const rejected =
        failed.has(key) || (legacyKey !== undefined && failed.has(legacyKey));
      if (!attempted || rejected) broken = true;
      return undefined;
    },
    get servedCount() {
      return served;
    },
    get available() {
      return results.size;
    },
  };
}

export function loadResumePlan(runDir: string, isLive: boolean) {
  if (isLive)
    throw new Error("Workflow run is active; its journal cannot be resumed");
  return createResumePlan(readJournal(runDir));
}

export { callKey } from "./serialization.ts";
