import { normalizeTranscript } from "./model.ts";
import type { AgentRecord, TranscriptEntry, WorkflowDetails } from "./model.ts";
import {
  losslessJsonStringify,
  safeStringify,
  truncateUtf8,
  writeFileAtomic,
} from "./serialization.ts";
import * as fs from "node:fs";
import * as path from "node:path";

const ARTIFACT_TRANSCRIPT_MAX_BYTES = 32 * 1024;
const ARTIFACT_TRANSCRIPT_ENTRY_MAX_BYTES = 8 * 1024;
const ARTIFACT_RESULT_MAX_BYTES = 1024 * 1024;
/** Smallest useful shard; below this the agent is recorded as omitted instead. */
const ARTIFACT_TRANSCRIPT_SHARD_MIN_BYTES = 256;
const TRANSCRIPT_SHARD_DIR = "transcripts";
const RESULT_ARTIFACT_NAME = "result.json";
const TRANSCRIPT_ARTIFACT_NAME = "transcripts.json";
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;

export const WORKFLOW_TRANSCRIPT_MANIFEST_VERSION = 2;
/** Aggregate cap across every shard, so the manifest stays bounded. */
export const ARTIFACT_TRANSCRIPT_TOTAL_MAX_BYTES = 256 * 1024;
export const WORKFLOW_CHECKPOINT_INTERVAL_MS = 500;
export const WORKFLOW_HEARTBEAT_FILENAME = "heartbeat";
export const WORKFLOW_HEARTBEAT_INTERVAL_MS = 5000;
export const WORKFLOW_HEARTBEAT_STALE_MS = 30000;
const ENTRY_TRUNCATION_MARKER = "\n[entry truncated]";
const TRANSCRIPT_TRUNCATION_MARKER =
  "[artifact transcript truncated: older entries omitted]";

function textBytes(text: string) {
  return Buffer.byteLength(text, "utf8");
}

function boundEntry(entry: TranscriptEntry, maxBytes: number) {
  if (textBytes(entry.text) <= maxBytes) return { ...entry };
  const markerBytes = textBytes(ENTRY_TRUNCATION_MARKER);
  const text =
    maxBytes > markerBytes
      ? `${truncateUtf8(entry.text, maxBytes - markerBytes)}${ENTRY_TRUNCATION_MARKER}`
      : truncateUtf8(ENTRY_TRUNCATION_MARKER, maxBytes);
  return { ...entry, text };
}

/** Keep the initial prompt plus the newest useful context within the artifact cap. */
export function boundedArtifactTranscript(
  transcript: TranscriptEntry[],
  options: { maxBytes?: number; entryMaxBytes?: number } = {},
) {
  if (transcript.length === 0) return [];
  const maxBytes = Math.max(
    256,
    options.maxBytes ?? ARTIFACT_TRANSCRIPT_MAX_BYTES,
  );
  const entryMaxBytes = Math.max(
    64,
    Math.min(
      maxBytes,
      options.entryMaxBytes ?? ARTIFACT_TRANSCRIPT_ENTRY_MAX_BYTES,
    ),
  );
  const bounded = transcript.map((entry) => boundEntry(entry, entryMaxBytes));
  if (
    bounded.reduce((total, entry) => total + textBytes(entry.text), 0) <=
    maxBytes
  ) {
    return bounded;
  }

  const initialIndex = transcript.findIndex((entry) => entry.role === "user");
  const initial = boundEntry(
    transcript[initialIndex >= 0 ? initialIndex : 0],
    Math.min(entryMaxBytes, maxBytes - textBytes(TRANSCRIPT_TRUNCATION_MARKER)),
  );
  const marker: TranscriptEntry = {
    role: "toolResult",
    name: "transcript",
    text: TRANSCRIPT_TRUNCATION_MARKER,
  };
  let remaining = maxBytes - textBytes(initial.text) - textBytes(marker.text);
  const tail: TranscriptEntry[] = [];

  for (
    let index = transcript.length - 1;
    index >= 0 && remaining > 0;
    index--
  ) {
    if (index === initialIndex || (initialIndex < 0 && index === 0)) continue;
    const entry = boundEntry(
      transcript[index],
      Math.min(entryMaxBytes, remaining),
    );
    tail.push(entry);
    remaining -= textBytes(entry.text);
  }

  tail.reverse();
  return [initial, marker, ...tail];
}

