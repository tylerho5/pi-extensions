# @tylerho/pi-background-terminals

Runs long-lived background shell processes started by the model, inspectable and killable via /ps.

## Install

`pi install npm:@tylerho/pi-background-terminals`

---

# Background terminals

Background terminals are long-lived shell processes that the model starts with `bg_start` and inspects or stops with `bg_status`, `bg_list`, and `bg_kill`. A terminal receives no input at any point, and its settlement reaches the model exactly once, either as a follow-up message or as the return value of the tool that collected it. The tool family resembles Claude Code's `BashOutput` and `KillShell` tools in purpose, with pi's own names, parameters, and result shapes.

## How it works

A terminal is one tracked shell process. Each has an id (`bt-1`, `bt-2`, ...), a title, the command line, the resolved working directory, and separate stdout and stderr captures.

### Async core and the read model

One `ManagedRuntime` over a `TerminalManager` service (`Context.Service` with a `Layer.effect` implementation) is the async boundary. Tool handlers run effects through `runTool`, which turns typed failures and defects into thrown `Error` values and turns interruption into a message. Node stream plumbing is not Effect-based. The `data`, `exit`, `close`, and `error` callbacks mutate a per-entry snapshot directly. The TUI reads through a synchronous `TerminalReadModel` bridge, so a render never touches the runtime.

### Process model and settlement

A terminal is a `spawn` of the platform shell: `/bin/sh -c <command>` on POSIX, and `process.env.ComSpec` (default `cmd.exe`) with `/d /s /c <command>` on Windows. The spawn uses `stdio: ["ignore", "pipe", "pipe"]` and `detached: true` on POSIX, so the child leads its own process group and a group kill reaches its descendants. `stdin: "ignore"` means a process that reads stdin sees EOF at once. An interactive command is a caller mistake, and `bg_kill` is the remedy.

A terminal settles into one of three final states. `done` means exit code 0, `failed` means a non-zero exit or a spawn-level `error`, and `killed` means a termination started by `bg_kill`, the `/ps` `x` key, or session teardown. `settle()` is idempotent, so the first of a racing kill and a natural exit wins. The `exit` callback records `exitCode` and `signal`. Settlement happens on `close`, because that fires after stdio flushes and the completion message must carry the final output. A spawn failure arrives through `error`, which marks the entry failed and prevents `close` from overwriting the real reason with its errno.

Teardown is one path. Every entry scope has a finalizer that sends SIGTERM to the process group, waits 2s (`FORCE_KILL_AFTER_MS`), sends SIGKILL, and waits a further 500ms. A grandchild can hold the inherited stdio pipes after the shell exits, so an `exit` with no following `close` schedules a bounded scope close after a 1s grace (`SETTLE_GRACE_MS`). If the entry still runs after the finalizer's grace and no close-path flush is in flight, the finalizer flushes the spill streams and settles the entry itself. Each scope close is bounded at 5s (`STOP_TIMEOUT_MS`), and terminate, grace, and flush together stay inside that bound so shutdown stays bounded end to end.

### Caps and pruning

`MAX_RUNNING = 8` terminals run at once. `start` reserves a slot synchronously before its first yield and releases it in an `ensuring`, so parallel tool calls cannot race past the cap. Over the cap, the spawn fails with `ConcurrencyLimitError` and the message `Max 8 background terminals can run concurrently. Stop one with bg_kill before starting another.`

`MAX_TRACKED = 32` entries are retained. `pruneSettled()` drops the oldest settled entries first and never drops a running entry or one with an in-flight kill. `MAX_SETTLED_HISTORY = 128` immutable tombstones (id, title, status, exit) keep a kill report truthful when pruning races the tool boundary. Each entry's `settled` `Deferred` completes exactly once, so kill callers and the scope finalizer can wait on the same settlement without missing it.

### Output capture and spill files

