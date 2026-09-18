/**
 * Subagents — spawn background subagents on one of two backends
 * (pi, Claude Code) unified behind a single Effect service interface.
 *
 * Tools (for the parent LLM):
 * - subagent_spawn: spawn on a semantic delegation tier (or an explicit
 *   harness/model/effort override); description, prompt, optional name,
 *   working_dir, run_in_background, harness, model, reasoning_effort.
 *   Max 50 running at once across all backends.
 * - subagent_cancel: stop one or more running subagents.
 * - subagent_check: non-blocking pull — a settled agent returns its full
 *   hand-back report, a running one returns status and guidance.
 * - subagent_list: list all subagents.
 *
 * There is no blocking wait tool: the parent keeps working or ends its turn;
 * unawaited subagents queue their result as a follow-up message when they
 * settle. `/subagents` opens a picker + full interactive takeover view.
 *
 * Architecture: Effect v4 generators throughout (backends -> manager ->
 * runtime); this file is the async boundary where tool handlers run effects
 * against one shared ManagedRuntime. pi runs in-process SDK sessions; claude
 * drives the Claude Agent SDK.
 *
 * Each tier maps to a user-configured harness/model/effort in
 * shared/subagent-models.json; the cost ceiling (when set) applies only to a
 * model an agent picked for itself.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
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
  costCeiling,
  DELEGATION_TIERS,
  loadDelegationConfig,
  resolveDelegationTarget,
  saveDelegationConfig,
  type DelegationTier,
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
  pickEffort,
  pickTierConfig,
  tierTargetLabel,
} from "./src/ui/model-picker.ts";
import {
  BACKEND_NAMES,
  latestText,
  REASONING_EFFORTS,
  runRefOf,
  type SubagentRunRef,
  type SubagentSnapshot,
} from "./src/domain.ts";
import {
  SubagentManager,
  type SubagentManagerShape,
  type SubagentReadModel,
} from "./src/manager.ts";
import {
  buildSubagentCheckRunningNote,
  buildSubagentSpawnResult,
  delegationLabel,
  describeSubagent,
  SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CANCEL_TOOL_DESCRIPTION,
  SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CHECK_TOOL_DESCRIPTION,
  SUBAGENT_LIST_TOOL_DESCRIPTION,
  SUBAGENT_SEND_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SEND_TOOL_DESCRIPTION,
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_PROMPT_SNIPPET,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import { createDeferredResultDelivery } from "./src/result-delivery.ts";
import { buildHandback } from "./src/handback.ts";
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
const TOOL_OUTPUT_MAX_BYTES = 48 * 1024; // total budget for multi-report tool output (cancel)

interface BtwResultData {
  readonly id: string;
  readonly description: string;
  /** Legacy label from before the description rename. */
  readonly title?: string;
  readonly status: SubagentSnapshot["status"];
  readonly errorText?: string;
  readonly prompt: string;
  readonly answer: string;
  readonly sessionFilePath?: string;
}

