"use strict";

// This file is launched by sandbox.ts in Node permission mode. It deliberately
// has no filesystem/network/child-process permissions and receives workflow
// source only over a validated IPC channel.
const vm = require("node:vm");
const sendIpc =
  typeof process.send === "function" ? process.send.bind(process) : undefined;
// If a future V8 escape exposes `process`, remove the convenient bridges to
// builtins, native bindings, parent signalling, and addons before any workflow
// source is compiled. The parent still enforces the authenticated IPC protocol.
for (const capability of [
  "getBuiltinModule",
  "binding",
  "_linkedBinding",
  "dlopen",
  "kill",
  "abort",
  "send",
]) {
  try {
    Object.defineProperty(process, capability, {
      value: undefined,
      writable: false,
      configurable: false,
    });
  } catch {
    // The VM boundary and permission mode remain mandatory controls.
  }
}

const BOOTSTRAP = String.raw`
(function bootstrapWorkflowApi() {
  "use strict";
  const callHost = globalThis.__hostBridge;
  delete globalThis.__hostBridge;
  const MAX_CONCURRENCY = globalThis.__maxConcurrency;
  delete globalThis.__maxConcurrency;
  // Explicit error rather than silent truncation, now that the run-wide agent
  // cap is a runaway backstop rather than a practical bound on fan-out.
  const MAX_FANOUT_ITEMS = 4096;

  // Nondeterminism would break resume: a replayed script must produce the same
  // agent() prompts to hit the journal. Stamp results after the run instead.
  const forbid = (name) => () => {
    throw new Error(
      name + " is unavailable in workflow scripts (it would break resume) — pass timestamps in via args, and vary work by index rather than randomly",
    );
  };
  const RealDate = Date;
  Math.random = forbid("Math.random()");
  RealDate.now = forbid("Date.now()");
  globalThis.Date = new Proxy(RealDate, {
    construct(target, callArgs, newTarget) {
      if (callArgs.length === 0) forbid("new Date()")();
      return Reflect.construct(target, callArgs, newTarget);
    },
    apply() {
      return forbid("Date()")();
    },
  });
  let nextRequestId = 0;
  const unconsumed = new Set();
  const inFlight = new Set();

  function deepFreeze(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 32 || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key], depth + 1);
    return value;
  }

  function requestAgent(promptValue, optionsValue = {}) {
    const id = ++nextRequestId;
    unconsumed.add(id);
    let started;
    const begin = () => {
      unconsumed.delete(id);
      if (!started) {
        let payload;
        try {
          payload = JSON.stringify({
            id,
            prompt: typeof promptValue === "string" ? promptValue : String(promptValue ?? ""),
            options: optionsValue && typeof optionsValue === "object" ? optionsValue : {},
          });
        } catch (error) {
          started = Promise.reject(new Error("agent() arguments must be serializable: " + error.message));
          return started;
        }
        inFlight.add(id);
        started = callHost("agent", payload)
          .then((json) => JSON.parse(json))
          .finally(() => inFlight.delete(id));
      }
      return started;
    };
    return Object.freeze({
      then(resolve, reject) {
        return begin().then(resolve, reject);
      },
      catch(reject) {
        return begin().catch(reject);
      },
      finally(callback) {
        return begin().finally(callback);
      },
      get [Symbol.toStringTag]() {
        return "Promise";
      },
    });
  }

  async function mapLimited(items, concurrency, invoke) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await invoke(items[index]);
      }
    });
    await Promise.all(workers);
    return results;
  }

  async function parallel(items, options = {}) {
    if (!Array.isArray(items)) throw new Error("parallel() expects an array of zero-argument agent thunks");
    if (items.length > MAX_FANOUT_ITEMS) {
      throw new Error("parallel() accepts at most " + MAX_FANOUT_ITEMS + " items; got " + items.length);
    }
    for (const item of items) {
      if (typeof item !== "function") {
        throw new Error("parallel() items must be zero-argument functions");
      }
    }
    const requested = options && typeof options.concurrency === "number"
      ? Math.floor(options.concurrency)
      : MAX_CONCURRENCY;
    if (!Number.isFinite(requested) || requested < 1) {
      throw new Error("parallel(): concurrency must be a positive integer");
    }
    const concurrency = Math.min(MAX_CONCURRENCY, requested);
    // A throwing thunk resolves to null rather than rejecting the whole call.
    return mapLimited(items, concurrency, async (item) => {
      try {
        return await item();
      } catch {
        return null;
      }
    });
  }

  // Unlike parallel(), pipeline() holds no script-level worker slot: every item
  // advances as soon as its own previous stage settles, and the run-wide host
  // semaphore is the only thing serialising the agent calls underneath.
  async function pipeline(items, ...stages) {
    if (!Array.isArray(items)) throw new Error("pipeline() expects an array of items");
    if (items.length > MAX_FANOUT_ITEMS) {
      throw new Error("pipeline() accepts at most " + MAX_FANOUT_ITEMS + " items; got " + items.length);
    }
    for (const stage of stages) {
      if (typeof stage !== "function") {
        throw new Error("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
      }
    }
    return Promise.all(items.map(async (item, index) => {
      let value = item;
      try {
        for (const stage of stages) {
          if (value === null) break;
          value = await stage(value, item, index);
        }
      } catch (error) {
        // A throwing stage drops just that item; the rest of the run continues.
        log("pipeline[" + index + "] failed: " + (error && error.message ? error.message : String(error)));
        return null;
      }
      return value === undefined ? null : value;
    }));
  }

  function phase(title) {
    callHost("phase", JSON.stringify({ title: String(title) }));
  }

  function log(message) {
    callHost("log", JSON.stringify({ message: String(message).slice(0, 500) }));
  }

  // Runs a saved workflow inline as a sub-step. The child shares this run's
  // concurrency cap, agent counter, abort signal, and budget. One level only:
  // the host rejects a workflow() call made from inside a nested run.
  async function workflow(nameOrRef, workflowArgs) {
    const name = typeof nameOrRef === "string" ? nameOrRef : undefined;
    if (!name) throw new Error("workflow() expects a saved workflow name");
    let payload;
    try {
      payload = JSON.stringify({ name, args: workflowArgs });
    } catch (error) {
      throw new Error("workflow() args must be serializable: " + error.message);
    }
    const json = await callHost("workflow", payload);
    const settled = JSON.parse(json);
    if (settled && settled.error) throw new Error(settled.error);
    return settled ? settled.result : null;
  }

  // Refreshed by the host on every settled agent() call, so spent()/remaining()
  // read live numbers rather than a snapshot taken at script start.
  let budgetState = globalThis.__budget;
  delete globalThis.__budget;
  globalThis.__setBudget = (next) => {
    budgetState = next;
  };
  const budget = Object.freeze({
    get total() {
      return budgetState.total;
    },
    spent() {
      return budgetState.spent;
    },
    remaining() {
      return budgetState.total === null ? Infinity : budgetState.remaining;
    },
  });

  const argsEnvelope = JSON.parse(globalThis.__argsJson);
  const args = argsEnvelope.defined ? deepFreeze(argsEnvelope.value) : undefined;
  delete globalThis.__argsJson;
  const stringify = JSON.stringify;
  function serializeResult(value) {
    const seen = new WeakSet();
    return stringify(value === undefined ? null : value, (_key, item) => {
      if (typeof item === "bigint") return item.toString() + "n";
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[circular]";
        seen.add(item);
      }
      return item;
    });
  }
  Object.defineProperties(globalThis, {
    agent: { value: requestAgent, writable: false, configurable: false },
    parallel: { value: parallel, writable: false, configurable: false },
    pipeline: { value: pipeline, writable: false, configurable: false },
    phase: { value: phase, writable: false, configurable: false },
    log: { value: log, writable: false, configurable: false },
    budget: { value: budget, writable: false, configurable: false },
    workflow: { value: workflow, writable: false, configurable: false },
    args: { value: args, writable: false, configurable: false },
    __workflowCheck: {
      value: Object.freeze(() => ({
        unconsumed: unconsumed.size,
        inFlight: inFlight.size,
      })),
      writable: false,
      configurable: false,
    },
    __workflowSerialize: {
      value: Object.freeze(serializeResult),
      writable: false,
      configurable: false,
    },
  });
})();
`;