stdout and stderr are captured separately. `OutputBuffer` keeps the newest 2 MiB (`RETAINED_PER_STREAM`) of a stream in memory, dropping whole chunks from the head and counting the dropped bytes in `truncatedBytes`. A single chunk larger than the cap is cut to its tail on a UTF-8 code point boundary, so retention stays strictly bounded and the retained text stays contiguous. `version` increments on every push, and the joined text is cached between pushes so an idle 1Hz UI tick does not re-join megabytes.

Each stream also spills to an append-mode file with mode 0600 at `os.tmpdir()/pi-background-terminals/session-XXXXXX/<id>.<stdout|stderr>.log`, inside a 0700 directory created per session. The spill holds the complete capture up to 256 MiB per stream (`MAX_SPILL_BYTES_PER_STREAM`). When a write returns false, the buffer reports backpressure and the manager pauses the stream until `drain`. Settlement flushes the spills first, bounded at 1.5s (`SPILL_FLUSH_TIMEOUT_MS`), so a completion message never points at a partial file. A failed or capped spill clears `spillPath` and appends a note to `errorText`. `disposeAll` removes the session directory.

### Exactly-once completion delivery

Settlement calls `onSettled(snapshot, consumed)`. `consumed` is true only when an in-flight `bg_kill` is collecting the settlement, tracked in the manager's `killInterest` map. A UI kill through `requestKill` is not consumed, so that result still reaches the model. An unconsumed settlement is deferred into a map keyed by id (`createDeferredResultDelivery`), and the extension delivers it with `deliverAs: "followUp"` and `triggerTurn: true`: queued until the agent has no more tool calls, and waking the model only when it is idle. Flushing happens on the `isIdle()` fast path and on the `agent_settled` event. The map clears on drain, so whoever drains first wins and a double delivery is impossible. `bg_status` on a settled entry consumes that id in its handler, because the status result is the delivery. Nothing polls.

### Widget and session teardown

While at least one terminal runs, a one-line widget keyed `background-terminals` sits above the editor and reads `■ N background terminals running • /ps to view`, with `terminal` singular when exactly one runs. It is driven by `view.subscribe` and calls `setWidget` only when the running count changes, because per-chunk notifications arrive hundreds of times a second. The last settle clears it.

`session_shutdown`, which fires for `/new`, `/resume`, `/fork`, `/reload`, and quit, drops the session context, clears the result map, unsubscribes and clears the widget, then disposes the runtime. Disposal runs the manager finalizer, which calls `disposeAll`: every entry scope closes, every process tree receives SIGTERM then SIGKILL, and the spill directory is removed. Nothing persists across sessions.

### The /ps overlay

The overlay runs over the synchronous read model. The dashboard renders every tracked terminal with a status glyph, title, id, pid, elapsed time, and exit. It holds a selection object rather than an index, so a refresh keeps the same terminal selected, and it re-renders on `view.subscribe` plus a 1Hz ticker for elapsed time. The detail view subscribes to one id and debounces re-renders by 50ms, because a chatty process emits a chunk per write. It keeps a wrapped-line cache keyed by the stream's byte count and the render width, pins the view to the bottom until the user scrolls, and keeps only the last carriage-return segment of a progress line so npm and cargo output shows its final state. Titles and commands pass through `oneLine`, and output passes through `sanitizeText` at render time, so a newline or control character cannot desync a fixed-height row. Returning from the detail view falls back to the dashboard, and cancel closes the overlay back to the editor.

## API

All model-facing strings live in `src/prompt.ts`, and tool parameters use `typebox` `Type.Object`. A failure throws a plain `Error`, which pi reports as a tool error.

### Tools

