/**
 * Default models for delegated work (subagent harnesses and workflow agents),
 * plus the cost ceiling that keeps agent-chosen models off the expensive tier.
 *
 * Delegation targets are configured per semantic tier: fast, standard, and deep
 * on the native pi harness, and claude for the secondary harness. Version 1
 * { pi, claude, costCeiling } files migrate in memory.
 *
 * Defaults are user intent, so they are never ceiling-checked: the ceiling only
 * applies to a model an agent picked for itself. Set the tiers with
 * /subagent-model and the ceiling with /subagent-cost.
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

/**
 * Output-price ceiling in USD per million tokens, inclusive. Disabled by
 * default; set a local value with /subagent-cost, or override per launch with
 * PI_SUBAGENT_COST_CEILING.
 */
export const DEFAULT_COST_CEILING = null;

export interface SubagentModels {
  readonly costCeiling: number | null;
  readonly pi: PiDefaults;
  readonly claude: ClaudeDefaults;
}

export const DEFAULT_SUBAGENT_MODELS: SubagentModels = {
  costCeiling: DEFAULT_COST_CEILING,
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

/** The fixed semantic tiers a caller picks for delegated work. */
export const DELEGATION_TIERS = ["fast", "standard", "deep", "claude"] as const;
export type DelegationTier = (typeof DELEGATION_TIERS)[number];

export interface PiTarget {
  readonly harness: "pi";
  readonly provider: string;
  readonly model: string;
  readonly effort: Effort;
}

/** Claude Code takes model aliases, not registry entries. */
export interface ClaudeTarget {
  readonly harness: "claude";
  readonly model: string;
  readonly effort: Effort;
}

export interface DelegationTiers {
  readonly fast: PiTarget;
  readonly standard: PiTarget;
  readonly deep: PiTarget;
  readonly claude: ClaudeTarget;
}

export interface DelegationConfig {
  readonly version: 2;
  readonly costCeiling: number | null;
  readonly tiers: DelegationTiers;
}

/** What one caller asks for: a fixed tier, or a concrete harness/model/effort. */
export interface DelegationSelection {
  readonly tier?: DelegationTier;
  readonly harness?: "pi" | "claude";
  readonly model?: string;
  readonly effort?: Effort;
}

type DelegationTarget = PiTarget | ClaudeTarget;

const DEFAULT_PI_TARGET: PiTarget = {
  harness: "pi",
  ...DEFAULT_SUBAGENT_MODELS.pi,
};

const DEFAULT_CLAUDE_TARGET: ClaudeTarget = {
  harness: "claude",
  ...DEFAULT_SUBAGENT_MODELS.claude,
};

/** Code defaults reuse the legacy pi target for every pi tier. */
export const DEFAULT_DELEGATION_CONFIG: DelegationConfig = {
  version: 2,
  costCeiling: DEFAULT_COST_CEILING,
  tiers: {
    fast: DEFAULT_PI_TARGET,
    standard: DEFAULT_PI_TARGET,
    deep: DEFAULT_PI_TARGET,
    claude: DEFAULT_CLAUDE_TARGET,
  },
};

const sharedDirectory = dirname(fileURLToPath(import.meta.url));
export const SUBAGENT_MODELS_PATH = join(
  sharedDirectory,
  "subagent-models.json",
);

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
  const ceiling = costCeiling();
  return curatedModels(models, cwd).filter(
    (model) => !exceeds(ceiling, model.cost),
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isEffort = (value: unknown): value is Effort =>
  typeof value === "string" && EFFORTS.includes(value as Effort);

const nonEmpty = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

function parseCostCeiling(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  return DEFAULT_COST_CEILING;
}

const harnessMatches = (value: unknown, harness: "pi" | "claude") =>
  value === undefined || value === harness;

function parsePiTarget(value: unknown, fallback: PiTarget): PiTarget {
  if (!isRecord(value) || !harnessMatches(value.harness, "pi")) return fallback;
  const provider = nonEmpty(value.provider);
  const model = nonEmpty(value.model);
  if (!provider || !model || !isEffort(value.effort)) return fallback;
  return { harness: "pi", provider, model, effort: value.effort };
}

function parseClaudeTarget(
  value: unknown,
  fallback: ClaudeTarget,
): ClaudeTarget {
  if (!isRecord(value) || !harnessMatches(value.harness, "claude")) {
    return fallback;
  }
  const model = nonEmpty(value.model);
  if (!model || !isEffort(value.effort)) return fallback;
  return { harness: "claude", model, effort: value.effort };
}

function parseTiers(value: Record<string, unknown>): DelegationTiers {
  const defaults = DEFAULT_DELEGATION_CONFIG.tiers;
  if (value.version === 2 && isRecord(value.tiers)) {
    const tiers = value.tiers;
    return {
      fast: parsePiTarget(tiers.fast, defaults.fast),
      standard: parsePiTarget(tiers.standard, defaults.standard),
      deep: parsePiTarget(tiers.deep, defaults.deep),
      claude: parseClaudeTarget(tiers.claude, defaults.claude),
    };
  }
  const pi = parsePiTarget(value.pi, defaults.standard);
  return {
    fast: pi,
    standard: pi,
    deep: pi,
    claude: parseClaudeTarget(value.claude, defaults.claude),
  };
}

/** Each tier falls back independently, so one bad entry keeps the rest. */
export function parseDelegationConfig(value: unknown): DelegationConfig {
  if (!isRecord(value)) return DEFAULT_DELEGATION_CONFIG;
  return {
    version: 2,
    costCeiling: parseCostCeiling(value.costCeiling),
    tiers: parseTiers(value),
  };
}

/** Legacy per-harness view; the pi half reports the standard tier. */
export function parseSubagentModels(value: unknown): SubagentModels {
  return toSubagentModels(parseDelegationConfig(value));
}

function toSubagentModels(config: DelegationConfig): SubagentModels {
  return {
    costCeiling: config.costCeiling,
    pi: {
      provider: config.tiers.standard.provider,
      model: config.tiers.standard.model,
      effort: config.tiers.standard.effort,
    },
    claude: {
      model: config.tiers.claude.model,
      effort: config.tiers.claude.effort,
    },
  };
}

export function loadDelegationConfig(
  path = SUBAGENT_MODELS_PATH,
): DelegationConfig {
  try {
    return parseDelegationConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return DEFAULT_DELEGATION_CONFIG;
  }
}

export async function saveDelegationConfig(
  config: DelegationConfig,
  path = SUBAGENT_MODELS_PATH,
) {
  await writeJsonAtomic(path, config);
}

export function loadSubagentModels(): SubagentModels {
  return toSubagentModels(loadDelegationConfig());
}

export async function saveSubagentModels(config: SubagentModels) {
  await writeJsonAtomic(SUBAGENT_MODELS_PATH, config);
}

async function writeJsonAtomic(file: string, value: unknown) {
  const tempPath = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(file), { recursive: true });
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, file);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export type ResolvedDelegationTarget =
  | {
      readonly harness: "pi";
      readonly provider?: string;
      readonly model: string;
      readonly effort: Effort;
      readonly source:
        | { readonly kind: "tier"; readonly tier: DelegationTier }
        | { readonly kind: "explicit" };
    }
  | {
      readonly harness: "claude";
      readonly model: string;
      readonly effort: Effort;
      readonly source:
        | { readonly kind: "tier"; readonly tier: "claude" }
        | { readonly kind: "explicit" };
    };

function splitPiModel(value: string): { provider?: string; model: string } {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return { model: value };
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

function explicitEffort(effort: Effort | undefined, fallback: Effort): Effort {
  if (effort === undefined) return fallback;
  if (!isEffort(effort)) {
    throw new Error(
      `Unknown effort "${String(effort)}". Valid efforts: ${EFFORTS.join(", ")}.`,
    );
  }
  return effort;
}

function tierTarget(
  config: DelegationConfig,
  tier: DelegationTier,
  supportedHarnesses: readonly ("pi" | "claude")[],
): ResolvedDelegationTarget {
  const target: DelegationTarget | undefined = config.tiers[tier];
  if (!target) {
    throw new Error(`Tier "${tier}" is not defined in the delegation config.`);
  }
  if (!supportedHarnesses.includes(target.harness)) {
    throw new Error(
      `Tier "${tier}" resolves to the "${target.harness}" harness, which ` +
        `this caller does not support. Supported harnesses: ${harnessList(supportedHarnesses)}.`,
    );
  }
  if (target.harness === "claude") {
    return {
      harness: "claude",
      model: target.model,
      effort: target.effort,
      source: { kind: "tier", tier: "claude" },
    };
  }
  return {
    harness: "pi",
    provider: target.provider,
    model: target.model,
    effort: target.effort,
    source: { kind: "tier", tier },
  };
}

const harnessList = (supported: readonly ("pi" | "claude")[]) =>
  supported.join(", ") || "none";

/** Pure mapping from a caller selection to one normalized delegation target. */
export function resolveDelegationTarget(options: {
  readonly config: DelegationConfig;
  readonly selection: DelegationSelection;
  readonly supportedHarnesses: readonly ("pi" | "claude")[];
}): ResolvedDelegationTarget {
  const { config, selection, supportedHarnesses } = options;
  const explicit =
    selection.harness !== undefined ||
    selection.model !== undefined ||
    selection.effort !== undefined;

  if (selection.tier !== undefined) {
    if (explicit) {
      throw new Error(
        `Tier "${selection.tier}" cannot be combined with an explicit harness, model, or effort.`,
      );
    }
    return tierTarget(config, selection.tier, supportedHarnesses);
  }

  if (!explicit) return tierTarget(config, "standard", supportedHarnesses);

  const harness = selection.harness;
  if (harness === undefined) {
    throw new Error(
      `An explicit model or effort requires "harness" (one of: ${harnessList(supportedHarnesses)}).`,
    );
  }
  if (!supportedHarnesses.includes(harness)) {
    throw new Error(
      `Harness "${harness}" is not supported here. Supported harnesses: ${harnessList(supportedHarnesses)}.`,
    );
  }
  const model = nonEmpty(selection.model);
  if (!model) {
    throw new Error(
      `Harness "${harness}" requires an explicit "model" ` +
        `(${harness === "pi" ? '"provider/model"' : "a Claude Code alias"}).`,
    );
  }

  if (harness === "claude") {
    return {
      harness: "claude",
      model,
      effort: explicitEffort(selection.effort, config.tiers.claude.effort),
      source: { kind: "explicit" },
    };
  }

  const split = splitPiModel(model);
  return {
    harness: "pi",
    ...(split.provider === undefined ? {} : { provider: split.provider }),
    model: split.model,
    effort: explicitEffort(selection.effort, config.tiers.standard.effort),
    source: { kind: "explicit" },
  };
}

/** Null when the ceiling is disabled. Env is a per-launch override of the file. */
export function costCeiling(): number | null {
  const override = process.env.PI_SUBAGENT_COST_CEILING?.trim();
  if (override) {
    if (override.toLowerCase() === "off") return null;
    const parsed = Number.parseFloat(override);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return loadSubagentModels().costCeiling;
}

function exceeds(ceiling: number | null, cost: ModelCost | undefined) {
  return ceiling !== null && !!cost && cost.output > ceiling;
}

export function exceedsCostCeiling(cost: ModelCost | undefined) {
  return exceeds(costCeiling(), cost);
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
    `/subagent-cost if this task really needs a pricier model.`
  );
}
