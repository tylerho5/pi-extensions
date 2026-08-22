/**
 * Builds and drives the dream's child session over the `shared` layer, mirroring
 * what `subagents/backends/pi.ts` does, with two deliberate divergences:
 *
 *   - `SessionManager.inMemory()` — a dream must not write a session file, or
 *     Task 3's scan would count it and the dream could feed itself.
 *   - an explicit `tools` allowlist rather than `noTools` — `noTools: "all"`
 *     would empty the allowlist and drop the custom confined tools with it.
 *
 * The runner owns the turn/cost caps, progress reporting, touched-file tracking
 * (writes, edits, and confined `rm` deletions), and usage capture. A cap trip or
 * a user/shutdown cancel is `"aborted"` (the lock is kept so it cannot retry-loop
 * its spend); an exception or a pre-flight refusal is `"failed"` (the lock rolls
 * back). No real model call happens in tests — the session factory is injectable.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  SessionManager,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";

/** pi's thinking levels are the shared effort scale; derive the type from the SDK. */
type ThinkingLevel = NonNullable<
  NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"]
>;
import {
  bindChildSessionExtensions,
  childToolPolicy,
  createChildResources,
  shutdownAndDisposeChildSession,
} from "../../../shared/child-session.ts";
import { buildDreamPrompt } from "./prompt.ts";
import { serializeSessions, type SessionRef } from "./sessions.ts";
import type { DreamSettings } from "./settings.ts";
import { buildDreamTools, isInsideMemoryDir } from "./tools.ts";

/** What a dream did to one memory file over the whole run. */
export type DreamFileOp = "created" | "edited" | "removed";

export interface DreamResult {
  status: "completed" | "failed" | "aborted";
  filesTouched: string[];
  /** Per-file outcome, grouped for display. Optional so inline failure stubs stay small. */
  fileOps?: { created: string[]; edited: string[]; removed: string[] };
  turns: number;
  costUsd?: number;
  usage?: { tokens?: number; contextWindow?: number };
  summary?: string;
}

