/**
 * pi backend — real implementation over the pi SDK.
 *
 * Each subagent is an in-process `AgentSession` (a port of v1
 * subagents/manager.ts + shared/child-session.ts):
 * - real session files visible in /resume, child resources loaded per-cwd
 *   with trust gating, and the child tool denylist;
 * - btw children additionally inherit the parent conversation: the snapshot
 *   taken at spawn time is seeded into the child session file (fenced with
 *   by-the-way.ts markers) before createAgentSession, which restores it
 *   as the child's history — a true fork;
 * - `session.subscribe()` events translated to normalized SubagentEvents;
 * - send() steers a streaming run or starts a fresh prompt() when idle;
 * - interrupt clears the queue and aborts; closing the session scope emits
 *   the child session_shutdown hook and disposes the session.
 */

import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionEvent,
  ModelRegistry,
  SessionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Cause, Scope } from "effect";
import { Effect, Queue, Stream } from "effect";
import type { SubagentBackend, SubagentSession } from "../backend.ts";
import type {
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
  TranscriptPart,
} from "../domain.ts";
import { SendError, SpawnError } from "../domain.ts";
import { BTW_CONTEXT_END, BTW_CONTEXT_START } from "../by-the-way.ts";
import { createToolCallTimeoutGuard } from "../../../shared/tool-call-timeout.ts";
import {
  affordableModels,
  costCeilingMessage,
  exceedsCostCeiling,
  loadSubagentModels,
  modelKey,
} from "../../../shared/subagent-models.ts";

const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;

/** Tools that headless children must not receive. Everything else stays enabled. */
const CHILD_EXCLUDED_TOOL_NAMES = [
  "subagent_spawn",
  "subagent_wait",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
  "workflow",
  "ask_user",
] as const;

// --- Model + effort resolution -----------------------------------------------

type ThinkingLevel = NonNullable<
  NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"]
>;

/** Cheap-tier labels offered when the ceiling rejects an agent's choice. */
function affordableLabels(registry: ModelRegistry, cwd: string) {
  return affordableModels(registry.getAvailable(), cwd).map(modelKey);
}

/**
 * Resolve the generic model hint against the parent registry:
 * "provider/model-id" is exact; a bare id prefers the configured default's
 * provider, then must be unambiguous across providers. No hint uses the
 * configured default (/subagent-model) rather than inheriting the parent, so
 * delegated work does not silently run on an expensive interactive model.
 */
