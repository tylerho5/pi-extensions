# @tylerho/pi-summaries

Generates a compact recap of each agent run and appends it to the session once the run settles.

## Install

`pi install npm:@tylerho/pi-summaries`

---

# Summaries

After an agent run settles, this extension writes a short recap and one next step, then appends them to the session as a `summary-recap` entry that the TUI renders as a "✦ Recap" card. Generation runs on its own configured model, held in `~/.pi/agent/summaries/config.private.json`, so recap traffic never touches the main agent's provider rotation. `/recap` changes the model or turns the feature on and off.

## How it works

Recaps cover a run, and a run begins at a user turn and ends when pi settles. `createRunBoundary()` in [`shared/transcript.ts`](shared.md) holds one marker, `baselineLeafId`. `before_agent_start` records the current leaf with `begin(leafId)`, and the first call wins because the marker is set with `??=`. Recaps wait for a quiet session, so several runs can pile up behind that one marker, and the eventual recap covers all of them. `getRunEntries(branch, baselineLeafId)` slices the session branch after the baseline leaf. When that leaf is gone, the entries come back empty and the boundary is cleared without a recap.

The recap fires on `agent_settled` rather than `agent_end`. pi may auto-retry or queue follow-ups after `agent_end`, and settling means the run is actually over. The handler requires TUI mode, an active session, and a pending run.

`scheduleRecap` arms a `setTimeout` for `idleDelayMs()` and calls `.unref()`, so a pending recap never holds the process open. The delay defaults to 180,000 ms, which matches Claude Code's away-summary delay, and the floor is `MIN_IDLE_DELAY_MS` (30,000 ms). `PI_SUMMARY_IDLE_MS` overrides it with a positive integer in milliseconds. The timer only decides whether a timer exists. The fire-time checks in `writeRecap` are the authority: a pending run, `config.enabled`, `sessionActive`, `ctx.isIdle()`, `!ctx.hasPendingMessages()`, and `!anyRunning()`.

User activity drops an armed recap. The `input` handler calls `onUserActivity()` when `event.source === "interactive"`, and `user_bash` calls it for shell activity. That cancels the timer and aborts in-flight recaps, because a recap landing mid-turn is noise. The boundary survives the abort, so the next quiet stretch recaps the dropped run together with the new one.

Child agents keep the recap deferred. The extension subscribes to [`shared/agent-activity.ts`](shared.md) when it loads, and a notification cancels the timer while any child reports a running count. When the last child settles and the session is idle, the listener re-arms it. A run whose subagent outlives the main agent still gets a recap, written after the child finishes.

`summarizeRun` looks the configured model up with `ctx.modelRegistry.find(provider, model)` and throws `SummaryError` when the model is unavailable. It gets the key and headers from `getApiKeyAndHeaders`, then calls `completeSimple` from `@earendil-works/pi-ai/compat` with `SUMMARY_SYSTEM_PROMPT`, `maxRetries: 1`, `timeoutMs: 40_000`, and an outer `Effect.timeout("100 seconds")` that gives both attempts room. `reasoningOptions` passes the reasoning level through unless the level is `"off"`. Thinking tokens count toward DeepSeek's output budget, so a reasoning run gets `maxTokens: 8_000` and a run without reasoning gets `1_000`.

A parse failure or a length-truncated response from a reasoning run retries once with reasoning off, which needs far fewer tokens. Transport failures do not retry. With reasoning already off, a length stop reports `The summary model response hit the token limit and was truncated.`, and any other parse failure reports that the model did not return valid recap JSON.

`parseRecapResponse` requires exactly one JSON object with only the keys `recap` and `next`. It tries the trimmed response first, then any fenced block, then the brace-delimited slice between the first `{` and the last `}`. Each field is stripped of ANSI/OSC sequences and control characters, trimmed, and capped (`RECAP_MAX_LENGTH` 600, `NEXT_MAX_LENGTH` 200) with an ellipsis marking the cut. A leading `Next:` prefix is removed from the next step. An empty field makes the candidate invalid.