| Tool | Parameters | Behavior |
|---|---|---|
| `bg_start` | `command` (string, required), `title` (string, required), `working_dir` (optional string) | Fire-and-forget spawn. `command` is trimmed and must not be empty. `title` has its whitespace collapsed to one line, because a newline in a fixed-height UI row desyncs the renderer, and is cut to 80 characters, with `terminal` used when the result is empty. `working_dir` resolves against `ctx.cwd` and must be an existing directory. Returns `Started background terminal bt-1 "dev server" (pid 12345, /path).` plus a line naming the id, and `details: { id, title, cwd, pid }`. |
| `bg_status` | `id` (string, required) | Non-blocking peek. Returns one `describeTerminal` line, `bt-1 [running] "dev server" (pid 12345, 3m12s, exit -, /path, stdout 1.2KB, stderr 0B)`, then an `Error:` line when `errorText` is set, then labeled `stdout:` and `stderr:` sections. A section with no bytes reads `(empty)`. Sections are tail-truncated to 16 KiB and 400 lines for stdout, and 8 KiB and 200 lines for stderr, and a truncated section ends with `[stdout truncated: showing last <shown> of <total>. Full log: <path>]`, or `Full output in the /ps viewer` when no spill exists. An unknown id throws and lists the known ids. A settled entry consumes its pending follow-up here, because this result is the delivery. `details: { id, status, pid, exitCode, signal }`. |
| `bg_list` | none | One line per tracked terminal, running and settled, or `No background terminals.` `details: { terminals: [{ id, title, status, pid }] }`. |
| `bg_kill` | `ids` (string array, required) | Dedups the ids, rejects an empty list, and rejects unknown ids with the known list. Sends SIGTERM to the whole tree, escalates to SIGKILL, and resolves only after settlement. An aborted call leaves the termination running and reports that the kill wait was aborted. The report is one line per id: `Killed bt-1 "dev server" (SIGTERM).`, `bt-2 "build" exited on its own before the kill landed (exit 0).`, or `bt-3 "watcher" was already failed (exit 1).` It consumes the ids' deferred follow-ups. `details: { results: [{ id, title, status, killed }] }`. |

### Commands

`/ps` is described as "List and inspect background terminals". Outside TUI mode, when the context has a UI, it notifies a plain-text listing, or `No background terminals.` when empty. In TUI mode with nothing tracked it notifies `No background terminals yet. The agent starts them with bg_start.` Otherwise it opens the two-stage overlay.

On the dashboard, `tui.select.up` and `tui.select.down` (or `j` and `k`) move the selection, `tui.select.confirm` opens the detail view, `x` kills the selected terminal when it runs, and `tui.select.cancel` closes the overlay.

In the read-only detail view, `t` switches between stdout and stderr, `tui.editor.cursorUp` and `tui.editor.cursorDown` (or `j` and `k`) scroll six lines, `tui.editor.pageUp` and `tui.editor.pageDown` page by one viewport, `g` jumps to the top, `G` returns to the live tail, `x` kills a running terminal, and `tui.select.cancel` or `app.interrupt` goes back to the dashboard. The hint rows render the configured keys through `KeybindingsManager`, so a rebound key shows its real binding.

### Events

- `session_start`: stores the session context used by the `isIdle()` fast path, and the UI context when `ctx.hasUI` is true.
- `agent_settled`: drains deferred results into follow-up messages.
- `session_shutdown`: drops the session context, clears the result map, unsubscribes and clears the widget, disposes the runtime, and nulls every reference.

### Message renderer

`pi.registerMessageRenderer("background-terminal-result", ...)` renders the completion message. Collapsed, it shows a status icon (`x` for failed, a muted square for killed, a success square otherwise), a `terminal bt-1 · dev server · exit 0` header, an 8-line preview of the body, and `... (ctrl+o to expand)` when the body is longer. Expanded, the header stays and the body renders as Markdown. The body drops only the summary line, so an `Error:` line stays visible, and `sanitizeText` strips ANSI and control characters from raw process output so the transcript does not smear.

### Exports

