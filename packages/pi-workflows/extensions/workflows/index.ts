/**
 * workflows: model-authored multi-agent orchestration.
 *
 * A `workflow` tool that runs a JavaScript orchestration script written inline
 * by the model. The script executes ordered phases, fanning work out to
 * isolated subagents:
 *
 *   export const meta = { name, description, phases: [{ title, detail? }] }
 *   phase(title)                                  // mark runtime phase progression
 *   await agent(prompt, { label?, phase?, schema?, model?, provider?, effort? })
 *   await pipeline(items, stage1, stage2, ...)    // no barrier between stages
 *   await parallel([() => agent(...), ...], { concurrency? })
 *   args                                          // parsed JSON args passed with the tool call
 *
 * `agent()` resolves to the subagent's final text, or to the validated object
 * when a schema was supplied, or to `null` when it failed. Scripts filter with
 * `.filter(Boolean)`; failure reasons live on the run record, not the value.
 *
 * Runs are backgrounded by default, returning a run id immediately and
 * delivering a follow-up message when they settle; `background: false` blocks
 * with live progress in the tool block. Run artifacts (script, args, statuses,
 * result) are saved under `~/.pi/agent/workflows/<runId>/` for inspection, and
 * `journal.jsonl` records every settled agent() call so a later run can replay
 * the unchanged prefix via `resumeFromRunId`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  getAgentDir,
  getMarkdownTheme,
  keyHint,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { formatActivityStatus } from "../shared/activity-status.ts";
import { reportRunning } from "../shared/agent-activity.ts";
import {
  registerWorkflowRuntime,
  type OrchestrationDSL,
} from "../shared/workflow-runtime.ts";
import { hydrateWorkflowResult, isRunLiveFromDisk } from "./artifacts.ts";
import {
  formatBudget,
  loadDefaultBudget,
  parseBudget,
  saveDefaultBudget,
} from "./budget.ts";
import {
  sessionWorkflowRunIds,
  showWorkflowDashboard,
  type WorkflowDashboardControls,
} from "./dashboard.ts";
import { renderWorkflowCompletion } from "./completion.ts";
import { createResumePlan, loadResumePlan, readJournal } from "./journal.ts";
import {
  compactToolDetails,
  createLaunch,
  errorText,
  type ActiveRun,
} from "./launch.ts";
import {
  extractMeta,
  prepareWorkflowScript,
  type WorkflowMeta,
} from "./meta.ts";
import {
  agentContext,
  aggregateUsage,
  agentStateWord,
  countStates,
  formatElapsed,
  formatUsage,
  phaseGroups,
  resultJson,
  stateSquare,
  statusColor,
  statusWord,
  SQUARE,
  type WorkflowDetails,
} from "./model.ts";
import {
  buildBackgroundWorkflowLaunchResult,
  buildWorkflowResultMessage,
  WORKFLOW_PARAMETER_DESCRIPTIONS,
  WORKFLOW_PROMPT_GUIDELINES,
  WORKFLOW_PROMPT_SNIPPET,
  WORKFLOW_TOOL_DESCRIPTION,
} from "./prompt.ts";
import { createWorkflowResources, runAgent } from "./runner.ts";
import { writeFileAtomic } from "./serialization.ts";
import { createWorkflowRail } from "./rail.ts";
import {
  describeSavedWorkflows,
  findSavedWorkflow,
  listSavedWorkflows,
} from "./registry.ts";
import {
  runWorkflowSandbox,
  type RunWorkflowSandboxOptions,
} from "./sandbox.ts";

const WorkflowParams = Type.Object({
  script: Type.Optional(
    Type.String({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.script,
    }),
  ),
  name: Type.Optional(
    Type.String({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.name,
    }),
  ),
  args: Type.Optional(
    Type.String({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.args,
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.background,
    }),
  ),
  resumeFromRunId: Type.Optional(
    Type.String({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.resumeFromRunId,
    }),
  ),
  budgetTokens: Type.Optional(
    Type.Number({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.budgetTokens,
    }),
  ),
});

type WorkflowInput = Static<typeof WorkflowParams>;

interface RunSummary {
  runId: string;
  name?: string;
  status: string;
  done: number;
  total: number;
  startedAt: number;
  active: boolean;
}

function createWorkflowOrchestrator(
  prepared: ReturnType<typeof prepareWorkflowScript>,
  args: unknown,
  ctx: ExtensionContext,
) {
  return (dsl: OrchestrationDSL) => {
    const budget = () => ({
      total: dsl.budget.total,
      spent: dsl.budget.spent(),
      remaining: dsl.budget.remaining(),
    });
    const onAgent =
      dsl.agent as unknown as RunWorkflowSandboxOptions["onAgent"];
    const runNestedWorkflow = async (
      name: string,
      nestedArgs: unknown,
      signal: AbortSignal,
    ) => {
      const saved = findSavedWorkflow(ctx.cwd, name);
      if (!saved) {
        const available = listSavedWorkflows(ctx.cwd)
          .map((workflow) => workflow.name)
          .join(", ");
        return {
          error: `Workflow "${name}" not found. Available: ${available || "(none)"}`,
        };
      }
      let nestedPrepared: ReturnType<typeof prepareWorkflowScript>;
      try {
        nestedPrepared = prepareWorkflowScript(saved.script);
      } catch (error) {
        return {
          error: `Nested workflow "${name}" failed to parse: ${errorText(error)}`,
        };
      }
      dsl.log(`▸ ${name}`);
      try {
        const result = await runWorkflowSandbox({
          source: nestedPrepared.source,
          args: nestedArgs,
          cwd: ctx.cwd,
          signal,
          onAgent,
          onPhase: dsl.phase,
          onLog: dsl.log,
          budget,
        });
        return { result };
      } catch (error) {
        return { error: errorText(error) };
      }
    };

    return runWorkflowSandbox({
      source: prepared.source,
      args,
      cwd: ctx.cwd,
      signal: dsl.signal,
      onAgent,
      onPhase: dsl.phase,
      onLog: dsl.log,
      budget,
      onNestedWorkflow: runNestedWorkflow,
    });
  };
}

function persistRunDetails(runDir: string, details: WorkflowDetails) {
  writeFileAtomic(path.join(runDir, "workflow.json"), JSON.stringify(details));
}

function hasLiveResume(
  sourceRunId: string,
  activeRuns: Map<string, ActiveRun>,
): boolean {
  if (
    [...activeRuns.values()].some(
      (run) => run.details.resumedFromRunId === sourceRunId,
    )
  ) {
    return true;
  }
  const base = path.join(getAgentDir(), "workflows");
  let names: string[];
  try {
    names = fs.readdirSync(base).filter((name) => name.startsWith("wf_"));
  } catch {
    return false;
  }
  return names.some((name) => {
    const runDir = path.join(base, name);
    try {
      const details = JSON.parse(
        fs.readFileSync(path.join(runDir, "workflow.json"), "utf8"),
      ) as Partial<WorkflowDetails>;
      return (
        details.resumedFromRunId === sourceRunId &&
        (details.status === "running" || details.status === "stopping") &&
        isRunLiveFromDisk(runDir)
      );
    } catch {
      return false;
    }
  });
}

function listRuns(
  activeRuns: Map<string, WorkflowDetails>,
  sessionId: string,
  referencedRunIds: ReadonlySet<string>,
): RunSummary[] {
  const base = path.join(getAgentDir(), "workflows");
  let names: string[] = [];
  try {
    names = fs.readdirSync(base).filter((name) => name.startsWith("wf_"));
  } catch {
    // No runs yet.
  }
  const summaries: RunSummary[] = [];
  for (const runId of names) {
    const live = activeRuns.get(runId);
    if (live) {
      const { done, failed } = countStates(live);
      summaries.push({
        runId,
        name: live.name,
        status: live.status,
        done: done + failed,
        total: live.agents.length,
        startedAt: live.startedAt,
        active: true,
      });
      continue;
    }
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(base, runId, "workflow.json"), "utf8"),
      ) as Partial<WorkflowDetails>;
      if (parsed.sessionId !== sessionId && !referencedRunIds.has(runId)) {
        continue;
      }
      const agents = parsed.agents ?? [];
      // Absence from this instance's map is not proof the run is dead; only a
      // stale heartbeat on disk is.
      const activeStatus =
        parsed.status === "running" || parsed.status === "stopping";
      const runDir = path.join(base, runId);
      const onDiskLive = activeStatus && isRunLiveFromDisk(runDir);
      if (activeStatus && !onDiskLive) {
        parsed.status = "interrupted";
        parsed.finishedAt = parsed.finishedAt ?? Date.now();
        parsed.error =
          parsed.error ?? "Recovered stale run that was not active";
        for (const agent of parsed.agents ?? []) {
          if (agent.state !== "running") continue;
          agent.state = "interrupted";
          agent.error = agent.error ?? "Run ended before this agent settled";
          agent.finishedAt = parsed.finishedAt;
        }
        try {
          persistRunDetails(runDir, parsed as WorkflowDetails);
        } catch {
          // Keep the recovered state visible if the artifact is read-only.
        }
      }
      summaries.push({
        runId,
        name: parsed.name,
        status: parsed.status ?? "unknown",
        done: agents.filter((agent) => agent.state !== "running").length,
        total: agents.length,
        startedAt: parsed.startedAt ?? 0,
        active: onDiskLive,
      });
    } catch {
      // Ignore unreadable artifacts because their session cannot be verified.
    }
  }
  return summaries.sort((a, b) => b.startedAt - a.startedAt);
}

function runDetailText(
  run: RunSummary,
  activeRuns: Map<string, WorkflowDetails>,
): string {
  const runDir = path.join(getAgentDir(), "workflows", run.runId);
  const live = activeRuns.get(run.runId);
  if (live) return buildWorkflowResultMessage(live, runDir);
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(runDir, "workflow.json"), "utf8"),
    ) as WorkflowDetails;
    return buildWorkflowResultMessage(
      hydrateWorkflowResult(runDir, parsed),
      runDir,
    );
  } catch {
    return `Run ${run.runId} — ${run.status}`;
  }
}

export default function workflows(pi: ExtensionAPI) {
  /** Live background runs, for /workflows and shutdown cleanup. */
  const activeRuns = new Map<string, ActiveRun>();
  const activeDetails = () =>
    new Map(
      [...activeRuns].map(([runId, run]) => [runId, run.details] as const),
    );

  /** Finished counts remain visible until the dashboard acknowledges them. */
  let lastUi: ExtensionContext["ui"] | undefined;
  let controlContext: ExtensionContext | undefined;
  let completedRuns = 0;
  let failedRuns = 0;

  // The live rail: a belowEditor widget that reads the active-runs map on
  // every render (details mutate in place) and repaints on a 1 Hz tick while a
  // run is live. `railRefresh` lets updateIndicator repaint immediately on a
  // launch or settle instead of waiting for the next tick.
  let railContext: ExtensionContext | undefined;
  let railRefresh: (() => void) | undefined;
  const mountWorkflowRail = (ctx: ExtensionContext) => {
    // The rail is a component factory, which only the TUI renders.
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    railContext = ctx;
    ctx.ui.setWidget(
      "workflow-task-rail",
      (tui, theme) => {
        railRefresh = () => tui.requestRender();
        return createWorkflowRail(
          activeDetails,
          () => completedRuns + failedRuns,
          theme,
          () => tui.requestRender(),
        );
      },
      { placement: "belowEditor" },
    );
  };

  const updateIndicator = () => {
    // Publish for other extensions (summaries gates recaps on it). Must run
    // even without a UI context, so publish before the UI guard.
    reportRunning("workflows", activeRuns.size);
    railRefresh?.();
    const ui = lastUi;
    if (!ui) return;
    try {
      const running = activeRuns.size;
      if (running === 0 && completedRuns === 0 && failedRuns === 0) {
        ui.setStatus("workflows", undefined);
        return;
      }
      ui.setStatus(
        "workflows",
        formatActivityStatus(ui.theme, "workflows", {
          running,
          done: completedRuns,
          failed: failedRuns,
        }),
      );
    } catch {
      // UI may be unavailable.
    }
  };

  const recordSettledRun = (status: WorkflowDetails["status"]) => {
    if (status === "completed") completedRuns += 1;
    else if (status === "failed" || status === "aborted") failedRuns += 1;
  };

  const launch = createLaunch({
    pi,
    activeRuns,
    updateIndicator,
    recordSettledRun,
    setLastUi: (ui) => {
      lastUi = ui;
    },
    runAgent,
    createResources: createWorkflowResources,
  });

  // Publish the runtime so consumers (code-review) can launch tracked runs
  // through the shared seam without importing this extension.
  registerWorkflowRuntime({ launch });

  const startResume = (runId: string, retryIndex?: number) => {
    if (!/^wf_[0-9a-f]{12}$/.test(runId))
      throw new Error(`Invalid workflow run id "${runId}"`);
    if (activeRuns.has(runId) || hasLiveResume(runId, activeRuns))
      throw new Error(`Workflow run ${runId} is still active`);
    const ctx = controlContext;
    if (!ctx) throw new Error("Workflow controls are not available yet");

    const runDir = path.join(getAgentDir(), "workflows", runId);
    const detailsPath = path.join(runDir, "workflow.json");
    if (!fs.existsSync(detailsPath))
      throw new Error(`Workflow run ${runId} has no saved details to resume`);
    const details = JSON.parse(
      fs.readFileSync(detailsPath, "utf8"),
    ) as WorkflowDetails;
    if (
      details.sessionId !== ctx.sessionManager.getSessionId() &&
      !sessionWorkflowRunIds(ctx).has(runId)
    ) {
      throw new Error(`Workflow run ${runId} is not available in this session`);
    }
    if (details.status === "running" || details.status === "stopping") {
      if (isRunLiveFromDisk(runDir))
        throw new Error(`Workflow run ${runId} is still active`);
      details.status = "interrupted";
      details.finishedAt = details.finishedAt ?? Date.now();
      details.error =
        details.error ?? "Recovered stale run that was not active";
      for (const agent of details.agents) {
        if (agent.state !== "running") continue;
        agent.state = "interrupted";
        agent.error = agent.error ?? "Run ended before this agent settled";
        agent.finishedAt = details.finishedAt;
      }
      persistRunDetails(runDir, details);
    }

    if (retryIndex === undefined) {
      if (details.status !== "paused" && details.status !== "interrupted")
        throw new Error(
          `Workflow run ${runId} cannot be resumed from ${details.status}`,
        );
    } else {
      const agent = details.agents.find((item) => item.index === retryIndex);
      if (
        !agent ||
        (agent.state !== "error" &&
          agent.state !== "skipped" &&
          agent.state !== "interrupted")
      ) {
        throw new Error(
          `Agent ${retryIndex} in workflow run ${runId} cannot be retried`,
        );
      }
    }

    const scriptPath = path.join(runDir, "script.js");
    if (!fs.existsSync(scriptPath))
      throw new Error(`Workflow run ${runId} has no saved script to resume`);
    const script = fs.readFileSync(scriptPath, "utf8");
    const prepared = prepareWorkflowScript(script);
    let args: unknown;
    let argsRaw: string | undefined;
    try {
      argsRaw = fs.readFileSync(path.join(runDir, "args.json"), "utf8");
      try {
        args = JSON.parse(argsRaw);
      } catch {
        args = argsRaw;
      }
    } catch {
      args = undefined;
    }
    if (details.resumable === false) {
      throw new Error(
        `Workflow run ${runId} cannot be resumed: ${details.resumeError ?? "journal is non-resumable"}`,
      );
    }
    const resumePlan = loadResumePlan(
      runDir,
      activeRuns.has(runId) || isRunLiveFromDisk(runDir),
    );
    const selectedResumePlan =
      retryIndex === undefined
        ? resumePlan
        : createResumePlan(
            readJournal(runDir).filter((entry) => entry.index < retryIndex - 1),
          );
    const extraArtifacts: Record<string, string> = { "script.js": script };
    if (argsRaw !== undefined) extraArtifacts["args.json"] = argsRaw;
    launch(
      {
        meta: prepared.meta,
        background: ctx.hasUI,
        delivery: "model-followup",
        resumePlan: selectedResumePlan,
        resumeFromRunId: runId,
        extraArtifacts,
        orchestrate: createWorkflowOrchestrator(prepared, args, ctx),
      },
      ctx,
    );
  };

  const dashboardControls: WorkflowDashboardControls = {
    stop: (runId) => activeRuns.get(runId)?.stop(),
    pause: (runId) => activeRuns.get(runId)?.pause(),
    skipAgent: (runId, index) =>
      activeRuns.get(runId)?.skipAgent(index) ?? false,
    retryAgent: (runId, index) => {
      startResume(runId, index);
      return true;
    },
    resume: async (runId) => {
      startResume(runId);
    },
  };

  pi.registerMessageRenderer("workflow-completion", renderWorkflowCompletion);

  pi.on("session_start", (_event, ctx) => {
    controlContext = ctx;
    if (ctx.hasUI) lastUi = ctx.ui;
    mountWorkflowRail(ctx);
    updateIndicator();
  });

  pi.on("session_shutdown", async () => {
    const runs = [...activeRuns.values()];
    for (const run of runs) run.controller.abort("Session is shutting down");
    await Promise.all(
      runs.map((run) => run.controller.settle({ abort: true })),
    );
    const completions = runs
      .map((run) => run.completion)
      .filter(
        (completion): completion is Promise<void> => completion !== undefined,
      );
    if (completions.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 8_000);
        timer.unref?.();
      });
      await Promise.race([Promise.allSettled(completions), timeout]);
      if (timer) clearTimeout(timer);
    }
    railContext?.ui.setWidget("workflow-task-rail", undefined);
    railContext = undefined;
    railRefresh = undefined;
    lastUi?.setStatus("workflows", undefined);
    lastUi = undefined;
    controlContext = undefined;
  });

  pi.registerCommand("workflows-budget", {
    description:
      "Show or set the default workflow output-token budget (e.g. `500k`, `1.5m`, `off`)",
    handler: async (rawArgs, ctx) => {
      const arg = rawArgs.trim();
      if (!arg) {
        ctx.ui.notify(
          `Workflow budget: ${formatBudget(loadDefaultBudget())}. Set with \`/workflows-budget 500k\` or \`off\`.`,
          "info",
        );
        return;
      }
      try {
        const tokens = parseBudget(arg);
        saveDefaultBudget(tokens);
        ctx.ui.notify(
          `Workflow budget set to ${formatBudget(tokens)}.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(errorText(error), "error");
      }
    },
  });

  pi.registerCommand("workflows", {
    description:
      "List workflow runs (`/workflows <runId>` for one run's detail)",
    handler: async (rawArgs, ctx) => {
      const arg = rawArgs.trim();
      if (ctx.mode === "tui") {
        lastUi = ctx.ui;
        controlContext = ctx;
        await showWorkflowDashboard(
          ctx,
          activeDetails,
          arg || undefined,
          dashboardControls,
        );
        // Opening the dashboard acknowledges finished runs.
        completedRuns = 0;
        failedRuns = 0;
        updateIndicator();
        return;
      }
      // Non-TUI fallback: plain text listing.
      const runs = listRuns(
        activeDetails(),
        ctx.sessionManager.getSessionId(),
        sessionWorkflowRunIds(ctx),
      );
      if (runs.length === 0) {
        ctx.ui.notify("No workflow runs yet.", "info");
        return;
      }
      if (arg) {
        const run = runs.find((r) => r.runId === arg || r.runId.endsWith(arg));
        ctx.ui.notify(
          run
            ? runDetailText(run, activeDetails())
            : `No workflow run matching "${arg}".`,
          run ? "info" : "warning",
        );
        return;
      }
      const labels = runs.map(
        (r) =>
          `${r.active ? "* " : "  "}${r.runId}  ${r.status}  ${r.name ?? ""}  ${r.done}/${r.total}`,
      );
      if (!ctx.hasUI) {
        ctx.ui.notify(labels.join("\n"), "info");
        return;
      }
      const choice = await ctx.ui.select("Workflow runs", labels);
      if (!choice) return;
      const run = runs[labels.indexOf(choice)];
      if (run) ctx.ui.notify(runDetailText(run, activeDetails()), "info");
    },
  });

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description:
      WORKFLOW_TOOL_DESCRIPTION + describeSavedWorkflows(process.cwd()),
    promptSnippet: WORKFLOW_PROMPT_SNIPPET,
    promptGuidelines: WORKFLOW_PROMPT_GUIDELINES,
    parameters: WorkflowParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      controlContext = ctx;
      let script: string;
      if (params.name) {
        const saved = findSavedWorkflow(ctx.cwd, params.name);
        if (!saved) {
          const available = listSavedWorkflows(ctx.cwd)
            .map((workflow) => workflow.name)
            .join(", ");
          throw new Error(
            `Workflow "${params.name}" not found. Available: ${available || "(none)"}`,
          );
        }
        script = params.script ?? saved.script;
      } else if (params.script) {
        script = params.script;
      } else {
        throw new Error("Must provide script or name");
      }

      let prepared: ReturnType<typeof prepareWorkflowScript>;
      try {
        prepared = prepareWorkflowScript(script);
      } catch (error) {
        throw new Error(`Workflow script failed to parse: ${errorText(error)}`);
      }

      let args: unknown;
      if (params.args !== undefined) {
        try {
          args = JSON.parse(params.args);
        } catch {
          args = params.args;
        }
      }

      // Only our own generated ids: this value reaches a path join.
      const resumeFrom =
        params.resumeFromRunId &&
        /^wf_[0-9a-f]{12}$/.test(params.resumeFromRunId)
          ? params.resumeFromRunId
          : undefined;
      if (params.resumeFromRunId && !resumeFrom) {
        throw new Error(
          `Invalid resumeFromRunId "${params.resumeFromRunId}" (expected a wf_… run id)`,
        );
      }
      let resumePlan = createResumePlan([]);
      if (resumeFrom) {
        if (activeRuns.has(resumeFrom) || hasLiveResume(resumeFrom, activeRuns))
          throw new Error(`Workflow run ${resumeFrom} is still active`);
        const priorDir = path.join(getAgentDir(), "workflows", resumeFrom);
        const priorPath = path.join(priorDir, "workflow.json");
        if (!fs.existsSync(priorPath))
          throw new Error(
            `Workflow run ${resumeFrom} has no saved details to resume`,
          );
        const prior = JSON.parse(
          fs.readFileSync(priorPath, "utf8"),
        ) as WorkflowDetails;
        if (prior.status === "running" || prior.status === "stopping") {
          if (isRunLiveFromDisk(priorDir))
            throw new Error(`Workflow run ${resumeFrom} is still active`);
          prior.status = "interrupted";
          prior.finishedAt = prior.finishedAt ?? Date.now();
          prior.error =
            prior.error ?? "Recovered stale run that was not active";
          for (const agent of prior.agents) {
            if (agent.state !== "running") continue;
            agent.state = "interrupted";
            agent.error = agent.error ?? "Run ended before this agent settled";
            agent.finishedAt = prior.finishedAt;
          }
          persistRunDetails(priorDir, prior);
        }
        if (prior.resumable === false) {
          throw new Error(
            `Workflow run ${resumeFrom} cannot be resumed: ${prior.resumeError ?? "journal is non-resumable"}`,
          );
        }
        resumePlan = loadResumePlan(
          priorDir,
          activeRuns.has(resumeFrom) || isRunLiveFromDisk(priorDir),
        );
      }

      // CC runs every workflow in the background; blocking is the opt-out.
      // A headless session has nowhere to deliver the follow-up, so it blocks.
      const background = (params.background ?? true) && ctx.hasUI;

      const extraArtifacts: Record<string, string> = { "script.js": script };
      if (params.args !== undefined) extraArtifacts["args.json"] = params.args;

      const handle = launch(
        {
          meta: prepared.meta,
          background,
          budgetTokens: params.budgetTokens,
          delivery: "model-followup",
          resumePlan,
          resumeFromRunId: resumeFrom,
          extraArtifacts,
          signal,
          onToolUpdate: (update) => onUpdate?.(update),
          orchestrate: createWorkflowOrchestrator(prepared, args, ctx),
        },
        ctx,
      );

      if (background) {
        return {
          content: [
            {
              type: "text",
              text: buildBackgroundWorkflowLaunchResult({
                runId: handle.runId,
                name: handle.details.name,
                runDir: handle.runDir,
              }),
            },
          ],
          details: compactToolDetails(handle.details),
        };
      }

      const outcome = await handle.settled;
      if (outcome.status !== "completed") {
        // Pi marks tool failures only when execute throws; returning isError is
        // ignored by the extension API.
        throw new Error(
          buildWorkflowResultMessage(handle.details, handle.runDir),
        );
      }
      return {
        content: [
          {
            type: "text",
            text: buildWorkflowResultMessage(handle.details, handle.runDir),
          },
        ],
        details: compactToolDetails(handle.details),
      };
    },

    renderCall(args: Partial<WorkflowInput>, theme) {
      const meta =
        typeof args.script === "string"
          ? extractMeta(args.script)
          : { phases: [] };
      let text =
        theme.fg("toolTitle", theme.bold("workflow ")) +
        theme.fg("accent", (meta as WorkflowMeta).name ?? "(script)");
      if (args.background) text += theme.fg("dim", " (background)");
      const description = (meta as WorkflowMeta).description;
      if (description) text += `\n  ${theme.fg("dim", description)}`;
      for (const phase of meta.phases.slice(0, 8)) {
        text += `\n  ${theme.fg("dim", SQUARE)} ${theme.fg("accent", phase.title)}${
          phase.detail ? theme.fg("dim", ` — ${phase.detail}`) : ""
        }`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as WorkflowDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(
          first?.type === "text" ? first.text : "(no output)",
          0,
          0,
        );
      }

      const { done, failed, skipped, interrupted } = countStates(details);
      const settled = done + failed + skipped + interrupted;
      const elapsed = formatElapsed(details.startedAt, details.finishedAt);
      let header =
        `${theme.fg(statusColor(details.status), SQUARE)} ${theme.fg("toolTitle", theme.bold("workflow "))}` +
        `${theme.fg("accent", details.name ?? details.runId)} ` +
        theme.fg(
          "dim",
          `${settled}/${details.agents.length} agents · ${elapsed} · `,
        ) +
        theme.fg(statusColor(details.status), statusWord(details.status));
      if (failed) header += theme.fg("error", ` · ${failed} failed`);
      if (skipped) header += theme.fg("dim", ` · ${skipped} skipped`);
      if (interrupted)
        header += theme.fg("warning", ` · ${interrupted} interrupted`);
      if (details.background) header += theme.fg("dim", " (background)");
      if (details.status === "running" && details.currentPhase) {
        header += theme.fg("muted", ` · ${details.currentPhase}`);
      }
      const totals = formatUsage(aggregateUsage(details.agents));

      if (!expanded) {
        let text = header;
        for (const agent of details.agents) {
          const context = agentContext(agent);
          text += `\n  ${stateSquare(agent.state, theme)} ${theme.fg("accent", agent.label)}${
            agent.phase ? theme.fg("dim", ` (${agent.phase})`) : ""
          }${theme.fg(
            "dim",
            ` · ${agentStateWord(agent.state)}${context ? ` · ${context}` : ""}${agent.attempts !== undefined ? ` · ${agent.attempts} attempt${agent.attempts === 1 ? "" : "s"}` : ""} · ${formatElapsed(agent.startedAt, agent.finishedAt)}`,
          )}`;
        }
        if (totals) text += `\n  ${theme.fg("dim", `Total: ${totals}`)}`;
        if (details.error)
          text += `\n  ${theme.fg("error", `Error: ${details.error}`)}`;
        text += `\n${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
        return new Text(text, 0, 0);
      }

      const container = new Container();
      container.addChild(new Text(header, 0, 0));
      if (details.description) {
        container.addChild(
          new Text(theme.fg("dim", details.description), 0, 0),
        );
      }

      for (const group of phaseGroups(details)) {
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme.fg("muted", `─── ${group.title} ───`), 0, 0),
        );
        for (const agent of group.agents) {
          const usage = formatUsage(agent.usage, agent.model);
          const context = agentContext(agent);
          let line = `${stateSquare(agent.state, theme)} ${theme.fg("accent", agent.label)} ${theme.fg(
            "dim",
            [
              agentStateWord(agent.state),
              context,
              agent.attempts !== undefined
                ? `${agent.attempts} attempt${agent.attempts === 1 ? "" : "s"}`
                : undefined,
              formatElapsed(agent.startedAt, agent.finishedAt),
            ]
              .filter(Boolean)
              .join(" · "),
          )}`;
          if (usage) line += ` ${theme.fg("dim", usage)}`;
          container.addChild(new Text(line, 0, 0));
          if (agent.error) {
            container.addChild(
              new Text(`  ${theme.fg("error", agent.error)}`, 0, 0),
            );
          } else if (agent.preview) {
            const preview = agent.preview.split("\n").slice(0, 2).join(" ");
            container.addChild(new Text(`  ${theme.fg("dim", preview)}`, 0, 0));
          }
        }
      }

      if (details.error) {
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme.fg("error", `Error: ${details.error}`), 0, 0),
        );
      }

      if (details.resumable === false) {
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(
            theme.fg(
              "warning",
              `Resume unavailable: ${details.resumeError ?? "journal is non-resumable"}`,
            ),
            0,
            0,
          ),
        );
      }

      if (details.result !== undefined) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── result ───"), 0, 0));
        container.addChild(
          new Markdown(
            `\`\`\`json\n${resultJson(details.result)}\n\`\`\``,
            0,
            0,
            getMarkdownTheme(),
          ),
        );
      } else if (details.resultOmitted) {
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(
            theme.fg("warning", `Result not stored: ${details.resultOmitted}`),
            0,
            0,
          ),
        );
      }

      if (totals) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", `Total: ${totals}`), 0, 0));
      }
      return container;
    },
  });
}
