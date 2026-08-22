import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Data, Effect } from "effect";
import { readJsonOrDefault, writeJsonAtomic } from "../../shared/state-file.ts";

class ConfigWriteError extends Data.TaggedError("ConfigWriteError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export interface SummaryConfig {
  readonly provider: string;
  readonly model: string;
  readonly reasoning: ReasoningLevel;
}

export const DEFAULT_SUMMARY_CONFIG: SummaryConfig = {
  provider: "deepseek",
  model: "deepseek-v4-flash",
  reasoning: "medium",
};

/**
 * Quiet time after a run before its recap is written, matching Claude Code's
 * away-summary delay: three minutes, and never under thirty seconds. Override
 * with PI_SUMMARY_IDLE_MS=<milliseconds>.
 */
export const DEFAULT_IDLE_DELAY_MS = 180_000;
export const MIN_IDLE_DELAY_MS = 30_000;

export function idleDelayMs() {
  const override = Number.parseInt(
    process.env.PI_SUMMARY_IDLE_MS?.trim() ?? "",
    10,
  );
  return Number.isFinite(override) && override > 0
    ? Math.max(MIN_IDLE_DELAY_MS, override)
    : DEFAULT_IDLE_DELAY_MS;
}

// Resolved at call time (not a module-load const) so it follows getAgentDir()
// — needed for tests, which point it at a temp dir via PI_CODING_AGENT_DIR.
export function PRIVATE_CONFIG_PATH(): string {
  return join(getAgentDir(), "summaries", "config.private.json");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isReasoningLevel = (value: unknown): value is ReasoningLevel =>
  typeof value === "string" &&
  REASONING_LEVELS.includes(value as ReasoningLevel);

export function parseSummaryConfig(value: unknown) {
  if (!isRecord(value)) return DEFAULT_SUMMARY_CONFIG;

  if (
    typeof value.provider !== "string" ||
    !value.provider.trim() ||
    typeof value.model !== "string" ||
    !value.model.trim() ||
    !isReasoningLevel(value.reasoning)
  ) {
    return DEFAULT_SUMMARY_CONFIG;
  }

  return {
    provider: value.provider.trim(),
    model: value.model.trim(),
    reasoning: value.reasoning,
  } satisfies SummaryConfig;
}

export function loadSummaryConfig() {
  return readJsonOrDefault(
    PRIVATE_CONFIG_PATH(),
    DEFAULT_SUMMARY_CONFIG,
    parseSummaryConfig,
  );
}

export function saveSummaryConfig(config: SummaryConfig, signal?: AbortSignal) {
  const write = Effect.tryPromise({
    try: async () => {
      writeJsonAtomic(PRIVATE_CONFIG_PATH(), config, 0o600);
    },
    catch: (cause) =>
      new ConfigWriteError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(Effect.timeout("5 seconds"));

  return Effect.runPromise(write, signal ? { signal } : undefined);
}
