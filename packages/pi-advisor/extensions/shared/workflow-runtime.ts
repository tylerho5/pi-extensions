/**
 * Cross-extension seam for the workflow orchestration runtime. The `workflows`
 * extension registers its `launch` implementation here on load; consumers
 * (`workflows`' own `workflow` tool, `code-review`) resolve it via
 * `getWorkflowRuntime()` and drive a tracked run through `launch(...)`. Import-
 * free like the other `shared/` leaves — only the pi `ExtensionContext` type.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface AgentOptions {
  label?: string;
  phase?: string;
  schema?: unknown;
  model?: string;
  provider?: string;
  effort?: string;
}

export interface BudgetView {
  total: number | null;
  spent(): number;
  remaining(): number;
}

/**
 * The orchestration surface handed to a run's `orchestrate` callback. Mirrors
 * the workflow script DSL (agent/parallel/pipeline/phase/log/budget) but as a
 * plain TypeScript API, so an in-process orchestrator can drive the same
 * tracked-run machinery the sandbox path uses.
 */
export interface OrchestrationDSL {
  agent(prompt: string, opts?: AgentOptions): Promise<string | unknown | null>;
  parallel<T>(
    thunks: Array<() => Promise<T>>,
    opts?: { concurrency?: number },
  ): Promise<Array<T | null>>;
  pipeline(
    items: unknown[],
    ...stages: Array<(prev: unknown, item: unknown, i: number) => unknown>
  ): Promise<unknown[]>;
  phase(title: string): void;
  log(message: string): void;
  budget: BudgetView;
  /** The run's abort signal; a sandbox core needs it, a TS engine may ignore it. */
  signal: AbortSignal;
}

export interface WorkflowPhase {
  title: string;
  detail?: string;
}

export interface WorkflowMeta {
  /** Optional: a name-less workflow script falls back to its run id. */
  name?: string;
  description?: string;
  phases: WorkflowPhase[];
}

export type RunStatus = "completed" | "failed" | "aborted";

export interface RunOutcome<T> {
  status: RunStatus;
  result?: T;
  error?: string;
  runId: string;
}

/**
 * `model-followup` reproduces the existing `workflow` tool behavior (background
 * → follow-up message; blocking → await + throw on non-completed).
 * `programmatic` suppresses the follow-up and resolves `settled` with the
 * outcome so the caller presents results itself; the run still background-tracks
 * in `/workflows`.
 */
export type DeliveryMode = "model-followup" | "programmatic";

export interface LaunchSpec<T> {
  meta: WorkflowMeta;
  background?: boolean;
  budgetTokens?: number;
  delivery?: DeliveryMode;
  orchestrate: (dsl: OrchestrationDSL) => Promise<T>;
}

export interface WorkflowRunHandle<T> {
  runId: string;
  settled: Promise<RunOutcome<T>>;
}

export interface WorkflowRuntime {
  launch<T>(spec: LaunchSpec<T>, ctx: ExtensionContext): WorkflowRunHandle<T>;
}

// The runtime is held on `globalThis`, not in a module-level variable. pi's
// extension loader creates a fresh jiti instance per extension with
// `moduleCache: false`, so a module singleton would be a *different* object in
// each importing extension: `workflows` registers into one instance while
// `code-review` reads a different, still-empty one. `globalThis` is
// process-global, so the registration survives module duplication.
const RUNTIME_KEY = Symbol.for("pi.shared.workflow-runtime");

type RuntimeGlobal = typeof globalThis & {
  [key: symbol]: WorkflowRuntime | undefined;
};

const g = globalThis as RuntimeGlobal;

export function registerWorkflowRuntime(runtime: WorkflowRuntime): void {
  g[RUNTIME_KEY] = runtime;
}

export function getWorkflowRuntime(): WorkflowRuntime | undefined {
  return g[RUNTIME_KEY];
}

/** Test helper: drop the registered runtime so tests start from a clean slate. */
export function resetWorkflowRuntime(): void {
  g[RUNTIME_KEY] = undefined;
}