function writeRunFile(runDir: string, name: string, content: string) {
  writeFileAtomic(path.join(runDir, name), content);
}

export interface WorkflowHeartbeat {
  stop(): void;
}

/**
 * Beat a liveness timestamp to `<runDir>/heartbeat` while the run executes.
 * A missing or stale beat is what marks an on-disk `running` run as orphaned,
 * so a crash leaves a stale file while a graceful end stops beating.
 */
export function createWorkflowHeartbeat(
  runDir: string,
  options: {
    intervalMs?: number;
    now?: () => number;
    write?: (filePath: string, content: string) => void;
  } = {},
): WorkflowHeartbeat {
  const intervalMs = Math.max(
    0,
    options.intervalMs ?? WORKFLOW_HEARTBEAT_INTERVAL_MS,
  );
  const now = options.now ?? Date.now;
  const write = options.write ?? writeFileAtomic;
  const filePath = path.join(runDir, WORKFLOW_HEARTBEAT_FILENAME);
  const beat = () => {
    try {
      write(filePath, String(now()));
    } catch {
      // A missed beat is recoverable; failing the run over it is not.
    }
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/** Age of the last beat in ms, or undefined when there is no readable beat. */
export function readWorkflowHeartbeatAgeMs(
  runDir: string,
  now: () => number = Date.now,
): number | undefined {
  try {
    const { mtimeMs } = fs.statSync(
      path.join(runDir, WORKFLOW_HEARTBEAT_FILENAME),
    );
    return now() - mtimeMs;
  } catch {
    return undefined;
  }
}

/** Disk-side liveness: a fresh beat means an owner is still executing. */
export function isRunLiveFromDisk(
  runDir: string,
  now: () => number = Date.now,
): boolean {
  const age = readWorkflowHeartbeatAgeMs(runDir, now);
  return age !== undefined && age < WORKFLOW_HEARTBEAT_STALE_MS;
}

export interface WorkflowArtifactOptions {
  /** Aggregate byte cap across all transcript shards. */
  transcriptTotalMaxBytes?: number;
  /** Per-entry byte cap inside a shard. */
  transcriptEntryMaxBytes?: number;
  /** Byte cap for the stored workflow result. */
  resultMaxBytes?: number;
}

/** One agent's transcript slot in the manifest; omitted slots name a reason. */
export interface TranscriptManifestRecord {
  index: number;
  shard?: string;
  bytes?: number;
  omitted?: true;
  reason?: string;
}

export interface TranscriptManifest {
  version: number;
  limitBytes: number;
  totalBytes: number;
  agents: TranscriptManifestRecord[];
}

function persistTranscriptShards(
  runDir: string,
  agents: AgentRecord[],
  options: WorkflowArtifactOptions,
): TranscriptManifest {
  const limitBytes = Math.max(
    1024,
    options.transcriptTotalMaxBytes ?? ARTIFACT_TRANSCRIPT_TOTAL_MAX_BYTES,
  );
  const entryMaxBytes =
    options.transcriptEntryMaxBytes ?? ARTIFACT_TRANSCRIPT_ENTRY_MAX_BYTES;
  const records: TranscriptManifestRecord[] = [];
  let totalBytes = 0;

  for (const agent of agents) {
    const transcript = Array.isArray(agent.transcript) ? agent.transcript : [];
    if (transcript.length === 0) {
      records.push({ index: agent.index, bytes: 0 });
      continue;
    }
    const remaining = limitBytes - totalBytes;
    if (remaining < ARTIFACT_TRANSCRIPT_SHARD_MIN_BYTES) {
      records.push({
        index: agent.index,
        omitted: true,
        reason: "Transcript aggregate limit reached",
      });
      continue;
    }
    // Leave headroom for JSON quoting/escaping so the stored shard fits.
    const textBudget = Math.floor(remaining * 0.75);
    let content: string;
    try {
      content = losslessJsonStringify(
        boundedArtifactTranscript(transcript, {
          maxBytes: Math.min(ARTIFACT_TRANSCRIPT_MAX_BYTES, textBudget),
          entryMaxBytes,
        }),
        Math.min(remaining, ARTIFACT_TRANSCRIPT_MAX_BYTES * 2),
      );
    } catch {
      records.push({
        index: agent.index,
        omitted: true,
        reason: "Transcript could not be serialized",
      });
      continue;
    }
    const bytes = textBytes(content);
    if (bytes > remaining) {
      records.push({
        index: agent.index,
        omitted: true,
        reason: "Transcript aggregate limit reached",
      });
      continue;
    }
    const shard = `${TRANSCRIPT_SHARD_DIR}/${agent.index}.json`;
    try {
      writeRunFile(runDir, shard, content);
    } catch {
      records.push({
        index: agent.index,
        omitted: true,
        reason: "Transcript shard could not be written",
      });
      continue;
    }
    totalBytes += bytes;
    records.push({ index: agent.index, shard, bytes });
  }

  return {
    version: WORKFLOW_TRANSCRIPT_MANIFEST_VERSION,
    limitBytes,
    totalBytes,
    agents: records,
  };
}

export function persistWorkflowJson(
  runDir: string,
  details: WorkflowDetails,
  options: WorkflowArtifactOptions = {},
) {
  const manifest = persistTranscriptShards(
    runDir,
    Array.isArray(details.agents) ? details.agents : [],
    options,
  );
  writeRunFile(
    runDir,
    TRANSCRIPT_ARTIFACT_NAME,
    losslessJsonStringify(manifest, MANIFEST_MAX_BYTES),
  );

  const resultMaxBytes = options.resultMaxBytes ?? ARTIFACT_RESULT_MAX_BYTES;
  let resultArtifact: string | undefined;
  let resultOmitted: string | undefined;
  if (details.result !== undefined) {
    try {
      writeRunFile(
        runDir,
        RESULT_ARTIFACT_NAME,
        losslessJsonStringify(details.result, resultMaxBytes),
      );
      resultArtifact = RESULT_ARTIFACT_NAME;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resultOmitted = /byte limit/.test(message)
        ? `Workflow result exceeds the ${resultMaxBytes} byte artifact limit and was not stored`
        : `Workflow result was not stored: ${message}`;
    }
  }

  // Surface the omission to in-memory readers (the tool result row) too.
  if (resultOmitted) details.resultOmitted = resultOmitted;
  const compact: WorkflowDetails = {
    ...details,
    ...(resultArtifact
      ? { result: "[stored in result.json]", resultArtifact }
      : {}),
    transcriptArtifact: TRANSCRIPT_ARTIFACT_NAME,
    agents: (Array.isArray(details.agents) ? details.agents : []).map(
      (agent) => ({ ...agent, transcript: [] }),
    ),
  };
  if (!resultArtifact) {
    delete compact.result;
    delete compact.resultArtifact;
  }
  writeRunFile(
    runDir,
    "workflow.json",
    safeStringify(compact, { maxBytes: 1024 * 1024 }),
  );
}

/** Resolve a run-dir-relative artifact path, refusing absolute or escaping paths. */
function resolveRunFile(runDir: string, relative: string): string | undefined {
  if (!relative || path.isAbsolute(relative)) return undefined;
  const root = path.resolve(runDir);
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep))
    return undefined;
  return resolved;
}

