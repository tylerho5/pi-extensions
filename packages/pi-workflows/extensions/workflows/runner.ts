/**
 * Workflow subagent runner.
 *
 * Each `agent()` call in a workflow script becomes one isolated in-process
 * AgentSession created here: in-memory session, normal trust-aware resources
 * and extensions, recursive orchestration/user-prompt tools denied, and an
 * optional one-shot `structured_output` tool when a schema is supplied.
 *
 * `runAgent()` never throws: every failure mode (session creation, provider
 * errors, aborts, missing structured output) settles into an `AgentOutcome`.
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionEventListener,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import {
  bindChildSessionExtensions,
  childToolPolicy,
  createChildResources,
  shutdownAndDisposeChildSession,
} from "../shared/child-session.ts";
import { createToolCallTimeoutGuard } from "../shared/tool-call-timeout.ts";
import { emptyUsage, type AgentUsage, type TranscriptEntry } from "./model.ts";
import {
  buildWorkflowAgentPrompt,
  STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION,
  STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
  WORKFLOW_AGENT_SYSTEM_INSTRUCTION,
} from "./prompt.ts";
import { safeStringify, truncateUtf8 } from "./serialization.ts";

const AGENT_OUTPUT_MAX_BYTES = 64 * 1024;
export const FIRST_RESPONSE_TIMEOUT_MS = 45_000;
/** Matches CC's MAX_STRUCTURED_OUTPUT_RETRIES: give up rather than loop forever. */
export const MAX_STRUCTURED_OUTPUT_ATTEMPTS = 5;
/** Mid-run no-progress abort, matching CC's stall window. */
export const STALL_TIMEOUT_MS = 180_000;
const TRANSCRIPT_ENTRY_MAX_BYTES = 16 * 1024;
const TRANSCRIPT_TOTAL_MAX_BYTES = 256 * 1024;
const TRANSCRIPT_MAX_ENTRIES = 200;

export type WorkflowModel = NonNullable<ExtensionContext["model"]>;
export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type AgentMessage = AgentSession["messages"][number];
type ToolTimingEvent = Extract<
  AgentSessionEvent,
  { type: "tool_execution_start" | "tool_execution_end" }
>;

export interface ToolExecutionTiming {
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
}

export interface AgentOutcome {
  ok: boolean;
  /** Final assistant text (may be empty when only structured output was produced). */
  output: string;
  /** Captured structured_output payload when a schema was supplied. */
  structured?: unknown;
  error?: string;
  aborted: boolean;
  usage: AgentUsage;
  model?: string;
  contextWindow?: number;
  transcript: TranscriptEntry[];
}

export interface AgentProgress {
  preview: string;
  usage: AgentUsage;
  model?: string;
  contextWindow?: number;
  transcript: TranscriptEntry[];
}

export interface RunAgentOptions {
  prompt: string;
  schema?: unknown;
  model?: WorkflowModel;
  thinkingLevel?: ThinkingLevel;
  cwd: string;
  loader: DefaultResourceLoader;
  settingsManager: SettingsManager;
  modelRegistry: ExtensionContext["modelRegistry"];
  signal?: AbortSignal;
  onProgress?: (progress: AgentProgress) => void;
  /** Test-only override for the per-tool execution timeout. */
  toolCallTimeoutMs?: number;
  /** Test-only override for the first assistant response-event timeout. */
  firstResponseTimeoutMs?: number;
  /** Test-only override for the mid-run no-progress timeout. */
  stallTimeoutMs?: number;
}

/** Build a fresh extension runtime for each concurrent workflow child. */
export function createWorkflowResources(
  cwd: string,
  variant: "plain" | "structured",
  projectTrusted: boolean,
) {
  return createChildResources({
    cwd,
    projectTrusted,
    appendSystemPrompt: [
      variant === "structured"
        ? STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION
        : WORKFLOW_AGENT_SYSTEM_INSTRUCTION,
    ],
  });
}

interface WorkflowToolSession {
  getAllTools(): Array<{ name: string }>;
  getToolDefinition(name: string): ToolDefinition | undefined;
  subscribe(listener: AgentSessionEventListener): () => void;
}

