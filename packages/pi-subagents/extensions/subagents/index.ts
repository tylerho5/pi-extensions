/**
 * Subagents — spawn background subagents on the native pi harness. The
 * Claude Agent SDK backend stays in the manager behind the same Effect
 * service interface but is no longer reachable from the tool surface.
 *
 * Tools (for the parent LLM):
 * - subagent_spawn: spawn on a semantic delegation tier (or an explicit
 *   model/effort override); description, prompt, optional name,
 *   working_dir, run_in_background, model, reasoning_effort.
 *   Max 50 running at once.
 * - subagent_cancel: stop one or more running subagents.
 * - subagent_send: steer or resume a subagent.
 * - subagent_list: find tracked subagent ids.
 *
 * There is no blocking wait tool: the parent keeps working or ends its turn;
 * unawaited subagents queue their result as a follow-up message when they
 * settle. `/subagents` opens a picker + full interactive takeover view.
 *
 * Architecture: Effect v4 generators throughout (backends -> manager ->
 * runtime); this file is the async boundary where tool handlers run effects
 * against one shared ManagedRuntime. pi runs in-process SDK sessions; claude
 * drives the Claude Agent SDK but is not offered to callers.
 *
 * Each tier maps to a user-configured pi model and effort in
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
  truncateToWidth,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  type TUI,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  costCeiling,
  PI_DELEGATION_TIERS,
  loadDelegationConfig,
  resolveDelegationTarget,
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
import { pickEffort } from "./src/ui/model-picker.ts";
import { runSubagentsMenu } from "./src/ui/settings-menu.ts";
import {
  formatElapsedBetween,
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
  buildNestingPrompt,
  buildSubagentSpawnResult,
  delegationLabel,
  describeSubagent,
  SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CANCEL_TOOL_DESCRIPTION,
  SUBAGENT_LIST_TOOL_DESCRIPTION,
  SUBAGENT_SEND_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SEND_TOOL_DESCRIPTION,
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_PROMPT_SNIPPET,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import {
  acknowledgeDeliveredResult,
  createDeferredResultDelivery,
  runRefKey,
} from "./src/result-delivery.ts";
import { buildHandback } from "./src/handback.ts";
import {
  createSpawnGroupCoordinator,
  type SpawnCallArgs,
  type SpawnDetails,
  type SpawnResult,
} from "./src/ui/spawn-group.ts";
import { spinnerGlyph } from "./src/ui/activity-row.ts";
import {
  createSubagentRuntime,
  runTool,
  type SubagentRuntime,
} from "./src/runtime.ts";
import { capChars, formatCost, truncationNotice } from "./src/format.ts";
import {
  fastSummaryTarget,
  makeSummarizeDeps,
  shouldSummarize,
  summarizeReport,
  type SummarizeResult,
} from "./src/summarize.ts";
import { loadSummaryConfig } from "./src/summary-config.ts";
import {
  createProgressTracker,
  PROGRESS_MAX_TOKENS,
  PROGRESS_NOTES_CHAR_CAP,
  PROGRESS_PROMPT,
  type ProgressTracker,
} from "./src/progress.ts";
import { loadNestingConfig } from "./src/nesting-config.ts";
import {
  resolveNativeDelegation,
  type NativeDelegationBinding,
} from "./src/delegation.ts";
import { openBtwPanel } from "./src/ui/btw-panel.ts";
import { openSubagentPicker, openSubagentTakeover } from "./src/ui/takeover.ts";
import {
  rowComponent,
  sendCallRowText,
  sendExpandedText,
  sendRowText,
} from "./src/ui/send-row.ts";
import { completionHeaderText, digestLineText } from "./src/ui/result-row.ts";
import {
  createTaskRail,
  TaskRailController,
  railRows,
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
  readonly runSequence?: number;
  readonly description: string;
  /** Legacy label from before the description rename. */
  readonly title?: string;
  readonly status: SubagentSnapshot["status"];
  readonly errorText?: string;
  readonly fullOutput: string;
  readonly sessionFilePath?: string;
  readonly createdAt?: number;
  readonly settledAt?: number;
  readonly runStartedAt?: number;
  readonly costUsd?: number;
  readonly tokens?: number;
  readonly contextWindow?: number;
  readonly summary?: string;
  readonly summaryCostUsd?: number;
  readonly summaryTokens?: number;
}

