/**
 * Subagents — spawn background subagents on one of two backends
 * (pi, Claude Code) unified behind a single Effect service interface.
 *
 * Tools (for the parent LLM):
 * - subagent_spawn: fire-and-forget spawn (prompt, title, agent, working_dir,
 *   model, reasoning_effort). Max 50 running at once across all backends.
 * - subagent_wait: block until the listed subagents settle, return results.
 * - subagent_cancel: stop one or more running subagents.
 * - subagent_check: peek at a subagent's status and recent activity.
 * - subagent_list: list all subagents.
 *
 * Unawaited subagents queue their result as a follow-up message when they
 * settle. `/subagents` opens a picker + full interactive takeover view.
 *
 * Architecture: Effect v4 generators throughout (backends -> manager ->
 * runtime); this file is the async boundary where tool handlers run effects
 * against one shared ManagedRuntime. pi runs in-process SDK sessions; claude
 * drives the Claude Agent SDK.
 *
 * Both harnesses default to the models set by /subagent-model, and a cost
 * ceiling keeps agent-chosen models off the expensive tier.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  buildSessionContext,
  formatSize,
  getAgentDir,
  getMarkdownTheme,
  keyHint,
  ProjectTrustStore,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  Text,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  type TUI,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  loadSubagentModels,
  saveSubagentModels,
  type SubagentModels,
} from "../shared/subagent-models.ts";
import {
  deriveBtwTitle,
  isModelVisible,
  BTW_PROMPT_PREFIX,
} from "./src/by-the-way.ts";
import {
  findFocusedComponent,
  isDefaultEditorFocused,
} from "./src/ui/focus.ts";
import {
  pickClaudeEffort,
  pickClaudeModel,
  pickHarness,
  pickPiEffort,
  pickPiModel,
} from "./src/ui/model-picker.ts";
import {
  BACKEND_NAMES,
  formatElapsed,
  latestText,
  REASONING_EFFORTS,
  type SubagentSnapshot,
} from "./src/domain.ts";
import { formatContextUtilization } from "./src/format.ts";
import {
  SubagentManager,
  type SubagentManagerShape,
  type SubagentReadModel,
} from "./src/manager.ts";
import {
  buildSubagentResultMessage,
  buildSubagentSpawnResult,
  SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CANCEL_TOOL_DESCRIPTION,
  SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CHECK_TOOL_DESCRIPTION,
  SUBAGENT_LIST_TOOL_DESCRIPTION,
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_PROMPT_SNIPPET,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
  SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS,
  SUBAGENT_WAIT_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import { createDeferredResultDelivery } from "./src/result-delivery.ts";
import {
  createSubagentRuntime,
  runTool,
  type SubagentRuntime,
} from "./src/runtime.ts";
import { openBtwPanel } from "./src/ui/btw-panel.ts";
import { openSubagentPicker, openSubagentTakeover } from "./src/ui/takeover.ts";
import {
  createTaskRail,
  TaskRailController,
  visibleRailSubagents,
} from "./src/ui/task-rail.ts";

const SUBAGENT_OUTPUT_MAX_BYTES = 24 * 1024;
const WAIT_OUTPUT_MAX_BYTES = 48 * 1024;
const WAIT_PER_AGENT_MAX_BYTES = 16 * 1024;
// The follow-up result message keeps only this much of the output in the
// model's context; the full text renders from details on expand.
const RESULT_PREVIEW_MAX_BYTES = 2 * 1024;
const RESULT_PREVIEW_MAX_LINES = 16;

interface BtwResultData {
  readonly id: string;
  readonly title: string;
  readonly status: SubagentSnapshot["status"];
  readonly errorText?: string;
  readonly prompt: string;
  readonly answer: string;
  readonly sessionFilePath?: string;
}

interface SubagentResultDetails {
  readonly id: string;
  readonly title: string;
  readonly status: SubagentSnapshot["status"];
  readonly errorText?: string;
  readonly fullOutput: string;
  readonly sessionFilePath?: string;
}

function describeSubagent(snap: SubagentSnapshot) {
  const details = [
    `${snap.backend}: ${snap.meta.modelLabel ?? "?"}`,
    formatContextUtilization(snap.usage),
    formatElapsed(snap),
    snap.cwd,
  ].filter(Boolean);
  return `${snap.id} [${snap.status}] "${snap.title}" (${details.join(", ")})`;
}

function truncatedOutput(
  snap: SubagentSnapshot,
  maxBytes = SUBAGENT_OUTPUT_MAX_BYTES,
): string {
  const output = snap.finalText || "(no output)";
  const truncation = truncateHead(output, {
    maxBytes: Math.min(maxBytes, DEFAULT_MAX_BYTES),
    maxLines: Math.min(600, DEFAULT_MAX_LINES),
  });
  let text = truncation.content;
  if (truncation.truncated) {
    text += `\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} shown. Full transcript in session file: ${snap.meta.sessionFilePath ?? "?"}]`;
  }
  return text;
}

/**
 * Same-directory children inherit the live parent decision. An alternate cwd
 * is trusted only when pi's persisted trust store explicitly trusts it (or a
 * containing directory); unreadable/invalid trust data fails closed.
 */
