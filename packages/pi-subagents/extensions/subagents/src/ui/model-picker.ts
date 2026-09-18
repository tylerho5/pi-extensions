/**
 * /subagent-model — pick the default model and effort for each delegation tier.
 *
 * A tier is a fixed harness, so the flow selects the tier first and then the
 * model that tier's harness accepts. These defaults are what a tier resolves
 * to and are exempt from the cost ceiling: choosing here is an explicit
 * decision.
 */

import {
  ThinkingSelectorComponent,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import {
  CLAUDE_MODEL_CHOICES,
  curatedModels,
  DELEGATION_TIERS,
  EFFORTS,
  modelKey,
  type ClaudeTarget,
  type DelegationConfig,
  type DelegationTier,
  type DelegationTiers,
  type Effort,
  type PiTarget,
} from "../../../shared/subagent-models.ts";

const isEffort = (value: unknown): value is Effort =>
  typeof value === "string" && EFFORTS.includes(value as Effort);

/** Marks models the agent may not select on its own, so the cost is visible. */
function modelLabel(model: Model<Api>, ceiling: number | null) {
  const price = model.cost?.output;
  const cost = typeof price === "number" ? ` · $${price}/Mtok out` : "";
  const overCeiling =
    ceiling !== null && price !== undefined && price > ceiling
      ? " · over ceiling"
      : "";
  return `${modelKey(model)}${cost}${overCeiling}`;
}

/** Levels the model itself supports; a non-reasoning model only takes `off`. */
function piEffortOptions(model: Model<Api>): Effort[] {
  return getSupportedThinkingLevels(model);
}

/** Claude Code takes a thinking budget, so every level is available. */
function claudeEffortOptions(): Effort[] {
  return [...EFFORTS];
}

/** `harness/model · effort` — the mapping half of a tier line. */
export function tierTargetLabel(
  config: DelegationConfig,
  tier: DelegationTier,
) {
  const target = config.tiers[tier];
  const model =
    target.harness === "pi"
      ? `${target.provider}/${target.model}`
      : target.model;
  return `${target.harness}/${model} · ${target.effort}`;
}

/** First-screen line: the tier name plus its current mapping. */
function tierLabel(config: DelegationConfig, tier: DelegationTier) {
  return `${tier} · ${tierTargetLabel(config, tier)}`;
}

/** Replace one tier, keeping every other tier and the ceiling untouched. */
export function applyTierSelection(
  config: DelegationConfig,
  tier: DelegationTier,
  target: PiTarget | ClaudeTarget,
): DelegationConfig {
  const tiers: DelegationTiers = { ...config.tiers, [tier]: target };
  return { ...config, tiers };
}

export interface TierPickerUi {
  select(
    title: string,
    options: readonly string[],
  ): Promise<string | undefined>;
  pickEffort(
    options: readonly Effort[],
    current: Effort,
  ): Promise<Effort | undefined>;
  notify(message: string, type: "info" | "warning" | "error"): void;
}

export interface TierPickerDeps {
  readonly ui: TierPickerUi;
  readonly config: DelegationConfig;
  readonly cwd: string;
  readonly models: readonly Model<Api>[];
  readonly ceiling: number | null;
}

export interface TierPickerResult {
  readonly tier: DelegationTier;
  readonly config: DelegationConfig;
}

/**
 * Tier-first flow: tier → model for that tier's fixed harness → effort.
 * Returns the complete next config, or undefined when any step is cancelled.
 */
export async function pickTierConfig(
  deps: TierPickerDeps,
): Promise<TierPickerResult | undefined> {
  const { ui, config } = deps;
  const labels = DELEGATION_TIERS.map((tier) => tierLabel(config, tier));
  const tierChoice = await ui.select("Subagent tier", labels);
  if (tierChoice === undefined) return undefined;
  const tier = DELEGATION_TIERS[labels.indexOf(tierChoice)];
  if (tier === undefined) return undefined;

  if (tier === "claude") {
    const model = await ui.select("Default Claude Code subagent model", [
      ...CLAUDE_MODEL_CHOICES,
    ]);
    if (model === undefined) return undefined;
    const effort = await ui.pickEffort(
      claudeEffortOptions(),
      config.tiers.claude.effort,
    );
    if (effort === undefined) return undefined;
    return {
      tier,
      config: applyTierSelection(config, tier, {
        harness: "claude",
        model,
        effort,
      }),
    };
  }

  const models = curatedModels(deps.models, deps.cwd);
  if (models.length === 0) {
    ui.notify("No configured models are available.", "warning");
    return undefined;
  }
  const modelLabels = models.map((model) => modelLabel(model, deps.ceiling));
  const modelChoice = await ui.select(
    `Default ${tier} pi subagent model`,
    modelLabels,
  );
  if (modelChoice === undefined) return undefined;
  const model = models[modelLabels.indexOf(modelChoice)];
  if (model === undefined) return undefined;
  const effort = await ui.pickEffort(
    piEffortOptions(model),
    config.tiers[tier].effort,
  );
  if (effort === undefined) return undefined;
  return {
    tier,
    config: applyTierSelection(config, tier, {
      harness: "pi",
      provider: model.provider,
      model: model.id,
      effort,
    }),
  };
}

/** Thinking-level selector over the levels the chosen model supports. */
export async function pickEffort(
  ctx: ExtensionCommandContext,
  options: readonly Effort[],
  current: Effort,
) {
  const levels = [...options];
  const start = levels.includes(current) ? current : (levels[0] ?? "off");
  const selected = await ctx.ui.custom<string | undefined>(
    (tui, _theme, _keybindings, done) => {
      const selector = new ThinkingSelectorComponent(
        start,
        levels,
        (level) => done(level),
        () => done(undefined),
      );
      const list = selector.getSelectList();
      return {
        render: (width) => selector.render(width),
        invalidate: () => selector.invalidate(),
        handleInput: (data) => {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    },
  );
  return isEffort(selected) ? selected : undefined;
}
