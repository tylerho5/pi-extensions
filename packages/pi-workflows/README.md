# @tylerho/pi-workflows

Sandboxed multi-agent workflow orchestration, plus a deterministic multi-angle code review built on it.

## Install

`pi install npm:@tylerho/pi-workflows`

---

# Workflows

Model-authored multi-agent orchestration for pi. The `workflow` tool runs an inline JavaScript orchestration script in a restricted, killable child process, and each `agent()` call in that script becomes one isolated child AgentSession. Runs background by default, return a run id immediately, and deliver a follow-up message when they settle. Artifacts land in `~/.pi/agent/workflows/<runId>/`, and `resumeFromRunId` replays the unchanged prefix of `agent()` calls from that run's journal.

## How it works

The script holds the structure. Fan-out, verification, and synthesis live in plain JavaScript (`map`, `filter`, `if`, `await`) instead of model decisions. The tool description gates calls on explicit user opt-in: the keyword `ultracode`, a direct request to run a workflow or fan out agents, or a skill or slash command that says to call it. For any other task, the agent describes what a workflow could do and asks first.

Execution passes through three layers.

1. `prepareWorkflowScript` (meta.ts) parses the source with acorn and statically decodes `export const meta = {...}`. Only plain object, array, and primitive literals pass, so calls, spreads, computed keys, and templates fail closed. The metadata bytes are then blanked out of the source with the line count preserved, so nothing executable survives.
2. `runWorkflowSandbox` (sandbox.ts) spawns a Node child with `--permission` (fs-read of the worker directory only, `--max-old-space-size=128`, `--stack-size=2048`) and runs the script inside a `vm` context with `codeGeneration: { strings: false, wasm: false }`. The child has no imports, eval, timers, filesystem, network, or process APIs, and `process`, `require`, and `fetch` are `undefined`. It talks to the host only over an authenticated IPC channel, with a token of 24 random bytes and validation of every message. The body compiles as `(async function __piWorkflowBody() { ... })()` with `agent`, `parallel`, `pipeline`, `phase`, `log`, `budget`, `workflow`, and `args` as parameters.
3. `RunController` (controller.ts) owns the run-wide semaphore, the agent-call cap, and the abort signal. Each `agent()` resolves through `runAgent` (runner.ts), which creates a fresh in-process AgentSession with `SessionManager.inMemory`, binds child-session extensions, and denies recursive orchestration tools.

Determinism is required because resume depends on it. `Math.random()`, `Date.now()`, and a bare `new Date()` throw inside the script, so a replayed call produces the same prompt. Vary work by index and pass timestamps through `args`. The sandbox also rejects non-yielding synchronous code through the `vm` timeout, unawaited `agent()` calls (`Workflow created N unawaited agent() call(s)`), and a return before in-flight agents settle.

`pipeline()` is the default and holds no barrier. Items flow through stages independently, and each stage callback receives `(prevResult, originalItem, index)`. Wall-clock equals the slowest single-item chain, not the sum of stage maxima. `parallel()` is a barrier that awaits every thunk before returning, so it fits only a genuine cross-item dependency such as dedup before expensive downstream work or an early exit on zero findings. A throwing stage or thunk drops that item to `null`, and a pipeline failure also logs `pipeline[index] failed: <msg>`.

`agent()` selects a delegation tier: `fast` for bounded mechanical work or lookups, `standard` for normal coding, research, and review (the default when omitted), and `deep` for uncertain, cross-cutting, architectural, or adversarial work. `resolveDelegationTarget()` in `shared/subagent-models.ts` maps the tier through the user's map in `extensions/shared/subagent-models.json`, set with `/subagent-model`, to a pi provider, model, and effort. An unavailable target fails the agent with a direct error. `tier` cannot be combined with `model`, `provider`, or `effort`. The runner passes `supportedHarnesses: ["pi"]`, so the `claude` tier fails rather than running another target. A tier's effort replaces the inherited parent thinking level, and tiered agents render as `tier→resolved-id`. Resolution happens when `agent()` is called, before a concurrency slot is taken, so a queued agent already records the model it will run, and a call that fails to resolve records no model at all rather than the parent session's.