- `src/domain.ts`: `TerminalStatus` (`running`, `done`, `failed`, `killed`), `OutputView` (`text`, `totalBytes`, `truncatedBytes`, `spillPath?`), `TerminalSnapshot` (readonly `id`, `command`, `title`, `cwd`, `pid?`, `status`, `createdAt`, `settledAt?`, `exitCode?`, `signal?`, `errorText?`, `stdout`, `stderr`), `formatElapsed(snap)` (`3m12s`), `formatExit(snap)` (`exit 0`, `SIGTERM`, or `running`), and the tagged errors `SpawnError`, `ConcurrencyLimitError`, and `UnknownTerminalError`.
- `src/manager.ts`: `MAX_RUNNING` (8), `MAX_TRACKED` (32), `RETAINED_PER_STREAM` (2 MiB), `MAX_SPILL_BYTES_PER_STREAM` (256 MiB), `StartOptions` (`command`, `title`, `cwd`), `KillResult` (`id`, `title`, `status`, `wasRunning`, `killed`, `exit`), `TerminalReadModel` (`list`, `get`, `size`, `subscribe`, `subscribeTo`, `requestKill`, `setOnSettled`), `TerminalManagerShape` (`start`, `status`, `kill`, `list`, `disposeAll`, `view`), the `TerminalManager` service (tag `background-terminals/TerminalManager`), and `TerminalManagerLive`.
- `src/runtime.ts`: `createTerminalRuntime()`, the `TerminalRuntime` type, and `runTool(runtime, effect, { signal?, interruptMessage? })`.
- `src/output.ts`: `OutputBuffer(maxRetainedBytes, spill?)` with `push(chunk)`, `view()`, `totalBytes`, `truncatedBytes`, `version`, and `spillPath`.
- `src/result-delivery.ts`: `createDeferredResultDelivery<T extends { id: string }>()`, which returns `{ defer, consume(ids), drain(), clear() }` and honors one delivery per id.
- `src/prompt.ts`: `BG_START_TOOL_DESCRIPTION`, `BG_START_PROMPT_SNIPPET`, `BG_START_PROMPT_GUIDELINES`, `BG_START_PARAMETER_DESCRIPTIONS`, `BG_STATUS_TOOL_DESCRIPTION`, `BG_STATUS_PARAMETER_DESCRIPTIONS`, `BG_LIST_TOOL_DESCRIPTION`, `BG_KILL_TOOL_DESCRIPTION`, `BG_KILL_PARAMETER_DESCRIPTIONS`, the builders `buildStartResult`, `describeTerminal`, `buildStatusResult`, `buildTerminalResultMessage`, `buildKillReport`, and the truncation bounds `STATUS_STDOUT_MAX` (16 KiB), `STATUS_STDERR_MAX` (8 KiB), `RESULT_STDOUT_MAX` (8 KiB), `RESULT_STDERR_MAX` (4 KiB), plus the module-private line caps `STATUS_STDOUT_MAX_LINES` (400), `STATUS_STDERR_MAX_LINES` (200), `RESULT_STDOUT_MAX_LINES` (40), `RESULT_STDERR_MAX_LINES` (20).
- `src/ui/output-view.ts`: `sanitizeText(text)`, `buildOutputLines(text, width)`, `createOutputLineCache()`.
- `src/ui/ps.ts`: `openTerminalPicker(ctx, view)`, `DashboardSelection`, `reconcileDashboardSelection(selection, terminals)`.

## Examples

1. Start a dev server and keep working

   ```
   bg_start(command: "npm run dev", title: "dev server", working_dir: "~/projects/pi")
   ```

   Returns immediately with `bt-1` and the widget appears above the editor. When the server exits or is killed, one `background-terminal-result` follow-up arrives carrying the tail of stdout and stderr.

2. Peek at progress mid-run

   ```
   bg_status(id: "bt-1")
   ```

   Returns one metadata line plus tail-truncated `stdout:` and `stderr:` sections. When the retained tail is incomplete, the section note names the full log, for example `Full log: /var/folders/.../pi-background-terminals/session-XXXXXX/bt-1.stdout.log`.

3. Stop a wedged process

   ```
   bg_kill(ids: ["bt-1"])
   ```

   SIGTERMs the process group, escalates to SIGKILL after 2s if needed, and returns only after settlement: `Killed bt-1 "dev server" (SIGTERM).` A natural exit that beat the signal is reported as such.

4. Human inspection with `/ps`

   The dashboard lists every tracked terminal. Enter opens the detail view for live-tail scrolling, `t` toggles stdout and stderr, and `x` kills a running terminal. Outside TUI mode `/ps` prints the same listing through `ui.notify`.
