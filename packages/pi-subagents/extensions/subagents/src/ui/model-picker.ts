/**
 * /subagent-model — pick the default model and effort per harness.
 *
 * These defaults are what every spawn uses when the agent omits `model`, and
 * they are exempt from the cost ceiling: choosing here is an explicit decision.
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
  EFFORTS,
  exceedsCostCeiling,
  modelKey,
  type Effort,
  type SubagentModels,
} from "../../../shared/subagent-models.ts";

const isEffort = (value: unknown): value is Effort =>
  typeof value === "string" && EFFORTS.includes(value as Effort);

/** Marks models the agent may not select on its own, so the cost is visible. */
function modelLabel(model: Model<Api>) {
  const price = model.cost?.output;
  const cost = typeof price === "number" ? ` · $${price}/Mtok out` : "";
  const overCeiling = exceedsCostCeiling(model.cost) ? " · over ceiling" : "";
  return `${modelKey(model)}${cost}${overCeiling}`;
}

export async function pickHarness(
  ctx: ExtensionCommandContext,
  current: SubagentModels,
) {
  const options = [
    `pi · ${current.pi.provider}/${current.pi.model} · ${current.pi.effort}`,
    `claude · ${current.claude.model} · ${current.claude.effort}`,
  ];
  const selected = await ctx.ui.select("Subagent harness", options);
  if (selected === undefined) return undefined;
  return options.indexOf(selected) === 0
    ? ("pi" as const)
    : ("claude" as const);
}

/** The enabled-models list, cheapest first — not every model a provider offers. */
export async function pickPiModel(ctx: ExtensionCommandContext) {
  const models = curatedModels(ctx.modelRegistry.getAvailable(), ctx.cwd);
  if (models.length === 0) {
    ctx.ui.notify("No configured models are available.", "warning");
    return undefined;
  }
  const labels = models.map(modelLabel);
  const selected = await ctx.ui.select("Default pi subagent model", labels);
  return selected === undefined ? undefined : models[labels.indexOf(selected)];
}

/** Only levels the chosen model actually supports. */
export async function pickPiEffort(
  ctx: ExtensionCommandContext,
  model: Model<Api>,
  current: Effort,
) {
  const supported = getSupportedThinkingLevels(model);
  const start = supported.includes(current) ? current : (supported[0] ?? "off");
  const selected = await ctx.ui.custom<string | undefined>(
    (tui, _theme, _keybindings, done) => {
      const selector = new ThinkingSelectorComponent(
        start,
        supported,
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

export async function pickClaudeModel(ctx: ExtensionCommandContext) {
  const selected = await ctx.ui.select("Default Claude Code subagent model", [
    ...CLAUDE_MODEL_CHOICES,
  ]);
  return selected === undefined ? undefined : selected;
}

/** Claude Code takes a thinking budget, so every level is available. */
export async function pickClaudeEffort(ctx: ExtensionCommandContext) {
  const selected = await ctx.ui.select("Thinking effort", [...EFFORTS]);
  return isEffort(selected) ? selected : undefined;
}