/**
 * Transcript slots from either the versioned manifest (shard paths) or the
 * legacy inline map shape written before sharding.
 */
function transcriptSources(
  manifest: unknown,
): Map<number, { shard?: string; entries?: unknown }> {
  const sources = new Map<number, { shard?: string; entries?: unknown }>();
  if (!manifest || typeof manifest !== "object") return sources;
  const record = manifest as Record<string, unknown>;
  if (typeof record.version === "number" && Array.isArray(record.agents)) {
    for (const item of record.agents) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      if (typeof entry.index !== "number") continue;
      if (typeof entry.shard === "string")
        sources.set(entry.index, { shard: entry.shard });
    }
    return sources;
  }
  for (const [key, value] of Object.entries(record)) {
    const index = Number(key);
    if (Number.isInteger(index) && index >= 0)
      sources.set(index, { entries: value });
  }
  return sources;
}

function transcriptOmissionReasons(manifest: unknown): Map<number, string> {
  const reasons = new Map<number, string>();
  if (!manifest || typeof manifest !== "object") return reasons;
  const record = manifest as Record<string, unknown>;
  if (!Array.isArray(record.agents)) return reasons;
  for (const item of record.agents) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.index === "number" &&
      entry.omitted === true &&
      typeof entry.reason === "string"
    ) {
      reasons.set(entry.index, entry.reason);
    }
  }
  return reasons;
}

