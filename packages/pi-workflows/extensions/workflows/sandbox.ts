import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { BudgetView } from "./budget.ts";
import { DEFAULT_CONCURRENCY } from "./controller.ts";
import { MAX_WORKFLOW_SOURCE_BYTES } from "./meta.ts";
import { losslessJsonStringify } from "./serialization.ts";

const MAX_SOURCE_BYTES = MAX_WORKFLOW_SOURCE_BYTES;
const MAX_ARGS_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_AGENT_MESSAGE_BYTES = 512 * 1024;
const MAX_AGENT_REQUESTS = 1000;

export interface SandboxAgentOptions {
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

/**
 * Whatever the agent returned: its final text, the validated object when a
 * schema was supplied, or `null` when it failed.
 */
export type SandboxAgentResult = unknown;

export interface RunWorkflowSandboxOptions {
  source: string;
  args: unknown;
  cwd: string;
  signal: AbortSignal;
  onAgent: (
    prompt: string,
    options: SandboxAgentOptions,
    signal: AbortSignal,
  ) => Promise<SandboxAgentResult>;
  onPhase: (title: string) => void;
  /** Script-emitted progress lines, including pipeline stage failures. */
  onLog?: (message: string) => void;
  /** Live budget snapshot pushed to the script after every settled agent. */
  budget?: () => BudgetView | null;
  /** Runs a saved workflow inline; absent inside a nested run (one level only). */
  onNestedWorkflow?: (
    name: string,
    args: unknown,
    signal: AbortSignal,
  ) => Promise<{ result?: unknown; error?: string }>;
}

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function terminateChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }, 1_000);
  force.unref?.();
}

function sanitizeAgentOptions(value: unknown): SandboxAgentOptions {
  if (!isRecord(value)) return {};
  return {
    ...(value.label !== undefined ? { label: value.label } : {}),
    ...(value.phase !== undefined ? { phase: value.phase } : {}),
    ...(value.schema !== undefined ? { schema: value.schema } : {}),
    ...(value.tier !== undefined ? { tier: value.tier } : {}),
    ...(value.model !== undefined ? { model: value.model } : {}),
    ...(value.provider !== undefined ? { provider: value.provider } : {}),
    ...(value.effort !== undefined ? { effort: value.effort } : {}),
    ...(value.isolation !== undefined ? { isolation: value.isolation } : {}),
    ...(value.requireWork !== undefined
      ? { requireWork: value.requireWork }
      : {}),
    ...(value.stallMs !== undefined ? { stallMs: value.stallMs } : {}),
  };
}

/**
 * Execute orchestration code in a separate, permission-restricted Node process.
 * The child can only invoke the narrow agent/phase IPC protocol and is always
 * terminated on completion, cancellation, or protocol failure. The workflow
 * itself and its agent requests have no wall-clock deadline. Active requests
 * are aborted only when the workflow is cancelled or the sandbox is cleaned up.
 */