let initialized = false;
let token;
let vmContext;
let nestedRequestId = 0;
const pendingAgents = new Map();

function send(message) {
  sendIpc?.({ token, ...message });
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  send({ kind: "error", error: message.slice(0, 16 * 1024) });
}

process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (!initialized) {
    if (
      message.kind !== "init" ||
      typeof message.token !== "string" ||
      typeof message.source !== "string" ||
      typeof message.argsJson !== "string" ||
      typeof message.budgetJson !== "string" ||
      !Number.isInteger(message.maxConcurrency) ||
      message.maxConcurrency < 1
    ) {
      process.exitCode = 1;
      return;
    }
    initialized = true;
    token = message.token;
    run(
      message.source,
      message.argsJson,
      message.maxConcurrency,
      message.budgetJson,
    );
    return;
  }
  if (message.token === token && message.kind === "workflowResult") {
    const pending = pendingAgents.get("wf:" + message.id);
    if (!pending) return;
    pendingAgents.delete("wf:" + message.id);
    pending.resolve(message.resultJson);
    return;
  }
  if (message.token !== token || message.kind !== "agentResult") return;
  if (typeof message.budgetJson === "string" && vmContext?.__setBudget) {
    try {
      const next = JSON.parse(message.budgetJson);
      if (next) vmContext.__setBudget(next);
    } catch {
      // Keep the previous snapshot.
    }
  }
  const pending = pendingAgents.get(message.id);
  if (!pending) return;
  pendingAgents.delete(message.id);
  if (typeof message.resultJson === "string")
    pending.resolve(message.resultJson);
  else
    pending.reject(
      new Error(
        typeof message.error === "string" ? message.error : "Agent IPC failed",
      ),
    );
});