`model`, `provider`, and `effort` remain for a user-requested override and bypass tiers. An override defaults to the configured subagent model (`loadSubagentModels().pi`), not the parent session model, so fan-out does not burn an expensive interactive model. `model-aliases.ts` resolves the model option in a chain: an exact `provider/id` or bare registry id, then `modelAliases` from `workflows.json`, then a known CC alias with no mapping (`haiku`, `sonnet`, `opus`, `fable`) falling back to the configured default. Exact hits pass a cost ceiling check, where `exceedsCostCeiling` rejects an agent-picked expensive model and `affordableModels` supplies alternatives. Alias-resolved models skip the ceiling because the user configured them. A broken alias target fails with a `fix modelAliases` error. Agents record `requestedModel` and render as `alias→resolved-id`. `effort` sets a thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), and omitting it inherits the parent level from `pi.getThinkingLevel()`.

Run-wide caps: concurrency is `DEFAULT_CONCURRENCY` = `min(16, max(2, cores - 2))`, which is CC's formula. Total agent calls are capped at `MAX_AGENT_CALLS` 1000, and past it `agent()` resolves `null`. `parallel()` and `pipeline()` accept at most 4096 items and throw beyond that rather than truncating. `budgetTokens`, or the `/workflows-budget` default, sets a hard output-token ceiling. Once `spent()` reaches `total`, the next `agent()` throws `WorkflowBudgetExceededError` inside the script while in-flight agents finish. An unset budget never blocks and `budget.remaining()` returns `Infinity`.

Every settled `agent()` appends one line to `journal.jsonl` with `{ index, key, label, phase?, result }`. `key` is the sha256 of canonical JSON over `{ prompt, options }` with sorted keys, truncated to 32 hex, so option order does not matter. `createResumePlan` replays the longest unchanged prefix. The first mismatch, whether a different key, a missing entry, or an out-of-order index, ends replay for the rest of the run. Matched calls return cached results instantly and mark `cached: true`.

`background` defaults to `true`, and `(params.background ?? true) && ctx.hasUI` forces it off in a headless session, where there is no UI to deliver the follow-up to. A background run returns a launch message immediately and delivers the completion follow-up as a `workflow-completion` custom message through `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`. The model-facing content is unchanged (`[Background workflow <runId> <status>]` plus the full report), and the registered renderer paints a digest instead of the report. A blocking run emits tool-block progress throttled at 120 ms and throws on a non-completed status, which is how pi marks the tool failure. `session_shutdown` aborts and settles every active run.

The live rail. A `belowEditor` widget (`workflow-task-rail`) shows the active runs. A header carries the running and finished counts, and each row carries the run name, the current phase, the settled and total agent counts, and the elapsed time. The rail renders at most 8 rows and collapses the rest into a `… N more` line. It re-reads the active-runs map on every render, so details that mutate in place (`currentPhase`, the growing agents array) stay current. A 1 Hz tick repaints the elapsed times while a run is live, and `updateIndicator()` repaints immediately on a launch or settle. The widget hides while nothing runs, and it has no key handling.

Each agent runs with normal trust-aware resources (`createWorkflowResources` calls `createChildResources` in `shared/child-session.ts`), the same `childToolPolicy()` denylist subagents use, and an optional one-shot `structured_output` tool when the script passes `schema`. The denylist covers `subagent_spawn`, `subagent_wait`, `subagent_cancel`, `subagent_check`, `subagent_list`, `workflow`, `ask_user_question`, `enter_worktree`, `exit_worktree`, and `code_review`. A schema must be a bounded JSON object of at most 10,000 nodes and depth 24, with no `__proto__`, `constructor`, or `prototype` keys, and it wraps through `Type.Unsafe` so every JSON Schema keyword survives. Children receive `WORKFLOW_AGENT_SYSTEM_INSTRUCTION` or `STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION`. `isolation: 'worktree'` runs one agent in a fresh detached git worktree on branch `wf/<runId>/<agentIndex>-<slug>`, removes it when the agent left it unchanged, and keeps it while logging the path and changed-file count when it did not.

Watchdogs in runner.ts bound each agent. The first assistant response event must arrive within `FIRST_RESPONSE_TIMEOUT_MS` 45 s, or a silent provider request aborts. Mid-run progress must arrive within `STALL_TIMEOUT_MS` 180 s, and the watchdog suspends while a tool executes because the per-tool guard bounds that. Each child tool call is limited by `CHILD_TOOL_CALL_TIMEOUT_MS` 30 min in `shared/tool-call-timeout.ts`. Structured output gets `MAX_STRUCTURED_OUTPUT_ATTEMPTS` 5 attempts before the agent aborts. `runAgent` never throws and settles every failure mode into `AgentOutcome { ok, output, structured?, error?, aborted, usage, model, contextWindow, transcript }`, with `output` truncated to 64 KiB.

