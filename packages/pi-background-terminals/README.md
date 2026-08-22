# @tylerho/pi-background-terminals

Runs long-lived background shell processes started by the model, inspectable and killable via /ps.

## Install

`pi install npm:@tylerho/pi-background-terminals`

---

# Background terminals

Long-lived shell processes started by the model, inspectable and killable but never writable (stdin is ignored at the OS level — there is no send/steer surface at all). `bg_start` spawns fire-and-forget; the model is notified **exactly once** when a process exits via a follow-up message; `/ps` opens a full-screen list → detail inspector. Processes are session-scoped: `/new`, `/resume`, `/fork`, `/reload`, and quit kill every tree (SIGTERM → SIGKILL) within bounded time.

## Key concepts

- **Effect v4 core, plain-callback streams.** One `ManagedRuntime` over a `TerminalManager` service (`Context.Service` + `Layer`) is the async boundary; tool handlers run effects via `runTool`. Node stream plumbing (`child.stdout.on("data")`, `child.on("exit"|"close"|"error")`) is plain callbacks mutating a per-entry snapshot. The TUI reads through a synchronous `TerminalReadModel` bridge so it never touches the Effect runtime.
- **Process model.** A "terminal" is `spawn` of the platform shell — `/bin/sh -c <command>` on POSIX, `cmd.exe /d /s /c <command>` on Windows — with `stdio: ["ignore", "pipe", "pipe"]` and `detached: true` on POSIX (own process group → group-kill takes descendants). `stdin: "ignore"` makes a process that reads stdin see EOF immediately; interactive commands are the caller's mistake, `bg_kill` is the remedy.
- **States are final**: `running → done | failed | killed`. `done` = exit 0; `failed` = non-zero exit or spawn `'error'` event; `killed` = terminated by `bg_kill`, the `/ps` `x` key, or session teardown. `settle()` is idempotent (`if (status !== "running") return`); `exitCode` and `signal` are recorded from the `'exit'` callback, settlement happens on `'close'` (so the completion message always carries the final flushed output). A shell exit whose stdio never closes (a grandchild holding the pipes) triggers a bounded scope-close reaping after a 1s grace — the entry can't occupy a running slot forever.
- **Caps & bounds.** `MAX_RUNNING = 8` concurrent (race-free via a synchronous reservation before the first yield); `MAX_TRACKED = 32` entries retained, pruned oldest-settled-first (never running, never an id with in-flight kill interest); `MAX_SETTLED_HISTORY = 128` immutable tombstones keep kill reports truthful after pruning. Kill escalation: SIGTERM to the whole process group → 2s (`FORCE_KILL_AFTER_MS`) → SIGKILL; scope closes bounded at 5s (`STOP_TIMEOUT_MS`); spill flush bounded at 1.5s.
- **Output capture.** stdout and stderr are captured separately. `OutputBuffer` keeps the newest ≤ 2 MiB (`RETAINED_PER_STREAM`) per stream in memory (head-dropped, counted in `truncatedBytes`, single oversized chunks trimmed to their UTF-8-safe tail); a 0600 append-mode `WriteStream` spill under `os.tmpdir()/pi-background-terminals/session-*/<id>.<stdout|stderr>.log` (dir 0700) holds the complete capture, bounded at 256 MiB per stream. Settle flushes spills (bounded) before publishing, so the notification's `spillPath` always points at a complete file. `disposeAll` removes the private session dir. Everything the model sees is tail-truncated (`truncateTail` + clamps) with a pointer at the full log.
- **Exactly-once completion delivery.** On settle the manager fires `onSettled(snap, consumed)`; `consumed` is set only by an in-flight `bg_kill` collecting the settlement (via the manager's `killInterest` map), never by `bg_status` — a `bg_status` on an already-settled entry returns the delivery by calling `resultDelivery.consume([snap.id])` in its tool handler. Unconsumed results go into a deferred `Map` keyed by id (`createDeferredResultDelivery`), then flushed via `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })` — queued until the agent has no more tool calls, wakes the model iff idle. `isIdle()` fast path + `agent_settled` flush + Map-keyed drain makes double delivery structurally impossible; the tool handlers additionally `consume` ids whose settlement they returned. No polling anywhere.
- **Widget & teardown.** While ≥1 process runs, a one-line widget (key `background-terminals`) above the editor shows `■ N background terminal(s) running • /ps to view`, driven by `view.subscribe` and only re-set when the running count changes (a per-chunk notification fires hundreds of times a second). `session_shutdown` clears delivery/UI, then disposes the runtime → manager finalizer → `disposeAll` → every entry scope, bounded so a wedged process cannot hang shutdown. No cross-session persistence; spill paths are session-lifetime pointers.

## API

### Tools (registered by the LLM)

All tool descriptions/prompts/result builders live in `src/prompt.ts`. Parameters use `typebox` `Type.Object`; failures throw plain `Error` (sets `isError`).

| Tool | Purpose |
|---|---|
| `bg_start` | Fire-and-forget spawn. Params: `command` (string, shell line), `title` (string, whitespace-collapsed, truncated to 80 chars, default `"terminal"`), `working_dir` (optional string, resolved against `ctx.cwd` and must be an existing directory). Returns `Started background terminal bt-N "title" (pid N, /cwd). …` text; `details: { id, title, cwd, pid }`. |
| `bg_status` | Non-blocking peek. Params: `id` (string, e.g. `"bt-1"`). Unknown id → throws listing known ids. Returns one metadata line + tail-truncated `stdout:`/`stderr:` sections (16 KiB/400 lines and 8 KiB/200 lines) with truncation notes pointing at the spill path; if the entry already settled, its pending automatic follow-up is consumed (this status is the delivery). `details: { id, status, pid, exitCode, signal }`. |
| `bg_list` | List all tracked terminals (running and settled). No params. One `describeTerminal` line each (`bt-N [status] "title" (pid N, 3m12s, exit 0, /cwd, stdout X, stderr Y)`), or `No background terminals.` `details: { terminals: [{ id, title, status, pid }] }`. |
| `bg_kill` | Stop one or more. Params: `ids` (array of string). Unknown ids → throws listing them. SIGTERM→SIGKILL the whole tree, resolves only after settlement; an aborted wait (`interruptMessage: "Kill wait aborted; termination continues in the background."`) does not cancel the termination. Report per id distinguishes `Killed …`, natural-exit-won-the-race, and already-settled. Consumes the ids' deferred follow-ups. `details: { results: [{ id, title, status, killed }] }`. |

### Commands

| Command | Purpose |
|---|---|
| `/ps` | List and inspect background terminals. TUI mode: two-stage full-screen overlay — dashboard (select with `tui.select.up/down` + `j`/`k`, Enter to inspect, `x` to kill running, `tui.select.cancel` to close; 1Hz elapsed ticker + live `view.subscribe` re-render; selection kept stable across refreshes) → read-only detail view (metadata header, `$ command`, stdout/stderr tab toggled with `t`, `x` kill, scroll `tui.editor.cursorUp/Down` + `j`/`k` in 6-line steps, `pageUp`/`pageDown`, `g`/`G` top/bottom, `tui.select.cancel`/`app.interrupt` back; 50ms debounced live re-render; output sanitized/wrapped via a `(version, width)` line cache). Non-TUI mode: plain-text listing via `ctx.ui.notify`. Empty state notifies "No background terminals yet. The agent starts them with bg_start." |

### Events

- `session_start` — captures the session `ctx` (for `isIdle()`) and, when `ctx.hasUI`, the `ui` context.
- `agent_settled` — `flushResults()`: drains deferred result delivery into follow-up messages. Together with the `isIdle()` fast path and Map-keyed delivery, double delivery is impossible — whoever drains first wins.
- `session_shutdown` — teardown: drop `sessionContext`, clear the result map, unsubscribe the widget, clear the widget, dispose the runtime (manager finalizer → `disposeAll` → every process tree SIGTERM→SIGKILL, each close bounded), null all refs. Processes never survive a session transition.

### Message renderer

- `pi.registerMessageRenderer("background-terminal-result", …)` — renders the async completion message. Collapsed: icon by status (`x` error / `■` muted / `■` success), `terminal bt-N · title · exit 0|SIGTERM|killed` header, 8-line preview, `… (ctrl+o to expand)`. Expanded: header + body as Markdown. The body drops only the summary line (the `Error:` line is real output); raw ANSI/control chars are stripped (`sanitizeText`) so the transcript doesn't smear.

### Widget

- `ctx.ui.setWidget("background-terminals", …)` — one line above the editor, present only while ≥1 process runs: `■ N background terminal(s) running • /ps to view`. Cleared on last settle and in `session_shutdown`. Not touched unless the running count changed.

### Exported functions / constants (module level)

- `src/domain.ts` — `TerminalStatus` (`"running" | "done" | "failed" | "killed"`), `OutputView` (`text`, `totalBytes`, `truncatedBytes`, `spillPath?`), `TerminalSnapshot` (readonly: `id`, `command`, `title`, `cwd`, `pid?`, `status`, `createdAt`, `settledAt?`, `exitCode?`, `signal?`, `errorText?`, `stdout`, `stderr`), `formatElapsed(snap)` (`3m12s`), `formatExit(snap)` (`exit 0`, `SIGTERM`, `running`), tagged errors `SpawnError`, `ConcurrencyLimitError`, `UnknownTerminalError` (all `Data.TaggedError` with `message`).
- `src/manager.ts` — `MAX_RUNNING = 8`, `MAX_TRACKED = 32`, `RETAINED_PER_STREAM = 2 MiB`, `MAX_SPILL_BYTES_PER_STREAM = 256 MiB`; `StartOptions { command, title, cwd }`; `KillResult { id, title, status, wasRunning, killed, exit }`; `TerminalReadModel` (`list`, `get`, `size`, `subscribe`, `subscribeTo`, `requestKill` (fire-and-forget UI kill, NOT marked consumed — the follow-up still fires), `setOnSettled`); `TerminalManagerShape` (`start`, `status`, `kill`, `list`, `disposeAll`, `view`); `TerminalManager` (`Context.Service`, tag `"background-terminals/TerminalManager"`); `TerminalManagerLive` (the `Layer`).
- `src/runtime.ts` — `createTerminalRuntime()` (`ManagedRuntime.make(TerminalManagerLive)`), `TerminalRuntime` (= `ReturnType<typeof createTerminalRuntime>`), `runTool(runtime, effect, { signal?, interruptMessage? })` — converts typed failures/defects to thrown `Error`, interruption to `interruptMessage`.
- `src/output.ts` — `OutputBuffer(maxRetainedBytes, spill?)` with `push(chunk) → boolean` (spill backpressure) and `view() → OutputView`; `version` counter bumps per push.
- `src/result-delivery.ts` — `createDeferredResultDelivery<T extends { id: string }>()` → `{ defer, consume(ids), drain(), clear() }`, one-shot per id.
- `src/prompt.ts` — all model-facing strings: `BG_START_TOOL_DESCRIPTION`, `BG_START_PROMPT_SNIPPET`, `BG_START_PROMPT_GUIDELINES`, `BG_START_PARAMETER_DESCRIPTIONS`, `BG_STATUS_TOOL_DESCRIPTION`, `BG_STATUS_PARAMETER_DESCRIPTIONS`, `BG_LIST_TOOL_DESCRIPTION`, `BG_KILL_TOOL_DESCRIPTION`, `BG_KILL_PARAMETER_DESCRIPTIONS`; builders `buildStartResult(snap)`, `describeTerminal(snap)`, `buildStatusResult(snap)`, `buildTerminalResultMessage(snap)`, `buildKillReport(results)`; truncation constants `STATUS_STDOUT_MAX` (16 KiB), `STATUS_STDERR_MAX` (8 KiB), `RESULT_STDOUT_MAX` (8 KiB), `RESULT_STDERR_MAX` (4 KiB).
- `src/ui/output-view.ts` — `sanitizeText(text)` (strips OSC/CSI/escape sequences, expands tabs, drops control chars), `buildOutputLines(text, width)` (keeps only the final `\r` segment of progress lines), `createOutputLineCache()` (wrapped-line cache keyed by `version:width`).
- `src/ui/ps.ts` — `openTerminalPicker(ctx, view)` (the pick→detail→back loop), `DashboardSelection { id?, index }`, `reconcileDashboardSelection(selection, terminals)`.

## Examples

1. **Start a dev server and keep working**
   ```
   bg_start(command: "npm run dev", title: "dev server", working_dir: "~/projects/pi")
   ```
   Returns immediately with `bt-1`; the widget appears above the editor. When the server exits (or is killed), a single `background-terminal-result` follow-up arrives with the tail of stdout/stderr.

2. **Peek at progress mid-run**
   ```
   bg_status(id: "bt-1")
   ```
   Returns one metadata line plus tail-truncated `stdout:`/`stderr:` sections with truncation notes (`Full log: /var/folders/.../pi-background-terminals/session-XXX/bt-1.stdout.log`) when the retained tail is incomplete.

3. **Stop a wedged process (whole tree)**
   ```
   bg_kill(ids: ["bt-1"])
   ```
   SIGTERMs the process group, escalates to SIGKILL after 2s if needed, and only returns after settlement: `Killed bt-1 "dev server" (SIGTERM).` A natural exit that beat the signal is reported honestly (`exited on its own before the kill landed`).

4. **Human inspection with `/ps`**
   The user (or the model telling the user) runs `/ps`: dashboard lists every tracked terminal with status glyphs, pid, elapsed, exit; Enter opens the detail view for live-tail scrolling, `t` toggles stdout/stderr, `x` kills. `/ps` also works in RPC/print mode as a plain-text listing via notify.