The system prompt asks for at most two short sentences of 40 words or fewer, covering what was done and the outcome, plus one actionable next step. `buildSummaryPrompt` wraps the transcript in `<recent_work>` tags. The 600 and 200 character caps are a backstop, not the target.

When the model call fails and the failure is not an abort or a shutdown, `buildFallbackRecap` derives a recap from the transcript: the unique tool names, the number of tool calls, and the final assistant text capped at 700 bytes. The entry is tagged `fallback: true` and the extension shows a warning notification with the error detail.

`serializeRunTranscript` renders session entries with role prefixes: `USER`, `ASSISTANT`, `TOOL CALL <name>`, `TOOL RESULT <name>` (with `(error)`), `USER SHELL` (with an exit code), and `EXTENSION <customType>`. It keeps text and tool-call blocks, so thinking blocks and images never reach the summary model. `summary-recap` entries are skipped, which keeps the transcript from recursing on its own output. Secrets are redacted twice: `redactSecrets` covers bearer tokens, API key shapes, and `key=value` patterns, and `sanitizeValue` redacts any value whose key name matches a secret pattern. Tool arguments are capped at 2,000 bytes and tool results at 5,000 bytes, each with a notice line. The full transcript is capped at 48,000 bytes and kept as 58 percent head and the rest tail around a middle-omitted marker.

A finished recap goes to `pi.appendEntry("summary-recap", recap)`, which persists it in the session and keeps it out of LLM context. `registerEntryRenderer` renders it as a `RecapCard`: a padded box on the `customMessageBg` background, an accent `✦ Recap` title, the recap as Markdown, and a `Next:` line. Expanded with ctrl+o, the card adds a dim source line with `provider/model · reasoning`, plus ` · local fallback` for a fallback recap. A missing entry payload renders `Recap unavailable` in the warning color.

While any recap task is active, `ctx.ui.setStatus("summaries", "✦ summarizing run…")` sets the muted footer status that [expanded-footer.md](expanded-footer.md) renders. `session_shutdown` marks the session inactive, cancels the timer, clears the boundary, unsubscribes from activity changes, aborts in-flight recaps, waits up to `SHUTDOWN_WAIT_MS` (1,000 ms) for them, and clears the status. `sessionActive` is `ctx.mode === "tui"`, so the recap path does nothing outside the TUI.

`config.enabled` gates the feature at both ends. A disabled config never arms a timer, and `writeRecap` re-checks at fire time, so an already-armed timer becomes a no-op. Disabling through `/recap` also cancels the armed timer and aborts in-flight recaps. The run boundary survives the toggle, so re-enabling recaps everything since the baseline.

The extension registers one command, one entry renderer, and six event handlers. It registers no tools and no shortcuts.

## API

### Commands

`/recap` configures run recaps. It takes no arguments and works in the TUI only, notifying `Recap settings are only available in the TUI.` in other modes when a UI is present. It loads the current config and opens `ui.select("Recap", …)` with two items.

- `Change model…` runs `openModelPicker`, then `openReasoningPicker`, then `saveSummaryConfig`, and notifies `Summary model: <provider>/<model> · <reasoning>`. A dismiss at any step returns without a change, and a failed save notifies `Could not save the private summary model config.`
- `Disable recaps` and `Enable recaps` flip `config.enabled`, save, and notify `Recaps disabled.` or `Recaps enabled.`. Disabling also calls `onUserActivity()`, which cancels the armed timer and aborts in-flight recaps. A failed save notifies `Could not save the private summary config.`

`openModelPicker` offers `curatedModels(ctx.modelRegistry.getAvailable(), ctx.cwd)`, the same scope `/subagent-model` uses, cheapest first. A label reads `provider/model` and adds ` · $X/Mtok out` when the model reports an output cost. An empty list notifies `No configured models are available for run recaps.` and returns undefined. `openReasoningPicker` renders a `ThinkingSelectorComponent` limited to `getSupportedThinkingLevels(model)` and preselects the current level when the model supports it.

### Events