`artifacts.ts` coalesces live state to disk every `WORKFLOW_CHECKPOINT_INTERVAL_MS` 500 ms, runs `checkpoint({ immediate: true })` on agent settle, and flushes synchronously at the end. Every write goes through `writeFileAtomic`, which writes a temp file and renames it.

## API

### Tool: `workflow`

`index.ts` registers the tool through `pi.registerTool({ name: "workflow", ... })`. The description, snippet, and guidelines come from `WORKFLOW_TOOL_DESCRIPTION`, `WORKFLOW_PROMPT_SNIPPET`, and `WORKFLOW_PROMPT_GUIDELINES` (prompt.ts), and the description appends the saved-workflow registry from `describeSavedWorkflows(process.cwd())`.

Parameters (typebox `WorkflowParams`, all optional):

| Name | Type | Meaning |
|---|---|---|
| `script` | string | Inline JS orchestration script. Required unless `name` is given. |
| `name` | string | Name of a saved workflow to run instead. Passing `script` too overrides the saved definition for one run. |
| `args` | string | Optional JSON string exposed to the script as `args`. Parsed when valid JSON, otherwise passed through as the raw string. |
| `background` | boolean | Default `true`: return the run id immediately and deliver a follow-up on completion. `false` blocks with live progress in the tool block. |
| `resumeFromRunId` | string | `wf_` plus 12 hex. Replays the unchanged `agent()` prefix from that run's journal. An invalid id is rejected. |
| `budgetTokens` | number | Output-token ceiling for this run. Floored, and a value of 0 or less falls back to the `/workflows-budget` default. |

Return shape:

- Background: `{ content: [{ type: "text", text: launch message }], details: compact WorkflowDetails }` immediately, with empty agent transcripts and the result capped at 64 KiB. The completion follow-up carries the full report.
- Blocking: the same shape after completion, and a throw of `Error(buildWorkflowResultMessage(...))` when the status is not `completed`.
- Errors: an unknown `name` (the message lists available names), an unparseable script, and an invalid `resumeFromRunId`.

`renderCall` extracts metadata through `extractMeta` and shows the phases. `renderResult` draws a state square per agent, a phase-grouped expanded view, status colors from `statusColor` and `stateSquare`, and an expand hint from `keyHint("app.tools.expand")`.

### Script API

A script may start with `export const meta = { name?, description?, whenToUse?, phases: [{ title, detail? }] }`. The phases drive the progress UI, the registry, and the `/workflows` display. The body then has these globals, all read-only bindings.

| Global | Behavior |
|---|---|
| `agent(prompt, options?)` | `await agent(prompt, { label?, phase?, schema?, tier?, model?, provider?, effort?, isolation? })` resolves to the final text as a string, the validated object when `schema` is given, or `null` on failure. It throws `WorkflowBudgetExceededError` on budget exhaustion and returns `null` when the call cap or an abort rejects it, so callers filter with `.filter(Boolean)`. Reason strings live on the run record, not in the value. |
| `pipeline(items, stage1, stage2, ...)` | No barrier between stages. Each stage receives `(prevResult, originalItem, index)`. A throwing stage drops that item to `null` and skips its remaining stages. At most 4096 items. |
| `parallel(thunks, { concurrency? })` | Barrier. Zero-argument thunks, and a throwing thunk resolves to `null` rather than rejecting. Concurrency defaults to the run-wide cap. At most 4096 items. Results come back in order. |
| `phase(title)` | Marks the current phase for progress and grouping. Titles are capped at 160 characters. |
| `log(message)` | Emits a progress line, capped at 500 characters, which the completion report replays. |
| `workflow(name, args?)` | Runs a saved workflow inline as a sub-step and returns its result. The child shares this run's concurrency cap, agent counter, abort signal, and budget. One level only, because nesting throws. An unknown name or a child syntax error throws. |
| `budget` | `{ total: number \| null, spent(): number, remaining(): number }`, refreshed by the host after every settled agent. |
| `args` | The parsed `args` tool parameter, deep-frozen, or `undefined`. |

Every `agent()` call must be awaited, and the script must return a JSON-serializable aggregate. Bigint becomes `"<n>n"`, a cycle becomes `"[circular]"`, and `undefined` becomes `null`. Imports, `export default`, eval, timers, process, and network access are unavailable.

### Commands

