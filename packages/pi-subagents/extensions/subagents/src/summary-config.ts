/** Local config for the settle-time report digest and the live progress line, edited in /subagents-menu. */

import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readJsonOrDefault, writeJsonAtomic } from "../../shared/state-file.ts";

export interface SummaryConfig {
  /** Compute a digest for settled runs at all. */
  readonly enabled: boolean;
  /** Head-only cap on the report text fed to the digest model. */
  readonly inputCharCap: number;
  /** Head-only cap on the raw report shown in an expanded row. */
  readonly rawCharCap: number;
  /** Reports shorter than this are already a digest, so skip the call. */
  readonly skipUnderChars: number;
  /** Hard bound on one digest call. */
  readonly timeoutMs: number;
  /** Write a live status line for running subagents. */
  readonly progressEnabled: boolean;
  /** How often a running subagent's status line may refresh. */
  readonly progressIntervalMs: number;
}

export const DEFAULT_SUMMARY_CONFIG: SummaryConfig = {
  enabled: true,
  inputCharCap: 8_000,
  rawCharCap: 4_000,
  skipUnderChars: 300,
  timeoutMs: 15_000,
  progressEnabled: true,
  progressIntervalMs: 30_000,
};

/** Resolved per call so a test can point getAgentDir at a temp directory. */
export function summaryConfigPath(): string {
  return join(getAgentDir(), "subagent-summary.json");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function positiveInt(value: unknown, fallback: number, zeroOk = false): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (zeroOk ? value < 0 : value <= 0) return fallback;
  return Math.floor(value);
}

/** Each field falls back on its own, so one bad value keeps the rest. */
export function parseSummaryConfig(value: unknown): SummaryConfig {
  if (!isRecord(value)) return DEFAULT_SUMMARY_CONFIG;
  return {
    enabled:
      typeof value.enabled === "boolean"
        ? value.enabled
        : DEFAULT_SUMMARY_CONFIG.enabled,
    inputCharCap: positiveInt(
      value.inputCharCap,
      DEFAULT_SUMMARY_CONFIG.inputCharCap,
    ),
    rawCharCap: positiveInt(
      value.rawCharCap,
      DEFAULT_SUMMARY_CONFIG.rawCharCap,
    ),
    skipUnderChars: positiveInt(
      value.skipUnderChars,
      DEFAULT_SUMMARY_CONFIG.skipUnderChars,
      true,
    ),
    timeoutMs: positiveInt(value.timeoutMs, DEFAULT_SUMMARY_CONFIG.timeoutMs),
    progressEnabled:
      typeof value.progressEnabled === "boolean"
        ? value.progressEnabled
        : DEFAULT_SUMMARY_CONFIG.progressEnabled,
    progressIntervalMs: positiveInt(
      value.progressIntervalMs,
      DEFAULT_SUMMARY_CONFIG.progressIntervalMs,
    ),
  };
}

export function loadSummaryConfig(path = summaryConfigPath()): SummaryConfig {
  return readJsonOrDefault(path, DEFAULT_SUMMARY_CONFIG, parseSummaryConfig);
}

export async function saveSummaryConfig(
  config: SummaryConfig,
  path = summaryConfigPath(),
): Promise<void> {
  if (typeof config.enabled !== "boolean")
    throw new Error("Summary enabled must be a boolean.");
  for (const key of [
    "inputCharCap",
    "rawCharCap",
    "skipUnderChars",
    "timeoutMs",
  ] as const) {
    const value = config[key];
    const minimum = key === "skipUnderChars" ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum)
      throw new Error(
        `${key} must be a ${minimum === 0 ? "non-negative" : "positive"} safe integer.`,
      );
  }
  writeJsonAtomic(path, parseSummaryConfig(config), 0o600);
}
