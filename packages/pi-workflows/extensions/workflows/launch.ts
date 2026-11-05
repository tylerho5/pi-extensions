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
  type SubagentModels,
} from "../shared/subagent-models.ts";
import {
  createWorkflowHeartbeat,
  createWorkflowPersistence,
  persistWorkflowJson,
  type WorkflowHeartbeat,
} from "./artifacts.ts";
import { loadDefaultBudget, WorkflowBudget } from "./budget.ts";
import { buildWorkflowCompletionDetails } from "./completion.ts";
import { DEFAULT_CONCURRENCY, RunController } from "./controller.ts";
import {
  appendJournalEntry,
  createResumePlan,
  type JournalEntry,
} from "./journal.ts";
import { resolveModelOption } from "./model-aliases.ts";
import { loadRegistrySettings } from "./registry.ts";
import {
  countStates,
  emptyUsage,
  type AgentRecord,
  type AgentUsage,
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
  type AgentOutcome,
  type RunAgentOptions,
  type ThinkingLevel,
  type WorkflowModel,
} from "./runner.ts";
import {
  callKey,
  legacyCallKey,
  safeStringify,
  writeFileAtomic,
} from "./serialization.ts";
import { createWorktree, isGitRepo } from "./worktree.ts";

const PREVIEW_LENGTH = 200;
const EMIT_INTERVAL_MS = 120;
const MAX_FANOUT_ITEMS = 4096;
/** Extra attempts after the first for an agent that keeps stalling. */
export const MAX_STALL_RETRIES = 5;

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
  requireWork?: unknown;
  stallMs?: unknown;
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

/** Fold one attempt's usage into an agent's cumulative total. */
function addUsage(total: AgentUsage, next: AgentUsage): void {
  total.input += next.input;
  total.output += next.output;
  total.cacheRead += next.cacheRead;
  total.cacheWrite += next.cacheWrite;
  total.cost += next.cost;
  total.turns += next.turns;
  if (next.contextTokens !== undefined)
    total.contextTokens = next.contextTokens;
}

/** The /subagents-menu pi default, shared with subagent spawns. */
function resolveDefaultAgentModel(
  ctx: ExtensionContext,
  loadModels: () => SubagentModels,
) {
  const configured = loadModels().pi;
  return ctx.modelRegistry.find(configured.provider, configured.model);
}

function affordableAgentModels(ctx: ExtensionContext) {
  return affordableModels(ctx.modelRegistry.getAvailable(), ctx.cwd).map(
    modelKey,
  );
}

function summaryLine(details: WorkflowDetails): string {
  const { done, failed, skipped, interrupted } = countStates(details);
  const settled = done + failed + skipped + interrupted;
  return `workflow ${details.name ?? details.runId}: ${settled}/${details.agents.length} agents${
    details.currentPhase ? ` · ${details.currentPhase}` : ""
  }`;
}

function writeRunFile(runDir: string, name: string, content: string) {
  writeFileAtomic(path.join(runDir, name), content);
}

export function compactToolDetails(details: WorkflowDetails): WorkflowDetails {
  const compact: WorkflowDetails = {
    ...details,
    agents: details.agents.map((agent) => ({ ...agent, transcript: [] })),
  };
  if (details.result !== undefined && !details.resultOmitted) {
    compact.result = JSON.parse(
      safeStringify(details.result, { maxBytes: 64 * 1024 }),
    );
  } else if (details.resultOmitted) {
    // Never carry a lossy stand-in next to the omission marker.
    delete compact.result;
  }
  return compact;
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
  stop(): void;
  pause(): void;
  skipAgent(index: number): boolean;
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
  /** Source run id when this launch resumes a prior run. */
  resumeFromRunId?: string;
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
  /** Injectable subagent-model config for tests; defaults to the file-backed loader. */
  loadSubagentModels?: () => SubagentModels;
  /** Settle deadline for the controller; tests use a short one. */
  settleTimeoutMs?: number;
  /** Injectable heartbeat factory for tests; defaults to the on-disk beat. */
  startHeartbeat?: (runDir: string) => WorkflowHeartbeat;
  /** Injectable journal writer for tests; defaults to appendJournalEntry. */
  appendJournal?: (runDir: string, entry: JournalEntry) => boolean;
}