| Command | Purpose |
|---|---|
| `/workflows-budget` | Shows the current default with no argument. Otherwise accepts `500k`, `1.5m`, `off`, `none`, `unlimited`, or a plain token count. The three words all mean unlimited. Persists to `workflow-budget.json` through `parseBudget`, `saveDefaultBudget`, and `loadDefaultBudget`. |
| `/workflows` | Opens the full-screen dashboard in the TUI: a run list, a per-run detail with a phases sidebar and an agents panel, then a per-agent transcript. `j` and `k` move, `g` and `G` jump, `l`, right, and enter descend, `h`, left, and esc ascend, and `s` writes `report.md` into the run directory. The view refreshes every 500 ms while a run is live, and opening it acknowledges finished runs and resets the footer counters. An optional `runId` argument opens that run directly, matched exactly or by a trailing segment of the id. Outside the TUI it prints a plain listing or offers a `ctx.ui.select` picker. |

### Messages and renderers

| custom type | delivery | renderer |
|---|---|---|
| `workflow-completion` | `{ deliverAs: "followUp", triggerTurn: true }`, visible | `renderWorkflowCompletion` |

The model-facing content stays the completion report. The renderer reads `details` (`runId`, `name`, `status`, `elapsed`, `agents`, `currentPhase`, `artifactsDir`), so the transcript never paints the report verbatim. Collapsed shows the digest (`✦ workflow <name> · <status> · N agents · <elapsed>`) plus the `/workflows <runId>` pointer. Expanded shows the report capped at 4000 characters and a pointer to the run directory, where `result.json` and `report.md` live. The dashboard `s` key writes `report.md`.

### Events

| Event | Handler |
|---|---|
| `session_start` | Captures `lastUi = ctx.ui` when `ctx.hasUI`, mounts the rail widget, and refreshes the indicator. |
| `session_shutdown` | Aborts every active run with `Session is shutting down`, settles each with `abort: true`, waits up to 8 s for completions, and clears the `workflows` footer status and the rail widget. |

`updateIndicator()` publishes `reportRunning("workflows", activeRuns.size)` to `shared/agent-activity.ts`, which summaries gates recaps on, and, when a UI exists, sets the `workflows` footer status through `formatActivityStatus(theme, "workflows", { running, done, failed })`. Finished-run counters stay visible until the dashboard acknowledges them.

### Config files and artifacts

| Path | Contents |
|---|---|
| `workflow-budget.json` | In the agent directory from `getAgentDir()`. `{ "tokens": number \| null }`, written by `/workflows-budget`. |
| `<agent dir>/workflows/*.js` | User-level saved workflow definitions. |
| `<cwd>/.pi/workflows/*.js` | Project-level saved definitions, which shadow user ones of the same name. |
| `workflows.json` | In the agent directory. `{ "extraDirs": ["~/.claude/workflows"], "modelAliases": { "sonnet": "deepseek/deepseek-v4-pro" } }`. `loadRegistrySettings()` re-reads it on every registry scan and every agent model resolution, so edits take effect immediately. |
| `~/.pi/agent/workflows/<runId>/` | Run artifacts. |

A saved definition is a `.js` file with a `meta.name` and `meta.description`, at most 512 KiB, and an optional `meta.whenToUse` that shows in the registry listing. Precedence runs from `extraDirs` (array order, later entries winning) through the user directory to the project directory. Extra-dir entries render with `[from <dir>]` in the tool description, and a malformed definition is skipped rather than breaking the registry. Run artifacts live in `wf_*` subdirectories of the user workflow directory, so they never collide with definitions.

A run directory holds `script.js`, `args.json` when args were passed, `workflow.json` (compact details with the result replaced by a pointer to `result.json` and transcripts replaced by `transcripts.json`), `result.json` (at most 1 MiB), `transcripts.json` (per-agent bounded transcripts keyed by index, holding the initial prompt plus the newest tail inside 32 KiB), `journal.jsonl`, and `report.md`, which the dashboard `s` key writes.

### Module exports

`index.ts` is the entry point, and its default export is `workflows(pi: ExtensionAPI)`. No other extension imports these modules directly. `index.ts` registers the run lifecycle into `shared/workflow-runtime.ts`, and `code-review` drives it through that seam.