function resolvePiModel(
  registry: ModelRegistry,
  hint: string | undefined,
): Model<any> | undefined {
  const configured = loadSubagentModels().pi;
  if (!hint) {
    const preferred = registry.find(configured.provider, configured.model);
    if (preferred) return preferred;
    // Configured default is gone (key removed, model retired). Fail loudly
    // rather than falling back to whatever the parent happens to run on.
    throw new Error(
      `Default subagent model "${configured.provider}/${configured.model}" is not available. Run /subagent-model to pick another.`,
    );
  }
  const slash = hint.indexOf("/");
  if (slash > 0) {
    const provider = hint.slice(0, slash);
    const id = hint.slice(slash + 1);
    const found = registry.find(provider, id);
    if (found) return found;
    throw new Error(`Unknown model "${hint}".`);
  }
  const found = registry.find(configured.provider, hint);
  if (found) return found;
  const matches = registry.getAll().filter((m) => m.id === hint);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Model "${hint}" exists in multiple providers (${matches.map((m) => m.provider).join(", ")}). Use "provider/${hint}".`,
    );
  }
  throw new Error(`Unknown model "${hint}".`);
}

/**
 * Reject expensive models an agent picked for itself. A configured default or a
 * user aside (/btw) is deliberate, so neither is checked.
 */
function enforceCostCeiling(
  registry: ModelRegistry,
  model: Model<any>,
  task: SpawnTask,
) {
  if (!task.model || task.origin === "btw") return;
  if (!exceedsCostCeiling(model.cost)) return;
  throw new Error(
    costCeilingMessage({
      label: modelKey(model),
      cost: model.cost,
      alternatives: affordableLabels(registry, task.cwd),
    }),
  );
}

// --- Child session helpers (ported from v1 shared/child-session.ts) -----------

/** Load normal global/package resources and trust-gated project resources. */
async function createChildResources(cwd: string, projectTrusted: boolean) {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted,
  });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await loader.reload();
  return { loader, settingsManager };
}

function waitBounded(operation: Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([
    operation.then(
      () => undefined,
      () => undefined,
    ),
    timeout,
  ])
    .catch(() => {})
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

/** Emit child session_shutdown (bounded), then dispose. Never throws. */
async function shutdownAndDisposeChildSession(session: AgentSession) {
  try {
    if (session.extensionRunner.hasHandlers("session_shutdown")) {
      await waitBounded(
        session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        }),
        CHILD_SHUTDOWN_TIMEOUT_MS,
      );
    }
  } catch {
    // Extension runner inspection/emission is best-effort during teardown.
  } finally {
    try {
      session.dispose();
    } catch {
      // Disposal is terminal and must remain idempotent for callers.
    }
  }
}

// --- Event translation ----------------------------------------------------------

function messageRole(msg: unknown): Message["role"] | undefined {
  const role = (msg as { role?: string } | undefined)?.role;
  if (role === "user" || role === "assistant" || role === "toolResult")
    return role;
  return undefined;
}

/**
 * Last assistant message the child produced, excluding inherited btw context.
 * Seeds are identified by object identity: appendMessage stores the exact
 * object buildSessionContext later restores, and compaction keeps the same
 * references, so parent messages can never leak into the child's result even
 * when the child itself produced nothing (preflight failure, early abort).
 */
function lastAssistantMessage(
  session: AgentSession,
  exclude?: ReadonlySet<object>,
): AssistantMessage | undefined {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (exclude?.has(msg)) continue;
    if (messageRole(msg) === "assistant") return msg as AssistantMessage;
  }
  return undefined;
}

/** Final assistant text output (last assistant message with text), v1 semantics. */
function finalOutput(
  session: AgentSession,
  exclude?: ReadonlySet<object>,
): string {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (exclude?.has(msg)) continue;
    if (messageRole(msg) !== "assistant") continue;
    const text = (msg as AssistantMessage).content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function safeJson(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value);
    return text === "{}" ? undefined : text.slice(0, 4_096);
  } catch {
    return undefined;
  }
}

/** First non-empty line of a tool result-ish value (v1 liveToolPreview). */
function toolPreview(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value
      .split("\n")
      .find((line) => line.trim())
      ?.trim();
  }
  if (!value || typeof value !== "object") return undefined;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") continue;
    const firstLine = record.text.split("\n").find((line) => line.trim());
    if (firstLine) return firstLine.trim();
  }
  return undefined;
}

function assistantParts(msg: AssistantMessage): TranscriptPart[] {
  const parts: TranscriptPart[] = [];
  for (const part of msg.content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "thinking") {
      parts.push({
        type: "thinking",
        text: part.redacted ? "" : part.thinking,
        redacted: part.redacted,
      });
    } else if (part.type === "toolCall") {
      parts.push({
        type: "toolCall",
        toolId: part.id,
        name: part.name,
        argsPreview: safeJson(part.arguments),
      });
    }
  }
  return parts;
}

function userText(msg: Message): string {
  const content = (msg as { content: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

// --- The session ------------------------------------------------------------------

/** Seed message: anything appendMessage accepts (summary roles are rewritten). */
export type SeedableMessage = Exclude<
  SessionContext["messages"][number],
  { role: "compactionSummary" | "branchSummary" }
>;

/**
 * Rewrite summary roles into the plain user text convertToLlm would produce;
 * appendMessage rejects the summary roles themselves. Every other message
 * (user/assistant/toolResult/custom/bashExecution) passes through unchanged.
 */
export function toSeedMessage(
  message: SessionContext["messages"][number],
): SeedableMessage {
  if (message.role === "compactionSummary") {
    return {
      role: "user",
      content: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${message.summary}\n</summary>`,
      timestamp: message.timestamp,
    };
  }
  if (message.role === "branchSummary") {
    return {
      role: "user",
      content: `The following is a summary of a branch that this conversation came back from:\n\n<summary>\n${message.summary}\n</summary>`,
      timestamp: message.timestamp,
    };
  }
  return message;
}