/** The slice of AgentSession the runner drives. Both the real session and the test fake satisfy it. */
interface DrivableSession {
  subscribe(listener: (event: any) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  getSessionStats(): { cost: number };
  getContextUsage():
    { tokens?: number | null; contextWindow?: number | null } | undefined;
}

/** Injectable seams so the runner can be tested without a real model or disk I/O. */
export interface DreamRunDeps {
  createResources?: (opts: {
    cwd: string;
    projectTrusted: boolean;
  }) => Promise<{ loader: unknown; settingsManager: unknown }>;
  createSession?: (options: any) => Promise<{ session: DrivableSession }>;
  bindExtensions?: (session: any) => Promise<void>;
  shutdown?: (session: any) => Promise<void>;
}

const DEFAULT_DEPS: Required<DreamRunDeps> = {
  createResources: (opts) => createChildResources(opts),
  createSession: (options) =>
    createAgentSession(options).then((r) => ({
      session: r.session as unknown as DrivableSession,
    })),
  bindExtensions: (session) => bindChildSessionExtensions(session),
  shutdown: (session) => shutdownAndDisposeChildSession(session),
};

/** "provider/model-id" is exact; a bare id must be unambiguous across providers. */
function resolveModel(
  registry: ModelRegistry,
  key: string,
): Model<any> | undefined {
  const slash = key.indexOf("/");
  if (slash > 0) {
    return (
      registry.find(key.slice(0, slash), key.slice(slash + 1)) ?? undefined
    );
  }
  const matches = registry.getAll().filter((model) => model.id === key);
  return matches.length === 1 ? matches[0] : undefined;
}

function assistantText(message: any): string {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter(
      (block: any) => block?.type === "text" && typeof block.text === "string",
    )
    .map((block: any) => block.text)
    .join("\n")
    .trim();
}

/**
 * Files a successful tool call changed, with the operation kind. `write` is
 * "created" or "edited" depending on whether the file existed just before the
 * call (captured at tool_execution_start); `edit` is always "edited"; confined
 * `rm` operands are "removed".
 */
function touchedPaths(
  toolName: string,
  args: any,
  memoryDir: string,
  writeExisted: boolean,
): Array<{ path: string; op: DreamFileOp }> {
  if (toolName === "write" || toolName === "edit") {
    const path = typeof args?.path === "string" ? args.path : undefined;
    if (!path || !isInsideMemoryDir(path, memoryDir)) return [];
    const op: DreamFileOp =
      toolName === "edit" ? "edited" : writeExisted ? "edited" : "created";
    return [{ path: resolve(memoryDir, path), op }];
  }
  if (toolName === "bash") {
    const command: string =
      typeof args?.command === "string" ? args.command : "";
    const tokens = command.trim().split(/\s+/);
    if (tokens[0] !== "rm") return [];
    return tokens
      .slice(1)
      .filter((token) => !token.startsWith("-"))
      .map((token) => token.replace(/^['"]|['"]$/g, ""))
      .filter(
        (token) => token.endsWith(".md") && isInsideMemoryDir(token, memoryDir),
      )
      .map((token) => ({
        path: resolve(memoryDir, token),
        op: "removed" as const,
      }));
  }
  return [];
}

/** Fold one more op into the per-file map: a file created then edited stays "created". */
function recordOp(
  ops: Map<string, DreamFileOp>,
  path: string,
  op: DreamFileOp,
): void {
  if (op === "edited" && ops.get(path) === "created") return;
  ops.set(path, op);
}

export async function runDream(opts: {
  cwd: string;
  memoryDir: string;
  sessions: readonly SessionRef[];
  settings: DreamSettings;
  modelRegistry: ModelRegistry;
  projectTrusted: boolean;
  signal: AbortSignal;
  onProgress?: (p: { turn: number; maxTurns: number; costUsd: number }) => void;
  deps?: DreamRunDeps;
}): Promise<DreamResult> {
  const { memoryDir, settings, signal } = opts;
  const deps = { ...DEFAULT_DEPS, ...opts.deps };

  const model = resolveModel(opts.modelRegistry, settings.model);
  if (!model) {
    return {
      status: "failed",
      filesTouched: [],
      turns: 0,
      summary: `Dream model "${settings.model}" is not available in the model registry. Fix memory.dream.model and the next idle dream will use it.`,
    };
  }

  const { loader, settingsManager } = await deps.createResources({
    cwd: opts.cwd,
    projectTrusted: opts.projectTrusted,
  });

  const { session } = await deps.createSession({
    cwd: opts.cwd,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
    resourceLoader: loader,
    model,
    thinkingLevel: settings.effort as ThinkingLevel,
    tools: ["read", "bash", "write", "edit"],
    customTools: buildDreamTools(memoryDir),
    excludeTools: childToolPolicy().excludeTools,
  });
  await deps.bindExtensions(session);

  const ops = new Map<string, DreamFileOp>();
  const pending = new Map<
    string,
    { toolName: string; args: any; writeExisted: boolean }
  >();
  let turns = 0;
  let costUsd = 0;
  let capTripped = false;
  let userAborted = false;
  let summary: string | undefined;

  const terminal = () => capTripped || userAborted;
  const onAbort = () => {
    userAborted = true;
    void session.abort();
  };

  const unsubscribe = session.subscribe((event) => {
    switch (event?.type) {
      case "message_end": {
        if (event.message?.role !== "assistant" || terminal()) break;
        turns += 1;
        const text = assistantText(event.message);
        if (text) summary = text;
        costUsd = session.getSessionStats().cost;
        opts.onProgress?.({
          turn: turns,
          maxTurns: settings.maxTurns,
          costUsd,
        });
        if (turns >= settings.maxTurns || costUsd >= settings.maxCostUsd) {
          capTripped = true;
          void session.abort();
        }
        break;
      }
      case "tool_execution_start": {
        // For writes, snapshot existence now — by tool_execution_end the file
        // already exists and created-vs-edited would be unknowable.
        let writeExisted = false;
        const path =
          typeof event.args?.path === "string" ? event.args.path : undefined;
        if (
          event.toolName === "write" &&
          path &&
          isInsideMemoryDir(path, memoryDir)
        ) {
          writeExisted = existsSync(resolve(memoryDir, path));
        }
        pending.set(event.toolCallId, {
          toolName: event.toolName,
          args: event.args,
          writeExisted,
        });
        break;
      }
      case "tool_execution_end": {
        const started = pending.get(event.toolCallId);
        pending.delete(event.toolCallId);
        if (event.isError || !started) break;
        for (const { path, op } of touchedPaths(
          started.toolName,
          started.args,
          memoryDir,
          started.writeExisted,
        )) {
          recordOp(ops, path, op);
        }
        break;
      }
    }
  });

  let failed = false;
  let failureMessage: string | undefined;
  try {
    if (signal.aborted) {
      userAborted = true;
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
      const transcriptText = await serializeSessions(
        opts.sessions,
        settings.transcriptBudgetBytes,
      );
      await session.prompt(
        buildDreamPrompt({
          memoryDir,
          sessions: opts.sessions,
          transcriptText,
        }),
      );
    }
  } catch (error) {
    if (!terminal()) {
      failed = true;
      failureMessage = error instanceof Error ? error.message : String(error);
    }
  } finally {
    unsubscribe();
    signal.removeEventListener("abort", onAbort);
    await deps.shutdown(session);
  }

  const usage = session.getContextUsage();
  const status = terminal() ? "aborted" : failed ? "failed" : "completed";
  const created: string[] = [];
  const edited: string[] = [];
  const removed: string[] = [];
  for (const [path, op] of ops) {
    (op === "created" ? created : op === "edited" ? edited : removed).push(
      path,
    );
  }
  return {
    status,
    filesTouched: [...ops.keys()],
    fileOps: { created, edited, removed },
    turns,
    costUsd,
    usage: usage
      ? {
          tokens: usage.tokens ?? undefined,
          contextWindow: usage.contextWindow ?? undefined,
        }
      : undefined,
    summary: failed ? failureMessage : summary,
  };
}
