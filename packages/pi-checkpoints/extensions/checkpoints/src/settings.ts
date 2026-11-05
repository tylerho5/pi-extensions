/**
 * The checkpoint extension's two knobs, read the way the `guard` extension reads
 * its own: `JSON.parse` of the agent's `settings.json`, falling back to defaults on
 * a missing or malformed file. Malformed data never throws.
 *
 * `cleanupPeriodDays` keeps Claude Code's name and its top-level placement, because
 * that is the name the published docs use; `enabled` nests under `checkpoints` so it
 * cannot collide with an unrelated key.
 */

import { readFileSync } from "node:fs";

export interface CheckpointSettings {
  /** false disables snapshotting entirely, so `/rewind` has nothing to offer. */
  readonly enabled: boolean;
  /** Retention window for shadow repositories, in days. */
  readonly cleanupPeriodDays: number;
}

export const DEFAULT_CHECKPOINT_SETTINGS: CheckpointSettings = {
  enabled: true,
  cleanupPeriodDays: 30,
};

/** Claude Code's documented switch for the same behavior. */
const DISABLE_ENV = "CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPositiveFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** A settings object as the extension reads it: `checkpoints.enabled` and the
 * top-level `cleanupPeriodDays`. A missing or malformed value keeps its default. */
export function parseCheckpointSettings(raw: unknown): CheckpointSettings {
  if (!isRecord(raw)) return DEFAULT_CHECKPOINT_SETTINGS;
  const nested = isRecord(raw.checkpoints) ? raw.checkpoints : {};
  return {
    enabled:
      typeof nested.enabled === "boolean"
        ? nested.enabled
        : DEFAULT_CHECKPOINT_SETTINGS.enabled,
    cleanupPeriodDays: isPositiveFinite(raw.cleanupPeriodDays)
      ? raw.cleanupPeriodDays
      : DEFAULT_CHECKPOINT_SETTINGS.cleanupPeriodDays,
  };
}

const readSettingsFile = (settingsPath: string): unknown => {
  try {
    return JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return undefined;
  }
};

/** The settings in effect. The environment variable wins over the file, so
 * `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING=1` disables even when settings enable it. */
export function loadCheckpointSettings(
  settingsPath: string,
  env: NodeJS.ProcessEnv = process.env,
): CheckpointSettings {
  const settings = parseCheckpointSettings(readSettingsFile(settingsPath));
  if (env[DISABLE_ENV] === "1") return { ...settings, enabled: false };
  return settings;
}