/**
 * Seed the child session file with the parent's conversation (btw only).
 * createAgentSession restores messages already present in the session
 * manager, so the child becomes a true fork: compaction, resume, and the
 * transcript treat the inherited context like the child's own history. The
 * inherited range is fenced with custom entries so the takeover view's
 * persisted-transcript loader can hide it — a side-question panel shows the
 * aside, not the whole parent conversation.
 */
export function seedInheritedBtwContext(
  sessionManager: SessionManager,
  seedMessages: readonly SeedableMessage[],
) {
  if (seedMessages.length === 0) return;
  sessionManager.appendCustomEntry(BTW_CONTEXT_START);
  for (const message of seedMessages) {
    sessionManager.appendMessage(message);
  }
  sessionManager.appendCustomEntry(BTW_CONTEXT_END);
}

function boundedError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    4096,
  );
}

const makePiSession = (
  task: SpawnTask,
): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> =>
  Effect.gen(function* () {
    const registry = task.parent.modelRegistry;
    if (!registry) {
      return yield* new SpawnError({
        message: "pi backend requires the parent session's model registry.",
      });
    }

    const model = yield* Effect.try({
      try: () => {
        const resolved = resolvePiModel(registry, task.model);
        if (resolved) enforceCostCeiling(registry, resolved, task);
        return resolved;
      },
      catch: (error) => new SpawnError({ message: boundedError(error) }),
    });
    // pi's thinking levels ARE the shared reasoning-effort scale.
    const thinkingLevel = (task.reasoningEffort ??
      loadSubagentModels().pi.effort) as ThinkingLevel | undefined;

    // Parent conversation the btw child inherits, mapped once up front so the
    // same objects are both appended to the child session file and used for
    // identity-based exclusion from the child's own result. The snapshot was
    // taken at spawn time: the parent may keep streaming after it, but these
    // messages are frozen.
    const seedMessages =
      task.origin === "btw" && task.parent.contextMessages?.length
        ? task.parent.contextMessages.map(toSeedMessage)
        : [];
    const seedSet = new Set<object>(seedMessages);

    const session = yield* Effect.tryPromise({
      try: async () => {
        const { loader, settingsManager } = await createChildResources(
          task.cwd,
          task.parent.projectTrusted,
        );
        const sessionManager = SessionManager.create(task.cwd);
        // Naming must precede any seeded history: the dream log classifies
        // session files by scanning only the first 8 KB for a session_info
        // entry, and a large inherited prefix would push it out of range.
        try {
          sessionManager.appendSessionInfo(
            `${task.origin === "btw" ? "btw" : "subagent"}: ${task.title}`,
          );
        } catch {
          // Naming is best-effort.
        }
        seedInheritedBtwContext(sessionManager, seedMessages);
        const { session } = await createAgentSession({
          cwd: task.cwd,
          sessionManager,
          settingsManager,
          resourceLoader: loader,
          model,
          thinkingLevel,
          excludeTools: [...CHILD_EXCLUDED_TOOL_NAMES],
          // btw asides are one-off questions answered from context: the child
          // gets no tools at all, so it cannot wander into tool use.
          noTools: task.origin === "btw" ? "all" : undefined,
        });
        // Start child extension session hooks/resources in headless mode.
        // A rejection here would otherwise leak the freshly created session:
        // the scope finalizer that owns cleanup is only registered later.
        try {
          await session.bindExtensions({ mode: "print" });
        } catch (error) {
          await shutdownAndDisposeChildSession(session);
          throw error;
        }
        return session;
      },
      catch: (error) => new SpawnError({ message: boundedError(error) }),
    });

    const state = {
      closed: false,
      /** prompt() rejection for the active run; folded into RunSettled. */
      runError: undefined as string | undefined,
      /** One terminal event per run: lifecycle, prompt-rejection, and abort
       * fallbacks can all race to settle; the first wins. */
      settled: false,
    };

    const events = yield* Queue.make<SubagentEvent, Cause.Done>();
    const emit = (event: SubagentEvent) => {
      Queue.offerUnsafe(events, event);
    };

    const toolTimeout = createToolCallTimeoutGuard();
    toolTimeout.apply(session);

    const activeModel = (): Model<any> | undefined => {
      const sessionModel = session.model;
      const last = lastAssistantMessage(session, seedSet);
      if (!last) return sessionModel;
      if (
        sessionModel &&
        (last.provider !== sessionModel.provider ||
          last.model !== sessionModel.id)
      ) {
        // The session changed models after this assistant response.
        return sessionModel;
      }
      return (
        registry.find(last.provider, last.responseModel ?? last.model) ??
        sessionModel
      );
    };

    const currentMeta = (): SubagentMeta => {
      const m = activeModel();
      return {
        backend: "pi",
        modelLabel: m ? `${m.provider}/${m.id}` : undefined,
        contextWindow: m?.contextWindow,
        sessionFilePath: session.sessionFile,
      };
    };

    const emitUsage = () => {
      const usage = session.getContextUsage();
      emit({
        _tag: "UsageChanged",
        tokens: usage?.tokens ?? undefined,
        contextWindow: activeModel()?.contextWindow ?? usage?.contextWindow,
      });
    };

    const settle = () => {
      if (state.settled) return;
      state.settled = true;
      const last = lastAssistantMessage(session, seedSet);
      const partialText = finalOutput(session, seedSet) || undefined;
      if (last?.stopReason === "aborted") {
        emit({
          _tag: "RunSettled",
          outcome: { _tag: "Interrupted", partialText },
        });
        return;
      }
      const errorText =
        state.runError ??
        (last?.stopReason === "error"
          ? (last.errorMessage ?? "Run failed")
          : undefined);
      if (errorText !== undefined) {
        emit({
          _tag: "RunSettled",
          outcome: {
            _tag: "Failed",
            errorText: boundedError(errorText),
            partialText,
          },
        });
        return;
      }
      emit({
        _tag: "RunSettled",
        outcome: { _tag: "Completed", finalText: finalOutput(session) },
      });
    };

    const handleEvent = (event: AgentSessionEvent) => {
      if (state.closed) return;
      switch (event.type) {
        case "agent_start":
          // Extensions may register tools between runs; guard new ones too.
          toolTimeout.apply(session);
          state.settled = false;
          emit({ _tag: "RunStarted" });
          break;
        case "message_update": {
          const streamEvent = event.assistantMessageEvent;
          if (streamEvent.type === "text_delta") {
            emit({
              _tag: "AssistantDelta",
              kind: "text",
              delta: streamEvent.delta,
            });
          } else if (streamEvent.type === "thinking_delta") {
            emit({
              _tag: "AssistantDelta",
              kind: "thinking",
              delta: streamEvent.delta,
            });
          }
          break;
        }
        case "message_end": {
          const role = messageRole(event.message);
          if (role === "user") {
            const text = userText(event.message as Message);
            if (text.trim()) emit({ _tag: "UserMessage", text });
          } else if (role === "assistant") {
            emit({
              _tag: "AssistantMessage",
              parts: assistantParts(event.message as AssistantMessage),
            });
            emitUsage();
            emit({ _tag: "MetaChanged", meta: currentMeta() });
          }
          // toolResult messages are covered by tool_execution_end.
          break;
        }
        case "tool_execution_start":
          emit({
            _tag: "ToolStart",
            toolId: event.toolCallId,
            name: event.toolName,
            argsPreview: safeJson(event.args),
          });
          break;
        case "tool_execution_update":
          emit({
            _tag: "ToolUpdate",
            toolId: event.toolCallId,
            outputPreview: toolPreview(event.partialResult),
          });
          break;
        case "tool_execution_end":
          emit({
            _tag: "ToolEnd",
            toolId: event.toolCallId,
            name: event.toolName,
            isError: event.isError,
            outputPreview: toolPreview(event.result),
          });
          break;
        case "queue_update":
          emit({
            _tag: "QueueChanged",
            queued: [
              ...event.steering.map((text) => ({
                text,
                kind: "steer" as const,
              })),
              ...event.followUp.map((text) => ({
                text,
                kind: "follow-up" as const,
              })),
            ],
          });
          break;
        case "agent_settled":
          settle();
          break;
      }
    };
    const unsubscribe = session.subscribe(handleEvent);

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        state.closed = true;
        unsubscribe();
        try {
          session.clearQueue();
        } catch {
          // Continue with abort/dispose.
        }
        await waitBounded(session.abort(), CHILD_SHUTDOWN_TIMEOUT_MS);
        await shutdownAndDisposeChildSession(session);
        Queue.endUnsafe(events);
      }),
    );

    /** Start a fresh run (v1 manager.run): fire-and-forget, errors -> events. */
    const startRun = (text: string) => {
      state.runError = undefined;
      state.settled = false;
      emit({ _tag: "RunStarted" });
      void session.prompt(text).catch((error) => {
        state.runError = boundedError(error);
        // Preflight failures may never start the agent lifecycle, so no
        // agent_settled will arrive for them.
        if (!session.isStreaming) settle();
      });
    };

    emit({ _tag: "MetaChanged", meta: currentMeta() });
    startRun(task.prompt);

    return {
      meta: Effect.sync(currentMeta),
      events: Stream.fromQueue(events),
      send: (text) =>
        Effect.suspend((): Effect.Effect<void, SendError> => {
          if (state.closed) {
            return new SendError({ message: "Subagent session is closed." });
          }
          if (session.isStreaming) {
            // Steer the active run via the SDK's queue; queue_update events
            // render it, message_end(user) lands it in the transcript. A
            // rejected steer is a real send failure, not a diagnostic.
            return Effect.tryPromise({
              try: () => session.steer(text),
              catch: (error) => new SendError({ message: boundedError(error) }),
            }).pipe(Effect.asVoid);
          }
          return Effect.sync(() => startRun(text));
        }),
      interrupt: Effect.promise(async () => {
        if (state.closed) return;
        try {
          session.clearQueue();
        } catch {
          // Abort regardless.
        }
        await session.abort().catch(() => undefined);
        // Only resolve once streaming has actually stopped: reporting the
        // interrupt as complete while the run keeps working would let the
        // manager settle a run that is still mutating the workspace. The
        // manager bounds this effect at 5s and force-disposes on timeout.
        while (!state.closed && session.isStreaming) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        // No streaming run means no agent_settled will arrive; emit the
        // terminal event (once) so the run cannot look running forever.
        if (!state.closed && !state.settled) {
          state.settled = true;
          emit({ _tag: "RunSettled", outcome: { _tag: "Interrupted" } });
        }
      }),
    } satisfies SubagentSession;
  });

export const piBackend: SubagentBackend = {
  name: "pi",
  capabilities: { steering: true, modelSelection: true, reasoningEffort: true },
  // In-process SDK: always available.
  available: Effect.succeed(true),
  spawn: makePiSession,
};