/** Guard current tools and tools registered by extensions at later agent starts. */
export function guardWorkflowChildTools(
  session: WorkflowToolSession,
  timeoutMs?: number,
) {
  const guard = createToolCallTimeoutGuard(timeoutMs);
  guard.apply(session);
  return session.subscribe((event) => {
    if (event.type === "agent_start") guard.apply(session);
  });
}

function isJsonSchema(value: unknown): value is TSchema {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const seen = new WeakSet<object>();
  let nodes = 0;
  const validate = (current: unknown, depth: number): boolean => {
    if (++nodes > 10_000 || depth > 24) return false;
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return true;
    }
    if (typeof current === "number") return Number.isFinite(current);
    if (Array.isArray(current)) {
      return current.every((item) => validate(item, depth + 1));
    }
    if (typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);
    return Object.keys(current).every((key) => {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        return false;
      }
      return validate((current as Record<string, unknown>)[key], depth + 1);
    });
  };
  return validate(value, 0);
}

/** Preserve the caller's full JSON Schema instead of lossy keyword conversion. */
function jsonSchemaToTypebox(schema: unknown): TSchema {
  if (!isJsonSchema(schema)) {
    throw new Error("structured output schema must be a bounded JSON object");
  }
  return Type.Unsafe(schema);
}

/**
 * One-shot terminating tool injected when a schema is supplied: the subagent
 * calls it as its final action and we capture the validated object.
 */
function makeStructuredOutputTool(
  schema: unknown,
  capture: (value: unknown) => void,
): ToolDefinition {
  return defineTool({
    name: "structured_output",
    label: "Structured Output",
    description: STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
    parameters: jsonSchemaToTypebox(schema),
    async execute(_toolCallId, params) {
      capture(params);
      return {
        content: [{ type: "text", text: "Recorded structured result." }],
        details: params,
        terminate: true,
      };
    },
  });
}

/** How many times the child has tried to terminate with structured output. */
function countStructuredOutputAttempts(messages: AgentMessage[]): number {
  let attempts = 0;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "toolCall" && part.name === "structured_output") {
        attempts++;
      }
    }
  }
  return attempts;
}

