/**
 * SubagentManager — owns the registry of running/finished subagents.
 *
 * Each subagent is a scoped `SubagentSession` from a `SubagentBackend` plus a
 * pump fiber that folds its normalized event stream into a mutable
 * `SubagentSnapshot`. Closing a subagent's scope kills the underlying
 * session/process and stops the pump.
 *
 * The manager also exposes a synchronous `SubagentReadModel` so the
 * imperative TUI components (which render synchronously) can read snapshots
 * and issue fire-and-forget commands without touching the Effect runtime.
 */

import { randomUUID } from "node:crypto";
import type { DelegationIdentity } from "../../shared/child-delegation.ts";
import { DEFAULT_MAX_DEPTH, parseDepthArgument } from "./nesting-config.ts";
import {
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Result,
  Scope,
  Stream,
} from "effect";
import type { SubagentBackend, SubagentSession } from "./backend.ts";
import { BackendRegistry } from "./backend.ts";
import type {
  BackendName,
  LiveToolState,
  RunOutcome,
  SpawnTask,
  SubagentUsage,
  SubagentEvent,
  SubagentOrigin,
  SubagentMeta,
  SubagentRunRef,
  SubagentSnapshot,
  SubagentStatus,
  TranscriptItem,
} from "./domain.ts";
import {
  BackendUnavailableError,
  ConcurrencyLimitError,
  generateAgentId,
  SendError,
  SpawnError,
  validateSubagentName,
} from "./domain.ts";
import { reportRunning } from "../../shared/agent-activity.ts";
import { runRefKey } from "./result-delivery.ts";

export const MAX_RUNNING = 50;
// Finished child sessions remain enterable from the task-rail history for the
// lifetime of the parent session. The cap is a safety valve, not normal UI
// pagination; full transcripts are loaded lazily from each child's JSONL.
export const MAX_TRACKED = 4_096;
const STOP_TIMEOUT_MS = 5_000;
const ERROR_TEXT_MAX_LENGTH = 4_096;
const TRANSCRIPT_TEXT_MAX_LENGTH = 64 * 1_024;
const LIVE_ASSISTANT_MAX_LENGTH = 128 * 1_024;
const FINAL_TEXT_MAX_LENGTH = 1_024 * 1_024;
const MAX_TRANSCRIPT_ITEMS = 512;

function bounded(text: string) {
  return text.slice(0, ERROR_TEXT_MAX_LENGTH);
}

/**
 * Id slug for extension-generated titles (btw asides): lowercase alphanumerics
 * and hyphens only. Model-chosen names are used verbatim after validation; an
 * omitted name gets generateAgentId() instead.
 */
export function slugifyTitle(title: string) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return slug || "subagent";
}

function boundedTranscriptText(text: string) {
  return text.slice(0, TRANSCRIPT_TEXT_MAX_LENGTH);
}

function appendTranscript(snapshot: MutableSnapshot, item: TranscriptItem) {
  snapshot.transcript.push(item);
  if (snapshot.transcript.length > MAX_TRANSCRIPT_ITEMS) {
    snapshot.transcript.splice(
      0,
      snapshot.transcript.length - MAX_TRANSCRIPT_ITEMS,
    );
  }
}

// --- Internal state -----------------------------------------------------------

/** Mutable snapshot; exposed to readers via the readonly SubagentSnapshot type. */
interface MutableSnapshot {
  id: string;
  ancestry: DelegationIdentity;
  origin: SubagentOrigin;
  backend: BackendName;
  description: string;
  prompt: string;
  cwd: string;
  status: SubagentStatus;
  runSequence: number;
  createdAt: number;
  runStartedAt: number;
  settledAt?: number;
  errorText?: string;
  meta: SubagentMeta;
  usage: SubagentUsage;
  transcript: TranscriptItem[];
  liveAssistant?: { text: string; thinking: string };
  liveTools: LiveToolState[];
  queued: SubagentSnapshot["queued"];
  finalText: string;
  turns: number;
}

interface Entry {
  snapshot: MutableSnapshot;
  session: SubagentSession;
  scope: Scope.Closeable;
  pump?: Fiber.Fiber<void>;
  liveToolMap: Map<string, LiveToolState>;
  /** Idle restart dispatched but RunStarted not folded yet; counts as running
   * so concurrent restarts cannot race past the cap. */
  restarting?: boolean;
  /** The backend is in a turn the manager ignored (started after settle).
   * A resume steers into it, so no RunStarted will follow. */
  strayTurn?: boolean;
}

// --- Read model ----------------------------------------------------------------