function toOutcome<T>(details: WorkflowDetails, runId: string): RunOutcome<T> {
  const status =
    details.status === "completed" ||
    details.status === "aborted" ||
    details.status === "paused" ||
    details.status === "interrupted"
      ? details.status
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
  const readSubagentModels = deps.loadSubagentModels ?? loadSubagentModels;
  const startHeartbeat =
    deps.startHeartbeat ??
    ((runDir: string) => createWorkflowHeartbeat(runDir));

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
      ...(spec.resumeFromRunId
        ? { resumedFromRunId: spec.resumeFromRunId }
        : {}),
      sessionId: ctx.sessionManager.getSessionId(),
      name: meta.name,
      description: meta.description,
      background,
      status: "running",
      startedAt: Date.now(),
      phases: [...meta.phases],
      agents: [],
      resumable: true,
    };

    for (const [name, content] of Object.entries(spec.extraArtifacts ?? {}))
      writeRunFile(runDir, name, content);
    persistWorkflowJson(runDir, details);
    const persistence = createWorkflowPersistence(runDir, details);
    const writeJournal = deps.appendJournal ?? appendJournalEntry;
    const appendJournal = (entry: JournalEntry) => {
      if (writeJournal(runDir, entry)) return true;
      details.resumable = false;
      details.resumeError = "Workflow journal could not be written completely";
      persistence.checkpoint({ immediate: true });
      return false;
    };

    // Background runs survive Esc on the parent turn, but all runs are aborted
    // and settled during session shutdown.
    const controller = new RunController(background ? undefined : spec.signal);

    let controlRequest: "stop" | "pause" | undefined;
    const agentAbortControllers = new Map<number, AbortController>();
    const repeatedStopHandlers = new Map<number, () => void>();

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
    let previousCallKey: string | undefined;
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
      let key: string;
      try {
        key = callKey(prompt, opts, previousCallKey);
      } catch (error) {
        details.resumable = false;
        details.resumeError = errorText(error);
        persistence.checkpoint({ immediate: true });
        throw error;
      }
      previousCallKey = key;
      const oldKey = legacyCallKey(prompt, opts);

      // Replay serves only complete results from an unchanged call prefix.
      const cached = resumePlan.take(index - 1, key, oldKey);
      if (cached) {
        const result = cached.result;
        const now = Date.now();
        details.agents.push({
          index,
          label,
          ...(phase ? { phase } : {}),
          state: "done",
          startedAt: now,
          finishedAt: now,
          cached: true,
          preview: previewOf(result),
          usage: emptyUsage(),
          transcript: [],
        });
        const base = {
          version: 2 as const,
          index: index - 1,
          key,
          label,
          ...(phase ? { phase } : {}),
          attempt: 1,
        };
        appendJournal({ ...base, type: "started" });
        appendJournal({ ...base, type: "result", result });
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
          const withDefaultModel = (): AgentTarget | undefined => {
            const defaultModel = resolveDefaultAgentModel(
              ctx,
              readSubagentModels,
            );
            if (defaultModel) {
              model = defaultModel;
              return undefined;
            }
            const configured = readSubagentModels().pi;
            return reject(
              `agent "${label}": default subagent model "${configured.provider}/${configured.model}" is not available. Run /subagents-menu to pick another.`,
            );
          };
          // An explicit model or provider stands on its own: the configured
          // default is only a fallback for an effort-only override or an
          // unmapped CC alias, so an unavailable default cannot sink a call
          // that named its own target.
          if (opts.model === undefined && opts.provider === undefined) {
            const failure = withDefaultModel();
            if (failure) return failure;
          } else {
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
            } else if (resolution.kind === "alias") {
              // User-configured intent — no cost ceiling.
              model = resolution.model;
              requestedModel = resolution.alias;
            } else {
              // Known CC alias with no mapping — keep the subagent default.
              const failure = withDefaultModel();
              if (failure) return failure;
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
              `agent "${label}": tier "${resolved.source.kind === "tier" ? resolved.source.tier : "explicit"}" model "${provider}/${resolved.model}" is not available. Run /subagents-menu to pick another.`,
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

      const journalBase = (attempt: number) => ({
        version: 2 as const,
        index: index - 1,
        key,
        label,
        ...(phase ? { phase } : {}),
        attempt,
      });
      const startAttempt = (attempt: number) =>
        appendJournal({ ...journalBase(attempt), type: "started" });
      const failAttempt = (
        attempt: number,
        error: string,
        failureKind: "stall" | "aborted" | "error" = "error",
        skipped = false,
      ) =>
        appendJournal({
          ...journalBase(attempt),
          type: "failed",
          error,
          failureKind,
          ...(skipped ? { skipped: true as const } : {}),
        });
      const recordResult = (attempt: number, result: unknown) =>
        result === null || result === undefined
          ? failAttempt(attempt, "Agent returned no result")
          : appendJournal({ ...journalBase(attempt), type: "result", result });

      record.attempts = 1;
      startAttempt(1);
      const finishAgent = (
        state: AgentRecord["state"],
        error: string,
      ): ScriptAgentResult => {
        record.state = state;
        record.error = error;
        record.finishedAt = Date.now();
        failAttempt(
          record.attempts ?? 1,
          error,
          state === "interrupted" || state === "skipped" ? "aborted" : "error",
          state === "skipped",
        );
        emit();
        return null;
      };
      const fail = (error: string) => finishAgent("error", error);

      // A hard ceiling: this rejection surfaces as a throw inside the script.
      try {
        budget.assertAvailable();
      } catch (error) {
        finishAgent("error", errorText(error));
        throw error;
      }

      if (!prompt.trim())
        return fail("agent() requires a non-empty prompt string");
      if (controller.signal.aborted)
        return finishAgent(
          "interrupted",
          "Run stopped before this agent started",
        );
      if (!target.ok) return fail(target.error);

      const stallMs = opts.stallMs;
      if (
        stallMs !== undefined &&
        (typeof stallMs !== "number" ||
          !Number.isFinite(stallMs) ||
          stallMs <= 0)
      ) {
        return fail(
          `agent "${label}": stallMs must be a positive number of milliseconds`,
        );
      }

      const { model, thinkingLevel } = target;
      const skipController = new AbortController();
      agentAbortControllers.set(index, skipController);
      const taskInvocationSignal = invocationSignal
        ? AbortSignal.any([invocationSignal, skipController.signal])
        : skipController.signal;

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
          const runOptions: RunAgentOptions = {
            prompt,
            schema: opts.schema,
            model,
            thinkingLevel,
            cwd: childCwd,
            loader: resources.loader,
            settingsManager: resources.settingsManager,
            modelRegistry: ctx.modelRegistry,
            signal: runSignal,
            ...(opts.requireWork === true ? { requireWork: true } : {}),
            ...(stallMs !== undefined ? { stallTimeoutMs: stallMs } : {}),
            registerRepeatedStop: (resignal) => {
              repeatedStopHandlers.set(index, resignal);
              return () => {
                if (repeatedStopHandlers.get(index) === resignal)
                  repeatedStopHandlers.delete(index);
              };
            },
            onProgress: (progress) => {
              record.preview = progress.preview.slice(0, PREVIEW_LENGTH);
              record.usage = progress.usage;
              record.model = progress.model ?? record.model;
              record.contextWindow =
                progress.contextWindow ?? record.contextWindow;
              record.transcript = progress.transcript;
              emit();
            },
          };

          // A stalled attempt is retried serially, up to five times after the
          // first. runAgent awaits its child's shutdown, so the next attempt
          // cannot start before the previous one has exited.
          let outcome: AgentOutcome;
          let attempts = 0;
          const totalUsage = emptyUsage();
          do {
            attempts += 1;
            record.attempts = attempts;
            if (attempts > 1) startAttempt(attempts);
            outcome = await deps.runAgent(runOptions);
            addUsage(totalUsage, outcome.usage);
            budget.add(outcome.usage.output);
            if (!outcome.ok) {
              const skipped = skipController.signal.aborted;
              failAttempt(
                attempts,
                skipped ? "Skipped by user" : (outcome.error ?? "Agent failed"),
                skipped
                  ? "aborted"
                  : (outcome.failureKind ??
                      (outcome.aborted ? "aborted" : "error")),
                skipped,
              );
            }
          } while (
            !outcome.ok &&
            outcome.failureKind === "stall" &&
            attempts <= MAX_STALL_RETRIES &&
            !runSignal.aborted
          );
          if (worktree) {
            const released = await worktree.release();
            if (released.removed) delete record.worktree;
            else {
              const parts: string[] = [];
              if (released.changedFiles < 0) parts.push("unreadable");
              else {
                if (released.commits > 0)
                  parts.push(`${released.commits} new commit(s)`);
                if (released.changedFiles > 0)
                  parts.push(`${released.changedFiles} changed file(s)`);
                if (parts.length === 0) parts.push("no file changes");
              }
              logFn(
                `${label}: worktree kept on branch ${released.branch} at ${worktree.path} (${parts.join(", ")})`,
              );
            }
          }
          record.usage = totalUsage;
          record.model = outcome.model ?? record.model;
          record.contextWindow = outcome.contextWindow ?? record.contextWindow;
          record.transcript = outcome.transcript;
          record.preview = (outcome.output || record.preview).slice(
            0,
            PREVIEW_LENGTH,
          );
          record.finishedAt = Date.now();
          if (outcome.ok) {
            record.state = "done";
            delete record.error;
          } else if (skipController.signal.aborted) {
            record.state = "skipped";
            record.error = "Skipped by user";
          } else if (
            outcome.aborted ||
            outcome.failureKind === "aborted" ||
            runSignal.aborted ||
            controller.signal.aborted
          ) {
            record.state = "interrupted";
            record.error =
              outcome.error ?? "Run stopped before this agent settled";
          } else {
            record.state = "error";
            record.error = outcome.error ?? "Agent failed";
          }
          emit();

          if (record.state !== "done") return null;
          const result =
            opts.schema !== undefined ? outcome.structured : outcome.output;
          recordResult(attempts, result);
          return result;
        }, taskInvocationSignal)
        .catch((error) => {
          if (record.state === "skipped" || record.state === "interrupted")
            return null;
          if (skipController.signal.aborted)
            return finishAgent("skipped", "Skipped by user");
          if (controller.signal.aborted || invocationSignal?.aborted)
            return finishAgent("interrupted", errorText(error));
          return fail(errorText(error));
        })
        .finally(() => agentAbortControllers.delete(index));
    };

    const budgetView: OrchestrationDSL["budget"] = {
      get total() {
        return budget.total;
      },
      spent: () => budget.spent(),
      remaining: () => budget.remaining(),
    };

    const requestControl = (control: "stop" | "pause") => {
      if (details.status !== "running" && details.status !== "stopping") return;
      if (controlRequest === "stop" && control === "pause") return;
      const repeatedStop = control === "stop" && controller.signal.aborted;
      controlRequest = control;
      details.status = "stopping";
      details.finishedAt = undefined;
      delete details.error;
      persistence.checkpoint({ immediate: true });
      emit(false);
      controller.abort(
        control === "pause"
          ? "Workflow paused by user"
          : "Workflow stopped by user",
      );
      if (repeatedStop) {
        for (const resignal of repeatedStopHandlers.values()) {
          try {
            resignal();
          } catch {
            // A child that already disposed cannot accept another abort.
          }
        }
      }
      updateIndicator();
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
        if (!controlRequest) details.error = errorText(error);
        status = controlRequest
          ? controlRequest === "pause"
            ? "paused"
            : "aborted"
          : controller.signal.aborted
            ? "aborted"
            : "failed";
        if (!controlRequest) controller.abort("Workflow orchestration failed");
      }
      if (controlRequest)
        status = controlRequest === "pause" ? "paused" : "aborted";
      else if (controller.signal.aborted && status === "completed")
        status = "aborted";

      const settled = await controller.settle({
        abort: status !== "completed" || controller.signal.aborted,
        timeoutMs: deps.settleTimeoutMs,
      });
      if (!settled) {
        if (!controlRequest) {
          status = "failed";
          details.error = details.error
            ? `${details.error}; agent shutdown deadline exceeded`
            : "Agent shutdown deadline exceeded";
          controller.abort("Agent shutdown deadline exceeded");
        }
        details.status = "stopping";
        details.finishedAt = undefined;
        persistence.checkpoint({ immediate: true });
        emit(false);
        updateIndicator();
        await controller.whenDrained();
        if (controlRequest)
          status = controlRequest === "pause" ? "paused" : "aborted";
      }
      const { failed } = countStates(details);
      if (
        status === "completed" &&
        details.agents.length > 0 &&
        failed === details.agents.length
      ) {
        const firstError = details.agents.find(
          (agent) => agent.state === "error",
        )?.error;
        details.error = `All ${failed} agents failed${firstError ? `: ${firstError}` : ""}`;
        status = "failed";
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
    const heartbeat = startHeartbeat(runDir);
    const activeRun: ActiveRun = {
      details,
      controller,
      stop: () => requestControl("stop"),
      pause: () => requestControl("pause"),
      skipAgent: (index) => {
        const record = details.agents.find((agent) => agent.index === index);
        const abortController = agentAbortControllers.get(index);
        if (
          details.status !== "running" ||
          record?.state !== "running" ||
          !abortController ||
          abortController.signal.aborted
        ) {
          return false;
        }
        abortController.abort(new Error("Agent skipped by user"));
        return true;
      },
    };
    activeRuns.set(runId, activeRun);
    const completion = runScript();
    activeRun.completion = completion;
    if (ctx.hasUI) setLastUi(ctx.ui);
    updateIndicator();

    const sendFollowUp = delivery === "model-followup" && background;
    const reportPath = path.join(runDir, "report.md");

    // Record a rejection instead of retrying: a resend can duplicate a
    // follow-up the session may already have accepted.
    const persistDeliveryFailure = (error: unknown) => {
      details.deliveryFailure = { error: errorText(error), reportPath };
      try {
        persistence.flush();
      } catch {
        // Keep the failure visible in memory if the artifact is read-only.
      }
    };

    const settledPromise = new Promise<RunOutcome<T>>((resolve) => {
      void completion
        .catch((error) => {
          details.status = "failed";
          details.finishedAt = Date.now();
          details.error = details.error ?? errorText(error);
        })
        .finally(() => {
          heartbeat.stop();
          activeRuns.delete(runId);
          recordSettledRun(details.status);
          updateIndicator();
          try {
            writeFileAtomic(
              reportPath,
              buildWorkflowResultMessage(details, runDir),
            );
          } catch {
            // A read-only run dir must not fail delivery or settlement.
          }
          if (sendFollowUp) {
            try {
              const sent = (
                pi.sendMessage as unknown as (
                  message: unknown,
                  options: unknown,
                ) => unknown
              )(
                {
                  customType: "workflow-completion",
                  display: true,
                  // Byte-identical to the plain user message this replaced;
                  // the renderer reads details instead of painting content.
                  content: buildBackgroundWorkflowFollowUp({
                    runId,
                    status: details.status,
                    result: buildWorkflowResultMessage(details, runDir),
                  }),
                  details: buildWorkflowCompletionDetails(details, runDir),
                },
                { deliverAs: "followUp", triggerTurn: true },
              );
              // A late rejection is recorded but never retried; the run must
              // not wait on a follow-up turn to settle.
              if (
                sent &&
                typeof (sent as Promise<unknown>).then === "function"
              ) {
                void Promise.resolve(sent).catch(persistDeliveryFailure);
              }
            } catch (error) {
              persistDeliveryFailure(error);
            }
          }
          resolve(toOutcome<T>(details, runId));
        });
    });

    return { runId, settled: settledPromise, details, runDir };
  };
}
