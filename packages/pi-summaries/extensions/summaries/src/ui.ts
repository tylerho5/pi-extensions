import {
  getMarkdownTheme,
  ThinkingSelectorComponent,
  type ExtensionCommandContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { curatedModels, modelKey } from "../../shared/subagent-models.ts";
import type { ReasoningLevel } from "./config.ts";
import type { RunRecap } from "./summarizer.ts";

export interface RecapEntryData extends RunRecap {
  readonly provider: string;
  readonly model: string;
  readonly reasoning: ReasoningLevel;
  readonly fallback?: boolean;
}

class RecapCard {
  private readonly data: RecapEntryData;
  private readonly theme: Theme;
  private readonly expanded: boolean;

  constructor(data: RecapEntryData, theme: Theme, expanded: boolean) {
    this.data = data;
    this.theme = theme;
    this.expanded = expanded;
  }

  render(width: number) {
    const box = new Box(1, 1, (text) => this.theme.bg("customMessageBg", text));
    const title =
      this.theme.fg("accent", "✦ ") +
      this.theme.fg("customMessageLabel", this.theme.bold("Recap"));
    box.addChild(new Text(title, 0, 0));
    box.addChild(
      new Markdown(this.data.recap, 0, 1, getMarkdownTheme(), {
        color: (text) => this.theme.fg("customMessageText", text),
      }),
    );
    box.addChild(
      new Text(
        `${this.theme.fg("accent", this.theme.bold("Next:"))} ${this.theme.fg("customMessageText", this.data.next)}`,
        0,
        0,
      ),
    );
    if (this.expanded) {
      const source = `${this.data.provider}/${this.data.model} · ${this.data.reasoning}${this.data.fallback ? " · local fallback" : ""}`;
      box.addChild(new Text(this.theme.fg("dim", source), 0, 1));
    }
    return box.render(width);
  }

  invalidate() {}
}

export function renderRecap(
  data: RecapEntryData | undefined,
  expanded: boolean,
  theme: Theme,
) {
  if (!data) return new Text(theme.fg("warning", "Recap unavailable"), 0, 0);
  return new RecapCard(data, theme, expanded);
}

function modelLabel(model: Model<Api>) {
  const price = model.cost?.output;
  const cost = typeof price === "number" ? ` · $${price}/Mtok out` : "";
  return `${modelKey(model)}${cost}`;
}

/** The enabled-models list, cheapest first — the same scope /subagent-model offers. */
export async function openModelPicker(ctx: ExtensionCommandContext) {
  const models = curatedModels(ctx.modelRegistry.getAvailable(), ctx.cwd);
  if (models.length === 0) {
    ctx.ui.notify(
      "No configured models are available for run recaps.",
      "warning",
    );
    return undefined;
  }
  const labels = models.map(modelLabel);
  const selected = await ctx.ui.select("Summary model", labels);
  return selected === undefined ? undefined : models[labels.indexOf(selected)];
}

export function openReasoningPicker(
  ctx: ExtensionCommandContext,
  model: Model<Api>,
  current: ReasoningLevel,
) {
  const supported = getSupportedThinkingLevels(model);
  const selectedCurrent = supported.includes(current)
    ? current
    : (supported[0] ?? "off");

  return ctx.ui.custom<ModelThinkingLevel | undefined>(
    (tui, _theme, _keybindings, done) => {
      const selector = new ThinkingSelectorComponent(
        selectedCurrent,
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
}