/** Synchronous bridge for the TUI. Snapshots are live objects; do not mutate. */
export interface SubagentReadModel {
  list(): ReadonlyArray<SubagentSnapshot>;
  get(id: string): SubagentSnapshot | undefined;
  size(): number;
  /** Any-change notification (footer status, dashboard). */
  subscribe(listener: () => void): () => void;
  /** Per-subagent notification (takeover view). */
  subscribeTo(id: string, listener: () => void): () => void;
  /** Fire-and-forget: steer/continue a subagent (takeover input). */
  requestSend(
    id: string,
    text: string,
    onError?: (message: string) => void,
  ): void;
  /** Fire-and-forget: abort a running subagent (dashboard `x`, takeover). */
  requestAbort(id: string): void;
  /**
   * Register the settle hook. `consumed` is true when a foreground
   * spawn/cancel is collecting the result (so it must not also be
   * delivered as a follow-up message).
   */
  subscribeChildWork?(
    parentId: string | null,
    hook: (count: number) => void,
  ): () => void;
  subscribeSettled?(
    parentId: string | null,
    hook: (snap: SubagentSnapshot, consumed: boolean) => void,
  ): () => void;
  setOnSettled(
    hook: ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined,
  ): void;
}

// --- Service --------------------------------------------------------------------

export interface CancelResult {
  readonly id: string;
  readonly description: string;
  readonly status: SubagentStatus;
  readonly cancelled: boolean;
}

/** Outcome of a send: the run it belongs to, and whether it resumed a settled agent. */
export interface SendResult {
  readonly run: SubagentRunRef;
  readonly restarted: boolean;
}

/** Spawn-time behavior for the initial run's automatic delivery. */
export interface SpawnOptions {
  /** "claimed" registers wait interest for the initial run at spawn time. */
  readonly resultMode?: "automatic" | "claimed";
}

