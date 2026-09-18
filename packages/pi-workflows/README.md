# @tylerho/pi-workflows

Sandboxed multi-agent workflow orchestration, plus a deterministic multi-angle code review built on it.

## Install

`pi install npm:@tylerho/pi-workflows`

---

# Workflows

Model-authored multi-agent orchestration on top of subagent-style child sessions. A `workflow` tool runs an inline JavaScript orchestration script in a restricted, killable child process: the script encodes the structure (phases, fan-out, verification, synthesis) as deterministic JS (`map`/`filter`/`if`/`await`), and each `agent()` call becomes one isolated in-process AgentSession. Runs background by default, return a run id immediately, deliver a follow-up message on completion, and persist artifacts under `~/.pi/agent/workflows/<runId>/` (script, args, statuses, journal, result, per-agent transcripts). `resumeFromRunId` replays the unchanged prefix of `agent()` calls from `journal.jsonl`.

## Key concepts

- **Script-driven, not model-driven.** The script is where fan-out, verification, and synthesis live; control flow is plain JS, not the model deciding next steps. The tool description explicitly gates usage: `workflow` is ONLY called when the user has opted in ("ultracode", "use a workflow", "fan out agents", or a skill/command that says to) — otherwise the agent should describe what a workflow could do and ask.
- **Three layers of execution:**
  1. `prepareWorkflowScript` (meta.ts) parses the source with **acorn** and statically decodes `export const meta = {...}` (only static literals — calls, spreads, computed keys, templates all fail closed). It then blanks the metadata bytes out of the source (line count preserved) so nothing executable survives.
  2. `runWorkflowSandbox` (sandbox.ts) spawns a Node child with `--permission` (fs-read only of the worker dir, `--max-old-space-size=128`, `--stack-size=2048`) and runs the script inside a `vm` context (sandbox-child.cjs, `codeGeneration: { strings: false, wasm: false }`). The child has no imports, eval, timers, filesystem, network, or process APIs (`process`, `require`, `fetch` are all `undefined`), and communicates only via an authenticated IPC channel (`token` = 24 random bytes; every message is validated). The workflow body is compiled as a function with `agent, parallel, pipeline, phase, log, budget, workflow, args` as parameters.
  3. `RunController` (controller.ts) owns a run-wide semaphore, the agent-call cap, and the abort signal; each `agent()` resolves through `runAgent` (runner.ts), which creates a fresh in-process AgentSession (`SessionManager.inMemory`), binds child-session extensions, and denies recursive orchestration tools.
