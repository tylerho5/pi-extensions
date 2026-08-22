/**
 * The user-facing switches, read from pi's `settings.json` under a `memory`
 * key. Pi only persists fields it modified itself, so an unrecognized key
 * survives its writes:
 *
 *   "memory": {
 *     "enabled": true,
 *     "promptVariant": "auto",
 *     "recall": { "enabled": true, "provider": "deepseek", "model": "deepseek-v4-flash", "reasoning": "off" }
 *   }
 *
 * `PI_DISABLE_AUTO_MEMORY` mirrors Claude Code's
 * `CLAUDE_CODE_DISABLE_AUTO_MEMORY` and wins over the setting.
 */

import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_DREAM_SETTINGS,
  type DreamSettings,
  parseDreamScope,
} from "./dream/settings.ts";
import type { VariantSetting } from "./variant.ts";

/** Pi's thinking levels, reused as the selector's reasoning scale. */
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

/**
 * The per-turn relevance prefetch (Claude Code's `startRelevantMemoryPrefetch`).
 * `provider`/`model` name the cheap model that reads memory descriptions and
 * picks which files to surface; it is a separate, short call, so a fast model
 * is the right default. Claude Code hardcodes Sonnet — pi keeps it configurable.
 */
export interface RecallSettings {
  readonly enabled: boolean;
  readonly provider: string;
  readonly model: string;
  readonly reasoning: ReasoningLevel;
}

export interface MemorySettings {
  readonly enabled: boolean;
  readonly promptVariant: VariantSetting;
  readonly recall: RecallSettings;
  readonly dream: DreamSettings;
}

export const DEFAULT_RECALL_SETTINGS: RecallSettings = {
  enabled: true,
  provider: "deepseek",
  model: "deepseek-v4-flash",
  reasoning: "off",
};

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  enabled: true,
  promptVariant: "auto",
  recall: DEFAULT_RECALL_SETTINGS,
  dream: DEFAULT_DREAM_SETTINGS,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isVariantSetting = (value: unknown): value is VariantSetting =>
  value === "auto" || value === "full" || value === "terse";

const isReasoningLevel = (value: unknown): value is ReasoningLevel =>
  typeof value === "string" &&
  REASONING_LEVELS.includes(value as ReasoningLevel);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** Only the recall fields actually present, so unset fields keep their default. */
function parseRecallScope(value: unknown): Partial<RecallSettings> {
  if (!isRecord(value)) return {};
  return {
    ...(typeof value.enabled === "boolean" && { enabled: value.enabled }),
    ...(nonEmptyString(value.provider) && { provider: value.provider.trim() }),
    ...(nonEmptyString(value.model) && { model: value.model.trim() }),
    ...(isReasoningLevel(value.reasoning) && { reasoning: value.reasoning }),
  };
}

interface MemoryScope {
  enabled?: boolean;
  promptVariant?: VariantSetting;
  recall?: Partial<RecallSettings>;
  dream?: Partial<DreamSettings>;
}

/** Only the fields actually present, so an unset field defers to the next scope. */
function parseScope(value: unknown): MemoryScope {
  if (!isRecord(value)) return {};
  const recall = parseRecallScope(value.recall);
  const dream = parseDreamScope(value.dream);
  return {
    ...(typeof value.enabled === "boolean" && { enabled: value.enabled }),
    ...(isVariantSetting(value.promptVariant) && {
      promptVariant: value.promptVariant,
    }),
    ...(Object.keys(recall).length > 0 && { recall }),
    ...(Object.keys(dream).length > 0 && { dream }),
  };
}

/** Fold a parsed scope onto resolved settings, deep-merging the nested blocks. */
function applyScope(
  resolved: MemorySettings,
  scope: MemoryScope,
): MemorySettings {
  return {
    ...resolved,
    ...(scope.enabled !== undefined && { enabled: scope.enabled }),
    ...(scope.promptVariant !== undefined && {
      promptVariant: scope.promptVariant,
    }),
    ...(scope.recall && { recall: { ...resolved.recall, ...scope.recall } }),
    ...(scope.dream && { dream: { ...resolved.dream, ...scope.dream } }),
  };
}

export function parseMemorySettings(value: unknown): MemorySettings {
  return applyScope(DEFAULT_MEMORY_SETTINGS, parseScope(value));
}

const truthy = (value: string | undefined) =>
  value !== undefined &&
  ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());

/** Project settings win over global, matching how pi merges everything else. */
export function loadMemorySettings(cwd: string): MemorySettings {
  if (truthy(process.env.PI_DISABLE_AUTO_MEMORY)) {
    return { ...DEFAULT_MEMORY_SETTINGS, enabled: false };
  }
  try {
    const manager = SettingsManager.create(cwd, getAgentDir());
    const scopes = [manager.getGlobalSettings(), manager.getProjectSettings()];
    return scopes.reduce<MemorySettings>(
      (resolved, scope) =>
        applyScope(
          resolved,
          parseScope((scope as Record<string, unknown>).memory),
        ),
      DEFAULT_MEMORY_SETTINGS,
    );
  } catch {
    return DEFAULT_MEMORY_SETTINGS;
  }
}