function finalOutput(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const text = msg.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function safeJson(value: unknown): string {
  return safeStringify(value, {
    maxBytes: TRANSCRIPT_ENTRY_MAX_BYTES,
    maxDepth: 12,
    maxNodes: 2_000,
  });
}

/** Record lifecycle timings without inferring completion from message timestamps. */
export function recordToolExecutionTiming(
  timings: Map<string, ToolExecutionTiming>,
  event: ToolTimingEvent,
  observedAt = Date.now(),
) {
  const previous = timings.get(event.toolCallId);
  if (event.type === "tool_execution_start") {
    if (previous?.startedAt !== undefined) return;
    timings.set(event.toolCallId, { ...previous, startedAt: observedAt });
    return;
  }
  if (previous?.finishedAt !== undefined) return;
  const durationMs =
    previous?.startedAt === undefined
      ? undefined
      : Math.max(0, observedAt - previous.startedAt);
  timings.set(event.toolCallId, {
    ...previous,
    finishedAt: observedAt,
    ...(durationMs === undefined ? {} : { durationMs }),
  });
}

function toolMetadata(
  toolCallId: string,
  timings: ReadonlyMap<string, ToolExecutionTiming>,
) {
  const timing = timings.get(toolCallId);
  return {
    toolCallId: truncateUtf8(toolCallId, 1024),
    ...(timing?.startedAt === undefined ? {} : { startedAt: timing.startedAt }),
    ...(timing?.finishedAt === undefined
      ? {}
      : { finishedAt: timing.finishedAt }),
    ...(timing?.durationMs === undefined
      ? {}
      : { durationMs: timing.durationMs }),
  };
}

/** Convert pi messages into a compact, serializable transcript for the UI. */
export function transcriptFromMessages(
  messages: AgentMessage[],
  toolTimings: ReadonlyMap<string, ToolExecutionTiming> = new Map(),
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .map((part) =>
                part.type === "text" ? part.text : `[image: ${part.mimeType}]`,
              )
              .join("\n");
      if (text.trim()) {
        entries.push({ role: "user", text, timestamp: message.timestamp });
      }
      continue;
    }

    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "text" && part.text.trim()) {
          entries.push({
            role: "assistant",
            text: part.text,
            timestamp: message.timestamp,
          });
        } else if (part.type === "thinking" && part.thinking.trim()) {
          entries.push({
            role: "thinking",
            text: part.thinking,
            timestamp: message.timestamp,
          });
        } else if (part.type === "toolCall") {
          entries.push({
            role: "tool",
            name: part.name,
            text: safeJson(part.arguments),
            timestamp: message.timestamp,
            ...toolMetadata(part.id, toolTimings),
          });
        }
      }
      continue;
    }

    if (message.role !== "toolResult") continue;
    const text = message.content
      .map((part) =>
        part.type === "text" ? part.text : `[image: ${part.mimeType}]`,
      )
      .join("\n");
    entries.push({
      role: "toolResult",
      name: message.toolName,
      text,
      isError: message.isError,
      timestamp: message.timestamp,
      ...toolMetadata(message.toolCallId, toolTimings),
    });
  }
  const selected =
    entries.length <= TRANSCRIPT_MAX_ENTRIES
      ? entries
      : [entries[0], ...entries.slice(-(TRANSCRIPT_MAX_ENTRIES - 1))];
  const bounded: TranscriptEntry[] = [];
  let totalBytes = 0;
  for (const entry of selected) {
    const remaining = TRANSCRIPT_TOTAL_MAX_BYTES - totalBytes;
    if (remaining <= 0) break;
    const text = truncateUtf8(
      entry.text,
      Math.min(TRANSCRIPT_ENTRY_MAX_BYTES, remaining),
    );
    totalBytes += Buffer.byteLength(text, "utf8");
    bounded.push({
      ...entry,
      text:
        text === entry.text ? text : `${text}\n[transcript entry truncated]`,
    });
  }
  if (bounded.length < entries.length) {
    bounded.push({
      role: "toolResult",
      name: "transcript",
      text: `[transcript truncated: retained ${bounded.length} of ${entries.length} entries]`,
    });
  }
  return bounded;
}

function computeUsage(messages: AgentMessage[]): AgentUsage {
  const usage = emptyUsage();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    usage.turns++;
    const u = msg.usage;
    if (!u) continue;
    usage.input += u.input || 0;
    usage.output += u.output || 0;
    usage.cacheRead += u.cacheRead || 0;
    usage.cacheWrite += u.cacheWrite || 0;
    usage.cost += u.cost?.total || 0;
  }
  return usage;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    16 * 1024,
  );
}

function formatTimeout(timeoutMs: number) {
  return timeoutMs % 1_000 === 0
    ? `${timeoutMs / 1_000} seconds`
    : `${timeoutMs} ms`;
}

/**
 * Abort an agent that stops making progress mid-run. Re-armed by every session
 * event; suspended while a tool executes, since the per-tool-call timeout
 * already bounds that and would otherwise trip this at the same moment.
 */
export function createStallWatchdog(
  onStall: (message: string) => void,
  options: { timeoutMs?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? STALL_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let toolsInFlight = 0;
  let disarmed = false;

  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (disarmed || toolsInFlight > 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      disarmed = true;
      onStall(`Agent stalled — no progress for ${formatTimeout(timeoutMs)}.`);
    }, timeoutMs);
    timer.unref?.();
  };

  return {
    notify: arm,
    toolStarted() {
      toolsInFlight++;
      arm();
    },
    toolFinished() {
      toolsInFlight = Math.max(0, toolsInFlight - 1);
      arm();
    },
    disarm() {
      disarmed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** Abort a provider call that opens but never emits its first assistant event. */
export function createFirstResponseWatchdog(
  onTimeout: () => Promise<unknown>,
  options: { timeoutMs?: number; model?: string } = {},
) {
  const timeoutMs = options.timeoutMs ?? FIRST_RESPONSE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timer = undefined;
      const model = options.model ? ` for ${options.model}` : "";
      reject(
        new Error(
          `Agent received no assistant response event${model} within ${formatTimeout(timeoutMs)}; the provider request may be stalled. Retry the workflow.`,
        ),
      );
      void onTimeout().catch(() => {});
    }, timeoutMs);
    timer.unref?.();
  });

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  return {
    markResponse: cancel,
    async waitFor<T>(operation: Promise<T>) {
      try {
        return await Promise.race([operation, timeout]);
      } finally {
        cancel();
      }
    },
  };
}

