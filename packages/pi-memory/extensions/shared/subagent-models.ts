/**
 * Default models for delegated work (subagent harnesses and workflow agents),
 * plus the cost ceiling that keeps agent-chosen models off the expensive tier.
 *
 * Defaults are user intent, so they are never ceiling-checked: the ceiling only
 * applies to a model an agent picked for itself. Set them with /subagent-model.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

/** Mirrors pi's thinking levels, which are also the shared effort scale. */
export const EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type Effort = (typeof EFFORTS)[number];

export interface PiDefaults {
  readonly provider: string;
  readonly model: string;
  readonly effort: Effort;
}

/** Claude Code takes model aliases, not registry entries. */
export interface ClaudeDefaults {
  readonly model: string;
  readonly effort: Effort;
}

export interface SubagentModels {
  readonly pi: PiDefaults;
  readonly claude: ClaudeDefaults;
}

export const DEFAULT_SUBAGENT_MODELS: SubagentModels = {
  pi: { provider: "deepseek", model: "deepseek-v4-pro", effort: "high" },
  claude: { model: "sonnet", effort: "high" },
};

/**
 * Claude Code aliases an agent may select on its own. Pricier aliases stay
 * available as an explicit user choice (a configured default or a /btw aside)
 * because that harness bills against a subscription, not per token.
 */
export const CLAUDE_AGENT_SELECTABLE_MODELS = ["sonnet", "haiku"] as const;

/** Aliases offered by the picker, cheapest first. */
export const CLAUDE_MODEL_CHOICES = [
  "sonnet",
  "haiku",
  "opus",
  "fable",
] as const;

const sharedDirectory = dirname(fileURLToPath(import.meta.url));
export const SUBAGENT_MODELS_PATH = join(
  sharedDirectory,
  "subagent-models.json",
);

/**
 * Output-price ceiling in USD per million tokens, inclusive. Set at sonnet-5's
 * exact price so haiku-4.5 ($5) and sonnet-5 ($10) are selectable while the
 * $15-and-up tier (kimi-k3, gpt-5.6-terra, opus-4.8, gpt-5.6-sol, fable-5) is
 * not. Override with PI_SUBAGENT_COST_CEILING=<number>, or "off" to disable.
 */
export const DEFAULT_COST_CEILING = 10;

export interface ModelCost {
  readonly output: number;
}

/** Structural shape of a registry model, so this module stays SDK-light. */
export interface ModelLike {
  readonly provider: string;
  readonly id: string;
  readonly cost?: ModelCost;
}

export const modelKey = (model: ModelLike) => `${model.provider}/${model.id}`;

/** The curated `enabledModels` list, or null when the user has not set one. */
function enabledModelKeys(cwd: string) {
  try {
    const settings = SettingsManager.create(cwd, getAgentDir());
    const enabled = settings.getGlobalSettings().enabledModels;
    return enabled?.length ? new Set(enabled) : null;
  } catch {
    return null;
  }
}

/**
 * Models worth offering, cheapest first: the user's `enabledModels` when set,
 * otherwise every registry model with known pricing. Unpriced entries (a $0
 * cost, e.g. the "auto" router) are dropped from the fallback — they cannot be
 * judged against the ceiling and are not sensible picks.
 */
export function curatedModels<T extends ModelLike>(
  models: readonly T[],
  cwd: string,
) {
  const byCost = (a: T, b: T) =>
    (a.cost?.output ?? 0) - (b.cost?.output ?? 0) ||
    modelKey(a).localeCompare(modelKey(b));

  const enabled = enabledModelKeys(cwd);
  if (enabled) {
    const picked = models.filter((model) => enabled.has(modelKey(model)));
    if (picked.length) return picked.sort(byCost);
  }
  return models.filter((model) => (model.cost?.output ?? 0) > 0).sort(byCost);
}

/** Curated models an agent is allowed to select on its own. */
export function affordableModels<T extends ModelLike>(
  models: readonly T[],
  cwd: string,
) {
  return curatedModels(models, cwd).filter(
    (model) => !exceedsCostCeiling(model.cost),
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isEffort = (value: unknown): value is Effort =>
  typeof value === "string" && EFFORTS.includes(value as Effort);

const nonEmpty = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

function parsePi(value: unknown): PiDefaults {
  if (!isRecord(value)) return DEFAULT_SUBAGENT_MODELS.pi;
  const provider = nonEmpty(value.provider);
  const model = nonEmpty(value.model);
  if (!provider || !model || !isEffort(value.effort)) {
    return DEFAULT_SUBAGENT_MODELS.pi;
  }
  return { provider, model, effort: value.effort };
}

function parseClaude(value: unknown): ClaudeDefaults {
  if (!isRecord(value)) return DEFAULT_SUBAGENT_MODELS.claude;
  const model = nonEmpty(value.model);
  if (!model || !isEffort(value.effort)) return DEFAULT_SUBAGENT_MODELS.claude;
  return { model, effort: value.effort };
}

/** Each harness falls back independently, so one bad half keeps the other. */
export function parseSubagentModels(value: unknown): SubagentModels {
  if (!isRecord(value)) return DEFAULT_SUBAGENT_MODELS;
  return { pi: parsePi(value.pi), claude: parseClaude(value.claude) };
}

export function loadSubagentModels(): SubagentModels {
  try {
    return parseSubagentModels(
      JSON.parse(readFileSync(SUBAGENT_MODELS_PATH, "utf8")),
    );
  } catch {
    return DEFAULT_SUBAGENT_MODELS;
  }
}

export async function saveSubagentModels(config: SubagentModels) {
  const tempPath = `${SUBAGENT_MODELS_PATH}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(SUBAGENT_MODELS_PATH), { recursive: true });
  try {
    await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await rename(tempPath, SUBAGENT_MODELS_PATH);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/** Null when the ceiling is disabled. */
export function costCeiling(): number | null {
  const override = process.env.PI_SUBAGENT_COST_CEILING?.trim();
  if (!override) return DEFAULT_COST_CEILING;
  if (override.toLowerCase() === "off") return null;
  const parsed = Number.parseFloat(override);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_COST_CEILING;
}

export function exceedsCostCeiling(cost: ModelCost | undefined) {
  const ceiling = costCeiling();
  if (ceiling === null || !cost) return false;
  return cost.output > ceiling;
}

/** Actionable rejection naming the ceiling and what is still available. */
export function costCeilingMessage(options: {
  label: string;
  cost: ModelCost;
  alternatives: readonly string[];
}) {
  const ceiling = costCeiling();
  const affordable = options.alternatives.slice(0, 6).join(", ");
  return (
    `Model "${options.label}" costs $${options.cost.output}/Mtok output, over the ` +
    `$${ceiling}/Mtok subagent ceiling. ` +
    (affordable ? `Try one of: ${affordable}. ` : "") +
    `Omit "model" to use the configured default, or ask the user to run ` +
    `/subagent-model if this task really needs a pricier model.`
  );
}