function run(source, argsJson, maxConcurrency, budgetJson) {
  try {
    const sandbox = Object.create(null);
    sandbox.__argsJson = argsJson;
    sandbox.__maxConcurrency = maxConcurrency;
    sandbox.__budget = JSON.parse(budgetJson);
    sandbox.__hostBridge = (kind, payloadJson) => {
      if (kind === "phase" || kind === "log") {
        send({ kind, payloadJson });
        return undefined;
      }
      if (kind !== "agent" && kind !== "workflow")
        return Promise.reject(new Error("Unknown workflow operation"));
      if (kind === "workflow") {
        const id = ++nestedRequestId;
        return new Promise((resolve, reject) => {
          pendingAgents.set("wf:" + id, { resolve, reject });
          send({
            kind: "workflow",
            payloadJson: JSON.stringify({
              id,
              ...JSON.parse(payloadJson),
            }),
          });
        });
      }
      let id;
      try {
        id = JSON.parse(payloadJson).id;
      } catch {
        return Promise.reject(new Error("Invalid agent request"));
      }
      return new Promise((resolve, reject) => {
        pendingAgents.set(id, { resolve, reject });
        send({ kind: "agent", payloadJson });
      });
    };

    const context = (vmContext = vm.createContext(sandbox, {
      name: "pi-workflow",
      codeGeneration: { strings: false, wasm: false },
    }));
    new vm.Script(BOOTSTRAP, {
      filename: "workflow-bootstrap.js",
    }).runInContext(context, { timeout: 1000 });
    const workflow = vm.compileFunction(
      // Not named `workflow`: a named function expression binds its own name
      // inside the body and would shadow the workflow() primitive parameter.
      `"use strict";\nreturn (async function __piWorkflowBody() {\n${source}\n})();`,
      [
        "agent",
        "parallel",
        "pipeline",
        "phase",
        "log",
        "budget",
        "workflow",
        "args",
      ],
      { filename: "workflow-script.js", parsingContext: context },
    );
    context.__workflowBody = workflow;
    const invoke = `
      (() => {
        const workflowBody = globalThis.__workflowBody;
        delete globalThis.__workflowBody;
        globalThis.__workflowPromise = Promise.resolve(
          workflowBody(agent, parallel, pipeline, phase, log, budget, workflow, args),
        ).then(async (value) => {
          await Promise.resolve();
          const pending = __workflowCheck();
          if (pending.unconsumed > 0) {
            throw new Error("Workflow created " + pending.unconsumed + " unawaited agent() call(s)");
          }
          if (pending.inFlight > 0) {
            throw new Error("Workflow returned before " + pending.inFlight + " agent call(s) settled");
          }
          return __workflowSerialize(value);
        });
      })();
    `;
    new vm.Script(invoke, { filename: "workflow-invoke.js" }).runInContext(
      context,
      { timeout: 1000 },
    );
    Promise.resolve(context.__workflowPromise)
      .then((resultJson) => {
        if (typeof resultJson !== "string")
          throw new Error("Workflow result was not serializable");
        send({ kind: "result", resultJson });
      })
      .catch(fail);
  } catch (error) {
    fail(error);
  }
}