- `launch.ts` exports `createLaunch(deps)`, a dependency-injected factory over the active-runs map, the indicator and settled-run callbacks, `runAgent`, `createResources`, and an injectable delegation-config loader. It parameterizes the core (`spec.orchestrate(dsl)`, which is the sandbox script for the tool and an in-process engine for code-review) and delivery (`"model-followup"` for the background follow-up and the blocking throw, `"programmatic"` for a resolved `settled` with no follow-up). The returned `launch` matches `WorkflowRuntime["launch"]`. The internal spec and handle add the tool-only extras: resume plan, extra artifacts, blocking signal, and tool-block progress. It also exports `errorText`, `compactToolDetails`, and the types `ActiveRun`, `InternalLaunchSpec`, `InternalRunHandle`, and `LaunchDeps`. `index.ts` calls `registerWorkflowRuntime({ launch })` on load.
- `prompt.ts` exports `WORKFLOW_PARAMETER_DESCRIPTIONS`, `WORKFLOW_TOOL_DESCRIPTION`, `WORKFLOW_PROMPT_SNIPPET`, `WORKFLOW_PROMPT_GUIDELINES`, `buildWorkflowAgentPrompt`, `WORKFLOW_AGENT_SYSTEM_INSTRUCTION`, `STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION`, `STRUCTURED_OUTPUT_TOOL_DESCRIPTION`, `buildWorkflowResultMessage`, `buildBackgroundWorkflowFollowUp`, and `buildBackgroundWorkflowLaunchResult`.
- `runner.ts` exports `runAgent`, `createWorkflowResources`, `guardWorkflowChildTools`, `recordToolExecutionTiming`, `transcriptFromMessages`, `createStallWatchdog`, `createFirstResponseWatchdog`, the constants `FIRST_RESPONSE_TIMEOUT_MS` (45 s), `STALL_TIMEOUT_MS` (180 s), and `MAX_STRUCTURED_OUTPUT_ATTEMPTS` (5), and the types `WorkflowModel`, `ThinkingLevel`, `AgentOutcome`, `AgentProgress`, `RunAgentOptions`, and `ToolExecutionTiming`.
- `controller.ts` exports `RunController` with `.signal`, `.calls`, `.schedule(task, invocationSignal?)`, `.abort(reason?)`, and `.settle({ abort?, timeoutMs? })`, which seals the task registry and waits up to 8 s. Constants are `DEFAULT_CONCURRENCY`, `MAX_AGENT_CALLS` (1000), and `RUN_SHUTDOWN_TIMEOUT_MS` (8000).
- `budget.ts` exports `WorkflowBudget` (`.add()`, `.spent()`, `.remaining()`, `.assertAvailable()`, `.view()`), `WorkflowBudgetExceededError`, `loadDefaultBudget`, `saveDefaultBudget`, `parseBudget`, `formatBudget`, and the type `BudgetView`.
- `journal.ts` exports `callKey(prompt, options)`, `appendJournalEntry`, `readJournal`, `createResumePlan` (`.take(index, key)` returns `{ hit: true, result }` or undefined, plus `.servedCount` and `.available`), and `JOURNAL_FILENAME`.
- `meta.ts` exports `prepareWorkflowScript` (returns `{ source, meta }`), `extractMeta`, which is cached and safe in render paths, and the types `WorkflowMeta`, `WorkflowPhase`, and `PreparedWorkflowScript`.
- `model.ts` exports `WorkflowDetails`, `AgentRecord` with `tier` and `effort` provenance, `AgentUsage` and `emptyUsage`, `TranscriptEntry`, the state and status helpers `stateSquare`, `statusSquare`, `statusWord`, `statusColor`, and `SQUARE`, the formatters `formatElapsed`, `formatUsage`, `formatTokens`, `shortenHome`, `agentModelLabel`, `agentContext`, `aggregateUsage`, `countStates`, `phaseGroups`, and `resultJson`, and the constants `RESULT_JSON_MAX_BYTES` and `RESULT_JSON_MAX_LINES`.
- `artifacts.ts` exports `persistWorkflowJson`, `createWorkflowPersistence` (`.checkpoint({ immediate? })` and `.flush()`), `boundedArtifactTranscript`, and `WORKFLOW_CHECKPOINT_INTERVAL_MS` (500).
- `sandbox.ts` exports `runWorkflowSandbox`, which spawns the permission-restricted child and validates every IPC message, enforcing 512 KiB of source, 256 KiB of args, a 1 MiB result, and 1000 agent requests. Types are `RunWorkflowSandboxOptions`, `SandboxAgentOptions`, and `SandboxAgentResult`.
- `sandbox-child.cjs` is the worker runtime. It builds the `vm` context and the globals, forbids nondeterministic clocks, refreshes the budget through `__setBudget`, implements `parallel` and `pipeline` with `MAX_FANOUT_ITEMS` 4096, and runs the unawaited and in-flight checks.
- `registry.ts` exports `listSavedWorkflows(cwd)`, `collectSavedWorkflows(dirs)`, `findSavedWorkflow(cwd, name)`, `describeSavedWorkflows(cwd)`, `loadRegistrySettings()`, `userWorkflowDir()`, `projectWorkflowDir(cwd)`, and the types `SavedWorkflow` and `RegistrySettings`.
- `model-aliases.ts` exports `resolveModelOption(lookup, model, provider, aliases)`, which returns an exact, alias, default, or unknown resolution, `CC_MODEL_ALIASES`, and the types `ModelLookup` and `ModelOptionResolution`.
- `worktree.ts` exports `isGitRepo(cwd)` and `createWorktree({ cwd, runId, agentIndex, label })`, which returns `{ path, branch, release() }` with `release()` giving `{ removed, changedFiles }`.
- `serialization.ts` exports `safeStringify`, `toSerializable`, `truncateUtf8`, and `writeFileAtomic`. The whole extension uses these for artifact writes.
- `dashboard.ts` exports `showWorkflowDashboard(ctx, getActive, initialRunId?)`, `sessionWorkflowRunIds(ctx)`, `loadRunEntries(...)`, the class `WorkflowDashboard`, and the type `RunEntry`.
- `rail.ts` exports `MAX_RAIL_ROWS`, `workflowRailModel`, `renderWorkflowRail`, `createWorkflowRail`, and the types `WorkflowRailRow` and `WorkflowRailModel`. The model and the line renderer are pure, so they unit-test over a fake active-runs map.
- `completion.ts` exports `COMPLETION_REPORT_MAX_CHARS` (4000), `WorkflowCompletionDetails`, `buildWorkflowCompletionDetails`, and `renderWorkflowCompletion`.
- `prototype-scheduling/` is a throwaway prototype with a scheduler simulation and TUI, run through `npm run prototype:scheduling`. It answered the barrier-versus-pipeline question in July 2026 and motivated `pipeline()` and the CC concurrency formula. It is not part of the runtime surface.

