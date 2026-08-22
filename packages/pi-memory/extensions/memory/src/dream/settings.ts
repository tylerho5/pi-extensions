/**
 * The `memory.dream` settings block — background memory consolidation. Off by
 * default; it never runs without an explicit opt-in.
 *
 * `model` and `effort` are job config, like the summaries recap model, chosen
 * for memory fidelity over speed rather than inherited from the delegated
 * subagent default. `model` is any non-empty "provider/model" string; the
 * runner resolves it against the registry. Numeric thresholds match Claude
 * Code 2.1.220; the pi-added defaults (idle delay, transcript budget, cost cap)
 * carry the reasoning noted at each field.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { EFFORTS, type Effort } from "../../../shared/subagent-models.ts";

export interface DreamSettings {
  readonly enabled: boolean;
  readonly model: string;
  readonly effort: Effort;
  readonly minHours: number;
  readonly minSessions: number;
  readonly idleDelayMs: number;
  readonly maxTurns: number;
  readonly maxCostUsd: number;
  readonly transcriptBudgetBytes: number;
}

export const DEFAULT_DREAM_SETTINGS: DreamSettings = {
  enabled: false,
  model: "deepseek/deepseek-v4-pro",
  effort: "max",
  minHours: 24,
  minSessions: 5,
  idleDelayMs: 300_000,
  maxTurns: 30,
  maxCostUsd: 5,
  transcriptBudgetBytes: 96_000,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isEffort = (value: unknown): value is Effort =>
  typeof value === "string" && EFFORTS.includes(value as Effort);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** Positive and finite; anything else defers to the default, matching Claude Code's gate validation. */
const isPositiveNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * Only the fields actually present and valid, so an unset (or malformed) field
 * defers to the next scope instead of resetting it. Mirrors `parseRecallScope`.
 */
export function parseDreamScope(value: unknown): Partial<DreamSettings> {
  if (!isRecord(value)) return {};
  return {
    ...(typeof value.enabled === "boolean" && { enabled: value.enabled }),
    ...(nonEmptyString(value.model) && { model: value.model.trim() }),
    ...(isEffort(value.effort) && { effort: value.effort }),
    ...(isPositiveNumber(value.minHours) && { minHours: value.minHours }),
    ...(isPositiveNumber(value.minSessions) && {
      minSessions: value.minSessions,
    }),
    ...(isPositiveNumber(value.idleDelayMs) && {
      idleDelayMs: value.idleDelayMs,
    }),
    ...(isPositiveNumber(value.maxTurns) && { maxTurns: value.maxTurns }),
    ...(isPositiveNumber(value.maxCostUsd) && { maxCostUsd: value.maxCostUsd }),
    ...(isPositiveNumber(value.transcriptBudgetBytes) && {
      transcriptBudgetBytes: value.transcriptBudgetBytes,
    }),
  };
}

/** A full DreamSettings from a single `dream` block value, defaults for the rest. */
export function parseDreamSettings(value: unknown): DreamSettings {
  return { ...DEFAULT_DREAM_SETTINGS, ...parseDreamScope(value) };
}

// --- Persisting the automatic-dreaming toggle --------------------------------
//
// pi's built-in /settings menu is a closed, fixed-schema TUI component with no
// extension hook to add entries to, and SettingsManager exposes only typed
// setters for its own built-in fields — nothing generic for an extension-owned
// key like memory.dream.enabled. /dream-auto persists it by reading, merging,
// and writing the global settings.json directly, the way pi's own settings
// file already stores extension state it doesn't know the shape of.

function globalSettingsPath(agentDir: string): string {
  return join(agentDir, "settings.json");
}

/**
 * Absent file reads as `{}` (first toggle creates the file). Any other read or
 * parse failure propagates — silently coercing a malformed or mid-write file to
 * `{}` would then get written back, destroying the user's real settings. The
 * global settings.json can be concurrently written by a live pi session, so a
 * transient read race must surface as an error, never a silent wipe.
 */
async function readGlobalSettingsJson(
  path: string,
): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error(`${path} does not contain a JSON object`);
  }
  return parsed;
}

async function writeGlobalSettingsJson(
  path: string,
  settings: Record<string, unknown>,
): Promise<void> {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Flip `memory.dream.enabled` in the global settings.json, preserving every
 * other key including sibling `memory` and `memory.dream` fields.
 */
export async function persistDreamAutoEnabled(
  agentDir: string,
  enabled: boolean,
): Promise<void> {
  const path = globalSettingsPath(agentDir);
  const raw = await readGlobalSettingsJson(path);
  const memory = isRecord(raw.memory) ? raw.memory : {};
  const dream = isRecord(memory.dream) ? memory.dream : {};
  await writeGlobalSettingsJson(path, {
    ...raw,
    memory: { ...memory, dream: { ...dream, enabled } },
  });
}

/**
 * True when the project scope sets `memory.dream.enabled` explicitly — since
 * project settings win over global (see `applyScope` in `../settings.ts`), a
 * global toggle would have no visible effect and the caller should say so.
 */
export function projectOverridesDreamEnabled(
  cwd: string,
  agentDir: string = getAgentDir(),
): boolean {
  try {
    const project = SettingsManager.create(cwd, agentDir).getProjectSettings();
    const memory = (project as Record<string, unknown>).memory;
    return (
      isRecord(memory) &&
      isRecord(memory.dream) &&
      typeof memory.dream.enabled === "boolean"
    );
  } catch {
    return false;
  }
}