interface SubagentResultDetails {
  readonly id: string;
  readonly description: string;
  /** Legacy label from before the description rename. */
  readonly title?: string;
  readonly status: SubagentSnapshot["status"];
  readonly errorText?: string;
  readonly fullOutput: string;
  readonly sessionFilePath?: string;
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

/** The one unknown/pruned-id error shared by wait, cancel, check, and send. */
function unknownSubagentError(
  ids: ReadonlyArray<string>,
  known: ReadonlyArray<string>,
): Error {
  const label =
    ids.length === 1 ? "Unknown subagent id" : "Unknown subagent ids";
  return new Error(
    `${label}: ${ids.join(", ")}. Known: ${known.join(", ") || "none"}.`,
  );
}

/** Drop the deferred delivery for the runs whose reports a tool is returning. */
export function consumeReturnedRuns(
  delivery: { consume(refs: Iterable<SubagentRunRef>): void },
  view: { get(id: string): { id: string; runSequence: number } | undefined },
  ids: ReadonlyArray<string>,
) {
  delivery.consume(
    ids.flatMap((id) => {
      const snap = view.get(id);
      return snap ? [runRefOf(snap)] : [];
    }),
  );
}

/** One framed hand-back per subagent, within the total output budget. */
function subagentOutputSections(
  view: SubagentReadModel,
  ids: ReadonlyArray<string>,
): string[] {
  const sections: string[] = [];
  let remainingBytes = TOOL_OUTPUT_MAX_BYTES;
  for (let index = 0; index < ids.length; index++) {
    const snap = view.get(ids[index]);
    if (!snap) continue; // unknown ids are rejected before this runs
    const section = buildHandback({
      snapshot: snap,
      output: snap.finalText,
    }).modelText;
    const sectionBytes = Buffer.byteLength(section, "utf8");
    if (sectionBytes > remainingBytes) {
      sections.push(
        `[omitted: total output limit reached; no report for ${ids.slice(index).join(", ")}]`,
      );
      break;
    }
    sections.push(section);
    remainingBytes -= sectionBytes;
  }
  return sections;
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
    const handback = buildHandback({
      snapshot: snap,
      output: snap.finalText,
    });
    pi.sendMessage(
      {
        customType: "subagent-result",
        content: handback.modelText,
        display: true,
        details: {
          id: snap.id,
          description: snap.description,
          status: snap.status,
          errorText: snap.errorText,
          fullOutput: handback.fullOutput,
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
      description: snap.description,
      status: snap.status,
      errorText: snap.errorText,
      prompt: snap.prompt,
      answer: truncatedOutput(snap),
      sessionFilePath: snap.meta.sessionFilePath,
    });
    // Success needs no toast: the btw-result row already says so. A status
    // line fired mid-turn strands mid-transcript as streaming continues.
    if (snap.status === "error")
      ui?.notify(
        `by the way “${snap.description}” failed — reopen it with /btw`,
        "error",
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
      resultDelivery.consume([runRefOf(snap)]);
      return;
    }
    // Keep the result retractable while the parent is working. A later
    // subagent_check can consume it before agent_settled flushes follow-ups.
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
        taskRail.clearTap();
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
        taskRail.clearTap();
        return undefined;
      }
      if (taskRail.expanded) {
        taskRail.clearTap();
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
      // Collapsed: open on a down double-tap within the controller's window.
      // A lone tap reaches normal editor navigation; a held-key repeat is
      // neither a tap nor an editor move.
      if (isKeyRepeat(data)) return { consume: true };
      if (!taskRail.handleCollapsedDown(Date.now())) return undefined;
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
    description: Type.String({
      maxLength: 200,
      description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.description,
    }),
    prompt: Type.String({
      description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.prompt,
    }),
    name: Type.Optional(
      Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.name,
      }),
    ),
    tier: Type.Optional(
      StringEnum(DELEGATION_TIERS, {
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.tier,
      }),
    ),
    working_dir: Type.Optional(
      Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.workingDir,
      }),
    ),
    run_in_background: Type.Optional(
      Type.Boolean({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.runInBackground,
      }),
    ),
    harness: Type.Optional(
      StringEnum(BACKEND_NAMES, {
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.harness,
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
    description: string;
    cwd: string;
    harness: string;
    tier: DelegationTier | "explicit";
    model: string | undefined;
    effort: string;
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
      const target = resolveDelegationTarget({
        config: loadDelegationConfig(),
        selection: {
          tier: params.tier,
          harness: params.harness,
          model: params.model,
          effort: params.reasoning_effort,
        },
        supportedHarnesses: BACKEND_NAMES,
      });

      const cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`working_dir is not a directory: ${cwd}`);
      }

      const background = params.run_in_background !== false;
      const snap = await runTool(
        getRuntime(),
        manager.spawn(
          target.harness,
          {
            prompt: params.prompt,
            description: params.description,
            name: params.name,
            cwd,
            target,
            model:
              target.harness === "claude"
                ? target.model
                : target.provider
                  ? `${target.provider}/${target.model}`
                  : target.model,
            reasoningEffort: target.effort,
            parent: {
              parentCwd: ctx.cwd,
              projectTrusted: resolveChildProjectTrust({
                parentCwd: ctx.cwd,
                childCwd: cwd,
                parentTrusted: ctx.isProjectTrusted(),
              }),
              modelRegistry: ctx.modelRegistry,
            },
          },
          { resultMode: background ? "automatic" : "claimed" },
        ),
        { signal, interruptMessage: "Subagent spawn aborted." },
      );

      const tier = snap.meta.tier ?? "explicit";
      const header = buildSubagentSpawnResult({
        id: snap.id,
        description: snap.description,
        tier,
        harness: snap.backend,
        modelLabel: snap.meta.modelLabel ?? "?",
        effort: target.effort,
        background,
      });
      const details: SpawnDetails = {
        id: snap.id,
        description: snap.description,
        cwd,
        harness: snap.backend,
        tier,
        model: snap.meta.modelLabel,
        effort: target.effort,
      };

      if (background) {
        return {
          content: [{ type: "text", text: header }],
          details,
        };
      }

      // Foreground: the initial run is claimed at spawn, so no automatic
      // follow-up is queued. Wait for that run, then return its hand-back; if
      // the wait aborts, release the claim and leave the child running.
      const run = runRefOf(snap);
      try {
        await runTool(getRuntime(), manager.waitForRun(run), {
          signal,
          interruptMessage: "Wait aborted. Subagent keeps running.",
        });
      } catch (error) {
        await runTool(getRuntime(), manager.releaseRun(run)).catch(
          () => undefined,
        );
        throw error;
      }
      const settled = manager.view.get(snap.id) ?? snap;
      const handback = buildHandback({
        snapshot: settled,
        output: settled.finalText,
      });
      return {
        content: [{ type: "text", text: `${header}\n\n${handback.modelText}` }],
        details,
      };
    },
    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      let content = theme.fg("toolTitle", theme.bold("subagent_spawn"));
      if (args.description)
        content += " " + theme.fg("dim", `"${args.description}"`);
      if (args.name) content += " " + theme.fg("muted", `· ${args.name}`);
      if (args.tier) content += " " + theme.fg("muted", `· ${args.tier}`);
      else if (args.harness)
        content += " " + theme.fg("muted", `· ${args.harness}`);
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
        theme.fg(
          "dim",
          ` · ${delegationLabel(d.tier)} · ${d.harness} · ${d.model ?? "?"}`,
        );
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
      if (unknown.length > 0) throw unknownSubagentError(unknown, known);

      const report = await runTool(getRuntime(), manager.cancel(ids), {
        signal,
        interruptMessage: "Subagent cancellation aborted.",
      });
      // The report covers each listed run, settled or just cancelled; drop any
      // deferred copy so it is not delivered again as a follow-up.
      consumeReturnedRuns(resultDelivery, manager.view, ids);

      const lines = report.map((entry) =>
        entry.cancelled
          ? `Cancelled ${entry.id} "${entry.description}".`
          : `${entry.id} "${entry.description}" was already ${entry.status}.`,
      );
      const sections = subagentOutputSections(manager.view, ids);

      return {
        content: [
          { type: "text", text: [lines.join("\n"), ...sections].join("\n\n") },
        ],
        details: {
          results: report.map((entry) => ({
            id: entry.id,
            description: entry.description,
            status: entry.status,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_send",
    label: "Send to Subagent",
    description: SUBAGENT_SEND_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        description: SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.id,
      }),
      message: Type.String({
        description: SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.message,
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const manager = await getManager();
      const snap = manager.view.get(params.id);
      if (!snap || !isModelVisible(snap)) {
        const known = manager.view
          .list()
          .filter(isModelVisible)
          .map((s) => s.id);
        throw unknownSubagentError([params.id], known);
      }
      const result = await runTool(
        getRuntime(),
        manager.send(params.id, params.message),
        { signal, interruptMessage: "Send aborted." },
      );
      const verb = result.restarted ? "Resumed" : "Steered";
      const tail = result.restarted
        ? " The result arrives the same way as a spawn."
        : "";
      return {
        content: [
          {
            type: "text",
            text: `${verb} ${params.id} (run ${result.run.runSequence}).${tail}`,
          },
        ],
        details: {
          id: params.id,
          runSequence: result.run.runSequence,
          restarted: result.restarted,
        },
      };
    },
  });

  interface CheckDetails {
    id: string;
    description: string;
    status: SubagentSnapshot["status"];
    turns: number;
    tier: DelegationTier | "explicit" | undefined;
  }

  pi.registerTool({
    name: "subagent_check",
    label: "Check Subagent",
    description: SUBAGENT_CHECK_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        description: SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS.id,
      }),
    }),
    async execute(_toolCallId, params): Promise<AgentToolResult<CheckDetails>> {
      const manager = await getManager();
      const snap = manager.view.get(params.id);
      if (!snap || !isModelVisible(snap)) {
        const known = manager.view
          .list()
          .filter(isModelVisible)
          .map((s) => s.id);
        throw unknownSubagentError([params.id], known);
      }

      if (snap.status !== "running") {
        // The report renders from the retained snapshot, so this is safe even
        // after the follow-up already flushed; consuming is idempotent and
        // prevents a second automatic delivery for a run checked on demand.
        consumeReturnedRuns(resultDelivery, manager.view, [snap.id]);
        const handback = buildHandback({
          snapshot: snap,
          output: snap.finalText,
        });
        return {
          content: [{ type: "text", text: handback.modelText }],
          details: {
            id: snap.id,
            description: snap.description,
            status: snap.status,
            turns: snap.turns,
            tier: snap.meta.tier,
          },
        };
      }

      let text = `${describeSubagent(snap)}\nTurns: ${snap.turns}`;
      if (snap.errorText) text += `\nError: ${snap.errorText}`;

      const output = latestText(snap);
      if (output) {
        const preview = truncateHead(output, { maxBytes: 2048, maxLines: 20 });
        text += `\n\nLatest output:\n${preview.content}`;
        if (preview.truncated) text += "\n[...]";
      } else {
        text += "\n\n(no text output yet)";
      }
      text += `\n\n${buildSubagentCheckRunningNote(snap)}`;

      return {
        content: [{ type: "text", text }],
        details: {
          id: snap.id,
          description: snap.description,
          status: snap.status,
          turns: snap.turns,
          tier: snap.meta.tier,
        },
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
            description: snap.description,
            harness: snap.backend,
            status: snap.status,
            tier: snap.meta.tier,
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
      const cancelled = details.status === "cancelled";
      const failed = details.status === "error";
      const icon = cancelled
        ? theme.fg("warning", "x")
        : failed
          ? theme.fg("error", "x")
          : theme.fg("success", "■");
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`subagent ${details.id ?? "?"}`)) +
        theme.fg(
          "muted",
          ` · ${details.description ?? details.title ?? ""} · ${cancelled ? "cancelled" : failed ? "failed" : "finished"}`,
        );

      const content =
        typeof message.content === "string" ? message.content : "";
      // The framed report lives in details; entries written before that split
      // fall back to the content body (summary line and old preview pointer
      // removed — the Error line stays, it is part of the result).
      const contentBody = content
        .split("\n")
        .slice(1)
        .filter((line) => !line.startsWith("[Preview of the "))
        .join("\n")
        .trim();
      const body = (details.fullOutput ?? contentBody).trim();

      if (expanded) {
        // The full output lives in details so it never enters the model
        // context; entries persisted before that split fall back to the body.
        const full = [
          details.errorText ? `Error: ${details.errorText}` : "",
          body,
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
      const cancelled = data?.status === "cancelled";
      const failed = data?.status === "error";
      const icon = cancelled
        ? theme.fg("warning", "x")
        : failed
          ? theme.fg("error", "x")
          : theme.fg("success", "■");
      const header =
        `${icon} ` +
        theme.fg(
          "accent",
          theme.bold(`by the way · ${data?.description ?? data?.title ?? "?"}`),
        ) +
        theme.fg(
          "muted",
          ` · ${cancelled ? "cancelled" : failed ? "failed" : "answered"} · ${data?.id ?? "?"}`,
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

      const description = deriveBtwTitle(prompt);
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
            description,
            cwd: ctx.cwd,
            target: resolveDelegationTarget({
              config: loadDelegationConfig(),
              selection: {},
              supportedHarnesses: ["pi"],
            }),
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
      "Choose the default model and effort for each subagent delegation tier",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI)
          ctx.ui.notify(
            "Subagent model selection is only available in the TUI",
            "error",
          );
        return;
      }

      const result = await pickTierConfig({
        config: loadDelegationConfig(),
        cwd: ctx.cwd,
        models: ctx.modelRegistry.getAvailable(),
        ceiling: costCeiling(),
        ui: {
          select: (title, options) => ctx.ui.select(title, [...options]),
          pickEffort: (options, current) => pickEffort(ctx, options, current),
          notify: (message, type) => ctx.ui.notify(message, type),
        },
      });
      if (!result) return;

      try {
        await saveDelegationConfig(result.config);
      } catch {
        ctx.ui.notify("Could not save the subagent model defaults.", "error");
        return;
      }

      ctx.ui.notify(
        `${result.tier} → ${tierTargetLabel(result.config, result.tier)}`,
        "info",
      );
    },
  });

  pi.registerCommand("subagent-cost", {
    description:
      "Set the output-price ceiling ($/Mtok) for models subagents pick themselves",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI)
          ctx.ui.notify(
            "Subagent cost ceiling selection is only available in the TUI",
            "error",
          );
        return;
      }

      const current = costCeiling();
      const raw = await ctx.ui.input(
        "Subagent cost ceiling ($/Mtok output, off to disable)",
        current === null ? "off" : `$${current}`,
      );
      if (raw === undefined) return;

      const trimmed = raw.trim().replace(/^\$/, "").toLowerCase();
      if (!trimmed) return;

      let ceiling: number | null;
      if (trimmed === "off") {
        ceiling = null;
      } else {
        const parsed = Number.parseFloat(trimmed);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          ctx.ui.notify('Enter a positive dollar amount or "off".', "error");
          return;
        }
        ceiling = parsed;
      }

      try {
        await saveDelegationConfig({
          ...loadDelegationConfig(),
          costCeiling: ceiling,
        });
      } catch {
        ctx.ui.notify("Could not save the subagent cost ceiling.", "error");
        return;
      }

      ctx.ui.notify(
        ceiling === null
          ? "Subagent cost ceiling: off"
          : `Subagent cost ceiling: $${ceiling}/Mtok output`,
        "info",
      );
    },
  });
}
