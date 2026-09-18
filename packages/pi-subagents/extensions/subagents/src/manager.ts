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
  origin: SubagentOrigin;
  backend: BackendName;
  description: string;
  prompt: string;
  cwd: string;
  status: SubagentStatus;
  runSequence: number;
  createdAt: number;
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

export interface SubagentManagerShape {
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
  readonly view: SubagentReadModel;
}

export class SubagentManager extends Context.Service<
  SubagentManager,
  SubagentManagerShape
>()("subagents/SubagentManager") {}

// --- Implementation --------------------------------------------------------------

const makeManager = Effect.gen(function* () {
  const registry = yield* BackendRegistry;
  // Detached forker for sync contexts (read-model commands, pruning) that
  // preserves the manager's services instead of using the global runtime.
  const runDetached = Effect.runForkWith(yield* Effect.context());

  const entries = new Map<string, Entry>();
  const waitInterest = new Map<string, number>();
  const listeners = new Set<() => void>();
  /** One-shot nextChange waiters, swapped out before invocation so waiters
   * re-registering during notification are not visited in the same sweep. */
  let changeWaiters: Array<() => void> = [];
  const idListeners = new Map<string, Set<() => void>>();
  const cleanups = new Set<Fiber.Fiber<unknown>>();
  // Ids claimed synchronously at spawn time: two concurrent same-description
  // spawns must not both pass an entries-map uniqueness check before either
  // inserts.
  const takenIds = new Set<string>();
  let reserved = 0;
  let disposed = false;
  let onSettled:
    ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined;

  const notify = (id?: string) => {
    const waiters = changeWaiters;
    changeWaiters = [];
    for (const waiter of waiters) waiter();
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A failed status/render listener must not corrupt lifecycle state.
      }
    }
    if (id) {
      for (const listener of idListeners.get(id) ?? []) {
        try {
          listener();
        } catch {
          // Same.
        }
      }
    }
  };

  /** Resolves on the next state change. Interruption unregisters the waiter. */
  const nextChange = Effect.callback<void>((resume) => {
    const waiter = () => resume(Effect.void);
    changeWaiters.push(waiter);
    return Effect.sync(() => {
      const index = changeWaiters.indexOf(waiter);
      if (index >= 0) changeWaiters.splice(index, 1);
    });
  });

  const runningCount = () =>
    [...entries.values()].filter(
      (e) => e.snapshot.status === "running" || e.restarting === true,
    ).length;

  // Publish the running count for other extensions (summaries gates its recaps
  // on it). Called only at transition points; reportRunning no-ops when the
  // count is unchanged.
  const reportActivity = () => reportRunning("subagents", runningCount());

  const currentRef = (entry: Entry): SubagentRunRef => ({
    id: entry.snapshot.id,
    runSequence: entry.snapshot.runSequence,
  });
  const hasInterest = (ref: SubagentRunRef) =>
    (waitInterest.get(runRefKey(ref)) ?? 0) > 0;
  const isRunPending = (ref: SubagentRunRef) => {
    const snap = entries.get(ref.id)?.snapshot;
    return snap?.runSequence === ref.runSequence && snap.status === "running";
  };
  const addInterest = (refs: ReadonlyArray<SubagentRunRef>) => {
    for (const ref of refs) {
      const key = runRefKey(ref);
      waitInterest.set(key, (waitInterest.get(key) ?? 0) + 1);
    }
  };
  const releaseInterest = (refs: ReadonlyArray<SubagentRunRef>) => {
    for (const ref of refs) {
      const key = runRefKey(ref);
      const count = (waitInterest.get(key) ?? 1) - 1;
      if (count <= 0) waitInterest.delete(key);
      else waitInterest.set(key, count);
    }
  };

  const closeEntryScope = (entry: Entry) =>
    Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);

  const pruneSettled = () => {
    if (entries.size <= MAX_TRACKED) return;
    const candidates = [...entries.values()]
      .filter(
        (e) => e.snapshot.status !== "running" && !hasInterest(currentRef(e)),
      )
      .sort(
        (a, b) =>
          (a.snapshot.settledAt ?? a.snapshot.createdAt) -
          (b.snapshot.settledAt ?? b.snapshot.createdAt),
      );
    for (const entry of candidates) {
      if (entries.size <= MAX_TRACKED) break;
      entries.delete(entry.snapshot.id);
      const fiber = runDetached(closeEntryScope(entry));
      cleanups.add(fiber);
      fiber.addObserver(() => cleanups.delete(fiber));
    }
  };

  const settle = (entry: Entry, outcome: RunOutcome) => {
    const s = entry.snapshot;
    entry.restarting = false;
    if (s.status !== "running") {
      reportActivity();
      return;
    }
    s.settledAt = Date.now();
    switch (outcome._tag) {
      case "Completed":
        s.status = "done";
        s.errorText = undefined;
        s.finalText = outcome.finalText.slice(0, FINAL_TEXT_MAX_LENGTH);
        break;
      case "Failed":
        s.status = "error";
        s.errorText = bounded(outcome.errorText);
        // Never let a failed run report the previous run's successful output.
        s.finalText = (outcome.partialText ?? "").slice(
          0,
          FINAL_TEXT_MAX_LENGTH,
        );
        break;
      case "Interrupted":
        // A deliberate abort (model cancel tool, dashboard `x`, takeover) is
        // a distinct terminal state from a genuine failure, so the UI can
        // report it as cancelled instead of failed.
        s.status = "cancelled";
        s.errorText = "Run was aborted";
        s.finalText = (outcome.partialText ?? "").slice(
          0,
          FINAL_TEXT_MAX_LENGTH,
        );
        break;
    }
    s.liveAssistant = undefined;
    entry.liveToolMap.clear();
    s.liveTools = [];
    s.queued = [];
    const runRef = currentRef(entry);
    const consumed = hasInterest(runRef);
    waitInterest.delete(runRefKey(runRef));
    notify(s.id);
    try {
      // During teardown, don't queue results into a shutting-down session.
      if (!disposed) onSettled?.(s, consumed);
    } catch {
      // The parent session may be unavailable; settlement stays final.
    }
    pruneSettled();
    reportActivity();
  };

  const foldEvent = (entry: Entry, event: SubagentEvent) => {
    const s = entry.snapshot;
    switch (event._tag) {
      case "RunStarted":
        entry.restarting = false;
        s.status = "running";
        s.settledAt = undefined;
        s.errorText = undefined;
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
  ) =>
    Effect.gen(function* () {
      // Fail fast on invalid supplied names before reserving a concurrency
      // slot. btw titles are extension-generated and slugified instead.
      const origin = task.origin ?? "model";
      if (origin !== "btw" && task.name !== undefined) {
        const name = task.name;
        let nameError: string | undefined;
        try {
          validateSubagentName(name);
        } catch (error) {
          nameError = error instanceof Error ? error.message : String(error);
        }
        if (nameError !== undefined) {
          return yield* new SpawnError({ message: nameError });
        }
      }
      // Reserve synchronously (before the first yield inside doSpawn) so
      // parallel tool calls cannot race past the global cap.
      yield* Effect.suspend(
        (): Effect.Effect<void, SpawnError | ConcurrencyLimitError> => {
          if (disposed) {
            return new SpawnError({
              message: "Subagent manager is shutting down.",
            });
          }
          if (runningCount() + reserved >= MAX_RUNNING) {
            return new ConcurrencyLimitError({
              message: `Max ${MAX_RUNNING} subagents can run concurrently. Wait for one to finish before spawning another.`,
            });
          }
          reserved++;
          return Effect.void;
        },
      );

      const doSpawn = Effect.gen(function* () {
        const backend: SubagentBackend | undefined = registry.get(backendName);
        if (!backend) {
          return yield* new BackendUnavailableError({
            message: `Unknown backend "${backendName}".`,
          });
        }
        const available = yield* backend.available;
        if (!available) {
          return yield* new BackendUnavailableError({
            message: `Backend "${backendName}" is not available on this machine (binary/SDK/credentials missing).`,
          });
        }

        const scope = yield* Scope.make();
        const session = yield* Scope.provide(backend.spawn(task), scope).pipe(
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
        if (disposed) {
          yield* Scope.close(scope, Exit.void);
          return yield* new SpawnError({
            message: "Subagent manager shut down while spawning.",
          });
        }

        // Claude Code names agents verbatim: no prefix, no slug. Only
        // extension-generated descriptions (btw asides, free-form questions)
        // get slugified into an id; an omitted name gets a generated id.
        const base =
          origin === "btw"
            ? slugifyTitle(task.description)
            : (task.name ?? generateAgentId(task.description));
        let id = base;
        for (let n = 2; takenIds.has(id); n++) id = `${base}-${n}`;
        takenIds.add(id);
        const meta: SubagentMeta = {
          ...(yield* session.meta),
          tier:
            task.target.source.kind === "tier"
              ? task.target.source.tier
              : "explicit",
          effort: task.reasoningEffort,
        };
        const entry: Entry = {
          snapshot: {
            id,
            origin,
            backend: backendName,
            description: task.description,
            prompt: task.prompt,
            cwd: task.cwd,
            status: "running",
            runSequence: 1,
            createdAt: Date.now(),
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
        if (options?.resultMode === "claimed") addInterest([currentRef(entry)]);
        reportActivity();

        // Pump: fold the event stream into the snapshot. Tied to the entry
        // scope, so closing the scope stops it. If the stream ends while the
        // subagent still looks running, the backend died out from under us.
        const pump = Stream.runForEach(session.events, (event) =>
          Effect.sync(() => foldEvent(entry, event)),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (entry.snapshot.status === "running") {
                settle(entry, {
                  _tag: "Failed",
                  errorText: "Backend event stream ended unexpectedly",
                });
              }
            }),
          ),
        );
        entry.pump = yield* Scope.provide(Effect.forkScoped(pump), scope);

        notify(id);
        return entry.snapshot as SubagentSnapshot;
      });

      return yield* doSpawn.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            reserved--;
            notify();
          }),
        ),
      );
    });

  const waitFor = (
    ids: ReadonlyArray<string>,
    onPending?: (pending: string[]) => void,
  ) =>
    Effect.suspend(() => {
      const unique = [...new Set(ids)];
      const refs = unique
        .map((id) => entries.get(id)?.snapshot)
        .filter((snap): snap is MutableSnapshot => snap !== undefined)
        .map((snap) => ({ id: snap.id, runSequence: snap.runSequence }));
      addInterest(refs);
      const loop = Effect.gen(function* () {
        while (true) {
          const pending = refs.filter(isRunPending).map((ref) => ref.id);
          if (pending.length === 0) return;
          onPending?.(pending);
          yield* nextChange;
        }
      });
      return loop.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releaseInterest(refs);
            pruneSettled();
          }),
        ),
      );
    });

  const waitForRun = (ref: SubagentRunRef) =>
    Effect.suspend(() => {
      const loop = Effect.gen(function* () {
        while (isRunPending(ref)) yield* nextChange;
      });
      return loop.pipe(
        Effect.ensuring(Effect.sync(() => releaseInterest([ref]))),
      );
    });

  const releaseRun = (ref: SubagentRunRef) =>
    Effect.sync(() => {
      releaseInterest([ref]);
      pruneSettled();
    });

  /** Interrupt one running entry, force-closing its scope after 5s. */
  const abortEntry = (entry: Entry) =>
    Effect.gen(function* () {
      if (entry.snapshot.status !== "running") return;
      const graceful = yield* entry.session.interrupt.pipe(
        Effect.timeout(STOP_TIMEOUT_MS),
        Effect.result,
      );
      if (Result.isFailure(graceful)) {
        // Settle before closing the scope so the pump's stream-ended
        // fallback ("Backend event stream ended unexpectedly") cannot win
        // the race and report the wrong terminal reason.
        yield* Effect.sync(() => {
          settle(entry, { _tag: "Interrupted" });
          entry.snapshot.errorText =
            "Abort deadline exceeded; session was force-disposed";
          notify(entry.snapshot.id);
        });
        // Bound the close like disposeAll does: a stuck backend finalizer
        // must not hang cancel after the run is already settled.
        yield* closeEntryScope(entry).pipe(
          Effect.timeout(STOP_TIMEOUT_MS),
          Effect.ignore,
        );
      }
    });

  const cancel = (ids: ReadonlyArray<string>) =>
    Effect.suspend(() => {
      const unique = [...new Set(ids)];
      const running = unique
        .map((id) => entries.get(id))
        .filter(
          (entry): entry is Entry => entry?.snapshot.status === "running",
        );
      const runningRefs = running.map(currentRef);
      const runningIds = running.map((entry) => entry.snapshot.id);
      // Mark consumed before interrupting so cancellation does not also
      // enqueue duplicate automatic result messages into the parent.
      addInterest(runningRefs);
      const work = Effect.gen(function* () {
        yield* Effect.forEach(running, abortEntry, {
          concurrency: "unbounded",
        });
        while (runningRefs.some(isRunPending)) {
          yield* nextChange;
        }
      });
      return work.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releaseInterest(runningRefs);
            pruneSettled();
          }),
        ),
        Effect.map((): ReadonlyArray<CancelResult> =>
          unique.map((id) => {
            const snapshot = entries.get(id)?.snapshot;
            return {
              id,
              description: snapshot?.description ?? "?",
              status: snapshot?.status ?? "error",
              cancelled: runningIds.includes(id),
            };
          }),
        ),
      );
    });

  const send = (id: string, text: string) =>
    Effect.suspend((): Effect.Effect<SendResult, SendError> => {
      const entry = entries.get(id);
      if (!entry || disposed) {
        return new SendError({
          message: `Subagent "${id}" is no longer tracked.`,
        });
      }
      if (entry.snapshot.status === "running") {
        return entry.session
          .send(text)
          .pipe(Effect.as({ run: currentRef(entry), restarted: false }));
      }
      if (entry.restarting) {
        return new SendError({
          message: `Subagent "${id}" is already restarting; wait for its new run to start before sending again.`,
        });
      }
      // Restarting a settled subagent occupies a running slot again, so it
      // must respect the same cap as spawn. Steering an already-running one
      // does not consume additional capacity.
      if (runningCount() + reserved >= MAX_RUNNING) {
        return new SendError({
          message: `Max ${MAX_RUNNING} subagents can run concurrently; restarting "${id}" would exceed that.`,
        });
      }
      // Occupy the slot synchronously: the RunStarted that flips status
      // arrives via the async pump, and two concurrent restarts must not
      // both pass the check in that window. Cleared by RunStarted/settle,
      // or here when the backend rejects the send.
      entry.restarting = true;
      // A settled resume is a new run: the previous run's interest and
      // deferred result must not apply to it.
      entry.snapshot.runSequence += 1;
      const run = currentRef(entry);
      reportActivity();
      return entry.session.send(text).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            entry.restarting = false;
            entry.snapshot.runSequence -= 1;
            reportActivity();
          }),
        ),
        Effect.as({ run, restarted: true }),
      );
    });

  const disposeAll = Effect.gen(function* () {
    disposed = true;
    const all = [...entries.values()];
    entries.clear();
    waitInterest.clear();
    reportActivity();
    yield* Effect.forEach(
      all,
      (entry) =>
        closeEntryScope(entry).pipe(
          Effect.timeout(STOP_TIMEOUT_MS),
          Effect.ignore,
        ),
      { concurrency: "unbounded" },
    );
    // Pruning cleanups are detached; bound them like everything else so a
    // stuck backend finalizer cannot block runtime shutdown indefinitely.
    yield* Effect.forEach(
      [...cleanups],
      (fiber) =>
        Fiber.await(fiber).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore),
      { concurrency: "unbounded" },
    ).pipe(Effect.ignore);
    yield* Effect.sync(() => notify());
  });

  const view: SubagentReadModel = {
    list: () => [...entries.values()].map((entry) => entry.snapshot),
    get: (id) => entries.get(id)?.snapshot,
    size: () => entries.size,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
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
          Effect.catch((error) => Effect.sync(() => onError?.(error.message))),
        ),
      );
    },
    requestAbort: (id) => {
      const entry = entries.get(id);
      if (!entry) return;
      // UI-initiated aborts are not "consumed": the failed result still
      // flows back to the parent as a follow-up message, matching v1.
      runDetached(abortEntry(entry).pipe(Effect.ignore));
    },
    setOnSettled: (hook) => {
      onSettled = hook;
    },
  };

  // Safety net: disposing the ManagedRuntime tears everything down even if
  // the extension forgot to call disposeAll explicitly.
  yield* Effect.addFinalizer(() => disposeAll);

  return SubagentManager.of({
    spawn,
    waitFor,
    waitForRun,
    releaseRun,
    cancel,
    send,
    get: (id) => Effect.sync(() => entries.get(id)?.snapshot),
    list: Effect.sync(() => [...entries.values()].map((e) => e.snapshot)),
    disposeAll,
    view,
  });
});

export const SubagentManagerLive: Layer.Layer<
  SubagentManager,
  never,
  BackendRegistry
> = Layer.effect(SubagentManager, makeManager);