function resolveChildProjectTrust(options: {
  parentCwd: string;
  childCwd: string;
  parentTrusted: boolean;
}) {
  if (path.resolve(options.childCwd) === path.resolve(options.parentCwd)) {
    return options.parentTrusted;
  }
  try {
    const trustStore = new ProjectTrustStore(getAgentDir());
    return trustStore.get(options.childCwd) === true;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  let runtime: SubagentRuntime | undefined;
  let managerPromise: Promise<SubagentManagerShape> | undefined;
  let sessionContext: ExtensionContext | undefined;
  let ui: ExtensionUIContext | undefined;
  let rawInputUnsubscribe: (() => void) | undefined;
  let taskRailContext: ExtensionContext | undefined;
  let taskRailView: SubagentReadModel | undefined;
  // TUI instance, captured from the task-rail widget factory (it is invoked
  // synchronously on setWidget). Used to check focus before grabbing keys.
  let taskRailTui: TUI | undefined;
  let openingTaskRailSession = false;
  // Timestamp (ms) of the last down-arrow tap while the rail is collapsed;
  // 0 means no pending tap. The rail opens on a down double-tap.
  let lastDownTapAt = 0;
  const DOUBLE_TAP_MS = 500;
  const taskRail = new TaskRailController();
  const resultDelivery = createDeferredResultDelivery<SubagentSnapshot>();

  const getRuntime = () => (runtime ??= createSubagentRuntime());

  /** Resolve the manager service once per runtime and wire the extension hooks. */
  const getManager = () => {
    managerPromise ??= getRuntime()
      .runPromise(SubagentManager)
      .then((manager) => {
        manager.view.setOnSettled(onSettled);
        taskRailView = manager.view;
        refreshTaskRail();
        return manager;
      });
    return managerPromise;
  };

  const deliverResult = (snap: SubagentSnapshot) => {
    const source = snap.finalText || "(no output)";
    const preview = truncateHead(source, {
      maxBytes: RESULT_PREVIEW_MAX_BYTES,
      maxLines: RESULT_PREVIEW_MAX_LINES,
    });
    pi.sendMessage(
      {
        customType: "subagent-result",
        content: buildSubagentResultMessage({
          id: snap.id,
          title: snap.title,
          status: snap.status,
          errorText: snap.errorText,
          preview: preview.content,
          sizeLabel: formatSize(Buffer.byteLength(source, "utf8")),
        }),
        display: true,
        details: {
          id: snap.id,
          title: snap.title,
          status: snap.status,
          errorText: snap.errorText,
          fullOutput: truncatedOutput(snap),
          sessionFilePath: snap.meta.sessionFilePath,
        } satisfies SubagentResultDetails,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  const flushResults = () => {
    for (const snap of resultDelivery.drain()) deliverResult(snap);
  };

  const deliverBtwResult = (snap: SubagentSnapshot) => {
    // appendEntry is a synchronous SessionManager operation and emits an
    // entry_appended event, so it is safe while the parent is streaming and
    // never enters the model's context or follow-up queue.
    pi.appendEntry<BtwResultData>("btw-result", {
      id: snap.id,
      title: snap.title,
      status: snap.status,
      errorText: snap.errorText,
      prompt: snap.prompt,
      answer: truncatedOutput(snap),
      sessionFilePath: snap.meta.sessionFilePath,
    });
    ui?.notify(
      snap.status === "error"
        ? `by the way “${snap.title}” failed — reopen it with /btw`
        : `by the way “${snap.title}” answered — reopen it with /btw`,
      snap.status === "error" ? "error" : "info",
    );
  };

  const onSettled = (snap: SubagentSnapshot, consumed: boolean) => {
    // A shutdown can settle children while disposing their scopes. Never
    // append into a session whose extension runtime is already closing.
    if (!sessionContext) return;
    if (snap.origin === "btw") {
      deliverBtwResult({ ...snap, meta: { ...snap.meta } });
      return;
    }
    if (consumed) {
      resultDelivery.consume([snap.id]);
      return;
    }
    // Keep the result retractable while the parent is working. A later
    // subagent_wait can consume it before agent_settled flushes follow-ups.
    // Defer a copy: the live snapshot keeps mutating if the subagent is
    // restarted before the deferred result flushes.
    resultDelivery.defer({ ...snap, meta: { ...snap.meta } });
    if (sessionContext?.isIdle()) flushResults();
  };

  const refreshTaskRail = () => {
    const context = taskRailContext;
    if (!context?.hasUI) return;
    context.ui.setWidget(
      "subagent-task-rail",
      taskRailView
        ? (tui, theme) => {
            taskRailTui = tui;
            return createTaskRail(taskRailView!, taskRail, theme, () =>
              tui.requestRender(),
            );
          }
        : undefined,
      { placement: "belowEditor" },
    );
  };

  /**
   * True when TUI focus sits on the default editor — the plain editor view
   * with no modal open. The down-double-tap gesture that opens the task rail
   * must only fire there: while a modal (model selector, settings, extension
   * dialogs, overlays) has focus, down/up/enter belong to that component.
   */
  const isDefaultEditorView = () =>
    taskRailTui !== undefined &&
    isDefaultEditorFocused(findFocusedComponent(taskRailTui));

  const openTaskRailSelection = async () => {
    if (openingTaskRailSession || !taskRailContext) return;
    const manager = await getManager();
    const selected = visibleRailSubagents(manager.view, taskRail).find(
      (snap) => snap.id === taskRail.selectedId,
    );
    if (!selected) return;
    openingTaskRailSession = true;
    try {
      await openSubagentTakeover(taskRailContext, manager.view, selected.id);
    } finally {
      openingTaskRailSession = false;
    }
  };

  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx;
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    ui = ctx.ui;
    taskRailContext = ctx;
    refreshTaskRail();
    rawInputUnsubscribe?.();
    rawInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
      if (openingTaskRailSession) return undefined;
      // Kitty protocol (flag 2) emits key release events that matchesKey()
      // treats like presses. Drop them or every keypress is handled twice.
      if (isKeyRelease(data)) return undefined;
      // The gesture only owns keys from the default editor view. In any
      // modal, down/up/enter must fall through to the focused component —
      // and a down tap inside a modal must not seed a double-tap back in
      // the editor.
      if (!isDefaultEditorView()) {
        lastDownTapAt = 0;
        return undefined;
      }
      const view = taskRailView;
      if (!view) return undefined;
      if (ctx.ui.getEditorText().trim()) return undefined;
      const all = view.list().filter((snap) => snap.origin === "model");
      const totalRunning = all.filter(
        (snap) => snap.status === "running",
      ).length;
      const totalFinished = all.length - totalRunning;
      const visible = visibleRailSubagents(view, taskRail);
      if (visible.length === 0 && totalFinished === 0) return undefined;
      if (matchesKey(data, "enter") && taskRail.expanded) {
        void openTaskRailSelection();
        return { consume: true };
      }
      if (taskRail.expanded && matchesKey(data, "up")) {
        if (visible.length === 0) {
          taskRail.reset();
        } else if (taskRail.move(visible, -1) === "atTop") {
          taskRail.reset();
        }
        return { consume: true };
      }
      if (!matchesKey(data, "down")) {
        lastDownTapAt = 0;
        return undefined;
      }
      if (taskRail.expanded) {
        lastDownTapAt = 0;
        if (visible.length === 0) {
          // Expanded rail with nothing visible (e.g. toggled finished off with
          // no running); the next meaningful state is to show finished again.
          if (totalFinished > 0) taskRail.revealFinished();
          return { consume: true };
        }
        if (taskRail.move(visible, 1) === "atBottom" && totalFinished > 0) {
          // Bottom of the running list — don't wrap; instead surface the
          // finished subagents from earlier in the session for ↓ to step into.
          taskRail.revealFinished();
        }
        return { consume: true };
      }
      // Collapsed: open on a down double-tap within DOUBLE_TAP_MS. Swallow
      // the first tap so it doesn't fall through to the editor. Held-key
      // repeats are not taps — consume them without counting.
      if (isKeyRepeat(data)) return { consume: true };
      const now = Date.now();
      const doubleTap = now - lastDownTapAt <= DOUBLE_TAP_MS;
      lastDownTapAt = now;
      if (!doubleTap) return { consume: true };
      lastDownTapAt = 0;
      taskRail.toggleExpanded();
      // No running subagents: open straight to the finished list so the
      // down-twice gesture lands on real content instead of an empty rail.
      if (totalRunning === 0 && totalFinished > 0) taskRail.revealFinished();
      return { consume: true };
    });
  });

  pi.on("agent_settled", flushResults);

  pi.on("session_shutdown", async () => {
    sessionContext = undefined;
    taskRailContext?.ui.setWidget("subagent-task-rail", undefined);
    taskRailContext = undefined;
    taskRailView = undefined;
    taskRailTui = undefined;
    rawInputUnsubscribe?.();
    rawInputUnsubscribe = undefined;
    taskRail.reset();
    resultDelivery.clear();
    ui = undefined;
    const closing = runtime;
    runtime = undefined;
    managerPromise = undefined;
    // Disposing the runtime runs the manager finalizer, which tears down all
    // subagent scopes (and, later, their real child processes).
    await closing?.dispose();
  });

  // --- Tools -------------------------------------------------------------

  const spawnParameters = Type.Object({
    prompt: Type.String({
      description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.prompt,
    }),
    name: Type.String({
      description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.name,
    }),
    harness: StringEnum(BACKEND_NAMES, {
      description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.harness,
    }),
    working_dir: Type.Optional(
      Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.workingDir,
      }),
    ),
    model: Type.Optional(
      Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.model,
      }),
    ),
    reasoning_effort: Type.Optional(
      StringEnum(REASONING_EFFORTS, {
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.reasoningEffort,
      }),
    ),
  });

  interface SpawnDetails {
    id: string;
    title: string;
    cwd: string;
    harness: string;
    model: string | undefined;
  }

  pi.registerTool<typeof spawnParameters, SpawnDetails>({
    name: "subagent_spawn",
    label: "Spawn Subagent",
    description: SUBAGENT_SPAWN_TOOL_DESCRIPTION,
    promptSnippet: SUBAGENT_SPAWN_PROMPT_SNIPPET,
    promptGuidelines: SUBAGENT_SPAWN_PROMPT_GUIDELINES,
    parameters: spawnParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const manager = await getManager();
      const harness = params.harness;

      const cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`working_dir is not a directory: ${cwd}`);
      }

      const title = params.name.trim().slice(0, 160) || "subagent";
      const snap = await runTool(
        getRuntime(),
        manager.spawn(harness, {
          prompt: params.prompt,
          title,
          cwd,
          model: params.model,
          reasoningEffort: params.reasoning_effort,
          parent: {
            parentCwd: ctx.cwd,
            projectTrusted: resolveChildProjectTrust({
              parentCwd: ctx.cwd,
              childCwd: cwd,
              parentTrusted: ctx.isProjectTrusted(),
            }),
            modelRegistry: ctx.modelRegistry,
          },
        }),
        { signal, interruptMessage: "Subagent spawn aborted." },
      );

      return {
        content: [
          {
            type: "text",
            text: buildSubagentSpawnResult({
              id: snap.id,
              title: snap.title,
              harness,
              modelLabel: snap.meta.modelLabel ?? "?",
              cwd,
            }),
          },
        ],
        details: {
          id: snap.id,
          title: snap.title,
          cwd,
          harness,
          model: snap.meta.modelLabel,
        },
      };
    },
    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      let content = theme.fg("toolTitle", theme.bold("subagent_spawn"));
      if (args.name) content += " " + theme.fg("dim", `"${args.name}"`);
      if (args.harness) content += " " + theme.fg("muted", `· ${args.harness}`);
      text.setText(content);
      return text;
    },
    renderResult(result, { expanded }, theme, context) {
      if (context.isError || !result.details) {
        const msg =
          result.content[0]?.type === "text"
            ? result.content[0].text
            : "spawn failed";
        return new Text(theme.fg("error", msg), 0, 0);
      }
      const d = result.details;
      let text =
        theme.fg("success", "⏵ ") +
        theme.fg("accent", d.id) +
        theme.fg("dim", ` · ${d.harness} · ${d.model ?? "?"}`);
      if (expanded) {
        text += "\n" + theme.fg("dim", `  cwd: ${d.cwd}`);
      } else {
        text += theme.fg(
          "dim",
          ` (${keyHint("app.tools.expand", "to expand")})`,
        );
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Subagents",
    description: SUBAGENT_WAIT_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        maxItems: 64,
        description: SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");
      const known = manager.view
        .list()
        .filter(isModelVisible)
        .map((snap) => snap.id);
      const unknown = ids.filter((id) => {
        const snap = manager.view.get(id);
        return !snap || !isModelVisible(snap);
      });
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      await runTool(
        getRuntime(),
        manager.waitFor(ids, (pending) => {
          onUpdate?.({
            content: [
              { type: "text", text: `Waiting for ${pending.join(", ")}...` },
            ],
            details: { pending },
          });
        }),
        { signal, interruptMessage: "Wait aborted. Subagents keep running." },
      );

      // Settlement may have happened before this wait began. Remove any
      // deferred automatic delivery now that the tool is returning the result.
      resultDelivery.consume(ids);

      const sections: string[] = [];
      let remainingBytes = WAIT_OUTPUT_MAX_BYTES;
      for (const id of ids) {
        const snap = manager.view.get(id);
        if (!snap) {
          sections.push(`## ${id}\n\n(no longer tracked)`);
          continue;
        }
        const verb = snap.status === "error" ? "failed" : "finished";
        let section = `## ${snap.id} "${snap.title}" ${verb}`;
        if (snap.errorText) section += `\nError: ${snap.errorText}`;
        const headerBytes = Buffer.byteLength(section, "utf8") + 2;
        const outputBudget = Math.max(
          512,
          Math.min(WAIT_PER_AGENT_MAX_BYTES, remainingBytes - headerBytes),
        );
        section += `\n\n${truncatedOutput(snap, outputBudget)}`;
        const sectionBytes = Buffer.byteLength(section, "utf8");
        if (sectionBytes > remainingBytes) {
          sections.push(
            `## ${snap.id} "${snap.title}"\n\n[omitted: total wait output limit reached]`,
          );
          break;
        }
        sections.push(section);
        remainingBytes -= sectionBytes;
      }

      const combined = sections.join("\n\n---\n\n");
      const bounded = truncateHead(combined, {
        maxBytes: WAIT_OUTPUT_MAX_BYTES - 128,
        maxLines: DEFAULT_MAX_LINES,
      });
      const text = bounded.truncated
        ? `${bounded.content}\n\n[wait output truncated at the total output limit]`
        : bounded.content;
      return {
        content: [{ type: "text", text }],
        details: {
          results: ids.map((id) => {
            const snap = manager.view.get(id);
            return { id, title: snap?.title, status: snap?.status };
          }),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel Subagents",
    description: SUBAGENT_CANCEL_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        description: SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");

      const known = manager.view
        .list()
        .filter(isModelVisible)
        .map((snap) => snap.id);
      const unknown = ids.filter((id) => {
        const snap = manager.view.get(id);
        return !snap || !isModelVisible(snap);
      });
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      const report = await runTool(getRuntime(), manager.cancel(ids), {
        signal,
        interruptMessage: "Subagent cancellation aborted.",
      });

      const lines = report.map((entry) =>
        entry.cancelled
          ? `Cancelled ${entry.id} "${entry.title}".`
          : `${entry.id} "${entry.title}" was already ${entry.status}.`,
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          results: report.map((entry) => ({
            id: entry.id,
            title: entry.title,
            status: entry.status,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_check",
    label: "Check Subagent",
    description: SUBAGENT_CHECK_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        description: SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS.id,
      }),
    }),
    async execute(_toolCallId, params) {
      const manager = await getManager();
      const snap = manager.view.get(params.id);
      if (!snap || !isModelVisible(snap)) {
        const known = manager.view
          .list()
          .filter(isModelVisible)
          .map((s) => s.id);
        throw new Error(
          `Unknown subagent id "${params.id}". Known: ${known.join(", ") || "none"}.`,
        );
      }

      let text = `${describeSubagent(snap)}\nTurns: ${snap.turns}`;
      if (snap.errorText) text += `\nError: ${snap.errorText}`;

      const output = latestText(snap);
      if (output) {
        const preview = truncateHead(output, { maxBytes: 2048, maxLines: 20 });
        text += `\n\nLatest output:\n${preview.content}`;
        if (preview.truncated) text += "\n[...]";
      } else if (snap.status === "running") {
        text += "\n\n(no text output yet)";
      }

      return {
        content: [{ type: "text", text }],
        details: { id: snap.id, status: snap.status, turns: snap.turns },
      };
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List Subagents",
    description: SUBAGENT_LIST_TOOL_DESCRIPTION,
    parameters: Type.Object({}),
    async execute() {
      const manager = await getManager();
      const subs = manager.view.list().filter(isModelVisible);
      const text =
        subs.length === 0
          ? "No subagents."
          : subs.map((snap) => describeSubagent(snap)).join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          subagents: subs.map((snap) => ({
            id: snap.id,
            title: snap.title,
            harness: snap.backend,
            status: snap.status,
          })),
        },
      };
    },
  });

  // --- Result message rendering ------------------------------------------

  pi.registerMessageRenderer(
    "subagent-result",
    (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as Partial<SubagentResultDetails>;
      const failed = details.status === "error";
      const icon = failed ? theme.fg("error", "x") : theme.fg("success", "■");
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`subagent ${details.id ?? "?"}`)) +
        theme.fg(
          "muted",
          ` · ${details.title ?? ""} · ${failed ? "failed" : "finished"}`,
        );

      const content =
        typeof message.content === "string" ? message.content : "";
      // Remove the summary line and the model-facing pointer line ("[Preview of
      // the …]"). The following Error line (when present) is part of the
      // actual result and must remain visible.
      const body = content
        .split("\n")
        .slice(1)
        .filter((line) => !line.startsWith("[Preview of the "))
        .join("\n")
        .trim();

      if (expanded) {
        // The full output lives in details so it never enters the model
        // context; entries persisted before that split fall back to the body.
        const full = [
          details.errorText ? `Error: ${details.errorText}` : "",
          details.fullOutput ?? body,
        ]
          .filter(Boolean)
          .join("\n\n");
        const md = new Markdown(`${full}`, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      const previewLines = body.split("\n").slice(0, 8);
      let text = header;
      for (const line of previewLines)
        text += `\n${theme.fg("toolOutput", line)}`;
      if (body.split("\n").length > 8)
        text += `\n${theme.fg("dim", "... (ctrl+o to expand)")}`;
      return new Text(text, 0, 0);
    },
  );

  pi.registerEntryRenderer<BtwResultData>(
    "btw-result",
    (entry, { expanded }, theme) => {
      const data = entry.data;
      const failed = data?.status === "error";
      const icon = failed ? theme.fg("error", "x") : theme.fg("success", "■");
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`by the way · ${data?.title ?? "?"}`)) +
        theme.fg(
          "muted",
          ` · ${failed ? "failed" : "answered"} · ${data?.id ?? "?"}`,
        );
      const body = [
        data?.errorText ? `Error: ${data.errorText}` : "",
        data?.answer ?? "(no answer)",
      ]
        .filter(Boolean)
        .join("\n\n");

      if (expanded) {
        const md = new Markdown(body, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      // Collapsed: keep the transcript to a header + hint. The answer itself
      // is read in the /btw panel, or inline by expanding.
      return new Text(
        `${header}\n${theme.fg("dim", `  /btw to reopen · ${keyHint("app.tools.expand", "to read inline")}`)}`,
        0,
        0,
      );
    },
  );

  // --- Commands -----------------------------------------------------------

  const runByTheWay = async (rawArgs: string, ctx: ExtensionCommandContext) => {
    if (ctx.mode !== "tui") {
      if (ctx.hasUI)
        ctx.ui.notify("by the way is only available in the TUI", "error");
      return;
    }

    const manager = await getManager();
    const askPrompt = async () =>
      (await ctx.ui.input("by the way", "Ask a one-off question…"))?.trim() ??
      "";

    let prompt = rawArgs.trim();
    // The panel is the single btw surface: past asides listed above the
    // selected aside's answer, ←/→ switches between them, `n` asks a new
    // question. askNext skips the panel when it just closed with `n`.
    let askNext = false;
    while (true) {
      if (!prompt) {
        const hasHistory = manager.view
          .list()
          .some((snap) => snap.origin === "btw");
        if (hasHistory && !askNext) {
          const action = await openBtwPanel(ctx, manager.view);
          if (action === null) return;
        }
        prompt = await askPrompt();
        askNext = false;
        // Cancelled input: back to the panel, or out when there is no
        // history to revisit.
        if (!prompt) {
          if (!hasHistory) return;
          continue;
        }
      }

      const title = deriveBtwTitle(prompt);
      // Snapshot the parent conversation at spawn time. The snapshot is
      // synchronous (two adjacent reads, no awaits between them) and entries
      // are append-only, so it is race-free even while the parent is
      // streaming: an in-flight assistant message is only persisted on its
      // message_end, so the snapshot covers everything up to the parent's last
      // completed message — the same cut Claude Code applies to side questions.
      const contextMessages = buildSessionContext(
        ctx.sessionManager.getEntries(),
        ctx.sessionManager.getLeafId(),
      ).messages;
      try {
        await runTool(
          getRuntime(),
          manager.spawn("pi", {
            origin: "btw",
            // The child has no tools (see backends/pi.ts noTools); the prefix
            // keeps it from reasoning about tool use it cannot perform.
            prompt: `${BTW_PROMPT_PREFIX}\n\n${prompt}`,
            title,
            cwd: ctx.cwd,
            parent: {
              parentCwd: ctx.cwd,
              projectTrusted: ctx.isProjectTrusted(),
              modelRegistry: ctx.modelRegistry,
              contextMessages,
            },
          }),
        );
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
        return;
      }
      prompt = "";

      // Reopen the panel on the new aside (newest is selected by default);
      // `n` loops back for another question.
      const action = await openBtwPanel(ctx, manager.view);
      if (action !== "new") return;
      askNext = true;
    }
  };

  pi.registerCommand("btw", {
    description:
      "Ask a one-off side question, or revisit earlier answers from the popup",
    handler: runByTheWay,
  });

  pi.registerCommand("subagents", {
    description: "List, inspect, and take over subagents",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI)
          ctx.ui.notify(
            "Subagent takeover is only available in the TUI",
            "error",
          );
        return;
      }
      const manager = await getManager();
      if (manager.view.list().filter(isModelVisible).length === 0) {
        ctx.ui.notify(
          "No subagents yet. The agent spawns them with subagent_spawn.",
          "info",
        );
        return;
      }
      await openSubagentPicker(ctx, manager.view);
    },
  });

  pi.registerCommand("subagent-model", {
    description:
      "Choose the default model and effort for each subagent harness",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI)
          ctx.ui.notify(
            "Subagent model selection is only available in the TUI",
            "error",
          );
        return;
      }

      const current = loadSubagentModels();
      const harness = await pickHarness(ctx, current);
      if (!harness) return;

      let updated: SubagentModels;
      if (harness === "pi") {
        const model = await pickPiModel(ctx);
        if (!model) return;
        const effort = await pickPiEffort(ctx, model, current.pi.effort);
        if (!effort) return;
        updated = {
          ...current,
          pi: { provider: model.provider, model: model.id, effort },
        };
      } else {
        const model = await pickClaudeModel(ctx);
        if (!model) return;
        const effort = await pickClaudeEffort(ctx);
        if (!effort) return;
        updated = { ...current, claude: { model, effort } };
      }

      try {
        await saveSubagentModels(updated);
      } catch {
        ctx.ui.notify("Could not save the subagent model defaults.", "error");
        return;
      }

      const chosen =
        harness === "pi"
          ? `${updated.pi.provider}/${updated.pi.model} · ${updated.pi.effort}`
          : `${updated.claude.model} · ${updated.claude.effort}`;
      ctx.ui.notify(`Default ${harness} subagent: ${chosen}`, "info");
    },
  });
}