export interface SubagentOwner {
  readonly parentId: string | null;
  readonly spawn: SubagentManagerShape["spawn"];
  readonly get: SubagentManagerShape["get"];
  readonly list: SubagentManagerShape["list"];
  readonly send: SubagentManagerShape["send"];
  cancel(
    ids: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<CancelResult>, SendError>;
  waitForRun(ref: SubagentRunRef): Effect.Effect<void, SendError>;
  releaseRun(ref: SubagentRunRef): Effect.Effect<void, SendError>;
  subscribeChildWork(hook: (count: number) => void): () => void;
  subscribeSettled(
    hook: (snap: SubagentSnapshot, consumed: boolean) => void,
  ): () => void;
  readonly view: SubagentReadModel &
    Required<
      Pick<SubagentReadModel, "subscribeSettled" | "subscribeChildWork">
    >;
  closeChildren(): Effect.Effect<void>;
  /** False once this owner is settled, sealed, or closing; its child results are then dropped. */
  accepting(): boolean;
}

export interface SubagentManagerShape {
  forOwner(parentId: string | null): SubagentOwner;
  revokeOwner(parentId: string): Effect.Effect<void>;
  spawn(
    backend: BackendName,
    task: SpawnTask,
    options?: SpawnOptions,
  ): Effect.Effect<
    SubagentSnapshot,
    SpawnError | ConcurrencyLimitError | BackendUnavailableError
  >;
  /**
   * Wait until all listed subagents are settled. Unknown ids are treated as
   * settled (the tool layer validates ids first). While waiting, settles for
   * these ids are marked "consumed". Interruption (tool abort) releases the
   * interest and leaves the subagents running.
   */
  waitFor(
    ids: ReadonlyArray<string>,
    onPending?: (pending: string[]) => void,
  ): Effect.Effect<void>;
  /** Wait for one specific run; releases the caller's claim on exit. */
  waitForRun(ref: SubagentRunRef): Effect.Effect<void>;
  /** Release a claimed run without consuming it (aborted foreground wait). */
  releaseRun(ref: SubagentRunRef): Effect.Effect<void>;
  /** Cancel running subagents; resolves when they have settled. */
  cancel(
    ids: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<CancelResult>>;
  send(id: string, text: string): Effect.Effect<SendResult, SendError>;
  get(id: string): Effect.Effect<SubagentSnapshot | undefined>;
  readonly list: Effect.Effect<ReadonlyArray<SubagentSnapshot>>;
  readonly disposeAll: Effect.Effect<void>;
  readonly view: SubagentReadModel &
    Required<
      Pick<SubagentReadModel, "subscribeSettled" | "subscribeChildWork">
    >;
}

export class SubagentManager extends Context.Service<
  SubagentManager,
  SubagentManagerShape
>()("subagents/SubagentManager") {}

// --- Implementation --------------------------------------------------------------

/**
 * Ids that own at least one tracked descendant, computed with one parent read
 * per tracked node. Protected ancestors must never be pruned while work below
 * them is still live or undelivered.
 */
export function ancestorsWithDescendants(
  tree: ReadonlyMap<string, DelegationIdentity>,
): Set<string> {
  const protectedIds = new Set<string>();
  for (const id of tree.keys()) {
    const parentId = tree.get(id)?.parentId;
    if (parentId != null) protectedIds.add(parentId);
  }
  return protectedIds;
}

const makeManager = (maxDepth: number) =>
  Effect.gen(function* () {
    const registry = yield* BackendRegistry;
    const runDetached = Effect.runForkWith(yield* Effect.context());
    const rootId = randomUUID();
    const entries = new Map<string, Entry>();
    const ancestry = new Map<string, DelegationIdentity>();
    const pending = new Map<
      string,
      { fiber?: Fiber.Fiber<unknown, unknown> }
    >();
    const sealed = new Set<string>();
    /** Ids under an in-flight cancel; a resume must wait until it reports. */
    const cancelling = new Map<string, number>();
    const takenIds = new Set<string>();
    const waitInterest = new Map<string, number>();
    const listeners = new Set<() => void>();
    const idListeners = new Map<string, Set<() => void>>();
    const settledHooks = new Map<
      string | null,
      Set<(snap: SubagentSnapshot, consumed: boolean) => void>
    >();
    const childWorkHooks = new Map<
      string | null,
      Set<(count: number) => void>
    >();
    const lastChildWork = new Map<string | null, number>();
    const cleanups = new Set<Fiber.Fiber<unknown>>();
    let disposed = false;
    let onSettled:
      ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined;
    let changeWaiters: Array<() => void> = [];
    const notify = (id?: string) => {
      const waiters = changeWaiters;
      changeWaiters = [];
      for (const waiter of waiters) waiter();
      for (const listener of [
        ...listeners,
        ...(id ? (idListeners.get(id) ?? []) : []),
      ]) {
        try {
          listener();
        } catch {
          /* Reader failures do not change lifecycle. */
        }
      }
    };
    const nextChange = Effect.callback<void>((resume) => {
      const waiter = () => resume(Effect.void);
      changeWaiters.push(waiter);
      return Effect.sync(() => {
        changeWaiters = changeWaiters.filter((w) => w !== waiter);
      });
    });
    const currentRef = (entry: Entry): SubagentRunRef => ({
      id: entry.snapshot.id,
      runSequence: entry.snapshot.runSequence,
    });
    const hasInterest = (ref: SubagentRunRef) =>
      (waitInterest.get(runRefKey(ref)) ?? 0) > 0;
    const addInterest = (refs: ReadonlyArray<SubagentRunRef>) => {
      for (const ref of refs) {
        const key = runRefKey(ref);
        waitInterest.set(key, (waitInterest.get(key) ?? 0) + 1);
      }
    };
    const releaseInterest = (refs: ReadonlyArray<SubagentRunRef>) => {
      for (const ref of refs) {
        const key = runRefKey(ref),
          n = (waitInterest.get(key) ?? 1) - 1;
        if (n <= 0) waitInterest.delete(key);
        else waitInterest.set(key, n);
      }
    };
    const isRunPending = (ref: SubagentRunRef) => {
      const e = entries.get(ref.id);
      return (
        e?.snapshot.runSequence === ref.runSequence &&
        (e.snapshot.status === "running" || e.restarting === true)
      );
    };
    const runningCount = () =>
      [...entries.values()].filter(
        (e) => e.snapshot.status === "running" || e.restarting,
      ).length + pending.size;
    const childWorkCount = (parentId: string | null) =>
      [...pending.keys()].filter(
        (id) => ancestry.get(id)?.parentId === parentId,
      ).length +
      [...entries.values()].filter(
        (e) =>
          e.snapshot.ancestry.parentId === parentId &&
          (e.snapshot.status === "running" || e.restarting),
      ).length;
    const reportActivity = () => {
      reportRunning("subagents", runningCount());
      for (const [parentId, hooks] of childWorkHooks) {
        const count = childWorkCount(parentId);
        if (lastChildWork.get(parentId) === count) continue;
        lastChildWork.set(parentId, count);
        for (const hook of [...hooks]) {
          try {
            hook(count);
          } catch {
            /* Observer failure does not affect manager state. */
          }
        }
      }
    };
    const closeEntryScope = (entry: Entry) =>
      Scope.close(entry.scope, Exit.void).pipe(
        Effect.timeout(STOP_TIMEOUT_MS),
        Effect.ignore,
      );
    const belongsTo = (id: string, root: string) => {
      let current: string | null | undefined = id;
      while (current != null) {
        if (current === root) return true;
        current = ancestry.get(current)?.parentId;
      }
      return false;
    };
    const ownerOpen = (id: string | null) =>
      !disposed &&
      (id === null ||
        (!sealed.has(id) &&
          (pending.has(id) ||
            entries.get(id)?.snapshot.status === "running" ||
            entries.get(id)?.restarting === true)));
    const pruneSettled = () => {
      if (entries.size < MAX_TRACKED) return;
      const protectedIds = ancestorsWithDescendants(ancestry);
      const candidates = [...entries.values()]
        .filter(
          (e) =>
            e.snapshot.status !== "running" &&
            !e.restarting &&
            !hasInterest(currentRef(e)) &&
            !protectedIds.has(e.snapshot.id),
        )
        .sort(
          (a, b) =>
            (a.snapshot.settledAt ?? a.snapshot.createdAt) -
            (b.snapshot.settledAt ?? b.snapshot.createdAt),
        );
      for (const e of candidates) {
        if (entries.size < MAX_TRACKED) break;
        entries.delete(e.snapshot.id);
        ancestry.delete(e.snapshot.id);
        const fiber = runDetached(closeEntryScope(e));
        cleanups.add(fiber);
        fiber.addObserver(() => cleanups.delete(fiber));
      }
    };
    /** Open the restarted run whose RunStarted has not been folded yet. */
    /**
     * Accept the restarted run as live without its RunStarted (an interrupt
     * or stream end got there first), so it settles under its own ref.
     */
    const openPendingRun = (entry: Entry) => {
      entry.restarting = false;
    };
    const settle = (entry: Entry, outcome: RunOutcome, errorText?: string) => {
      const s = entry.snapshot;
      // A terminal event folded before a restart's RunStarted belongs to the
      // previous run (FIFO), so the restarted run stays live.
      if (s.status !== "running" || entry.restarting) {
        if (s.status !== "running") entry.strayTurn = false;
        reportActivity();
        return;
      }
      entry.restarting = false;
      if (outcome._tag !== "Completed") {
        sealed.add(s.id);
        runDetached(abortTree([s.id], false).pipe(Effect.ignore));
      }
      s.settledAt = Date.now();
      s.status =
        outcome._tag === "Completed"
          ? "done"
          : outcome._tag === "Failed"
            ? "error"
            : "cancelled";
      s.errorText =
        errorText ??
        (outcome._tag === "Failed"
          ? bounded(outcome.errorText)
          : outcome._tag === "Interrupted"
            ? "Run was aborted"
            : undefined);
      s.finalText = (
        outcome._tag === "Completed"
          ? outcome.finalText
          : (outcome.partialText ?? "")
      ).slice(0, FINAL_TEXT_MAX_LENGTH);
      s.liveAssistant = undefined;
      entry.liveToolMap.clear();
      s.liveTools = [];
      s.queued = [];
      const ref = currentRef(entry),
        consumed = hasInterest(ref);
      waitInterest.delete(runRefKey(ref));
      if (
        !disposed &&
        (s.ancestry.parentId === null || !sealed.has(s.ancestry.parentId))
      ) {
        const hooks = [
          ...(settledHooks.get(s.ancestry.parentId) ?? []),
          ...(s.ancestry.parentId === null && onSettled ? [onSettled] : []),
        ];
        for (const hook of hooks) {
          try {
            hook(s, consumed);
          } catch {
            /* Settlement stays final. */
          }
        }
      }
      notify(s.id);
      pruneSettled();
      reportActivity();
    };
    const foldEvent = (entry: Entry, event: SubagentEvent) => {
      const s = entry.snapshot;
      switch (event._tag) {
        case "RunStarted":
          // send() opens a run (status, start time) when it restarts the
          // agent; RunStarted only confirms it. A later turn of the live run
          // (pi emits one per agent_start) keeps the run's start time, and a
          // start nobody requested after settlement (a settled native parent
          // woken by a late child result) is ignored.
          if (s.status === "running") entry.restarting = false;
          else entry.strayTurn = true;
          break;
        case "RunSettled":
          settle(entry, event.outcome);
          return; // settle() already notified
        case "UserMessage":
          appendTranscript(s, {
            kind: "user",
            text: boundedTranscriptText(event.text),
          });
          break;
        case "AssistantDelta": {
          // Live state belongs to a live run; an ignored stray turn keeps
          // only its transcript.
          if (s.status !== "running") break;
          const live = s.liveAssistant ?? { text: "", thinking: "" };
          s.liveAssistant =
            event.kind === "text"
              ? {
                  ...live,
                  text: (live.text + event.delta).slice(
                    -LIVE_ASSISTANT_MAX_LENGTH,
                  ),
                }
              : {
                  ...live,
                  thinking: (live.thinking + event.delta).slice(
                    -LIVE_ASSISTANT_MAX_LENGTH,
                  ),
                };
          break;
        }
        case "AssistantMessage":
          appendTranscript(s, {
            kind: "assistant",
            parts: event.parts.map((part) =>
              part.type === "toolCall"
                ? {
                    ...part,
                    argsPreview: part.argsPreview
                      ? boundedTranscriptText(part.argsPreview)
                      : undefined,
                  }
                : { ...part, text: boundedTranscriptText(part.text) },
            ),
          });
          s.liveAssistant = undefined;
          s.turns++;
          break;
        case "ToolStart":
          if (s.status !== "running") break;
          entry.liveToolMap.set(event.toolId, {
            toolId: event.toolId,
            name: event.name,
            argsPreview: event.argsPreview
              ? boundedTranscriptText(event.argsPreview)
              : undefined,
          });
          s.liveTools = [...entry.liveToolMap.values()];
          break;
        case "ToolUpdate": {
          const current = entry.liveToolMap.get(event.toolId);
          if (current) {
            entry.liveToolMap.set(event.toolId, {
              ...current,
              outputPreview: event.outputPreview
                ? boundedTranscriptText(event.outputPreview)
                : current.outputPreview,
            });
            s.liveTools = [...entry.liveToolMap.values()];
          }
          break;
        }
        case "ToolEnd":
          entry.liveToolMap.delete(event.toolId);
          s.liveTools = [...entry.liveToolMap.values()];
          appendTranscript(s, {
            kind: "toolResult",
            toolId: event.toolId,
            name: event.name,
            isError: event.isError,
            outputPreview: event.outputPreview
              ? boundedTranscriptText(event.outputPreview)
              : undefined,
          });
          break;
        case "QueueChanged":
          s.queued = event.queued;
          break;
        case "UsageChanged":
          s.usage = {
            tokens: event.tokens ?? s.usage.tokens,
            contextWindow: event.contextWindow ?? s.usage.contextWindow,
            costUsd: event.costUsd ?? s.usage.costUsd,
          };
          break;
        case "MetaChanged":
          s.meta = { ...s.meta, ...event.meta };
          break;
        case "BackendError":
          s.errorText = bounded(event.message);
          break;
      }
      notify(s.id);
    };

    const spawn = (
      backendName: BackendName,
      task: SpawnTask,
      options?: SpawnOptions,
      parentId: string | null = null,
    ) =>
      Effect.gen(function* () {
        const origin = task.origin ?? "model";
        if (origin !== "btw" && task.name !== undefined)
          yield* Effect.try({
            try: () => validateSubagentName(task.name!),
            catch: (e) =>
              new SpawnError({
                message: e instanceof Error ? e.message : String(e),
              }),
          });
        const identity = yield* Effect.suspend(
          (): Effect.Effect<
            DelegationIdentity,
            SpawnError | ConcurrencyLimitError
          > => {
            if (!ownerOpen(parentId))
              return new SpawnError({
                message: "Subagent owner is unknown, settled, or closing.",
              });
            if (
              parentId !== null &&
              (backendName !== "pi" || task.target.harness !== "pi")
            )
              return new SpawnError({
                message: "Nested subagents support native pi only.",
              });
            const depth =
              parentId === null ? 1 : ancestry.get(parentId)!.depth + 1;
            if (depth > maxDepth)
              return new SpawnError({
                message: `Maximum subagent depth ${maxDepth} reached.`,
              });
            if (runningCount() >= MAX_RUNNING)
              return new ConcurrencyLimitError({
                message: `Max ${MAX_RUNNING} subagents can run concurrently. Wait for one to finish before spawning another.`,
              });
            pruneSettled();
            if (entries.size + pending.size >= MAX_TRACKED)
              return new SpawnError({
                message: `Max ${MAX_TRACKED} tracked subagents reached.`,
              });
            const base =
              origin === "btw"
                ? slugifyTitle(task.description)
                : (task.name ?? generateAgentId(task.description));
            let id = base;
            for (let n = 2; takenIds.has(id); n++) id = `${base}-${n}`;
            takenIds.add(id);
            const identity = Object.freeze({
              rootId,
              agentId: id,
              parentId,
              depth,
              maxDepth,
            });
            ancestry.set(id, identity);
            pending.set(id, {});
            reportActivity();
            return Effect.succeed(identity);
          },
        );
        const startup = Effect.gen(function* () {
          pending.get(identity.agentId)!.fiber = yield* Effect.fiber;
          const backend = registry.get(backendName);
          if (!backend)
            return yield* new BackendUnavailableError({
              message: `Unknown backend "${backendName}".`,
            });
          if (!(yield* backend.available))
            return yield* new BackendUnavailableError({
              message: `Backend "${backendName}" is not available on this machine (binary/SDK/credentials missing).`,
            });
          const scope = yield* Scope.make();
          const create = Effect.gen(function* () {
            const session = yield* Scope.provide(
              backend.spawn({
                ...task,
                ancestry: identity,
                parent: task.parent.delegation
                  ? {
                      ...task.parent,
                      delegation: {
                        runtime: task.parent.delegation.runtime,
                        owner: forOwner(identity.agentId),
                      },
                    }
                  : task.parent,
              }),
              scope,
            );
            if (sealed.has(identity.agentId) || !ownerOpen(parentId))
              return yield* new SpawnError({
                message: "Subagent manager shut down while spawning.",
              });
            const meta: SubagentMeta = {
              ...(yield* session.meta),
              tier:
                task.target.source.kind === "tier"
                  ? task.target.source.tier
                  : "explicit",
              effort: task.reasoningEffort,
            };
            const id = identity.agentId;
            const entry: Entry = {
              snapshot: {
                id,
                ancestry: identity,
                origin,
                backend: backendName,
                description: task.description,
                prompt: task.prompt,
                cwd: task.cwd,
                status: "running",
                runSequence: 1,
                createdAt: Date.now(),
                runStartedAt: Date.now(),
                meta,
                usage: { contextWindow: meta.contextWindow },
                transcript: [],
                liveTools: [],
                queued: [],
                finalText: "",
                turns: 0,
              },
              session,
              scope,
              liveToolMap: new Map(),
            };
            entries.set(id, entry);
            pending.delete(id);
            if (options?.resultMode === "claimed")
              addInterest([currentRef(entry)]);
            reportActivity();
            const pump = Stream.runForEach(session.events, (e) =>
              Effect.sync(() => foldEvent(entry, e)),
            ).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  openPendingRun(entry);
                  if (entry.snapshot.status === "running")
                    settle(entry, {
                      _tag: "Failed",
                      errorText: "Backend event stream ended unexpectedly",
                    });
                }),
              ),
            );
            entry.pump = yield* Scope.provide(Effect.forkScoped(pump), scope);
            notify(id);
            return entry.snapshot as SubagentSnapshot;
          });
          return yield* create.pipe(
            Effect.onError(() =>
              Scope.close(scope, Exit.void).pipe(
                Effect.timeout(STOP_TIMEOUT_MS),
                Effect.ignore,
              ),
            ),
          );
        });
        return yield* startup.pipe(
          Effect.onError(() => abortTree([identity.agentId], false)),
          Effect.ensuring(
            Effect.sync(() => {
              pending.delete(identity.agentId);
              if (!entries.has(identity.agentId))
                ancestry.delete(identity.agentId);
              reportActivity();
              notify();
            }),
          ),
        );
      });
    const waitRefs = (
      refs: ReadonlyArray<SubagentRunRef>,
      onPending?: (ids: string[]) => void,
    ) =>
      Effect.gen(function* () {
        while (refs.some(isRunPending)) {
          onPending?.(refs.filter(isRunPending).map((r) => r.id));
          yield* nextChange;
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releaseInterest(refs);
            pruneSettled();
          }),
        ),
      );
    const waitFor = (
      ids: ReadonlyArray<string>,
      onPending?: (ids: string[]) => void,
    ) =>
      Effect.suspend(() => {
        const refs = [...new Set(ids)].flatMap((id) => {
          const e = entries.get(id);
          return e ? [currentRef(e)] : [];
        });
        addInterest(refs);
        return waitRefs(refs, onPending);
      });
    const waitForRun = (ref: SubagentRunRef) =>
      Effect.suspend(() => waitRefs([ref]));
    const releaseRun = (ref: SubagentRunRef) =>
      Effect.sync(() => {
        releaseInterest([ref]);
        pruneSettled();
      });
    const abortEntry = (entry: Entry) =>
      Effect.gen(function* () {
        if (entry.snapshot.status !== "running" && !entry.restarting) return;
        const result = yield* entry.session.interrupt.pipe(
          Effect.timeout(STOP_TIMEOUT_MS),
          Effect.result,
        );
        // An interrupt that lands before a restart's RunStarted is folded
        // cancels that new run, so it settles (and delivers) under its ref.
        openPendingRun(entry);
        if (Result.isFailure(result)) {
          settle(
            entry,
            { _tag: "Interrupted" },
            "Abort deadline exceeded; session was force-disposed",
          );
          yield* closeEntryScope(entry);
        } else if (entry.snapshot.status === "running") {
          // Idle native parents need no SDK event to acknowledge cancellation.
          settle(entry, { _tag: "Interrupted" });
        }
      });
    const abortTree = (ids: ReadonlyArray<string>, includeRoots = true) =>
      Effect.suspend(() => {
        const affected = [...ancestry.keys()].filter((id) =>
          ids.some((root) => belongsTo(id, root)),
        );
        for (const id of [...ids, ...affected]) sealed.add(id);
        return Effect.forEach(
          affected.filter((id) => includeRoots || !ids.includes(id)),
          (id) => {
            const p = pending.get(id),
              entry = entries.get(id);
            return p?.fiber
              ? Fiber.interrupt(p.fiber).pipe(
                  Effect.timeout(STOP_TIMEOUT_MS),
                  Effect.ignore,
                )
              : entry
                ? abortEntry(entry)
                : Effect.void;
          },
          { concurrency: "unbounded" },
        ).pipe(Effect.asVoid);
      });
    const cancel = (ids: ReadonlyArray<string>) =>
      Effect.suspend(() => {
        const unique = [...new Set(ids)],
          running = unique.flatMap((id) => {
            const e = entries.get(id);
            return e && (e.snapshot.status === "running" || e.restarting)
              ? [e]
              : [];
          });
        const refs = running.map(currentRef);
        addInterest(refs);
        for (const id of unique)
          cancelling.set(id, (cancelling.get(id) ?? 0) + 1);
        return abortTree(unique).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              releaseInterest(refs);
              for (const id of unique) {
                const n = (cancelling.get(id) ?? 1) - 1;
                if (n <= 0) cancelling.delete(id);
                else cancelling.set(id, n);
              }
            }),
          ),
          Effect.map(() =>
            unique.map(
              (id) =>
                ({
                  id,
                  description: entries.get(id)?.snapshot.description ?? "?",
                  status: entries.get(id)?.snapshot.status ?? "error",
                  // A run that finished on its own while the interrupt was in
                  // flight reports its real status, not "Cancelled".
                  cancelled:
                    running.some((e) => e.snapshot.id === id) &&
                    entries.get(id)?.snapshot.status === "cancelled",
                }) as CancelResult,
            ),
          ),
        );
      });
    const send = (id: string, text: string) =>
      Effect.suspend((): Effect.Effect<SendResult, SendError> => {
        const entry = entries.get(id);
        if (
          !entry ||
          disposed ||
          (entry.snapshot.ancestry.parentId !== null &&
            !ownerOpen(entry.snapshot.ancestry.parentId))
        )
          return new SendError({
            message: `Subagent "${id}" is no longer tracked.`,
          });
        if (sealed.has(id) && entry.snapshot.status === "running")
          return new SendError({ message: "Subagent is closing." });
        if (cancelling.has(id))
          return new SendError({
            message: `Subagent "${id}" is being cancelled; wait for the cancel to report before sending.`,
          });
        if (entry.restarting)
          return new SendError({
            message: `Subagent "${id}" is already restarting; wait for its new run to start before sending again.`,
          });
        if (entry.snapshot.status === "running")
          return entry.session
            .send(text)
            .pipe(Effect.as({ run: currentRef(entry), restarted: false }));
        if (runningCount() >= MAX_RUNNING)
          return new SendError({
            message: `Max ${MAX_RUNNING} subagents can run concurrently; restarting "${id}" would exceed that.`,
          });
        sealed.delete(id);
        const s = entry.snapshot;
        const previous = {
          status: s.status,
          runStartedAt: s.runStartedAt,
          settledAt: s.settledAt,
          errorText: s.errorText,
          strayTurn: entry.strayTurn,
        };
        // The new run is live for every reader from here; `restarting` only
        // marks that its RunStarted has not been folded yet. A backend still
        // in an ignored turn takes the message as a steer, so that turn
        // becomes this run and its RunSettled settles it.
        entry.restarting = !entry.strayTurn;
        entry.strayTurn = false;
        s.runSequence++;
        s.status = "running";
        s.runStartedAt = Date.now();
        s.settledAt = undefined;
        s.errorText = undefined;
        const run = currentRef(entry);
        reportActivity();
        notify(id);
        return entry.session.send(text).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              entry.restarting = false;
              entry.strayTurn = previous.strayTurn;
              s.runSequence--;
              Object.assign(s, {
                status: previous.status,
                runStartedAt: previous.runStartedAt,
                settledAt: previous.settledAt,
                errorText: previous.errorText,
              });
              reportActivity();
              notify(id);
            }),
          ),
          Effect.as({ run, restarted: true }),
        );
      });
    const disposeAll = Effect.gen(function* () {
      disposed = true;
      yield* abortTree([...pending.keys()]);
      const all = [...entries.values()];
      entries.clear();
      waitInterest.clear();
      reportActivity();
      yield* Effect.forEach(all, closeEntryScope, { concurrency: "unbounded" });
      yield* Effect.forEach(
        [...cleanups],
        (f) =>
          Fiber.await(f).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore),
        { concurrency: "unbounded" },
      );
      ancestry.clear();
      settledHooks.clear();
      childWorkHooks.clear();
      notify();
    });
    const view: SubagentManagerShape["view"] = {
      list: () => [...entries.values()].map((e) => e.snapshot),
      get: (id) => entries.get(id)?.snapshot,
      size: () => entries.size,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      subscribeTo: (id, listener) => {
        let set = idListeners.get(id);
        if (!set) {
          set = new Set();
          idListeners.set(id, set);
        }
        set.add(listener);
        return () => {
          set.delete(listener);
          if (set.size === 0) idListeners.delete(id);
        };
      },
      requestSend: (id, text, onError) => {
        runDetached(
          send(id, text).pipe(
            Effect.catch((e) => Effect.sync(() => onError?.(e.message))),
          ),
        );
      },
      requestAbort: (id) => {
        runDetached(abortTree([id]).pipe(Effect.ignore));
      },
      subscribeChildWork: (parentId, hook) => {
        let set = childWorkHooks.get(parentId);
        if (!set) {
          set = new Set();
          childWorkHooks.set(parentId, set);
        }
        set.add(hook);
        const count = childWorkCount(parentId);
        lastChildWork.set(parentId, count);
        hook(count);
        return () => {
          set!.delete(hook);
          if (set!.size === 0) {
            childWorkHooks.delete(parentId);
            lastChildWork.delete(parentId);
          }
        };
      },
      subscribeSettled: (id, hook) => {
        let set = settledHooks.get(id);
        if (!set) {
          set = new Set();
          settledHooks.set(id, set);
        }
        set.add(hook);
        return () => {
          set.delete(hook);
          if (set.size === 0) settledHooks.delete(id);
        };
      },
      setOnSettled: (hook) => {
        onSettled = hook;
      },
    };
    const forOwner = (parentId: string | null): SubagentOwner => {
      const owned = (id: string) =>
        ancestry.has(id) && ancestry.get(id)!.parentId === parentId;
      const rejected = (id: string) =>
        new SendError({
          message: `Subagent "${id}" is not a direct child of this owner.`,
        });
      const ownerView: SubagentManagerShape["view"] = {
        list: () =>
          [...entries.values()]
            .filter((e) => owned(e.snapshot.id))
            .map((e) => e.snapshot),
        get: (id) => (owned(id) ? entries.get(id)?.snapshot : undefined),
        size: () => [...entries.keys()].filter(owned).length,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        subscribeTo: (id, listener) =>
          owned(id) ? view.subscribeTo(id, listener) : () => {},
        requestSend: (id, text, onError) => {
          if (owned(id))
            runDetached(
              send(id, text).pipe(
                Effect.catch((e) => Effect.sync(() => onError?.(e.message))),
              ),
            );
        },
        requestAbort: (id) => {
          if (owned(id)) runDetached(abortTree([id]).pipe(Effect.ignore));
        },
        subscribeChildWork: (_ignored, hook) =>
          view.subscribeChildWork(parentId, hook),
        subscribeSettled: (_ignored, hook) =>
          view.subscribeSettled(parentId, hook),
        setOnSettled: (hook) => {
          if (parentId === null) onSettled = hook;
        },
      };
      return {
        parentId,
        view: ownerView,
        closeChildren: () =>
          parentId === null ? Effect.void : abortTree([parentId], false),
        accepting: () => ownerOpen(parentId),
        subscribeChildWork: (hook) => view.subscribeChildWork(parentId, hook),
        subscribeSettled: (hook) => view.subscribeSettled(parentId, hook),
        spawn: (backend, task, options) =>
          spawn(backend, task, options, parentId),
        get: (id) =>
          Effect.sync(() =>
            owned(id) ? entries.get(id)?.snapshot : undefined,
          ),
        list: Effect.sync(() =>
          [...entries.values()]
            .filter((e) => owned(e.snapshot.id))
            .map((e) => e.snapshot),
        ),
        send: (id, text) =>
          Effect.suspend(() => (owned(id) ? send(id, text) : rejected(id))),
        cancel: (ids) =>
          Effect.suspend(() =>
            ids.every(owned)
              ? cancel(ids)
              : rejected(ids.find((id) => !owned(id))!),
          ),
        waitForRun: (ref) =>
          Effect.suspend(() =>
            owned(ref.id) ? waitForRun(ref) : rejected(ref.id),
          ),
        releaseRun: (ref) =>
          Effect.suspend(() =>
            owned(ref.id) ? releaseRun(ref) : rejected(ref.id),
          ),
      };
    };
    yield* Effect.addFinalizer(() => disposeAll);
    return SubagentManager.of({
      spawn,
      waitFor,
      waitForRun,
      releaseRun,
      cancel,
      send,
      forOwner,
      revokeOwner: (id) => abortTree([id], false),
      get: (id) => Effect.sync(() => entries.get(id)?.snapshot),
      list: Effect.sync(() => view.list()),
      disposeAll,
      view,
    });
  });

export function makeSubagentManagerLayer(options: { maxDepth?: number } = {}) {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  parseDepthArgument(String(maxDepth));
  return Layer.effect(SubagentManager, makeManager(maxDepth));
}
export const SubagentManagerLive: Layer.Layer<
  SubagentManager,
  never,
  BackendRegistry
> = makeSubagentManagerLayer();
