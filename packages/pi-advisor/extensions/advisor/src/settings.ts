/**
 * Advisor configuration: which model the `advisor` tool consults, independent
 * of the main agent's model. Persisted at ~/.pi/agent/advisor.json and edited
 * through /advisor. Follows the shared/subagent-models.ts conventions (per-
 * field fallback, atomic writes) so a corrupt or half-edited file can never
 * break the main session.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { EFFORTS, type Effort } from "../../shared/subagent-models.ts";

export interface AdvisorSettings {
  /** When false the tool stays registered but declines consultations. */
  readonly enabled: boolean;
  readonly provider: string;
  readonly model: string;
  readonly effort: Effort;
  /** Bounds the advisor's total output (thinking + text) per call. */
  readonly maxTokens: number;
}

/** Claude Code pairs its advisor with Opus; mirror that on the openrouter half. */
export const DEFAULT_ADVISOR_SETTINGS: AdvisorSettings = {
  enabled: true,
  provider: "openrouter",
  model: "anthropic/claude-opus-4.8",
  effort: "high",
  maxTokens: 32_000,
};

export const ADVISOR_SETTINGS_PATH = join(getAgentDir(), "advisor.json");

export const modelKey = (
  settings: Pick<AdvisorSettings, "provider" | "model">,
) => `${settings.provider}/${settings.model}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const isEffort = (value: unknown): value is Effort =>
  typeof value === "string" && EFFORTS.includes(value as Effort);

/** Each field falls back independently, so one bad value keeps the rest. */
export function parseAdvisorSettings(value: unknown): AdvisorSettings {
  if (!isRecord(value)) return DEFAULT_ADVISOR_SETTINGS;
  const defaults = DEFAULT_ADVISOR_SETTINGS;
  const maxTokens = value.maxTokens;
  return {
    enabled:
      typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    provider: nonEmpty(value.provider) ?? defaults.provider,
    model: nonEmpty(value.model) ?? defaults.model,
    effort: isEffort(value.effort) ? value.effort : defaults.effort,
    maxTokens:
      typeof maxTokens === "number" &&
      Number.isFinite(maxTokens) &&
      maxTokens >= 1_000
        ? Math.floor(maxTokens)
        : defaults.maxTokens,
  };
}

export function loadAdvisorSettings(): AdvisorSettings {
  try {
    return parseAdvisorSettings(
      JSON.parse(readFileSync(ADVISOR_SETTINGS_PATH, "utf8")),
    );
  } catch {
    return DEFAULT_ADVISOR_SETTINGS;
  }
}

export async function saveAdvisorSettings(settings: AdvisorSettings) {
  const tempPath = `${ADVISOR_SETTINGS_PATH}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(ADVISOR_SETTINGS_PATH), { recursive: true });
  try {
    await writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await rename(tempPath, ADVISOR_SETTINGS_PATH);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