## Examples

1. Background fan-out over a file list, with a find phase and a verify phase.

```js
export const meta = { name: 'audit', description: 'Find and verify bugs', phases: [{title:'Find'},{title:'Verify'}] }
const findings = await parallel(args.files.map(f => () => agent('Audit ' + f + ' for bugs', { phase: 'Find', schema: FINDINGS_SCHEMA })))
const confirmed = await parallel(findings.filter(Boolean).flatMap(r => r.bugs).map(b => () => agent('Adversarially verify: ' + b.title, { phase: 'Verify', schema: VERDICT_SCHEMA })))
return { confirmed: confirmed.filter(Boolean).filter(v => v.isReal) }
```

Called as `workflow({ script, args: JSON.stringify({ files: ['src/runner.ts'] }), background: true, budgetTokens: 400000 })`. The run id comes back immediately, the completion report arrives as a follow-up message, and `/workflows` shows live progress.

2. Resume after a failure. The result message of a failed run names the resume form, `workflow({ script, resumeFromRunId: "wf_..." })`. The agent edits the script and relaunches. Byte-identical `(prompt, options)` pairs replay from `journal.jsonl` instantly, and the first edited call and everything after it runs live.

3. A blocking run of a saved workflow. With `~/.pi/agent/workflows/review.js` saved and a project copy at `<cwd>/.pi/workflows/review.js` shadowing it, `workflow({ name: "review", args: '{"paths": ["src/"]}', background: false })` blocks with live tool-block progress and throws if the run fails. Inside a script, the same registry is reachable as `await workflow("review", { paths: [...] })`, at one nesting level, sharing the budget, caps, and abort signal.

4. A budget-scaled loop from `WORKFLOW_TOOL_DESCRIPTION`. The guard on `budget.total` keeps an unset budget, whose `remaining()` is `Infinity`, from running to the 1000-agent cap.

```js
while (budget.total && budget.remaining() > 50_000) {
  const result = await agent('Find bugs.', { schema: BUGS_SCHEMA })
  bugs.push(...(result?.bugs ?? []))
  log(`${bugs.length} found, ${Math.round(budget.remaining()/1000)}k remaining`)
}
```
