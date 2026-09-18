/**
 * The workflow run lifecycle, extracted from the `workflow` tool's `execute` so
 * it can drive any orchestrator — the sandbox script (the `workflow` tool) or
 * an in-process TypeScript engine (`code-review`) — and deliver results two
 * ways: `model-followup` (the tool's existing background follow-up / blocking
 * throw) or `programmatic` (resolve `settled`, no follow-up). Either way the run
 * background-tracks in `/workflows`.
 *
 * `createLaunch(deps)` takes its collaborators as dependencies (notably the
 * agent runner and resource factory) so the lifecycle is unit-testable with
 * stubs; `workflows(pi)` wires the real ones. The result satisfies the shared
 * `WorkflowRuntime["launch"]` contract; the internal spec/handle add the
 * tool-only extras (resume plan, artifacts, blocking signal, tool-block
 * progress) that `code-review` never uses.
 */

import { randomBytes } from "node:crypto";
import * as path from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
  LaunchSpec,
  OrchestrationDSL,
  RunOutcome,
  WorkflowRunHandle,
} from "../shared/workflow-runtime.ts";
import {
  affordableModels,
  costCeilingMessage,
  DELEGATION_TIERS,
  exceedsCostCeiling,
  loadDelegationConfig,
  loadSubagentModels,
  modelKey,
  resolveDelegationTarget,
  type DelegationConfig,
  type DelegationTier,
  type ResolvedDelegationTarget,
} from "../shared/subagent-models.ts";
import { createWorkflowPersistence, persistWorkflowJson } from "./artifacts.ts";
import { loadDefaultBudget, WorkflowBudget } from "./budget.ts";
import { DEFAULT_CONCURRENCY, RunController } from "./controller.ts";
import {
  appendJournalEntry,
  callKey,
  createResumePlan,
  readJournal,
} from "./journal.ts";
import { resolveModelOption } from "./model-aliases.ts";
import { loadRegistrySettings } from "./registry.ts";
import {
  countStates,
  emptyUsage,
  type AgentRecord,
  type WorkflowDetails,
} from "./model.ts";
import {
  buildBackgroundWorkflowFollowUp,
  buildWorkflowAgentPrompt,
  buildWorkflowResultMessage,
} from "./prompt.ts";
import {
  createWorkflowResources,
  runAgent,
  type ThinkingLevel,
  type WorkflowModel,
} from "./runner.ts";
import { safeStringify, writeFileAtomic } from "./serialization.ts";
import { createWorktree, isGitRepo } from "./worktree.ts";

const PREVIEW_LENGTH = 200;
const EMIT_INTERVAL_MS = 120;
const MAX_FANOUT_ITEMS = 4096;

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/**
 * What `agent()` resolves to: the final text, or the validated object when a
 * schema was supplied, or `null` when the agent failed. Callers filter with
 * `.filter(Boolean)` rather than checking a flag.
 */
type ScriptAgentResult = unknown;

interface AgentCallOptions {
  label?: unknown;
  phase?: unknown;
  schema?: unknown;
  tier?: unknown;
  model?: unknown;
  provider?: unknown;
  effort?: unknown;
  isolation?: unknown;
}

export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    16 * 1024,
  );
}

/** Short display string for whatever an agent returned. */
function previewOf(result: unknown): string {
  if (result === null || result === undefined) return "";
  const text =
    typeof result === "string"
      ? result
      : safeStringify(result, { maxBytes: 4 * 1024 });
  return text.slice(0, PREVIEW_LENGTH);
}

/** The /subagent-model pi default, shared with subagent spawns. */
function resolveDefaultAgentModel(ctx: ExtensionContext) {
  const configured = loadSubagentModels().pi;
  return ctx.modelRegistry.find(configured.provider, configured.model);
}

function affordableAgentModels(ctx: ExtensionContext) {
  return affordableModels(ctx.modelRegistry.getAvailable(), ctx.cwd).map(
    modelKey,
  );
}

function summaryLine(details: WorkflowDetails): string {
  const { done, failed } = countStates(details);
  const settled = done + failed;
  return `workflow ${details.name ?? details.runId}: ${settled}/${details.agents.length} agents${
    details.currentPhase ? ` · ${details.currentPhase}` : ""
  }`;
}

function writeRunFile(runDir: string, name: string, content: string) {
  writeFileAtomic(path.join(runDir, name), content);
}