| Event | Handler |
| --- | --- |
| `session_start` | Sets `sessionActive = ctx.mode === "tui"`, records `statusContext`, cancels any timer, clears the run boundary. |
| `input` | Calls `onUserActivity()` when `event.source === "interactive"`. |
| `user_bash` | Calls `onUserActivity()`. |
| `before_agent_start` | TUI only: `onUserActivity()`, then `runBoundary.begin(ctx.sessionManager.getLeafId())`. |
| `agent_settled` | TUI, active session, pending run: `scheduleRecap(ctx)`. |
| `session_shutdown` | Async. Marks the session inactive, cancels the timer, clears the boundary, unsubscribes from activity changes, aborts in-flight recaps, waits up to 1 s, clears the `summaries` status. |

### Entry renderer

`registerEntryRenderer("summary-recap", (entry, { expanded }, theme) => renderRecap(entry.data, expanded, theme))`. `renderRecap` takes `RecapEntryData`, which is `RunRecap` (`recap`, `next`) plus the config fields `provider`, `model`, `reasoning`, and an optional `fallback`.

### Config and environment

- `~/.pi/agent/summaries/config.private.json` (mode `0o600`, gitignored) holds `{ "enabled", "provider", "model", "reasoning" }`, with defaults `enabled: true`, `deepseek` / `deepseek-flash` / `medium`. `parseSummaryConfig` falls back to `DEFAULT_SUMMARY_CONFIG` on any missing or invalid field, with one exception: a missing `enabled` means true, because configs written before the toggle predate the field. A mistyped `enabled` still falls back to the full defaults. Provider and model are trimmed.
- `REASONING_LEVELS` is `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
- `PI_SUMMARY_IDLE_MS` overrides the quiet delay. A value below 30,000 ms is clamped up, and an invalid value falls back to 180,000 ms.
- `saveSummaryConfig` writes atomically through `writeJsonAtomic` (temp file plus rename) with a 5 second timeout, and accepts an abort signal.
- The config used to live inside the extension directory, which broke on a clean package install. That file is ignored now, and a user re-selects the model once with `/recap`.

### Internal exports

- `src/config.ts`: `REASONING_LEVELS`, `ReasoningLevel`, `SummaryConfig`, `DEFAULT_SUMMARY_CONFIG`, `DEFAULT_IDLE_DELAY_MS`, `MIN_IDLE_DELAY_MS`, `idleDelayMs()`, `PRIVATE_CONFIG_PATH()`, `parseSummaryConfig()`, `loadSummaryConfig()`, `saveSummaryConfig()`. `PRIVATE_CONFIG_PATH` is a function resolved at call time from `getAgentDir()`, not a module-load constant, so tests point it at a temp dir with `PI_CODING_AGENT_DIR`.
- `src/summarizer.ts`: `RunRecap`, `parseRecapResponse()`, `reasoningOptions()`, `summarizeRun()`.
- `src/prompt.ts`: `SUMMARY_SYSTEM_PROMPT`, `buildSummaryPrompt(transcript)`.
- `src/ui.ts`: `RecapEntryData`, `renderRecap()`, `openModelPicker()`, `openReasoningPicker()`.

## Examples

1. After any settled run, a recap card appears once the session goes quiet, for example `Updated config and ran focused tests.` with `Next: Review the diff.` Press ctrl+o to see which model wrote it.
2. To change the recap model, run `/recap`, pick `Change model…`, pick a provider and model from the list, pick a reasoning level, and confirm the notification `Summary model: openrouter/anthropic/claude-sonnet-4 · high`.
3. To pause the feature, run `/recap` and pick `Disable recaps`. Recaps resume from the same run boundary, so the first recap after re-enabling covers everything that accumulated. `config.private.json` can be edited by hand too, and an invalid value falls back to the defaults.
4. For faster recaps during interactive work, start pi with `PI_SUMMARY_IDLE_MS=30000`, so the recap lands 30 seconds after a run settles instead of 3 minutes.
5. To debug a missing recap, check the `summaries` footer status during generation, the warning notification when the model failed, and the deferral conditions. Pending user input, pending messages, or a running child agent each defer a recap, and a run with no entries after the baseline is cleared without one.