- **Determinism is mandatory** (it backs resume): `Math.random()`, `Date.now()`, and `new Date()` (no args) throw inside the script. Vary work by index and pass timestamps in via `args`. The sandbox also rejects non-yielding code (`vm` timeout), unawaited `agent()` calls ("Workflow created N unawaited agent() call(s)"), and returning before in-flight agents settle.
- **`pipeline()` is the default** — items flow through all stages independently with NO barrier; stage callbacks receive `(prevResult, originalItem, index)`. Wall-clock = slowest single item, not sum of stages. `parallel()` is a barrier (awaits every thunk before returning) — correct only for genuine cross-item dependencies (dedup before expensive downstream work, early-exit on zero findings). A throwing stage/thunk drops just that item to `null`; `pipeline` logs `pipeline[index] failed: <msg>`.
- **Caps & budget:** concurrency = `DEFAULT_CONCURRENCY` = `min(16, max(2, cores − 2))` (CC's formula; 8 on this machine); total agent calls capped at `MAX_AGENT_CALLS = 1000` (past it, `agent()` resolves `null`); `parallel()`/`pipeline()` accept ≤ 4096 items (explicit error beyond). `budgetTokens` (or the `/workflow-budget` default) sets a **hard output-token ceiling**: once `spent() >= total`, the next `agent()` throws `WorkflowBudgetExceededError` inside the script (in-flight agents finish); unset budgets never block (`budget.remaining()` is `Infinity`).
- **Resume:** every settled `agent()` appends one `journal.jsonl` line: `{ index, key, label, phase?, result }`. `key` = sha256 of canonical JSON of `{ prompt, options }` with sorted keys (option order doesn't matter), truncated to 32 hex. `createResumePlan` replays the longest unchanged prefix — the first mismatch (different key, missing entry, out-of-order index) permanently ends replay; matches return cached results instantly with `cached: true`. Prompts built from `Date.now()`/`Math.random()` always miss the cache.
- **Background vs blocking:** `background` defaults to `true` (and is forced in headless sessions — `(params.background ?? true) && ctx.hasUI`). Background runs return a launch message immediately and deliver `[Background workflow <runId> <status>]` + full report via `pi.sendUserMessage(..., { deliverAs: "followUp" })`. Blocking runs emit throttled tool-block progress (120 ms coalescing) and throw on non-completed status (pi marks tool failure only when `execute` throws). All runs are aborted + settled on `session_shutdown`.
- **Tiers:** `agent()` takes a `tier` — `fast` (bounded mechanical work, focused lookup), `standard` (normal coding, research, review — the default when omitted), or `deep` (uncertain, cross-cutting, architectural, adversarial). Each resolves through `resolveDelegationTarget()` (`shared/subagent-models.ts`) against the user's tier map in `subagent-models.json`, naming a native pi provider, model, and effort; the resolved model is looked up via `ctx.modelRegistry.find` and an unavailable target fails the agent loudly. The tier's effort replaces the inherited parent thinking level. `tier` cannot be combined with `model`/`provider`/`effort`. The workflow runner passes `supportedHarnesses: ["pi"]`, so the `claude` tier fails with a direct error instead of silently running another target. Tiered agents record `tier` and the resolved `effort` and render as `tier→resolved-id` in the dashboard.
- **Explicit overrides & cost:** `model`/`provider`/`effort` remain for a user-requested override and bypass tiers. An override defaults to the configured subagent model (`loadSubagentModels().pi` via `ctx.modelRegistry.find`), NOT the parent session's model — fan-out must not burn an expensive interactive model. `model`/`provider` options resolve in a chain (model-aliases.ts): exact `provider/id` or bare registry id → `modelAliases` from `workflows.json` → known CC alias (`haiku`/`sonnet`/`opus`/`fable`) with no mapping → the configured default. Exact hits are ceiling-checked (`exceedsCostCeiling` rejects agent-picked expensive models, `affordableModels` alternatives); alias-resolved models skip the ceiling (user-configured intent). Agents launched via a mapping record `requestedModel` and render as `alias→resolved-id` in the dashboard. `effort` maps to thinking level (`off|minimal|low|medium|high|xhigh|max`; default inherits the parent session via `pi.getThinkingLevel()`).
- **Child session contract:** each agent runs with normal trust-aware resources (`createWorkflowResources` → `shared/child-session.ts` `createChildResources`), the same `childToolPolicy()` denylist as subagents (`subagent_*`, `workflow`, `ask_user_question` — children cannot re-orchestrate or ask the user), and an optional one-shot `structured_output` tool when `schema` is supplied (schema must be a bounded JSON object — ≤10k nodes, depth ≤24, no `__proto__`/`constructor`/`prototype` keys; wrapped via `Type.Unsafe` so the caller's full JSON Schema is preserved). Children get a terminating system instruction (`WORKFLOW_AGENT_SYSTEM_INSTRUCTION` or `STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION`).
- **Watchdogs (runner.ts):** first assistant response within `FIRST_RESPONSE_TIMEOUT_MS` 45 s (silent provider request → abort), mid-run progress within `STALL_TIMEOUT_MS` 180 s (suspended while a tool executes — the per-tool timeout bounds that), each tool call ≤ 30 min (`CHILD_TOOL_CALL_TIMEOUT_MS`), structured output ≤ `MAX_STRUCTURED_OUTPUT_ATTEMPTS` 5 attempts then abort. `runAgent` never throws — every failure mode settles into `AgentOutcome { ok, output, structured?, error?, aborted, usage, model, contextWindow, transcript }`; `output` is truncated to 64 KiB.
- **Artifacts & checkpoints (artifacts.ts):** live state is coalesced to disk at `WORKFLOW_CHECKPOINT_INTERVAL_MS` 500 ms; `checkpoint({ immediate: true })` on agent settle; final `flush()` synchronous. Per run: `script.js`, `args.json` (if any), `workflow.json` (compact details; result replaced by a pointer to `result.json`, transcripts by `transcripts.json`), `result.json` (≤1 MiB), `transcripts.json` (per-agent bounded transcripts keyed by index: initial prompt + newest tail within 32 KiB), `journal.jsonl`, and `report.md` (dashboard `s` key). Atomic writes via temp-file + rename.

## API

### Tool: `workflow`

Registered with `pi.registerTool({ name: "workflow", ... })`. Prompt-facing description, snippet, and guidelines come from `WORKFLOW_TOOL_DESCRIPTION` / `WORKFLOW_PROMPT_SNIPPET` / `WORKFLOW_PROMPT_GUIDELINES` (prompt.ts); the description is appended with the saved-workflow registry via `describeSavedWorkflows(process.cwd())`.

Parameters (typebox `WorkflowParams`, all optional):

| Name | Type | Meaning |
|---|---|---|
| `script` | string | Inline JS orchestration script. Required unless `name` is given. |
| `name` | string | Name of a saved workflow to run instead (registry appended to the description). Passing `script` too overrides the saved definition for one run. |
| `args` | string | Optional JSON string exposed to the script as `args` (parsed when valid JSON, passed through as raw string otherwise). |
| `background` | boolean | Default `true`: return run id immediately, follow-up message on completion. `false` blocks with live progress in the tool block. |
| `resumeFromRunId` | string | `wf_` + 12 hex. Replays the unchanged `agent()` prefix from that run's journal. Invalid ids are rejected. |
| `budgetTokens` | number | Output-token hard ceiling for this run (floored, must be > 0); else the `/workflow-budget` default. |

Return shape:
- Background: `{ content: [{ type: "text", text: launch message }], details: compact WorkflowDetails }` immediately (details = agents with empty transcripts, result ≤ 64 KiB); completion arrives as a follow-up user message with the full report.
- Blocking: same shape after completion; **throws** `Error(buildWorkflowResultMessage(...))` when status ≠ `completed`.
- Errors: unknown `name` (lists available), unparseable script, invalid `resumeFromRunId`.

Example call:

```json
{
  "script": "export const meta = { name: 'review-changes', phases: [{title:'Review'},{title:'Verify'}] }\nconst results = await pipeline(DIMENSIONS, d => agent(d.prompt, {label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA}), review => parallel(review.findings.map(f => () => agent('verify: ' + f.title, {phase: 'Verify', schema: VERDICT_SCHEMA}))))\nreturn results.flat().filter(Boolean)",
  "args": "{\"paths\": [\"src/\"]}",
  "background": true,
  "budgetTokens": 500000
}
```

The tool also implements `renderCall` (extracts meta via `extractMeta`, shows phases) and `renderResult` (state squares per agent, phase-grouped detail view, `■` = status color, expand hint via `keyHint("app.tools.expand")`).

### Script DSL (sandbox globals)

The script runs as `(async function __piWorkflowBody() { <source> })()` with these globals (all read-only bindings):

| Global | Signature / behavior |
|---|---|
| `meta` | `export const meta = { name?, description?, whenToUse?, phases: [{ title, detail? }] }` — static literals only; drives the progress UI, registry, and `/workflows` display. |
| `phase(title)` | Marks the current phase (title ≤ 160 chars) for progress/grouping. |
| `agent(prompt, options?)` | `await agent(prompt: string, { label?, phase?, schema?, tier?, model?, provider?, effort?, isolation? })` → final text (string) | validated object (when `schema` given) | `null` on failure. `tier` selects a configured `fast`/`standard`/`deep` target (default `standard`); it cannot be combined with `model`/`provider`/`effort`, and the `claude` tier is unavailable to workflow agents. Throws `WorkflowBudgetExceededError` on budget exhaustion; returns `null` when rejected by the call-count cap or aborted; `.filter(Boolean)` the results. `isolation: 'worktree'` runs the agent in a fresh detached git worktree (branch `wf/<runId>/<agentIndex>-<slug>`, auto-removed if unchanged, kept + logged if dirty). |
| `pipeline(items, stage1, stage2, ...)` | No barrier. Each stage gets `(prevResult, originalItem, index)`. A throwing stage drops that item to `null` and logs `pipeline[index] failed: <msg>`; remaining stages for that item are skipped. ≤ 4096 items. Returns result array. |
| `parallel(thunks, { concurrency? })` | Barrier. Zero-arg thunks; a throwing thunk resolves to `null` (never rejects). Concurrency defaults to the run-wide cap. ≤ 4096 items. Returns results in order. |
| `log(message)` | Progress line (≤ 500 chars), replayed in the completion report. |
| `workflow(name, args?)` | Runs a saved workflow inline as a sub-step; shares this run's concurrency cap, agent counter, abort signal, and budget. **One level only** — nesting throws. Throws on unknown name or child syntax error. |
| `budget` | `{ total: number\|null, spent(): number, remaining(): number }` — live view, refreshed by the host after every settled agent. |
| `args` | Parsed `args` tool parameter (deep-frozen) or `undefined`. |

Rules: every `agent()` must be awaited (unawaited/unsettled calls fail the run); the script must `return` a JSON-serializable aggregate (bigint → `"<n>n"`, cycles → `"[circular]"`, `undefined` → `null`); `Math.random`/`Date.now`/`new Date()` forbidden; no imports/export-default/eval/timers/process/network.

### Commands

| Command | Purpose |
|---|---|
| `/workflow-budget` | Show or set the default output-token budget: no arg shows current (`Workflow budget: …`), else accepts `500k`, `1.5m`, `off`/`none`/`unlimited` (→ unlimited), or a plain token count. Persisted to `workflow-budget.json` via `parseBudget`/`saveDefaultBudget`/`loadDefaultBudget`. |
| `/workflows` | Watch runs. TUI: opens the full-screen dashboard (list → per-run detail: phases sidebar + agents panel → per-agent transcript; `j/k`/`g`/`G` navigate, `l`/`→`/enter into agents, `h`/`←`/esc back, `s` saves `report.md` to the run dir; refreshes every 500 ms while live; opening it acknowledges finished runs, resetting the footer counters). Optional arg `runId` (prefix match) opens that run's detail directly. Non-TUI fallback: plain-text listing or `ctx.ui.select` picker. |

### Events

| Event | Handler |
|---|---|
| `session_start` | Captures `lastUi = ctx.ui` (when `ctx.hasUI`) and refreshes the indicator. |
| `session_shutdown` | Aborts every active run (`"Session is shutting down"`), settles each with `abort: true`, waits up to 8 s for completions, clears the `workflows` footer status. |

Status indicator: `updateIndicator()` publishes `reportRunning("workflows", activeRuns.size)` to `shared/agent-activity.ts` (other extensions — summaries gates recaps on it) and, when UI exists, sets footer status `workflows` via `formatActivityStatus(theme, "workflows", { running, done, failed })`. Finished-run counters stay visible until the dashboard acknowledges them.

### Config files & artifacts

- `workflow-budget.json` — in the agent dir (`getAgentDir()`); `{ "tokens": number | null }`; written by `/workflow-budget`.
- Saved workflows (registry.ts): user-level `~/.pi/agent/workflows/*.js`, project-level `<cwd>/.pi/workflows/*.js`, plus any `extraDirs` from `workflows.json` (e.g. `~/.claude/workflows` to share CC definitions). Precedence: project shadows user shadows extra dirs (in array order). Each is a `.js` file with a `meta.name` + `meta.description` (and optional `whenToUse`, shown in the registry listing); ≤ 512 KiB. Extra-dir entries are marked `[from <dir>]` in the tool description's registry listing. Run artifacts live in `wf_*` subdirectories of the same user dir, so they never collide with definitions.
- `workflows.json` — in the agent dir (`getAgentDir()`); `{ "extraDirs": ["~/.claude/workflows"], "modelAliases": { "sonnet": "deepseek/deepseek-v4-pro" } }`; read by `loadRegistrySettings()` on every registry scan and agent model resolution (no caching, edits take effect immediately). `modelAliases` maps CC-style alias → pi model ref (`provider/id` or bare id); a mapped target that doesn't resolve fails the agent with a `fix modelAliases` error, an unmapped known CC alias falls back to the subagent default.
- Run dir `~/.pi/agent/workflows/<runId>/`: `script.js`, `args.json`, `workflow.json`, `result.json`, `transcripts.json`, `journal.jsonl`, `report.md` (see Key concepts).

### Module exports (internal surface)

All modules are imported by `index.ts` (entry, default export `workflows(pi: ExtensionAPI)`). No other extension imports these directly; instead `index.ts` registers the run lifecycle into `shared/workflow-runtime.ts`, and `code-review` drives it through that shared seam.

- **launch.ts** — `createLaunch(deps)` returns the run lifecycle as a dependency-injected factory (activeRuns, indicator, persistence, controller, budget, `agentFn`, in-process `parallel`/`pipeline`, delivery). The returned `launch` matches `WorkflowRuntime["launch"]`; its internal spec/handle add tool-only extras (resume plan, extra artifacts, blocking signal, tool-block progress). Parameterizes two things the `workflow` tool used to inline: the **core** (`spec.orchestrate(dsl)` — the sandbox script for the tool, an in-process engine for code-review) and **delivery** (`"model-followup"` = background follow-up / blocking throw; `"programmatic"` = resolve `settled`, no follow-up). Also exports `errorText`, `compactToolDetails`, and types `ActiveRun`, `InternalLaunchSpec`, `InternalRunHandle`, `LaunchDeps`. `index.ts` calls `registerWorkflowRuntime({ launch })` on load; the `workflow` tool's `execute` is a thin caller of `launch` with the sandbox core.
- **prompt.ts** — `WORKFLOW_PARAMETER_DESCRIPTIONS`, `WORKFLOW_TOOL_DESCRIPTION`, `WORKFLOW_PROMPT_SNIPPET`, `WORKFLOW_PROMPT_GUIDELINES`, `buildWorkflowAgentPrompt`, `WORKFLOW_AGENT_SYSTEM_INSTRUCTION`, `STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION`, `STRUCTURED_OUTPUT_TOOL_DESCRIPTION`, `buildWorkflowResultMessage`, `buildBackgroundWorkflowFollowUp`, `buildBackgroundWorkflowLaunchResult`.
- **runner.ts** — `runAgent` (one child AgentSession), `createWorkflowResources`, `guardWorkflowChildTools`, `recordToolExecutionTiming`, `transcriptFromMessages`, `createStallWatchdog`, `createFirstResponseWatchdog`, constants `FIRST_RESPONSE_TIMEOUT_MS` (45 s), `STALL_TIMEOUT_MS` (180 s), `MAX_STRUCTURED_OUTPUT_ATTEMPTS` (5); types `WorkflowModel`, `ThinkingLevel`, `AgentOutcome`, `AgentProgress`, `RunAgentOptions`, `ToolExecutionTiming`.
- **controller.ts** — `RunController` (`.signal`, `.calls`, `.schedule(task, invocationSignal?)`, `.abort(reason?)`, `.settle({ abort?, timeoutMs? })` — seals and waits ≤ 8 s); constants `DEFAULT_CONCURRENCY`, `MAX_AGENT_CALLS` (1000), `RUN_SHUTDOWN_TIMEOUT_MS` (8000).
- **budget.ts** — `WorkflowBudget` (`.add()`, `.spent()`, `.remaining()`, `.assertAvailable()`, `.view()`), `WorkflowBudgetExceededError`, `loadDefaultBudget`, `saveDefaultBudget`, `parseBudget`, `formatBudget`, type `BudgetView`.
- **journal.ts** — `callKey(prompt, options)`, `appendJournalEntry`, `readJournal`, `createResumePlan` (`.take(index, key)` → `{ hit: true, result }` | undefined; `.servedCount`, `.available`), `JOURNAL_FILENAME`.
- **meta.ts** — `prepareWorkflowScript` (→ `{ source, meta }`), `extractMeta` (cached, render-safe), types `WorkflowMeta`, `WorkflowPhase`, `PreparedWorkflowScript`.
- **model.ts** — `WorkflowDetails`, `AgentRecord` (with `tier`/`effort` provenance), `AgentUsage` (`emptyUsage`), `TranscriptEntry`, state/status helpers `stateSquare`, `statusSquare`, `statusWord`, `statusColor`, `SQUARE`, formatting `formatElapsed`, `formatUsage`, `formatTokens`, `shortenHome`, `agentModelLabel` (`alias→resolved-id` / `tier→resolved-id`), `agentContext`, `aggregateUsage`, `countStates`, `phaseGroups`, `resultJson`, constants `RESULT_JSON_MAX_BYTES`/`RESULT_JSON_MAX_LINES`.
- **artifacts.ts** — `persistWorkflowJson`, `createWorkflowPersistence` (`.checkpoint({ immediate? })`, `.flush()`), `boundedArtifactTranscript`, `WORKFLOW_CHECKPOINT_INTERVAL_MS` (500).
- **sandbox.ts** — `runWorkflowSandbox` (spawns the permission-restricted child; validates every IPC message; enforces source 512 KiB / args 256 KiB / result 1 MiB / 1000 agent requests), types `RunWorkflowSandboxOptions`, `SandboxAgentOptions`, `SandboxAgentResult`.
- **sandbox-child.cjs** — the worker runtime: bootstrap (`vm` context, globals, `Math.random`/`Date.now` forbidding, `budget` refresh via `__setBudget`), the `parallel`/`pipeline` implementations (`MAX_FANOUT_ITEMS` 4096), and the unawaited/in-flight checks.
- **registry.ts** — `listSavedWorkflows(cwd)`, `collectSavedWorkflows(dirs)`, `findSavedWorkflow(cwd, name)`, `describeSavedWorkflows(cwd)`, `loadRegistrySettings()`, `userWorkflowDir()`, `projectWorkflowDir(cwd)`, types `SavedWorkflow`, `RegistrySettings`.
- **model-aliases.ts** — `resolveModelOption(lookup, model, provider, aliases)` (exact → alias → CC-alias-default → unknown chain), `CC_MODEL_ALIASES`, types `ModelLookup`, `ModelOptionResolution`.
- **worktree.ts** — `isGitRepo(cwd)`, `createWorktree({ cwd, runId, agentIndex, label })` → `{ path, branch, release(): Promise<{ removed, changedFiles }> }`.
- **serialization.ts** — `safeStringify`, `toSerializable`, `truncateUtf8`, `writeFileAtomic` (also used by the whole extension for artifact writes).
- **dashboard.ts** — `showWorkflowDashboard(ctx, getActive, initialRunId?)` (full-screen overlay), `sessionWorkflowRunIds(ctx)`, `loadRunEntries(...)`, class `WorkflowDashboard`, type `RunEntry`.
- **prototype-scheduling/** — THROWAWAY prototype (scheduler simulation + TUI, `npm run prototype:scheduling`); answered the barrier-vs-pipeline question (2026-07-25) that motivated adding `pipeline()` and raising `DEFAULT_CONCURRENCY` to CC's formula. Not part of the runtime surface; safe to delete.

## Examples

1. **Explicit opt-in + background fan-out** (the agent is asked "use a workflow to audit the codebase"):

```
workflow({
  script: `export const meta = { name: 'audit', description: 'Find and verify bugs', phases: [{title:'Find'},{title:'Verify'}] }
const files = args.files
const findings = await parallel(files.map(f => () => agent('Audit ' + f + ' for bugs', {phase: 'Find', schema: FINDINGS_SCHEMA})))
const confirmed = await parallel(findings.filter(Boolean).flatMap(r => r.bugs).map(b => () => agent('Adversarially verify: ' + b.title, {phase: 'Verify', schema: VERDICT_SCHEMA})))
return { confirmed: confirmed.filter(Boolean).filter(v => v.isReal) }`,
  args: JSON.stringify({ files: ['src/runner.ts', 'src/sandbox.ts'] }),
  background: true,
  budgetTokens: 400000
})
```
Returns the run id immediately; the completion report (agents, log, result JSON) arrives as a follow-up message. `/workflows` shows live progress.

2. **Resume after a failure**: the result message of a failed run says `To resume after fixing the script: workflow({ script, resumeFromRunId: "wf_…" })`. The agent edits the script and relaunches with `resumeFromRunId` — byte-identical `(prompt, options)` pairs replay from `journal.jsonl` instantly; the first edited call and everything after runs live.

3. **Blocking run with a saved workflow**: user saved `~/.pi/agent/workflows/review.js` (project copy at `<cwd>/.pi/workflows/review.js` shadows it). Run `workflow({ name: "review", args: '{"paths": ["src/"]}', background: false })` — blocks with live tool-block progress; throws if the run fails. Inside a script, the same registry is reachable as `await workflow("review", { paths: [...] })` (one nesting level; shares budget/caps/abort).

4. **Budget-scaled loop** (from `WORKFLOW_TOOL_DESCRIPTION`): `while (budget.total && budget.remaining() > 50_000) { const result = await agent("Find bugs.", { schema: BUGS_SCHEMA }); bugs.push(...(result?.bugs ?? [])); log(\`${bugs.length} found, ${Math.round(budget.remaining()/1000)}k remaining\`) }` — guard on `budget.total` so an unset budget (remaining = Infinity) can't run to the 1000-agent cap.