export function compactToolDetails(details: WorkflowDetails): WorkflowDetails {
  return {
    ...details,
    ...(details.result !== undefined
      ? {
          result: JSON.parse(
            safeStringify(details.result, { maxBytes: 64 * 1024 }),
          ),
        }
      : {}),
    agents: details.agents.map((agent) => ({ ...agent, transcript: [] })),
  };
}

/** Mirrors sandbox-child.cjs mapLimited (bounded-concurrency map). */
async function mapLimited<I, O>(
  items: I[],
  concurrency: number,
  invoke: (item: I) => Promise<O>,
): Promise<O[]> {
  const results = new Array<O>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await invoke(items[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** Mirrors sandbox-child.cjs parallel (barrier; throwing thunk → null). */
async function inProcessParallel<T>(
  thunks: Array<() => Promise<T>>,
  options: { concurrency?: number } = {},
): Promise<Array<T | null>> {
  if (!Array.isArray(thunks))
    throw new Error(
      "parallel() expects an array of zero-argument agent thunks",
    );
  if (thunks.length > MAX_FANOUT_ITEMS)
    throw new Error(
      `parallel() accepts at most ${MAX_FANOUT_ITEMS} items; got ${thunks.length}`,
    );
  for (const item of thunks) {
    if (typeof item !== "function")
      throw new Error("parallel() items must be zero-argument functions");
  }
  const requested =
    options && typeof options.concurrency === "number"
      ? Math.floor(options.concurrency)
      : DEFAULT_CONCURRENCY;
  if (!Number.isFinite(requested) || requested < 1)
    throw new Error("parallel(): concurrency must be a positive integer");
  const concurrency = Math.min(DEFAULT_CONCURRENCY, requested);
  return mapLimited(thunks, concurrency, async (item) => {
    try {
      return await item();
    } catch {
      return null;
    }
  });
}

/** Mirrors sandbox-child.cjs pipeline (no barrier; throwing stage → null). */
async function inProcessPipeline(
  items: unknown[],
  stages: Array<(prev: unknown, item: unknown, i: number) => unknown>,
  log: (message: string) => void,
): Promise<unknown[]> {
  if (!Array.isArray(items))
    throw new Error("pipeline() expects an array of items");
  if (items.length > MAX_FANOUT_ITEMS)
    throw new Error(
      `pipeline() accepts at most ${MAX_FANOUT_ITEMS} items; got ${items.length}`,
    );
  for (const stage of stages) {
    if (typeof stage !== "function")
      throw new Error(
        "pipeline() stages must be functions: pipeline(items, item => ..., result => ...)",
      );
  }
  return Promise.all(
    items.map(async (item, index) => {
      let value: unknown = item;
      try {
        for (const stage of stages) {
          if (value === null) break;
          value = await stage(value, item, index);
        }
      } catch (error) {
        log(`pipeline[${index}] failed: ${errorText(error)}`);
        return null;
      }
      return value === undefined ? null : value;
    }),
  );
}

export interface ActiveRun {
  details: WorkflowDetails;
  controller: RunController;
  completion?: Promise<void>;
}

type ToolUpdate = {
  content: Array<{ type: "text"; text: string }>;
  details: WorkflowDetails;
};

/**
 * Internal spec: the shared `LaunchSpec` plus tool-only extras. `code-review`
 * calls through the narrower shared contract and never sets these.
 */
export interface InternalLaunchSpec<T> extends LaunchSpec<T> {
  /** Prior-run journal replay (the `workflow` tool's resume feature). */
  resumePlan?: ReturnType<typeof createResumePlan>;
  /** Extra files written to the run dir (e.g. `script.js`, `args.json`). */
  extraArtifacts?: Record<string, string>;
  /** Abort source for a blocking run (the tool's execute signal). */
  signal?: AbortSignal;
  /** Tool-block progress sink for a blocking run. */
  onToolUpdate?: (update: ToolUpdate) => void;
}

export interface InternalRunHandle<T> extends WorkflowRunHandle<T> {
  details: WorkflowDetails;
  runDir: string;
}

export interface LaunchDeps {
  pi: ExtensionAPI;
  activeRuns: Map<string, ActiveRun>;
  updateIndicator: () => void;
  recordSettledRun: (status: WorkflowDetails["status"]) => void;
  setLastUi: (ui: ExtensionContext["ui"]) => void;
  runAgent: typeof runAgent;
  createResources: typeof createWorkflowResources;
  /** Injectable delegation config for tests; defaults to the file-backed loader. */
  loadDelegationConfig?: () => DelegationConfig;
}

function toOutcome<T>(details: WorkflowDetails, runId: string): RunOutcome<T> {
  const status =
    details.status === "completed"
      ? "completed"
      : details.status === "aborted"
        ? "aborted"
        : "failed";
  return {
    status,
    result: details.result as T,
    ...(details.error ? { error: details.error } : {}),
    runId,
  };
}

export function createLaunch(deps: LaunchDeps) {
  const { pi, activeRuns, updateIndicator, recordSettledRun, setLastUi } = deps;
  const readDelegationConfig =
    deps.loadDelegationConfig ?? loadDelegationConfig;

  return function launch<T>(
    spec: InternalLaunchSpec<T>,
    ctx: ExtensionContext,
  ): InternalRunHandle<T> {
    const delivery = spec.delivery ?? "model-followup";
    const background = spec.background ?? true;
    const meta = spec.meta;
    const runId = `wf_${randomBytes(6).toString("hex")}`;
    const runDir = path.join(getAgentDir(), "workflows", runId);

    const budget = new WorkflowBudget(
      typeof spec.budgetTokens === "number" && spec.budgetTokens > 0
        ? Math.floor(spec.budgetTokens)
        : loadDefaultBudget(),
    );
    const resumePlan = spec.resumePlan ?? createResumePlan([]);

    const details: WorkflowDetails = {
      runId,
      sessionId: ctx.sessionManager.getSessionId(),
      name: meta.name,
      description: meta.description,
      background,
      status: "running",
      startedAt: Date.now(),
      phases: [...meta.phases],
      agents: [],
    };

    for (const [name, content] of Object.entries(spec.extraArtifacts ?? {}))
      writeRunFile(runDir, name, content);
    persistWorkflowJson(runDir, details);
    const persistence = createWorkflowPersistence(runDir, details);

    // Background runs survive Esc on the parent turn, but all runs are aborted
    // and settled during session shutdown.
    const controller = new RunController(background ? undefined : spec.signal);

    // Each concurrent child gets its own extension runtime. All children use
    // the parent cwd and live trust decision.
    const projectTrusted = ctx.isProjectTrusted();
    const getResources = (structured: boolean) =>
      deps.createResources(
        ctx.cwd,
        structured ? "structured" : "plain",
        projectTrusted,
      );

    // Throttled progress: tool-block updates when blocking. Background runs are
    // covered by the below-editor indicator and /workflows.
    let emitTimer: ReturnType<typeof setTimeout> | undefined;
    let lastEmit = 0;
    const flush = () => {
      emitTimer = undefined;
      lastEmit = Date.now();
      if (background) return;
      spec.onToolUpdate?.({
        content: [{ type: "text", text: summaryLine(details) }],
        details: compactToolDetails(details),
      });
    };
    const emit = (checkpoint = true) => {
      if (checkpoint) persistence.checkpoint();
      if (emitTimer) return;
      emitTimer = setTimeout(
        flush,
        Math.max(0, EMIT_INTERVAL_MS - (Date.now() - lastEmit)),
      );
    };
    const flushNow = () => {
      if (emitTimer) clearTimeout(emitTimer);
      flush();
    };

    const phaseFn = (title: unknown) => {
      const text = String(title);
      details.currentPhase = text;
      if (!details.phases.some((p) => p.title === text))
        details.phases.push({ title: text });
      emit();
    };

    const logFn = (message: string) => {
      (details.logs ??= []).push(message);
      emit();
    };

    let agentCounter = 0;
    const agentFn = async (
      promptValue: unknown,
      optsValue: unknown = {},
      invocationSignal?: AbortSignal,
    ): Promise<ScriptAgentResult> => {
      const index = ++agentCounter;
      const opts: AgentCallOptions =
        optsValue && typeof optsValue === "object"
          ? (optsValue as AgentCallOptions)
          : {};
      const label =
        typeof opts.label === "string" && opts.label.trim()
          ? opts.label.trim().slice(0, 160)
          : `agent-${index}`;

      const phase =
        typeof opts.phase === "string"
          ? opts.phase.slice(0, 160)
          : details.currentPhase;
      const prompt = buildWorkflowAgentPrompt(
        typeof promptValue === "string"
          ? promptValue
          : String(promptValue ?? ""),
      );
      const key = callKey(prompt, opts);

      // Replay serves the unchanged prefix without spending a slot or a call.
      const cached = resumePlan.take(index - 1, key);
      if (cached) {
        const result = cached.result;
        const now = Date.now();
        details.agents.push({
          index,
          label,
          ...(phase ? { phase } : {}),
          state: result === null ? "error" : "done",
          startedAt: now,
          finishedAt: now,
          cached: true,
          preview: previewOf(result),
          usage: emptyUsage(),
          transcript: [],
        });
        appendJournalEntry(runDir, {
          index: index - 1,
          key,
          label,
          ...(phase ? { phase } : {}),
          result,
        });
        persistence.checkpoint({ immediate: true });
        emit(false);
        return result;
      }

      // Tier resolution: omitted means `standard`. Explicit
      // model/provider/effort is the override path and bypasses tiers. It runs
      // before the record exists so an agent that is still queued for a slot,
      // or rejected outright, reports its own target rather than the parent
      // session's model.
      type AgentTarget =
        | {
            readonly ok: true;
            readonly model: WorkflowModel | undefined;
            readonly thinkingLevel: ThinkingLevel;
            readonly tier?: DelegationTier;
            readonly requestedModel?: string;
          }
        | { readonly ok: false; readonly error: string };

      const resolveAgentTarget = (): AgentTarget => {
        const reject = (error: string): AgentTarget => ({ ok: false, error });
        const hasExplicitTarget =
          opts.model !== undefined ||
          opts.provider !== undefined ||
          opts.effort !== undefined;
        let tier: DelegationTier | undefined;
        if (opts.tier !== undefined) {
          const raw =
            typeof opts.tier === "string" ? opts.tier : String(opts.tier);
          if (!(DELEGATION_TIERS as readonly string[]).includes(raw))
            return reject(
              `agent "${label}": invalid tier "${raw}" (use ${DELEGATION_TIERS.join("|")})`,
            );
          tier = raw as DelegationTier;
        }
        if (tier !== undefined && hasExplicitTarget)
          return reject(
            `agent "${label}": tier "${tier}" cannot be combined with an explicit model, provider, or effort`,
          );

        let model: WorkflowModel | undefined;
        let thinkingLevel: ThinkingLevel;
        let requestedModel: string | undefined;
        if (tier === undefined && hasExplicitTarget) {
          // Default to the configured subagent model, not the parent
          // session's, so fan-out does not run expensive interactive models.
          const defaultModel = resolveDefaultAgentModel(ctx);
          if (!defaultModel) {
            const configured = loadSubagentModels().pi;
            return reject(
              `agent "${label}": default subagent model "${configured.provider}/${configured.model}" is not available. Run /subagent-model to pick another.`,
            );
          }
          model = defaultModel;
          if (opts.model !== undefined || opts.provider !== undefined) {
            const modelOpt =
              typeof opts.model === "string" ? opts.model : undefined;
            const providerOpt =
              typeof opts.provider === "string" ? opts.provider : undefined;
            if (!modelOpt)
              return reject(
                `agent "${label}": \`provider\` requires \`model\` as well`,
              );
            const resolution = resolveModelOption(
              ctx.modelRegistry,
              modelOpt,
              providerOpt,
              loadRegistrySettings().modelAliases,
            );
            if (resolution.kind === "unknown") {
              const requested = providerOpt
                ? `${providerOpt}/${modelOpt}`
                : modelOpt;
              return reject(
                resolution.brokenAliasTarget
                  ? `agent "${label}": model alias "${modelOpt}" targets "${resolution.brokenAliasTarget}", which is not in the model registry (fix modelAliases in workflows.json)`
                  : `agent "${label}": unknown model "${requested}" (use provider/id)`,
              );
            }
            if (resolution.kind === "exact") {
              if (exceedsCostCeiling(resolution.model.cost)) {
                return reject(
                  `agent "${label}": ` +
                    costCeilingMessage({
                      label: `${resolution.model.provider}/${resolution.model.id}`,
                      cost: resolution.model.cost,
                      alternatives: affordableAgentModels(ctx),
                    }),
                );
              }
              model = resolution.model;
            } else {
              // "alias": user-configured intent — no cost ceiling. "default":
              // known CC alias with no mapping — keep the subagent default.
              if (resolution.kind === "alias") model = resolution.model;
              requestedModel = resolution.alias;
            }
          }
          // Effort → thinking level; default inherits the parent session.
          thinkingLevel = pi.getThinkingLevel();
          if (opts.effort !== undefined) {
            const effort = String(opts.effort);
            if (!(THINKING_LEVELS as readonly string[]).includes(effort)) {
              return reject(
                `agent "${label}": invalid effort "${effort}" (use ${THINKING_LEVELS.join("|")})`,
              );
            }
            thinkingLevel = effort as ThinkingLevel;
          }
        } else {
          let resolved: ResolvedDelegationTarget;
          try {
            resolved = resolveDelegationTarget({
              config: readDelegationConfig(),
              selection: tier === undefined ? {} : { tier },
              supportedHarnesses: ["pi"],
            });
          } catch (error) {
            return reject(`agent "${label}": ${errorText(error)}`);
          }
          if (resolved.harness !== "pi")
            return reject(
              `agent "${label}": the workflow runner supports only the pi harness`,
            );
          const provider = resolved.provider!;
          const found = ctx.modelRegistry.find(provider, resolved.model);
          if (!found)
            return reject(
              `agent "${label}": tier "${resolved.source.kind === "tier" ? resolved.source.tier : "explicit"}" model "${provider}/${resolved.model}" is not available. Run /subagent-model to pick another.`,
            );
          model = found;
          thinkingLevel = resolved.effort as ThinkingLevel;
          if (resolved.source.kind === "tier") {
            tier = resolved.source.tier;
            requestedModel = resolved.source.tier;
          }
        }
        return { ok: true, model, thinkingLevel, tier, requestedModel };
      };

      const target = resolveAgentTarget();

      const record: AgentRecord = {
        index,
        label,
        phase,
        state: "running",
        startedAt: Date.now(),
        preview: "",
        usage: emptyUsage(),
        transcript: [],
      };
      if (target.ok) {
        record.model = target.model?.id;
        record.contextWindow = target.model?.contextWindow;
        record.effort = target.thinkingLevel;
        if (target.tier !== undefined) record.tier = target.tier;
        if (target.requestedModel !== undefined)
          record.requestedModel = target.requestedModel;
      }
      details.agents.push(record);
      persistence.checkpoint({ immediate: true });
      emit(false);

      const journal = (result: ScriptAgentResult) => {
        appendJournalEntry(runDir, {
          index: index - 1,
          key,
          label,
          ...(phase ? { phase } : {}),
          result,
        });
        return result;
      };

      // A failed agent resolves to null; the reason lives on the run record and
      // in the completion report, not in the caller's value.
      const fail = (error: string): ScriptAgentResult => {
        record.state = "error";
        record.error = error;
        record.finishedAt = Date.now();
        emit();
        return journal(null);
      };

      // A hard ceiling: this rejection surfaces as a throw inside the script.
      budget.assertAvailable();

      if (!prompt.trim())
        return fail("agent() requires a non-empty prompt string");
      if (controller.signal.aborted)
        return fail("Workflow was aborted before this agent started");
      if (!target.ok) return fail(target.error);

      const { model, thinkingLevel } = target;

      return controller
        .schedule(async (runSignal) => {
          let childCwd = ctx.cwd;
          let worktree: Awaited<ReturnType<typeof createWorktree>> | undefined;
          if (opts.isolation === "worktree") {
            if (!(await isGitRepo(ctx.cwd)))
              return fail(
                `agent "${label}": isolation: 'worktree' requires a git repository`,
              );
            try {
              worktree = await createWorktree({
                cwd: ctx.cwd,
                runId,
                agentIndex: index,
                label,
              });
              childCwd = worktree.path;
              record.worktree = worktree.path;
              emit();
            } catch (error) {
              return fail(
                `agent "${label}": could not create worktree — ${errorText(error)}`,
              );
            }
          }

          const resources = await getResources(opts.schema !== undefined);
          const outcome = await deps.runAgent({
            prompt,
            schema: opts.schema,
            model,
            thinkingLevel,
            cwd: childCwd,
            loader: resources.loader,
            settingsManager: resources.settingsManager,
            modelRegistry: ctx.modelRegistry,
            signal: runSignal,
            onProgress: (progress) => {
              record.preview = progress.preview.slice(0, PREVIEW_LENGTH);
              record.usage = progress.usage;
              record.model = progress.model ?? record.model;
              record.contextWindow =
                progress.contextWindow ?? record.contextWindow;
              record.transcript = progress.transcript;
              emit();
            },
          });

          if (worktree) {
            const released = await worktree.release();
            if (released.removed) delete record.worktree;
            else
              logFn(
                `${label}: worktree kept at ${worktree.path} (${released.changedFiles < 0 ? "unreadable" : `${released.changedFiles} changed file(s)`})`,
              );
          }
          record.usage = outcome.usage;
          budget.add(outcome.usage.output);
          record.model = outcome.model ?? record.model;
          record.contextWindow = outcome.contextWindow ?? record.contextWindow;
          record.transcript = outcome.transcript;
          record.preview = (outcome.output || record.preview).slice(
            0,
            PREVIEW_LENGTH,
          );
          record.finishedAt = Date.now();
          record.state = outcome.ok ? "done" : "error";
          if (outcome.ok) {
            delete record.error;
          } else {
            record.error = outcome.error ?? "Agent failed";
          }
          emit();

          if (!outcome.ok) return journal(null);
          return journal(
            opts.schema !== undefined ? outcome.structured : outcome.output,
          );
        }, invocationSignal)
        .catch((error) => fail(errorText(error)));
    };

    const budgetView: OrchestrationDSL["budget"] = {
      get total() {
        return budget.total;
      },
      spent: () => budget.spent(),
      remaining: () => budget.remaining(),
    };

    const dsl: OrchestrationDSL = {
      agent: agentFn as OrchestrationDSL["agent"],
      parallel: inProcessParallel,
      pipeline: (items, ...stages) => inProcessPipeline(items, stages, logFn),
      phase: phaseFn,
      log: logFn,
      budget: budgetView,
      get signal() {
        return controller.signal;
      },
    };

    const runScript = async () => {
      let status: WorkflowDetails["status"] = "completed";
      try {
        details.result = await spec.orchestrate(dsl);
      } catch (error) {
        details.error = errorText(error);
        status = controller.signal.aborted ? "aborted" : "failed";
        controller.abort("Workflow orchestration failed");
      }

      const settled = await controller.settle({
        abort: status !== "completed",
      });
      if (!settled) {
        status = "failed";
        details.error = details.error
          ? `${details.error}; agent shutdown deadline exceeded`
          : "Agent shutdown deadline exceeded";
      }
      for (const record of details.agents) {
        if (record.state !== "running") continue;
        record.state = "error";
        record.error =
          record.error ?? "Agent did not settle before run cleanup";
        record.finishedAt = Date.now();
      }
      details.status = status;
      details.finishedAt = Date.now();
      try {
        persistence.flush();
      } catch (error) {
        details.status = "failed";
        details.error = `Artifact persistence failed: ${errorText(error)}`;
        throw new Error(details.error);
      } finally {
        flushNow();
      }
    };

    // Registered for /workflows visibility and session_shutdown abort; blocking
    // runs are watchable live from the dashboard too.
    const activeRun: ActiveRun = { details, controller };
    activeRuns.set(runId, activeRun);
    const completion = runScript();
    activeRun.completion = completion;
    if (ctx.hasUI) setLastUi(ctx.ui);
    updateIndicator();

    const sendFollowUp = delivery === "model-followup" && background;

    const settledPromise = new Promise<RunOutcome<T>>((resolve) => {
      void completion
        .catch((error) => {
          details.status = "failed";
          details.finishedAt = Date.now();
          details.error = details.error ?? errorText(error);
        })
        .finally(() => {
          activeRuns.delete(runId);
          recordSettledRun(details.status);
          updateIndicator();
          if (sendFollowUp) {
            try {
              pi.sendUserMessage(
                buildBackgroundWorkflowFollowUp({
                  runId,
                  status: details.status,
                  result: buildWorkflowResultMessage(details, runDir),
                }),
                { deliverAs: "followUp" },
              );
            } catch {
              // Session may be shutting down.
            }
          }
          resolve(toOutcome<T>(details, runId));
        });
    });

    return { runId, settled: settledPromise, details, runDir };
  };
}
