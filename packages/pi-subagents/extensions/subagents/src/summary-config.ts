/**
 * Local config for the settle-time report digest. Per-field fallback on a
 * missing, half-written, or corrupt file, resolved at call time so it follows
 * getAgentDir (tests point it at a temp dir). No command writes it yet; a user
 * edits `<agentDir>/subagent-summary.json` by hand.
 */

import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readJsonOrDefault } from "../../shared/state-file.ts";

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
}

export const DEFAULT_SUMMARY_CONFIG: SummaryConfig = {
  enabled: true,
  inputCharCap: 8_000,
  rawCharCap: 4_000,
  skipUnderChars: 300,
  timeoutMs: 15_000,
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
  };
}

export function loadSummaryConfig(path = summaryConfigPath()): SummaryConfig {
  return readJsonOrDefault(path, DEFAULT_SUMMARY_CONFIG, parseSummaryConfig);
}