/**
 * Fill a persisted run's result and transcripts from their artifacts. Returns a
 * new details object; the compact placeholder in `workflow.json` is never
 * presented as the stored value.
 */
export function hydrateWorkflowResult(
  runDir: string,
  details: WorkflowDetails,
): WorkflowDetails {
  const agents = (Array.isArray(details.agents) ? details.agents : []).map(
    (agent) => ({ ...agent, transcript: [] as TranscriptEntry[] }),
  );
  const hydrated: WorkflowDetails = { ...details, agents };

  if (typeof hydrated.resultArtifact === "string") {
    const resultPath = resolveRunFile(runDir, hydrated.resultArtifact);
    try {
      if (!resultPath) throw new Error("artifact path is unavailable");
      hydrated.result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    } catch {
      hydrated.result = undefined;
      hydrated.resultOmitted = `Result artifact could not be read: ${hydrated.resultArtifact}`;
    }
  }

  if (typeof hydrated.transcriptArtifact === "string") {
    const manifestPath = resolveRunFile(runDir, hydrated.transcriptArtifact);
    let manifest: unknown;
    let manifestReadable = false;
    if (manifestPath) {
      try {
        const parsed: unknown = JSON.parse(
          fs.readFileSync(manifestPath, "utf8"),
        );
        if (parsed && typeof parsed === "object") {
          manifest = parsed;
          manifestReadable = true;
        }
      } catch {
        manifest = undefined;
      }
    }
    const sources = transcriptSources(manifest);
    const omissions = transcriptOmissionReasons(manifest);
    for (const agent of hydrated.agents) {
      const omitted = omissions.get(agent.index);
      if (omitted) agent.transcriptOmitted = omitted;
      // A named-but-unreadable manifest is lost data, not an absent transcript.
      if (!manifestReadable) {
        agent.transcriptOmitted ??= "Transcript manifest could not be read";
        continue;
      }
      const source = sources.get(agent.index);
      if (!source) continue;
      if (source.shard) {
        const shardPath = resolveRunFile(runDir, source.shard);
        try {
          if (!shardPath) throw new Error("shard path is unavailable");
          agent.transcript = normalizeTranscript(
            JSON.parse(fs.readFileSync(shardPath, "utf8")),
          );
        } catch {
          agent.transcript = [];
          agent.transcriptOmitted = "Transcript shard could not be read";
        }
      } else if (source.entries !== undefined) {
        agent.transcript = normalizeTranscript(source.entries);
      }
    }
  }

  return hydrated;
}

/** Coalesce live checkpoints while keeping final persistence synchronous. */
export function createWorkflowPersistence(
  runDir: string,
  details: WorkflowDetails,
  options: {
    intervalMs?: number;
    persist?: (runDir: string, details: WorkflowDetails) => void;
  } = {},
) {
  const intervalMs = Math.max(
    0,
    options.intervalMs ?? WORKFLOW_CHECKPOINT_INTERVAL_MS,
  );
  const persist = options.persist ?? persistWorkflowJson;
  let lastPersistedAt = Date.now();
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const savePending = () => {
    timer = undefined;
    if (!dirty) return;
    try {
      persist(runDir, details);
      dirty = false;
      lastPersistedAt = Date.now();
    } catch {
      // Final flush retries and reports persistence failures synchronously.
    }
  };

  return {
    checkpoint(options: { immediate?: boolean } = {}) {
      dirty = true;
      if (options.immediate) {
        if (timer) clearTimeout(timer);
        timer = undefined;
        savePending();
        return;
      }
      if (timer) return;
      const delay = Math.max(0, intervalMs - (Date.now() - lastPersistedAt));
      if (delay === 0) {
        savePending();
        return;
      }
      timer = setTimeout(savePending, delay);
    },
    flush() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      persist(runDir, details);
      dirty = false;
      lastPersistedAt = Date.now();
    },
  };
}
