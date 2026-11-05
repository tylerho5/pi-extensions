# @tylerho/pi-turn-end

Appends a one-line marker to the session each time the agent stops: how long it worked and when it stopped.

## Install

`pi install npm:@tylerho/pi-turn-end`

---

# Turn end

A subdued one-line marker appended to the session history each time the agent stops working: `worked 1m 12s · stopped at 2:34 PM`. It answers two questions at a glance after a run finishes: how long the agent worked and when it stopped.

## Key concepts

- **Persisted custom entry, not a transient UI element.** The line is stored via `pi.appendEntry("turn-end", { startedAt, endedAt, durationMs })` and rendered via `pi.registerEntryRenderer("turn-end", …)`. It survives session reload (old entries re-render from stored data) and never enters the LLM context.
- **`agent_settled`, not `agent_end`.** `agent_end` fires before pi may auto-retry, auto-compact, or drain queued follow-ups; `agent_settled` is pi's "the agent has truly stopped" signal, which is when the line is appended.
- **First `agent_start` of a run sets the clock.** A module-level `startedAt` is set only when undefined, so auto-retries within one user turn don't restart the timer — the duration covers the whole run as the user experiences it. `session_start` resets it.
- **TUI only.** Handlers no-op when `ctx.mode !== "tui"`; there is no transcript to render into otherwise.
- **Stop time in Eastern time, unlabeled, dated when it isn't today.** The stop time comes from `Intl.DateTimeFormat` pinned to `America/New_York`, with no zone suffix on the line. A stop from today reads `stopped at 2:34 PM`; an earlier day reads `stopped Sunday, Sep 27 at 3:24 PM`. The check runs at render time against the current day, so yesterday's entry grows its date once the day rolls over — the caller can also pass an explicit `now` for deterministic output.

## API

### Events

- `agent_start` — records `Date.now()` if no run is already being timed (TUI mode only).
- `agent_settled` — computes `durationMs`, calls `pi.appendEntry(ENTRY_TYPE, …)`, clears the clock (TUI mode only).
- `session_start` — clears the clock so a stale start never carries into a new session.

### Entry renderer

`pi.registerEntryRenderer<TurnEndData>("turn-end", …)` — a single `Text` line, `theme.fg("dim", …)`, no box or background. Falls back to `turn ended` if an entry somehow lacks data.

### Exports

Default export is the standard `(pi: ExtensionAPI)` entry point. Also exports pure helpers for tests: `ENTRY_TYPE`, `TurnEndData`, `formatDuration(ms)` (`45s` / `1m 12s` / `1h 5m`), `formatStoppedAt(ms, now?)` (`2:34 PM`, or `Sunday, Sep 27 at 3:24 PM` when the stop is not from `now`'s day), `formatLine(data, now?)`.

## Examples

- Agent answers a quick question: `worked 8s · stopped at 2:34 PM`
- Agent runs a long refactor with a compaction retry mid-run: the retry does not reset the clock — `worked 6m 41s · stopped at 3:02 PM`
- Reloading an old session: each past run still shows its line, rendered from the persisted entry data. A run that finished on an earlier day is dated: `worked 2m 3s · stopped Sunday, Sep 27 at 3:24 PM`.