function isAssistantResponseEvent(event: AgentSessionEvent) {
  return (
    (event.type === "message_start" ||
      event.type === "message_update" ||
      event.type === "message_end") &&
    event.message.role === "assistant"
  );
}

export async function runAgent(
  options: RunAgentOptions,
): Promise<AgentOutcome> {
  let structured: unknown;
  let customTools: ToolDefinition[] | undefined;
  let session: AgentSession | undefined;
  let unsubscribeToolTimeout: (() => void) | undefined;
  try {
    customTools =
      options.schema !== undefined
        ? [
            makeStructuredOutputTool(options.schema, (value) => {
              structured = value;
            }),
          ]
        : undefined;
    ({ session } = await createAgentSession({
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.thinkingLevel
        ? { thinkingLevel: options.thinkingLevel }
        : {}),
      resourceLoader: options.loader,
      settingsManager: options.settingsManager,
      sessionManager: SessionManager.inMemory(options.cwd),
      ...(customTools ? { customTools } : {}),
      ...childToolPolicy(),
    }));
    await bindChildSessionExtensions(session);
    unsubscribeToolTimeout = guardWorkflowChildTools(
      session,
      options.toolCallTimeoutMs,
    );
  } catch (error) {
    unsubscribeToolTimeout?.();
    if (session) await shutdownAndDisposeChildSession(session);
    return {
      ok: false,
      output: "",
      error: `Failed to create agent session: ${errorText(error)}`,
      aborted: false,
      usage: emptyUsage(),
      model: options.model?.id,
      contextWindow: options.model?.contextWindow,
      transcript: [],
    };
  }

  const childSession = session;
  let usage = emptyUsage();
  let modelId = childSession.model?.id ?? options.model?.id;
  let contextWindow = childSession.model?.contextWindow;
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  const toolTimings = new Map<string, ToolExecutionTiming>();

  const sync = () => {
    const messages = childSession.messages;
    usage = computeUsage(messages);

    const sessionModel = childSession.model;
    modelId = sessionModel?.id ?? modelId;
    contextWindow = sessionModel?.contextWindow ?? contextWindow;
    const context = childSession.getContextUsage();
    if (
      typeof context?.tokens === "number" &&
      Number.isFinite(context.tokens) &&
      context.tokens >= 0
    ) {
      usage.contextTokens = context.tokens;
    }
    if (
      typeof context?.contextWindow === "number" &&
      Number.isFinite(context.contextWindow) &&
      context.contextWindow > 0
    ) {
      contextWindow = context.contextWindow;
    }

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "assistant") continue;
      // Some gateways report a concrete fallback model. Prefer its registry
      // metadata when available so capacity tracks the model that served the
      // latest response rather than a hardcoded/configured guess.
      const responseMatchesSession =
        !sessionModel ||
        (msg.provider === sessionModel.provider &&
          msg.model === sessionModel.id);
      const reportedId = msg.responseModel ?? msg.model;
      const reportedModel = responseMatchesSession
        ? options.modelRegistry.find(msg.provider, reportedId)
        : undefined;
      if (reportedModel) {
        modelId = reportedModel.id;
        contextWindow = reportedModel.contextWindow;
      }
      if (msg.stopReason) stopReason = msg.stopReason;
      if (msg.errorMessage) errorMessage = msg.errorMessage;
      break;
    }
  };

  let markFirstResponse = () => {};
  /** Set when we abort deliberately, so the outcome says why. */
  let terminationReason: string | undefined;
  const stall = createStallWatchdog(
    (message) => {
      terminationReason ??= message;
      void childSession.abort().catch(() => {});
    },
    { timeoutMs: options.stallTimeoutMs },
  );

  const unsubscribe = childSession.subscribe((event) => {
    if (isAssistantResponseEvent(event)) markFirstResponse();
    stall.notify();
    if (
      options.schema !== undefined &&
      structured === undefined &&
      terminationReason === undefined &&
      countStructuredOutputAttempts(childSession.messages) >=
        MAX_STRUCTURED_OUTPUT_ATTEMPTS
    ) {
      // Every attempt failed validation; stop burning turns on a shape the
      // child cannot produce.
      terminationReason = `Agent failed to produce valid structured output in ${MAX_STRUCTURED_OUTPUT_ATTEMPTS} attempts.`;
      stall.disarm();
      void childSession.abort().catch(() => {});
    }
    if (
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_end"
    ) {
      recordToolExecutionTiming(toolTimings, event);
      if (event.type === "tool_execution_start") stall.toolStarted();
      else stall.toolFinished();
    } else if (
      event.type !== "message_end" &&
      event.type !== "compaction_end"
    ) {
      return;
    }
    sync();
    options.onProgress?.({
      preview: finalOutput(childSession.messages),
      usage,
      model: modelId,
      contextWindow,
      transcript: transcriptFromMessages(childSession.messages, toolTimings),
    });
  });

  let aborted = false;
  let abortPromise: Promise<void> | undefined;
  const onAbort = () => {
    aborted = true;
    abortPromise ??= childSession.abort().catch(() => {});
  };
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  let output = "";
  let transcript: TranscriptEntry[] = [];
  try {
    if (!aborted) {
      const watchdog = createFirstResponseWatchdog(() => childSession.abort(), {
        timeoutMs: options.firstResponseTimeoutMs,
        model: modelId,
      });
      markFirstResponse = watchdog.markResponse;
      await watchdog.waitFor(
        childSession.prompt(buildWorkflowAgentPrompt(options.prompt)),
      );
    }
  } catch (error) {
    errorMessage = errorMessage ?? errorText(error);
    stopReason = stopReason ?? "error";
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    stall.disarm();
    if (abortPromise) await abortPromise;
    unsubscribe();
    unsubscribeToolTimeout?.();
    sync();
    output = truncateUtf8(
      finalOutput(childSession.messages),
      AGENT_OUTPUT_MAX_BYTES,
    );
    transcript = transcriptFromMessages(childSession.messages, toolTimings);
    await shutdownAndDisposeChildSession(childSession);
  }

  if (terminationReason !== undefined) {
    return {
      ok: false,
      output,
      structured,
      error: terminationReason,
      aborted: false,
      usage,
      model: modelId,
      contextWindow,
      transcript,
    };
  }

  if (aborted || stopReason === "aborted") {
    return {
      ok: false,
      output,
      structured,
      error: "Agent was aborted",
      aborted: true,
      usage,
      model: modelId,
      contextWindow,
      transcript,
    };
  }

  // A schema'd agent whose structured result was captured and validated has
  // delivered its output. The provider can still "terminate" the stream while
  // emitting the final structured_output call, which stamps that message with
  // stopReason="error" / errorMessage="terminated" even though the tool ran and
  // the loop ended cleanly (terminate:true). Salvage the result instead of
  // discarding it.
  if (options.schema !== undefined && structured !== undefined) {
    return {
      ok: true,
      output,
      structured,
      aborted: false,
      usage,
      model: modelId,
      contextWindow,
      transcript,
    };
  }

  const failed = stopReason === "error" || errorMessage !== undefined;
  if (failed) {
    return {
      ok: false,
      output,
      structured,
      error: errorMessage ?? "Agent failed",
      aborted: false,
      usage,
      model: modelId,
      contextWindow,
      transcript,
    };
  }

  if (options.schema !== undefined && structured === undefined) {
    return {
      ok: false,
      output,
      error:
        "Agent finished without calling structured_output; no structured result matching the schema was produced.",
      aborted: false,
      usage,
      model: modelId,
      contextWindow,
      transcript,
    };
  }

  return {
    ok: true,
    output,
    structured,
    aborted: false,
    usage,
    model: modelId,
    contextWindow,
    transcript,
  };
}