function elapsedOf(details: {
  runStartedAt?: number;
  createdAt?: number;
  settledAt?: number;
}): string | undefined {
  const start = details.runStartedAt ?? details.createdAt;
  return start === undefined
    ? undefined
    : formatElapsedBetween(start, details.settledAt);
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
  let runtimeMaxDepth: number | undefined;
  let ownsRuntime = true;
  let binding: NativeDelegationBinding | undefined;
  let unboundAncestry = false;
  let ownerSettledUnsubscribe: (() => void) | undefined;
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
  const resultDelivery = createDeferredResultDelivery<SubagentSnapshot>(
    (snap) => binding?.completion.reserveDelivery(runRefOf(snap)),
  );
  const spawnGroups = createSpawnGroupCoordinator();
  const spawnSpinnerTimers = new Map<string, ReturnType<typeof setInterval>>();
  let spawnSpinnerFrame = 0;
  const resetSpawnGroups = () => {
    for (const timer of spawnSpinnerTimers.values()) clearInterval(timer);
    spawnSpinnerTimers.clear();
    spawnSpinnerFrame = 0;
    spawnGroups.reset();
  };
  const ensureSpawnSpinner = (toolCallId: string, invalidate: () => void) => {
    if (spawnSpinnerTimers.has(toolCallId)) return;
    const timer = setInterval(() => {
      const view = spawnGroups.viewFor(toolCallId);
      if (!view.members.some((member) => !member.result)) {
        clearInterval(timer);
        spawnSpinnerTimers.delete(toolCallId);
        return;
      }
      spawnSpinnerFrame++;
      invalidate();
    }, 1000);
    timer.unref?.();
    spawnSpinnerTimers.set(toolCallId, timer);
  };

  /** Cache the digest per run so automatic delivery computes it once. */
  const summaryCache = new Map<string, Promise<SummarizeResult | undefined>>();
  let summaryConfigCache: ReturnType<typeof loadSummaryConfig> | undefined;
  const summaryConfig = () => (summaryConfigCache ??= loadSummaryConfig());
  const rawCharCap = () => summaryConfig().rawCharCap;

  // At most two digest calls in flight; the rest queue in order.
  let summarySlots = 0;
  const summaryQueue: Array<() => void> = [];
  const acquireSummarySlot = () => {
    if (summarySlots < 2) {
      summarySlots += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => summaryQueue.push(resolve));
  };
  const releaseSummarySlot = () => {
    const next = summaryQueue.shift();
    if (next) next();
    else summarySlots = Math.max(0, summarySlots - 1);
  };

  const computeSummary = async (
    snap: SubagentSnapshot,
  ): Promise<SummarizeResult | undefined> => {
    const config = summaryConfig();
    if (
      !shouldSummarize({
        enabled: config.enabled,
        status: snap.status,
        textLength: snap.finalText.length,
        skipUnderChars: config.skipUnderChars,
      })
    ) {
      return undefined;
    }
    const context = sessionContext;
    if (!context) return undefined;
    let target: ReturnType<typeof fastSummaryTarget>;
    try {
      target = fastSummaryTarget();
    } catch {
      return undefined;
    }
    await acquireSummarySlot();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      return await summarizeReport({
        deps: makeSummarizeDeps(context.modelRegistry),
        target,
        report: snap.finalText,
        inputCharCap: config.inputCharCap,
        signal: controller.signal,
      });
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
      releaseSummarySlot();
    }
  };

  const ensureSummary = (
    snap: SubagentSnapshot,
  ): Promise<SummarizeResult | undefined> => {
    const key = runRefKey(runRefOf(snap));
    const existing = summaryCache.get(key);
    if (existing) return existing;
    const pending = computeSummary(snap);
    summaryCache.set(key, pending);
    return pending;
  };

  let progressTracker: ProgressTracker | undefined;
  const summarizeProgress = async (notes: string, signal: AbortSignal) => {
    const context = sessionContext;
    if (!context) return undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, summaryConfig().timeoutMs);
    try {
      const result = await summarizeReport({
        deps: makeSummarizeDeps(context.modelRegistry),
        target: fastSummaryTarget(),
        report: notes,
        inputCharCap: PROGRESS_NOTES_CHAR_CAP,
        prompt: PROGRESS_PROMPT,
        maxTokens: PROGRESS_MAX_TOKENS,
        signal: controller.signal,
      });
      return result?.summary;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  };
  const startProgressTracker = (view: SubagentReadModel) => {
    const config = summaryConfig();
    if (progressTracker || !config.progressEnabled) return;
    progressTracker = createProgressTracker({
      view,
      intervalMs: config.progressIntervalMs,
      summarize: summarizeProgress,
      onChange: () => taskRailTui?.requestRender(),
    });
  };

  const getRuntime = () => {
    if (binding) return binding.runtime;
    if (!runtime) {
      runtimeMaxDepth = loadNestingConfig().maxDepth;
      runtime = createSubagentRuntime({ maxDepth: runtimeMaxDepth });
    }
    return runtime;
  };

  /** Resolve the manager service once per runtime and wire the extension hooks. */
  const getOwner = (manager: SubagentManagerShape) =>
    binding?.owner ?? manager.forOwner(null);

  const getManager = () => {
    managerPromise ??= getRuntime()
      .runPromise(SubagentManager)
      .then((manager) => {
        if (binding)
          ownerSettledUnsubscribe = binding.owner.subscribeSettled(onSettled);
        else manager.view.setOnSettled(onSettled);
        if (!binding) {
          taskRailView = manager.view;
          if (taskRailContext?.hasUI) startProgressTracker(manager.view);
        }
        refreshTaskRail();
        return manager;
      });
    return managerPromise;
  };

  const deliverResult = async (snap: SubagentSnapshot) => {
    const summary = sessionContext ? await ensureSummary(snap) : undefined;
    if (!sessionContext) throw new Error("Parent session is shutting down.");
    // A cancel returned this run while the digest was computing.
    if (!resultDelivery.isInFlight(runRefOf(snap))) return;
    // A cancelled or failed native parent drops child results instead of
    // starting a turn for them.
    if (binding && !binding.owner.accepting())
      throw new Error("Owning subagent has settled.");
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
          runSequence: snap.runSequence,
          description: snap.description,
          status: snap.status,
          errorText: snap.errorText,
          fullOutput: handback.fullOutput,
          sessionFilePath: snap.meta.sessionFilePath,
          createdAt: snap.createdAt,
          settledAt: snap.settledAt,
          runStartedAt: snap.runStartedAt,
          costUsd: snap.usage.costUsd,
          tokens: snap.usage.tokens,
          contextWindow: snap.usage.contextWindow,
          summary: summary?.summary,
          summaryCostUsd: summary?.costUsd,
          summaryTokens: summary?.tokens,
        } satisfies SubagentResultDetails,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  const flushResults = async () => {
    for (const snap of resultDelivery.drain()) {
      // A summary can outlive the session that requested it; a failed send
      // during shutdown must not strand the remaining results.
      const ref = runRefOf(snap);
      try {
        await deliverResult(snap);
        resultDelivery.scheduled(ref);
      } catch {
        resultDelivery.fail(ref);
      }
    }
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
    if (binding && !binding.owner.accepting()) return;
    // Defer a copy: the live snapshot keeps mutating if the subagent is
    // restarted before the deferred result flushes.
    resultDelivery.defer({ ...snap, meta: { ...snap.meta } });
    if (sessionContext?.isIdle()) void flushResults();
  };

  const refreshTaskRail = () => {
    const context = taskRailContext;
    if (!context?.hasUI) return;
    context.ui.setWidget(
      "subagent-task-rail",
      taskRailView
        ? (tui, theme) => {
            taskRailTui = tui;
            return createTaskRail(
              taskRailView!,
              taskRail,
              theme,
              () => tui.requestRender(),
              (id) => progressTracker?.lineFor(id),
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
    const selected = railRows(manager.view).find(
      (row) => row.snap.id === taskRail.selectedId,
    );
    if (!selected) return;
    openingTaskRailSession = true;
    try {
      await openSubagentTakeover(
        taskRailContext,
        manager.view,
        selected.snap.id,
      );
    } finally {
      openingTaskRailSession = false;
    }
  };

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "subagent_spawn") return;
    const branch = ctx.sessionManager.getBranch();
    const entryIndex = branch.findIndex((candidate) => {
      if (
        candidate.type !== "message" ||
        candidate.message.role !== "assistant"
      )
        return false;
      return candidate.message.content.some(
        (part) => part.type === "toolCall" && part.id === event.toolCallId,
      );
    });
    const entry = branch[entryIndex];
    if (
      entryIndex < 0 ||
      !entry ||
      entry.type !== "message" ||
      entry.message.role !== "assistant"
    )
      return;

    let responseCycleId = entry.id;
    for (let index = entryIndex - 1; index >= 0; index--) {
      const previous = branch[index];
      if (previous?.type === "message" && previous.message.role === "user") {
        responseCycleId = previous.id;
        break;
      }
    }

    const calls = entry.message.content.flatMap((part) =>
      part.type === "toolCall" && part.name === "subagent_spawn"
        ? [
            {
              responseCycleId,
              toolCallId: part.id,
              toolName: part.name,
              args: part.arguments as SpawnCallArgs,
            },
          ]
        : [],
    );
    spawnGroups.recordAssistantBatch(calls);
  });

  pi.on("session_start", (_event, ctx) => {
    resetSpawnGroups();
    sessionContext = ctx;
    const resolved = resolveNativeDelegation(
      ctx.sessionManager.getSessionId(),
      ctx.sessionManager.getBranch(),
    );
    binding = resolved.binding;
    unboundAncestry = resolved.unbound;
    ownsRuntime = !binding;
    if (binding) runtime = binding.runtime;
    managerPromise = undefined;
    if (unboundAncestry) {
      const denied = new Set([
        "subagent_spawn",
        "subagent_send",
        "subagent_cancel",
        "subagent_list",
      ]);
      pi.setActiveTools(
        pi.getActiveTools().filter((name) => !denied.has(name)),
      );
    }
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
      const rows = railRows(view);
      if (taskRail.expanded) {
        taskRail.clearTap();
        if (rows.length === 0) {
          taskRail.reset();
          return undefined;
        }
        if (matchesKey(data, "enter")) {
          void openTaskRailSelection();
          return { consume: true };
        }
        if (matchesKey(data, "escape")) {
          taskRail.reset();
          return { consume: true };
        }
        if (matchesKey(data, "x")) {
          const selected = rows.find(
            (row) => row.snap.id === taskRail.selectedId,
          );
          if (selected?.snap.status === "running")
            view.requestAbort(selected.snap.id);
          return { consume: true };
        }
        if (matchesKey(data, "up")) {
          if (taskRail.move(rows, -1) === "atTop") taskRail.reset();
          return { consume: true };
        }
        if (matchesKey(data, "down")) {
          taskRail.move(rows, 1);
          return { consume: true };
        }
        // Any other key hands focus back to the editor and reaches it.
        taskRail.reset();
        return undefined;
      }
      if (ctx.ui.getEditorText().trim() || rows.length === 0) return undefined;
      if (!matchesKey(data, "down")) {
        taskRail.clearTap();
        return undefined;
      }
      // A lone tap reaches normal editor navigation; a held-key repeat is
      // neither a tap nor an editor move.
      if (isKeyRepeat(data)) return { consume: true };
      if (!taskRail.handleCollapsedDown(Date.now(), rows)) return undefined;
      return { consume: true };
    });
  });

  pi.on("before_agent_start", (event) => {
    const depth = binding?.identity.depth ?? 0;
    const maxDepth =
      binding?.identity.maxDepth ??
      runtimeMaxDepth ??
      loadNestingConfig().maxDepth;
    const enabled =
      !unboundAncestry &&
      (binding !== undefined || pi.getActiveTools().includes("subagent_spawn"));
    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n" +
        buildNestingPrompt({ depth, maxDepth, enabled }),
    };
  });

  pi.on("agent_settled", () => {
    void flushResults();
  });

  pi.on("message_start", (event) => {
    acknowledgeDeliveredResult(resultDelivery, event.message);
  });

  pi.on("session_shutdown", async () => {
    sessionContext = undefined;
    const childBinding = binding;
    binding = undefined;
    unboundAncestry = false;
    ownerSettledUnsubscribe?.();
    ownerSettledUnsubscribe = undefined;
    if (childBinding)
      await runTool(
        childBinding.runtime,
        childBinding.owner.closeChildren(),
      ).catch(() => undefined);
    resetSpawnGroups();
    progressTracker?.dispose();
    progressTracker = undefined;
    taskRailContext?.ui.setWidget("subagent-task-rail", undefined);
    taskRailContext = undefined;
    taskRailView = undefined;
    taskRailTui = undefined;
    rawInputUnsubscribe?.();
    rawInputUnsubscribe = undefined;
    taskRail.reset();
    resultDelivery.clear();
    summaryCache.clear();
    summaryConfigCache = undefined;
    ui = undefined;
    const closing = ownsRuntime ? runtime : undefined;
    runtime = undefined;
    if (ownsRuntime) runtimeMaxDepth = undefined;
    managerPromise = undefined;
    // Disposing the runtime runs the manager finalizer, which tears down all
    // subagent scopes (and, later, their real child processes).
    await closing?.dispose();
  });

  // --- Tools -------------------------------------------------------------

  const spawnCommonParameters = {
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
  };
  const spawnParameters = Type.Object({
    ...spawnCommonParameters,
    tier: Type.Optional(
      StringEnum(PI_DELEGATION_TIERS, {
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.tier,
      }),
    ),
    model: Type.Optional(
      Type.String({
        minLength: 1,
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.model,
      }),
    ),
    reasoning_effort: Type.Optional(
      StringEnum(REASONING_EFFORTS, {
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.reasoningEffort,
      }),
    ),
  });

  pi.registerTool<typeof spawnParameters, SpawnDetails>({
    renderShell: "self",
    name: "subagent_spawn",
    label: "Spawn Subagent",
    description: SUBAGENT_SPAWN_TOOL_DESCRIPTION,
    promptSnippet: SUBAGENT_SPAWN_PROMPT_SNIPPET,
    promptGuidelines: SUBAGENT_SPAWN_PROMPT_GUIDELINES,
    parameters: spawnParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (unboundAncestry)
        throw new Error(
          "This child transcript has no live owning manager; delegation is disabled.",
        );
      const manager = await getManager();
      const owner = getOwner(manager);
      // The claude route is disabled, so an explicit model or effort implies
      // the pi harness; omitting every target field takes the standard tier.
      const explicitTarget =
        params.model !== undefined || params.reasoning_effort !== undefined;
      const target = resolveDelegationTarget({
        config: loadDelegationConfig(),
        selection: {
          tier: params.tier,
          harness: explicitTarget ? "pi" : undefined,
          model: params.model,
          effort: params.reasoning_effort,
        },
        supportedHarnesses: ["pi"],
      });

      const cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`working_dir is not a directory: ${cwd}`);
      }

      const background = params.run_in_background !== false;
      const snap = await runTool(
        getRuntime(),
        owner.spawn(
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
              delegation: { runtime: getRuntime(), owner },
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
        await runTool(getRuntime(), owner.waitForRun(run), {
          signal,
          interruptMessage: "Wait aborted. Subagent keeps running.",
        });
      } catch (error) {
        await runTool(getRuntime(), owner.releaseRun(run)).catch(
          () => undefined,
        );
        throw error;
      }
      const settled = owner.view.get(snap.id) ?? snap;
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
      spawnGroups.registerRow(context.toolCallId, context.invalidate);
      const initial = spawnGroups.viewFor(context.toolCallId);
      if (initial.kind === "sibling" && !context.expanded)
        return new Text("", 0, 0);
      if (initial.kind === "first" && !context.expanded) {
        ensureSpawnSpinner(context.toolCallId, context.invalidate);
        return {
          render(width) {
            const view = spawnGroups.viewFor(context.toolCallId);
            const good = view.members.filter(
              (member) =>
                member.result &&
                !member.result.isError &&
                member.result.details,
            );
            const pending = view.members.some((member) => !member.result);
            const heading = pending
              ? `${theme.fg("warning", spinnerGlyph(spawnSpinnerFrame))} ${theme.fg("warning", `Running ${view.members.length} agents…`)}`
              : `${theme.fg(good.length ? "success" : "error", good.length ? "✓" : "×")} ${good.length} background agents launched ${theme.fg("muted", "↓↓ select")}`;
            const lines = [truncateToWidth(heading, width)];
            view.members.forEach((member, index) => {
              const failed =
                member.result !== undefined &&
                (member.result.isError || member.result.details === undefined);
              const label =
                member.args.name ?? member.args.description ?? "subagent";
              const prefix = index === view.members.length - 1 ? "└ " : "├ ";
              lines.push(
                truncateToWidth(
                  theme.fg(failed ? "error" : "dim", `${prefix}${label}`),
                  width,
                ),
              );
            });
            return lines;
          },
          invalidate() {},
        };
      }
      // The id and the resolved target live on the result row, so the call
      // row carries only the description the model wrote.
      const content =
        theme.fg("toolTitle", theme.bold("subagent_spawn")) +
        (args.description
          ? " " + theme.fg("dim", `"${args.description}"`)
          : "");
      return new Text(content, 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      const details = result.details as SpawnDetails | undefined;
      const view = spawnGroups.viewFor(context.toolCallId);
      const recorded: SpawnResult = {
        details,
        isError: context.isError,
        message:
          result.content[0]?.type === "text"
            ? result.content[0].text
            : undefined,
      };
      spawnGroups.recordResult(context.toolCallId, recorded);
      if (view.kind !== "single" && !expanded) return new Text("", 0, 0);
      if (context.isError || !details) {
        const msg =
          result.content[0]?.type === "text"
            ? result.content[0].text
            : "spawn failed";
        return new Text(theme.fg("error", msg), 0, 0);
      }
      const d = details;
      let text =
        theme.fg("success", "⏵ ") +
        theme.fg("accent", d.id) +
        theme.fg(
          "dim",
          ` · ${delegationLabel(d.tier)} · ${d.harness} · ${d.model ?? "?"}`,
        );
      if (expanded) {
        // The tool result text is parent-model guidance, not user-facing;
        // expanded shows the two facts the collapsed row omits instead.
        text += "\n" + theme.fg("dim", `  cwd: ${d.cwd}`);
        if (d.effort) text += "\n" + theme.fg("dim", `  effort: ${d.effort}`);
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
      if (unboundAncestry)
        throw new Error(
          "This child transcript has no live owning manager; delegation is disabled.",
        );
      const manager = await getManager();
      const owner = getOwner(manager);
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");

      const known = owner.view
        .list()
        .filter(isModelVisible)
        .map((snap) => snap.id);
      const unknown = ids.filter((id) => {
        const snap = owner.view.get(id);
        return !snap || !isModelVisible(snap);
      });
      if (unknown.length > 0) throw unknownSubagentError(unknown, known);

      const report = await runTool(getRuntime(), owner.cancel(ids), {
        signal,
        interruptMessage: "Subagent cancellation aborted.",
      });
      // The report covers each listed run, settled or just cancelled; drop any
      // deferred copy so it is not delivered again as a follow-up.
      consumeReturnedRuns(resultDelivery, owner.view, ids);

      const lines = report.map((entry) =>
        entry.cancelled
          ? `Cancelled ${entry.id} "${entry.description}".`
          : `${entry.id} "${entry.description}" was already ${entry.status}.`,
      );
      const sections = subagentOutputSections(owner.view, ids);

      return {
        content: [
          { type: "text", text: [lines.join("\n"), ...sections].join("\n\n") },
        ],
        details: {
          results: report.map((entry) => ({
            id: entry.id,
            description: entry.description,
            status: entry.status,
            cancelled: entry.cancelled,
          })),
        },
      };
    },
    renderResult(result, { expanded }, theme, context) {
      const details = result.details as
        | {
            results?: Array<{
              id: string;
              description: string;
              status: string;
              cancelled: boolean;
            }>;
          }
        | undefined;
      if (context.isError || !details?.results) {
        const msg =
          result.content[0]?.type === "text"
            ? result.content[0].text
            : "cancel failed";
        return new Text(theme.fg("error", msg), 0, 0);
      }
      const lines = details.results.map((entry) =>
        entry.cancelled
          ? `${theme.fg("warning", "x ")}${theme.fg("accent", entry.id)}${theme.fg(
              "muted",
              ` "${entry.description}"`,
            )}`
          : `${theme.fg("dim", "· ")}${theme.fg("accent", entry.id)}${theme.fg(
              "muted",
              ` "${entry.description}" was already ${entry.status}`,
            )}`,
      );
      let text = lines.join("\n");
      if (!expanded) {
        text += `\n${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
        return new Text(text, 0, 0);
      }
      const contentText =
        result.content[0]?.type === "text" ? result.content[0].text : "";
      const { text: capped, truncated } = capChars(contentText, rawCharCap());
      text += `\n${theme.fg("toolOutput", capped)}`;
      if (truncated) text += `\n${theme.fg("dim", truncationNotice())}`;
      return new Text(text, 0, 0);
    },
  });

  interface SendRowState {
    resultRendered?: boolean;
  }

  pi.registerTool({
    renderShell: "self",
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
      if (unboundAncestry)
        throw new Error(
          "This child transcript has no live owning manager; delegation is disabled.",
        );
      const manager = await getManager();
      const owner = getOwner(manager);
      const snap = owner.view.get(params.id);
      if (!snap || !isModelVisible(snap)) {
        const known = owner.view
          .list()
          .filter(isModelVisible)
          .map((s) => s.id);
        throw unknownSubagentError([params.id], known);
      }
      const result = await runTool(
        getRuntime(),
        owner.send(params.id, params.message),
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
    renderCall(args, theme, context) {
      const state = context.state as SendRowState;
      return rowComponent((width) =>
        state.resultRendered
          ? ""
          : sendCallRowText({
              id: args.id,
              message: args.message ?? "",
              theme,
              width,
            }),
      );
    },
    renderResult(result, { expanded }, theme, context) {
      const state = context.state as SendRowState;
      if (!state.resultRendered) {
        // Mark the row on pi's persistent per-row state, then nudge the call
        // slot to drop the preview on the next tick. Calling invalidate()
        // synchronously here re-enters updateDisplay from its own result render
        // and overflows the stack.
        state.resultRendered = true;
        queueMicrotask(() => context.invalidate?.());
      }
      if (context.isError || !result.details) {
        const msg =
          result.content[0]?.type === "text"
            ? result.content[0].text
            : "send failed";
        return new Text(theme.fg("error", msg), 0, 0);
      }
      const d = result.details;
      const message =
        typeof context.args?.message === "string" ? context.args.message : "";
      if (!expanded) {
        return rowComponent((width) =>
          sendRowText({
            id: d.id,
            restarted: d.restarted,
            runSequence: d.runSequence,
            message,
            theme,
            width,
          }),
        );
      }
      return new Text(
        sendExpandedText({
          id: d.id,
          restarted: d.restarted,
          runSequence: d.runSequence,
          message,
          theme,
        }),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List Subagents",
    description: SUBAGENT_LIST_TOOL_DESCRIPTION,
    parameters: Type.Object({}),
    async execute() {
      if (unboundAncestry)
        return {
          content: [{ type: "text", text: "No subagents." }],
          details: { subagents: [] },
        };
      const manager = await getManager();
      const subs = getOwner(manager).view.list().filter(isModelVisible);
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
      const elapsed = elapsedOf(details);
      const header = completionHeaderText({
        id: details.id ?? "?",
        description: details.description ?? details.title,
        status: details.status ?? "done",
        elapsed,
        costUsd: details.costUsd,
        errorText: details.errorText,
        theme,
        width: 10000,
      });

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

      if (!expanded) {
        return {
          render: (width: number) => [
            completionHeaderText({
              id: details.id ?? "?",
              description: details.description ?? details.title,
              status: details.status ?? "done",
              elapsed,
              costUsd: details.costUsd,
              errorText: details.errorText,
              theme,
              width,
            }),
            ...(details.summary
              ? [digestLineText(details.summary, theme, width)]
              : []),
          ],
          invalidate: () => {},
        };
      }

      // Expanded: the raw report lives in details so it never enters the model
      // context; entries persisted before that split fall back to the body.
      const full = [
        details.errorText ? `Error: ${details.errorText}` : "",
        body,
      ]
        .filter(Boolean)
        .join("\n\n");
      const { text: capped, truncated } = capChars(full, rawCharCap());
      let text = `${header}\n${capped}`;
      if (truncated) {
        text += `\n${theme.fg("dim", truncationNotice(details.sessionFilePath))}`;
      }
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

    if (unboundAncestry) {
      ctx.ui.notify(
        "This child transcript has no live owning manager; delegation is disabled.",
        "error",
      );
      return;
    }
    const manager = await getManager();
    const owner = getOwner(manager);
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
        const hasHistory = owner.view
          .list()
          .some((snap) => snap.origin === "btw");
        if (hasHistory && !askNext) {
          const action = await openBtwPanel(ctx, owner.view);
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
          owner.spawn("pi", {
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
      const action = await openBtwPanel(ctx, getOwner(manager).view);
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
      if (unboundAncestry) {
        ctx.ui.notify(
          "This child transcript has no live owning manager; takeover is unavailable.",
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

  pi.registerCommand("subagents-menu", {
    description:
      "Configure subagent tiers, cost ceiling, nesting, and summaries",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI)
          ctx.ui.notify(
            "/subagents-menu is only available in the TUI.",
            "error",
          );
        return;
      }
      await runSubagentsMenu({
        cwd: ctx.cwd,
        models: ctx.modelRegistry.getAvailable(),
        effectiveCeiling: costCeiling,
        ui: {
          select: (title, options) => ctx.ui.select(title, [...options]),
          input: (title, placeholder) => ctx.ui.input(title, placeholder),
          pickEffort: (options, current) => pickEffort(ctx, options, current),
          notify: (message, type) => ctx.ui.notify(message, type),
        },
      });
    },
  });
}