export function runWorkflowSandbox(options: RunWorkflowSandboxOptions) {
  if (!process.allowedNodeEnvironmentFlags.has("--permission")) {
    return Promise.reject(
      new Error("This Node runtime cannot enforce workflow child permissions"),
    );
  }
  if (byteLength(options.source) > MAX_SOURCE_BYTES) {
    return Promise.reject(
      new Error(`Workflow script exceeds the ${MAX_SOURCE_BYTES} byte limit`),
    );
  }

  let argsJson: string;
  try {
    argsJson = losslessJsonStringify(
      {
        defined: options.args !== undefined,
        ...(options.args !== undefined ? { value: options.args } : {}),
      },
      MAX_ARGS_BYTES,
    );
  } catch {
    return Promise.reject(new Error("Workflow args exceed the IPC limit"));
  }

  return new Promise<unknown>((resolve, reject) => {
    const workerPath = fileURLToPath(
      new URL("./sandbox-child.cjs", import.meta.url),
    );
    const child = spawn(
      process.execPath,
      [
        "--permission",
        `--allow-fs-read=${path.dirname(workerPath)}`,
        "--max-old-space-size=128",
        "--stack-size=2048",
        workerPath,
      ],
      {
        cwd: options.cwd,
        env: {
          PATH: process.env.PATH ?? "",
          NODE_NO_WARNINGS: "1",
        },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    const token = randomBytes(24).toString("hex");
    const requestIds = new Set<number>();
    const activeAgentRequests = new Map<number, AbortController>();
    const activeNestedRequests = new Map<number, AbortController>();
    let requestCount = 0;
    let finished = false;

    const cleanup = () => {
      for (const abortController of activeAgentRequests.values()) {
        abortController.abort(new Error("Workflow stopped"));
      }
      activeAgentRequests.clear();
      for (const abortController of activeNestedRequests.values()) {
        abortController.abort(new Error("Workflow stopped"));
      }
      activeNestedRequests.clear();
      options.signal.removeEventListener("abort", onAbort);
      child.removeAllListeners("message");
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
      terminateChild(child);
    };
    const finish = (error?: Error, value?: unknown) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(new Error("Workflow was aborted"));

    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) {
      onAbort();
      return;
    }

    child.on("error", (error) => finish(error));
    child.on("exit", (code, exitSignal) => {
      if (!finished) {
        finish(
          new Error(
            `Workflow sandbox exited before completion (${exitSignal ?? code ?? "unknown"})`,
          ),
        );
      }
    });
    child.on("message", (raw: unknown) => {
      if (
        !isRecord(raw) ||
        raw.token !== token ||
        typeof raw.kind !== "string"
      ) {
        finish(new Error("Workflow sandbox sent an invalid IPC message"));
        return;
      }
      if (raw.kind === "phase") {
        if (
          typeof raw.payloadJson !== "string" ||
          byteLength(raw.payloadJson) > 4096
        ) {
          finish(new Error("Workflow sandbox sent an invalid phase update"));
          return;
        }
        try {
          const payload: unknown = JSON.parse(raw.payloadJson);
          if (!isRecord(payload) || typeof payload.title !== "string") {
            throw new Error("invalid title");
          }
          options.onPhase(payload.title.slice(0, 160));
        } catch {
          finish(new Error("Workflow sandbox sent an invalid phase update"));
        }
        return;
      }
      if (raw.kind === "log") {
        if (
          typeof raw.payloadJson !== "string" ||
          byteLength(raw.payloadJson) > 4096
        ) {
          finish(new Error("Workflow sandbox sent an invalid log message"));
          return;
        }
        try {
          const payload: unknown = JSON.parse(raw.payloadJson);
          if (!isRecord(payload) || typeof payload.message !== "string") {
            throw new Error("invalid message");
          }
          options.onLog?.(payload.message.slice(0, 500));
        } catch {
          finish(new Error("Workflow sandbox sent an invalid log message"));
        }
        return;
      }
      if (raw.kind === "workflow") {
        if (
          typeof raw.payloadJson !== "string" ||
          byteLength(raw.payloadJson) > MAX_AGENT_MESSAGE_BYTES
        ) {
          finish(new Error("Workflow sandbox sent an invalid nested request"));
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(raw.payloadJson);
        } catch {
          finish(new Error("Workflow sandbox sent malformed nested JSON"));
          return;
        }
        if (
          !isRecord(payload) ||
          typeof payload.id !== "number" ||
          typeof payload.name !== "string"
        ) {
          finish(new Error("Workflow sandbox sent an invalid nested request"));
          return;
        }
        const nestedId = payload.id;
        const reply = (settled: { result?: unknown; error?: string }) => {
          if (finished || !child.connected) return;
          let resultJson: string;
          try {
            resultJson = losslessJsonStringify(
              settled,
              MAX_AGENT_MESSAGE_BYTES,
            );
          } catch {
            resultJson = JSON.stringify({
              error: "Nested workflow result exceeded the IPC limit",
            });
          }
          child.send({
            token,
            kind: "workflowResult",
            id: nestedId,
            resultJson,
          });
        };
        const handler = options.onNestedWorkflow;
        if (!handler) {
          reply({ error: "workflow() cannot be nested more than one level" });
          return;
        }
        const abortController = new AbortController();
        const abortNested = () =>
          abortController.abort(
            options.signal.reason ?? new Error("Workflow stopped"),
          );
        if (options.signal.aborted) abortNested();
        else
          options.signal.addEventListener("abort", abortNested, { once: true });
        activeNestedRequests.set(nestedId, abortController);
        void handler(payload.name, payload.args, abortController.signal)
          .then(reply)
          .catch((error) => reply({ error: errorText(error) }))
          .finally(() => {
            activeNestedRequests.delete(nestedId);
            options.signal.removeEventListener("abort", abortNested);
          });
        return;
      }
      if (raw.kind === "agent") {
        if (
          typeof raw.payloadJson !== "string" ||
          byteLength(raw.payloadJson) > MAX_AGENT_MESSAGE_BYTES
        ) {
          finish(new Error("Workflow sandbox sent an oversized agent request"));
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(raw.payloadJson);
        } catch {
          finish(new Error("Workflow sandbox sent malformed agent JSON"));
          return;
        }
        if (
          !isRecord(payload) ||
          !Number.isSafeInteger(payload.id) ||
          typeof payload.id !== "number" ||
          payload.id < 1 ||
          typeof payload.prompt !== "string" ||
          payload.prompt.length > 100_000 ||
          !isRecord(payload.options)
        ) {
          finish(new Error("Workflow sandbox sent an invalid agent request"));
          return;
        }
        if (requestIds.has(payload.id) || ++requestCount > MAX_AGENT_REQUESTS) {
          finish(
            new Error("Workflow sandbox exceeded its agent request budget"),
          );
          return;
        }
        requestIds.add(payload.id);
        const id = payload.id;
        const abortController = new AbortController();
        const sendResult = (result: SandboxAgentResult) => {
          if (!activeAgentRequests.has(id)) return;
          if (finished || !child.connected) {
            activeAgentRequests.delete(id);
            return;
          }
          let resultJson: string;
          try {
            resultJson = losslessJsonStringify(result, MAX_AGENT_MESSAGE_BYTES);
          } catch {
            sendFailure(
              new Error(
                "Agent result exceeded the IPC limit or was not JSON data",
              ),
            );
            return;
          }
          activeAgentRequests.delete(id);
          if (finished || !child.connected) return;
          child.send({
            token,
            kind: "agentResult",
            id,
            resultJson,
            budgetJson: JSON.stringify(options.budget?.() ?? null),
          });
        };
        // A rejected onAgent rejects agent() inside the script; that is how the
        // hard token budget stops a runaway loop.
        const sendFailure = (error: unknown) => {
          if (!activeAgentRequests.delete(id)) return;
          if (finished || !child.connected) return;
          child.send({
            token,
            kind: "agentResult",
            id,
            error: errorText(error),
            budgetJson: JSON.stringify(options.budget?.() ?? null),
          });
        };
        activeAgentRequests.set(id, abortController);
        void options
          .onAgent(
            payload.prompt,
            sanitizeAgentOptions(payload.options),
            abortController.signal,
          )
          .then(sendResult)
          .catch(sendFailure);
        return;
      }
      if (raw.kind === "result") {
        if (
          typeof raw.resultJson !== "string" ||
          byteLength(raw.resultJson) > MAX_RESULT_BYTES
        ) {
          finish(new Error("Workflow result exceeded the IPC limit"));
          return;
        }
        try {
          finish(undefined, JSON.parse(raw.resultJson));
        } catch (error) {
          finish(
            new Error(`Workflow returned invalid JSON: ${errorText(error)}`),
          );
        }
        return;
      }
      if (raw.kind === "error" && typeof raw.error === "string") {
        finish(new Error(raw.error.slice(0, 16 * 1024)));
        return;
      }
      finish(new Error("Workflow sandbox sent an unknown IPC message"));
    });

    child.send(
      {
        kind: "init",
        token,
        source: options.source,
        argsJson,
        maxConcurrency: DEFAULT_CONCURRENCY,
        budgetJson: JSON.stringify(
          options.budget?.() ?? { total: null, spent: 0, remaining: Infinity },
        ),
      },
      (error) => {
        if (error) finish(error);
      },
    );
  });
}
