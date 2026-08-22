/**
 * advisor — Claude Code's advisor tool, ported to pi.
 *
 * Registers an `advisor` tool the main agent can consult mid-turn: a stronger
 * reviewer model that sees the whole conversation and gives strategic
 * guidance. The advisor model is configured independently of the main agent
 * model (~/.pi/agent/advisor.json, or /advisor in the TUI).
 *
 * Claude Code implements this server-side (Anthropic's advisor_20260301 beta
 * tool); pi is multi-provider, so this port is client-side: the extension
 * serializes the current session to a redacted transcript and makes a one-shot
 * completion against the configured model. Only the primary thread gets the
 * tool — subagent sessions spawn without extension custom tools, which mirrors
 * CC's "only the primary thread consults it" rule.
 *
 * The tool (and its prompt snippet/guidelines) is only registered while the
 * advisor is enabled. Disabling it removes the tool from the active tool set,
 * so the "when to call advisor" prompting leaves the system prompt and the
 * agent stops trying to call it.
 */

import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  curatedModels,
  EFFORTS,
  modelKey,
  type Effort,
} from "../shared/subagent-models.ts";
import { consultAdvisor, makeConsultDeps } from "./src/consult.ts";
import {
  ADVISOR_PROMPT_GUIDELINES,
  ADVISOR_PROMPT_SNIPPET,
  ADVISOR_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import {
  loadAdvisorSettings,
  saveAdvisorSettings,
  modelKey as advisorModelKey,
  type AdvisorSettings,
} from "./src/settings.ts";
import { serializeAdvisorTranscript } from "./src/transcript.ts";

function modelLabel(model: Model<Api>) {
  const price = model.cost?.output;
  const cost = typeof price === "number" ? ` · $${price}/Mtok out` : "";
  return `${modelKey(model)}${cost}`;
}

function resolveModelKey(
  ctx: ExtensionCommandContext,
  raw: string,
): { provider: string; model: string } | undefined {
  const slash = raw.indexOf("/");
  if (slash > 0) {
    const provider = raw.slice(0, slash);
    const model = raw.slice(slash + 1);
    if (ctx.modelRegistry.find(provider, model)) return { provider, model };
    return undefined;
  }
  const matches = ctx.modelRegistry
    .getAll()
    .filter((model) => model.id === raw);
  if (matches.length !== 1) return undefined;
  const model = matches[0];
  return { provider: model.provider, model: model.id };
}

async function pickEffort(
  ctx: ExtensionCommandContext,
  model: Model<Api>,
  current: Effort,
): Promise<Effort | undefined> {
  const supported = getSupportedThinkingLevels(model);
  const start = supported.includes(current) ? current : (supported[0] ?? "off");
  const { ThinkingSelectorComponent } =
    await import("@earendil-works/pi-coding-agent");
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
  return EFFORTS.includes(selected as Effort)
    ? (selected as Effort)
    : undefined;
}

async function openAdvisorPicker(
  ctx: ExtensionCommandContext,
  syncAdvisorTool: (enabled: boolean) => void,
) {
  const current = loadAdvisorSettings();
  const models = curatedModels(ctx.modelRegistry.getAvailable(), ctx.cwd);
  if (models.length === 0) {
    ctx.ui.notify("No configured models are available.", "warning");
    return;
  }

  const labels = models.map(modelLabel);
  const currentIndex = models.findIndex(
    (m) => m.provider === current.provider && m.id === current.model,
  );
  const options = [
    ...labels.map((label, i) =>
      i === currentIndex ? `${label} · current` : label,
    ),
    current.enabled ? "Turn advisor off" : "Turn advisor on",
  ];
  const selected = await ctx.ui.select("Advisor model", options);
  if (selected === undefined) return;

  const toggleIndex = options.length - 1;
  if (options.indexOf(selected) === toggleIndex) {
    const enabled = !current.enabled;
    try {
      await saveAdvisorSettings({ ...current, enabled });
    } catch {
      ctx.ui.notify("Could not save the advisor config.", "error");
      return;
    }
    syncAdvisorTool(enabled);
    ctx.ui.notify(
      current.enabled ? "Advisor turned off." : "Advisor turned on.",
      "info",
    );
    return;
  }

  const chosen = models[labels.indexOf(selected)];
  if (!chosen) return;
  const effort = await pickEffort(ctx, chosen, current.effort);
  if (!effort) return;

  const updated: AdvisorSettings = {
    ...current,
    enabled: true,
    provider: chosen.provider,
    model: chosen.id,
    effort,
  };
  try {
    await saveAdvisorSettings(updated);
  } catch {
    ctx.ui.notify("Could not save the advisor config.", "error");
    return;
  }
  syncAdvisorTool(true);
  ctx.ui.notify(`Advisor: ${modelKey(chosen)} · ${effort}`, "info");
}

const ADVISOR_TOOL_NAME = "advisor";

export default function advisor(pi: ExtensionAPI) {
  let toolRegistered = false;

  /** Register the tool once; pi has no unregister API. */
  const registerAdvisorTool = () => {
    if (toolRegistered) return;
    toolRegistered = true;
    pi.registerTool({
      name: ADVISOR_TOOL_NAME,
      label: "Advisor",
      description: ADVISOR_TOOL_DESCRIPTION,
      promptSnippet: ADVISOR_PROMPT_SNIPPET,
      promptGuidelines: ADVISOR_PROMPT_GUIDELINES,
      parameters: Type.Object({}),

      async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
        const settings = loadAdvisorSettings();
        const details = {
          model: advisorModelKey(settings),
          effort: settings.effort,
          durationMs: 0,
          truncated: false,
        };

        if (!settings.enabled) {
          return {
            content: [
              {
                type: "text" as const,
                text: "The advisor is disabled — run /advisor to pick a model, or ask the user to enable it.",
              },
            ],
            details,
          };
        }

        const deps = makeConsultDeps(ctx.modelRegistry);
        const transcript = serializeAdvisorTranscript(
          ctx.sessionManager.buildContextEntries(),
        );
        const result = await consultAdvisor({
          deps,
          settings,
          transcript,
          signal,
        });

        return {
          content: [{ type: "text" as const, text: result.advice }],
          details: {
            ...details,
            durationMs: result.durationMs,
            truncated: result.truncated,
          },
        };
      },

      renderCall(args, theme, _context) {
        const settings = loadAdvisorSettings();
        let text = theme.fg("toolTitle", theme.bold("advisor "));
        text += theme.fg(
          "muted",
          settings.enabled ? advisorModelKey(settings) : "(disabled)",
        );
        return new Text(text, 0, 0);
      },

      renderResult(result, _options, theme, _context) {
        const details = result.details as
          | {
              model?: string;
              effort?: string;
              durationMs?: number;
              truncated?: boolean;
            }
          | undefined;
        const first = result.content[0];
        const advice = first?.type === "text" ? first.text : "";
        if (!advice) return new Text("", 0, 0);

        const meta: string[] = [];
        if (details?.model) meta.push(details.model);
        if (details?.effort) meta.push(details.effort);
        if (typeof details?.durationMs === "number") {
          meta.push(`${(details.durationMs / 1000).toFixed(1)}s`);
        }
        const header =
          meta.length > 0 ? `${theme.fg("dim", meta.join(" · "))}\n` : "";
        const truncated = details?.truncated
          ? `\n${theme.fg("warning", "[advice truncated]")}`
          : "";
        return new Text(header + advice + truncated, 0, 0);
      },
    });
  };

  /**
   * Make the advisor tool visible to the agent (and its prompting present in
   * the system prompt) or hide it, per the current settings.
   */
  const syncAdvisorTool = (enabled: boolean) => {
    if (enabled) {
      registerAdvisorTool();
      if (!pi.getActiveTools().includes(ADVISOR_TOOL_NAME)) {
        pi.setActiveTools([...pi.getActiveTools(), ADVISOR_TOOL_NAME]);
      }
    } else {
      pi.setActiveTools(
        pi.getActiveTools().filter((name) => name !== ADVISOR_TOOL_NAME),
      );
    }
  };

  // Only register the tool when enabled, so the "when to call advisor"
  // prompting stays out of the system prompt while it is disabled.
  if (loadAdvisorSettings().enabled) {
    registerAdvisorTool();
  }

  // A tool registered earlier in this process stays in the registry for
  // sessions created later (extension tools are auto-activated), so re-check
  // the settings at every session start.
  pi.on("session_start", () => {
    syncAdvisorTool(loadAdvisorSettings().enabled);
  });

  pi.registerCommand("advisor", {
    description:
      "Configure the advisor: a stronger model the agent can consult mid-turn",
    getArgumentCompletions: (prefix) =>
      ["on", "off", "status"]
        .filter((word) => word.startsWith(prefix))
        .map((word) => ({ value: word, label: word })),
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();

      if (arg === "") {
        if (ctx.mode === "tui") {
          await openAdvisorPicker(ctx, syncAdvisorTool);
        } else {
          const settings = loadAdvisorSettings();
          const status = settings.enabled
            ? `enabled · ${advisorModelKey(settings)} · ${settings.effort}`
            : "disabled";
          ctx.ui.notify(`Advisor: ${status}`, "info");
        }
        return;
      }

      const current = loadAdvisorSettings();
      if (arg === "on" || arg === "off" || arg === "status") {
        let updated = current;
        if (arg === "on") updated = { ...current, enabled: true };
        if (arg === "off") updated = { ...current, enabled: false };
        if (arg !== "status") {
          try {
            await saveAdvisorSettings(updated);
          } catch {
            ctx.ui.notify("Could not save the advisor config.", "error");
            return;
          }
          syncAdvisorTool(updated.enabled);
        }
        ctx.ui.notify(
          `Advisor ${arg}: ${
            updated.enabled
              ? `${advisorModelKey(updated)} · ${updated.effort}`
              : "disabled"
          }`,
          "info",
        );
        return;
      }

      const resolved = resolveModelKey(ctx, arg);
      if (!resolved) {
        ctx.ui.notify(
          `"${arg}" is not an available model. Run /advisor with no arguments to pick one.`,
          "warning",
        );
        return;
      }

      let effort = current.effort;
      const model = ctx.modelRegistry.find(resolved.provider, resolved.model);
      if (model && ctx.mode === "tui") {
        const picked = await pickEffort(ctx, model, current.effort);
        if (!picked) return;
        effort = picked;
      }

      const updated: AdvisorSettings = {
        ...current,
        enabled: true,
        provider: resolved.provider,
        model: resolved.model,
        effort,
      };
      try {
        await saveAdvisorSettings(updated);
      } catch {
        ctx.ui.notify("Could not save the advisor config.", "error");
        return;
      }
      syncAdvisorTool(true);
      ctx.ui.notify(
        `Advisor: ${advisorModelKey(resolved)} · ${effort}`,
        "info",
      );
    },
  });
}
