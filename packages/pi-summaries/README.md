# @tylerho/pi-summaries

Generates a compact recap of each agent run and appends it to the session once the run settles.

## Install

`pi install npm:@tylerho/pi-summaries`

---

# Summaries (run recaps)

After an agent run settles, this extension produces a compact recap of what happened ("recap" + "next" step) and appends it to the session as a `summary-recap` custom entry, rendered as a "✦ Recap" card in the TUI. Recap work runs on its own configured model (default deepseek/deepseek-flash at medium reasoning), stored privately in `config.private.json` so the main agent's provider rotation is untouched. It exists because long sessions bury what a run actually did; the recap card keeps each run's outcome visible and gives the next turn a starting point. `/recap` configures the feature: change the model, or disable/enable it.

## Key concepts

- **Recap on settle, not end.** The recap fires on `agent_settled` (preferred over `agent_end`) because pi may auto-retry or queue follow-ups after `agent_end`; settling means the run is genuinely over.
- **Run boundary keeps the _oldest_ un-recapped baseline.** `createRunBoundary()` holds one marker (`baselineLeafId`). `before_agent_start` calls `runBoundary.begin(leafId)` (first-begin wins via `??=`). Recaps are deferred until the session goes quiet, so several runs can accumulate behind one marker — keeping the _first_ baseline means one recap covers all of them, not just the last. `getRunEntries(branch, baselineLeafId)` slices the session branch _after_ that leaf; if the leaf is gone, entries are empty and the boundary is cleared without a recap.
- **Idle-aware throttling.** `input` (source `"interactive"`) and `user_bash` events call `onUserActivity()`: cancel the armed timer **and abort in-flight recaps** (a recap landing mid-turn is noise). The boundary survives the abort, so the next quiet stretch recaps the dropped run together with the new one.
- **Quiet-period timer.** `scheduleRecap` arms a `setTimeout(idleDelayMs())` — default 180 s (Claude Code's away-summary delay), floor 30 s (`MIN_IDLE_DELAY_MS`), override via env `PI_SUMMARY_IDLE_MS=<milliseconds>` — `.unref()`'d. The timer only decides _whether_ a timer exists; `writeRecap`'s fire-time checks are the authority: pending run, `sessionActive`, `ctx.isIdle()`, `!ctx.hasPendingMessages()`, and **`!anyRunning()`**.
- **Child agents defer the recap.** Via `shared/agent-activity.ts`, `onActivityChange` cancels the timer whenever any child (subagent, workflow) is running and re-arms it when the last one settles and the session is idle again — so a run whose subagent outlives the main agent still gets recapped after the child finishes.
- **Independent model call.** `summarizeRun` looks the configured model up in `ctx.modelRegistry` (`find(provider, model)`; throws `SummaryError` if unavailable), gets API key/headers via `getApiKeyAndHeaders`, then calls `completeSimple` from `@earendil-works/pi-ai/compat` with `SUMMARY_SYSTEM_PROMPT`, `maxTokens: 1_000`, `maxRetries: 1`, `timeoutMs: 40_000` and an outer `Effect.timeout("45 seconds")`. Reasoning is passed through only when not `"off"` (`reasoningOptions`). The response must be exactly one JSON object `{"recap":..., "next":...}`; `parseRecapResponse` defensively unwraps fenced JSON and extracts brace-delimited candidates, then normalizes a leading "Next:" prefix and strips ANSI/OSC control sequences; recap capped at 2 400 chars, next at 400.
- **Local fallback.** If the model call fails (and it wasn't an abort or shutdown), `buildFallbackRecap` derives a recap from the transcript — unique tool names + final assistant text (700-char cap) — tagged `fallback: true`, with a warning notification "The summary model failed; showing a concise local fallback."
- **Transcript sanitization.** `serializeRunTranscript` serializes session entries with role prefixes (`USER`, `ASSISTANT`, `TOOL CALL`, `TOOL RESULT`, `USER SHELL`, `EXTENSION`), omitting thinking blocks, images, and its own `summary-recap` entries (no recursion). Secrets are redacted (`redactSecrets` regexes + key-name check in `sanitizeValue`); per-item caps with `[...]` notices (tool args 2 000 B, results 5 000 B); total transcript capped at 48 KB, truncated head+tail (58 % head) around a `[... transcript capped; middle omitted ...]` marker.
- **Entry + renderer.** The recap is appended via `pi.appendEntry("summary-recap", recap)`; `registerEntryRenderer("summary-recap")` renders it as a `RecapCard` (customMessageBg box, "✦ Recap" accent title, Markdown body, "Next:" line; expanded shows a dim source line `provider/model · reasoning` + ` · local fallback` when applicable; missing data renders "Recap unavailable").
- **Status + lifecycle.** While a recap is generating, `ctx.ui.setStatus("summaries", "✦ summarizing run…")` (shows on the expanded-footer line 3). `session_shutdown` aborts in-flight tasks and waits up to 1 s (`SHUTDOWN_WAIT_MS`) before clearing status. All activity tracking is session-scoped; `sessionActive = ctx.mode === "tui"` and every handler no-ops outside the TUI.
- **Enabled gate.** `config.enabled` (default `true`) gates the feature: disabled recaps never arm a timer, and `writeRecap` re-checks at fire time so an already-armed timer is a no-op. Disabling via `/recap` also cancels the armed timer and aborts in-flight recaps immediately. The run boundary survives the toggle, so re-enabling recaps everything accumulated since the baseline.
- **Brevity.** The system prompt asks for at most two short sentences (~40 words), and `parseRecapResponse` hard-caps the output (recap 600 chars, next 200) — the cap is a backstop, not the target.
- **No tools, no shortcuts.** The extension registers exactly one command, one entry renderer, and six event handlers — no `registerTool`, no `registerShortcut`.

## API

### Commands

| Command  | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/recap` | Configure run recaps (TUI only; notifies "Recap settings are only available in the TUI." otherwise). No args. Flow: loads current config → `ui.select` menu with two items: "Change model…" → `openModelPicker` (TUI `ui.select` over `curatedModels(ctx.modelRegistry.getAvailable(), ctx.cwd)` from `shared/subagent-models.ts` — the same scope `/subagent-model` offers, cheapest first, labels like `deepseek/deepseek-flash · $X/Mtok out`; warns "No configured models are available for run recaps." if empty) → `openReasoningPicker` (a `ThinkingSelectorComponent` limited to `getSupportedThinkingLevels(model)`, defaulting to the current level when supported) → `saveSummaryConfig` → notifies `Summary model: <provider>/<model> · <reasoning>`. "Disable recaps" / "Enable recaps" → flips `config.enabled`, saves, notifies `Recaps enabled.` / `Recaps disabled.`; disabling also cancels the armed timer and aborts in-flight recaps. |

### Events

| Event                | Handler                                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_start`      | Sets `sessionActive = ctx.mode === "tui"`, records `statusContext`, cancels any scheduled timer, clears the run boundary.                                        |
| `input`              | If `event.source === "interactive"`, `onUserActivity()`: cancels the scheduled recap and aborts all in-flight recaps.                                            |
| `user_bash`          | `onUserActivity()` — shell activity also counts as user activity.                                                                                                |
| `before_agent_start` | TUI only: `onUserActivity()` (drop any pending recap from the previous turn) then `runBoundary.begin(ctx.sessionManager.getLeafId())`.                           |
| `agent_settled`      | TUI + active + pending run: `scheduleRecap(ctx)` (arms the quiet-period timer).                                                                                  |
| `session_shutdown`   | Marks session inactive, cancels timer, clears boundary, unsubscribes from activity changes, aborts in-flight recaps, waits ≤ 1 s, clears the `summaries` status. |

### Entry renderer

- `registerEntryRenderer("summary-recap", (entry, { expanded }, theme) => renderRecap(...))` — renders `RecapEntryData` as the Recap card described above.

### Config & environment

- `config.private.json` (`~/.pi/agent/summaries/config.private.json`, gitignored, mode `0o600`): `{ "enabled", "provider", "model", "reasoning" }`. `parseSummaryConfig` falls back to `DEFAULT_SUMMARY_CONFIG` (`enabled: true`, `deepseek` / `deepseek-flash` / `medium`) on any missing/invalid field, except a missing `enabled`, which means `true` (configs written before the toggle predate the field; a mistyped `enabled` still falls back to defaults). Config used to live inside the extension directory (`extensions/summaries/config.private.json`), which broke on a clean package install; that old file is now ignored — users re-select their summary model once via `/recap`.
- `REASONING_LEVELS` = `off, minimal, low, medium, high, xhigh, max` (mirrors pi's thinking levels).
- `PI_SUMMARY_IDLE_MS` — quiet delay override; clamped to ≥ 30 000 ms; invalid values use the 180 000 ms default.
- `saveSummaryConfig` writes atomically (temp file + `rename`, `Effect.timeout("5 seconds")`, abortable).

### Internal exports (src modules)

- `src/config.ts` — `REASONING_LEVELS`, `ReasoningLevel`, `SummaryConfig`, `DEFAULT_SUMMARY_CONFIG`, `DEFAULT_IDLE_DELAY_MS`, `MIN_IDLE_DELAY_MS`, `idleDelayMs()`, `PRIVATE_CONFIG_PATH()`, `parseSummaryConfig()`, `loadSummaryConfig()`, `saveSummaryConfig()`. `PRIVATE_CONFIG_PATH` is a function (resolved at call time from `getAgentDir()`), not a module-load constant, so tests can point it at a temp dir via `PI_CODING_AGENT_DIR`.
- `src/summarizer.ts` — `RunRecap`, `parseRecapResponse()`, `reasoningOptions()`, `summarizeRun()`.
- `src/prompt.ts` — `SUMMARY_SYSTEM_PROMPT`, `buildSummaryPrompt(transcript)` (wraps transcript in `<recent_work>` tags).
- `src/ui.ts` — `RecapEntryData` (`RunRecap` + `provider`, `model`, `reasoning`, `fallback?`), `renderRecap()`, `openModelPicker()`, `openReasoningPicker()`.

## Examples

1. **After any settled run**, the extension appends a recap card automatically; the next agent turn sees it in history and can answer "What did the last run do?" by reading the recap — e.g. "Updated config and ran focused tests." / "Next: Review the diff."
2. **Change the recap model or pause the feature**: run `/recap`, pick "Change model…", pick a provider/model from the list, pick a reasoning level, confirm the notification `Summary model: openrouter/anthropic/claude-sonnet-4 · high`. Pick "Disable recaps" to stop them (they resume from the same run boundary when re-enabled), or edit `config.private.json` directly (write is atomic; invalid values silently fall back to defaults).
3. **Faster recaps for interactive work**: launch pi with `PI_SUMMARY_IDLE_MS=30000` so the recap lands 30 s after a run settles instead of the default 3 min.
4. **Debug a missing recap**: if a run ends with no card, check the `summaries` status line during generation (`✦ summarizing run…`), the warning notification when the model failed (local fallback shown with ` · local fallback` in the expanded view), and note that any pending user input, pending messages, or a still-running child agent defers the recap.
