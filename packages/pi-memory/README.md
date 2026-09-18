# @tylerho/pi-memory

Claude Code-style persistent file-based memory, with per-turn recall and idle-triggered consolidation dreams.

## Install

`pi install npm:@tylerho/pi-memory`

---

# Memory

Claude Code 2.1.220's persistent file-based memory, ported to pi. Memories are markdown files in a per-working-directory folder, indexed by `MEMORY.md`, which loads into the system prompt every session. The extension registers no model-facing tools. The agent reads and writes memories with `read`, `write` and `edit`, taught by a prompt injected at `before_agent_start`.

## Claude Code lineage

`src/prompt.ts` holds both prompt variants verbatim from the 2.1.220 bundle, apart from three adaptations the source marks with `PI:` comments. Pi names its tools lowercase, so "the Write tool" reads "the write tool". The AGENTS.md exclusion replaces CLAUDE.md. Claude Code follows its persistence heading with bullets steering the model toward Plan mode and a task list, and those bullets are dropped while the principle they serve stays.

Version 2.1.220 is the release the current port text came from. The baseline commit `a236070` (2026-08-01) already carried that version string in `src/prompt.ts`, and no later commit changed the prompt constants.

Other modules cite the same release: the selector system prompt and prefetch orchestration (`src/selector.ts`, `src/recall.ts`), the injected memory header, staleness note and `<system-reminder>` wrapper (`src/injection.ts`), index truncation (`src/index-file.ts`), the per-model variant gate (`src/variant.ts`), and the dream prompt and its gates (`src/dream/prompt.ts`, `src/dream/gate.ts`).

Three divergences in the recall path are deliberate. Claude Code constrains the selector reply with a provider-side JSON schema, and pi requests the JSON in the prompt and parses it defensively because many providers lack that schema support. Claude Code emits one internal message per surfaced memory, and pi delivers one injected user message holding the same blocks. Claude Code hardcodes Sonnet as the selector, and pi makes the recall model configuration.

The dream prompt marks seven adaptations. It reads pre-serialized transcripts instead of running a raw JSONL grep, has no `logs/` activity stream, reconciles against AGENTS.md, omits the team-memory tier, uses lowercase tool names, runs a tidy-only pass when no sessions are found, and tightens the index-line demote trigger to roughly 150 characters so it matches the target the prompt states.

## How it works

The memory directory is `<agentDir>/memory/<projectSlug(cwd)>/`. `projectSlug` matches the encoding pi already uses for its `sessions/` directories, so memory sits beside the sessions it was written in. `PI_MEMORY_DIR` replaces the whole path, which is how the tests and sandboxes point memory elsewhere, and `memoryDir` always returns a trailing separator so the prompt reads it as a directory. The extension creates the directory on session start and before `/memory` opens, so the injected prompt can say the directory already exists.

`MEMORY.md` is the only file always in context. It is read once per `session_start` and `session_compact` into `indexSection` and held stable for the rest of the session. `truncateIndex` caps the index at 200 lines or 25,000 characters, whichever limit trips first, cuts at the last newline inside the budget, and appends a `> WARNING:` block naming the overage. An absent or empty index injects a short section saying the index is empty. A manual `/memory` save and a finished dream do not refresh the snapshot, because changing the system prompt mid-session invalidates the cached prefix. Fresh content reaches the model through per-turn recall and the `read` tool.

`resolveVariant` reproduces Claude Code's per-model choice. `auto` serves the verbose `full` prompt, which carries the four memory types with worked examples, the exclusion list, the save procedure and the recall rules, to every model that does not carry Claude Code's `lean_prompt` capability. The lean list is `claude-opus-4-8`, `claude-opus-5`, `claude-fable-5` and `claude-mythos-5`, plus any `-eap` id, so a session on one of those gets `terse` and every other model gets `full`. Matching is by substring on a lowercased id where dots and underscores fold to dashes, so a provider prefix does not matter. `promptVariant` pins the choice to `full` or `terse`.

Recall is a per-turn relevance prefetch. When `recall.enabled` is true, `before_agent_start` blocks the turn on a one-shot selector call. `listMemoryCandidates` walks the memory directory recursively, keeps `.md` files other than the index, sorts them newest first and caps the list at 200. It parses frontmatter only (`name`, `description`, and `type` at the top level or nested under `metadata:`) and passes no body text to the selector. `selectMemories` sends the candidate lines and the user query to the recall model and asks for at most five filenames. `runRecall` then reads the chosen bodies. The selector runs with a 512 token cap, `maxRetries` 1, an 8 second timeout, reasoning off by default, and a prompt-requested `{"selected_memories": [...]}` reply that `parseSelectedFilenames` reads defensively. Any failure, including a missing model or key, a timeout or an unparseable reply, returns nothing and the turn proceeds.

The selected bodies become one user message holding one `<system-reminder>` block per memory. The first block carries a preamble asking the model to use a memory only if it applies. A memory older than one day gets a note saying how old it is, that memories are point-in-time observations, and that the reader should verify against current code, followed by a `Memory: <path>:` header. The `RecallLedger` marks the injected paths and totals their bytes against a 60,000 byte session budget. It rebuilds itself from the session transcript at every `session_start`, so a resume, reload or fork does not re-inject what the session already saw, and it resets on compaction, where the conversation is rebuilt. A query that is a single token with no spaces is skipped, and CJK text is exempt from that rule because it has no spaces. The footer shows `✦ recalled N memories`, and the transcript shows a collapsed `memory-recall` row that expands to the exact text the model received.

Memory writes get their own transcript row. `tool_result` stashes `write` and `edit` calls whose resolved path lands inside the memory directory, and `message_end` appends a `memory-write` entry once the tool result is not an error. The row reads `✦ memory saved: <name>` for a write, `✦ memory updated: <name>` for an edit, and `✦ memory index updated` for `MEMORY.md`. Ctrl+o adds the full path.

A dream is a background consolidation pass in a child session built with `SessionManager.inMemory()`, so it never writes a session file that its own scan would later count. `/dream` starts one on demand. When `dream.enabled` is true, `agent_settled` arms a timer for `idleDelayMs`, and an interactive input, a `user_bash` call or a new run cancels it. User activity never aborts a dream already in flight, because a half-written merge would be left without its replacement. Only a shutdown or a cap trip stops it, and a status line reports `✦ dreaming… (turn N/M)`.

The child runs the ported "Dream: Memory Consolidation" prompt. It walks four phases (orient, gather, consolidate, prune and reindex) and then reconciles feedback and project memories against AGENTS.md. Its tools are `read` plus confined replacements for `bash`, `write` and `edit`. A write or edit must resolve strictly inside the memory directory. Bash runs with the memory directory as its working directory and accepts read-only commands (`ls cat head tail wc grep rg diff stat pwd echo nl cut tr comm sort uniq`), a `rm -f <file>.md` inside the memory directory, and pipes whose every stage is itself read-only. Backticks, `;`, `&&`, `||`, `>`, `<`, `&` and `$()` are rejected outright. The runner passes an explicit `tools` allowlist rather than `noTools`, because `noTools: "all"` would empty the allowlist and drop the custom confined tools with it. Every call is wrapped in `runWithToolCallTimeout` at 30 minutes. `DREAM_TOOL_CONSTRAINTS` states the same rules to the model, and a test asserts that the prompt list and the handler list agree.

`evaluateGates` runs eight gates in order: the interactive TUI, memory enabled, not paused, `dream.enabled`, at least `minHours` (24) since the last consolidation, more than 10 minutes since the last scan in this process, at least `minSessions` (5) main sessions touched since then, and lock acquisition. `/dream` bypasses gates 4 through 7 and still respects the TUI, enabled, paused and lock gates. The lock is `.consolidate-lock` in the memory directory, the same filename Claude Code uses. Its mtime is the last consolidated timestamp and its contents are the owning PID, so an existing Claude Code memory directory keeps its timestamp. A lock older than one hour is stale. After writing its PID the process reads the file back, which resolves the race where two processes take over the same stale lock. A `failed` dream rolls the lock back so a config fix can retry, while `aborted` and `completed` keep it so a half-finished dream consumes the window instead of retrying its spend. The caps are `maxTurns` 30 and `maxCostUsd` 5.

`sessionsTouchedSince` scans `<agentDir>/sessions/<projectSlug(cwd)>/` for transcripts newer than the last consolidation. It reads the first 8 KB of each file to find the header id, the start time and any `session_info` entry named `subagent: …` or `btw: …`. Only main sessions count toward gate 7. Subagent transcripts are serialized so facts discovered there are not lost, and btw sessions are excluded from the pipeline entirely because a side-question answer duplicates the main conversation. `serializeSessions` spends `transcriptBudgetBytes` (96,000) on main sessions first and newest first, then fills the remaining budget with subagent sessions. Every block passes through `redactSecrets` before the dream reads it, because an unredacted credential would become a permanent memory.

Every dream attempt appends one JSON line to `dreams.jsonl` in the memory directory with its trigger, status, reason, model, duration, turns, cost, tokens, touched files and summary. Gated attempts are logged as `skipped` with the gate reason. The dream cannot delete the log, because its `rm` accepts only `.md` operands, and a failed log write never interrupts the dream. A fired dream also appends a `dream-outcome` entry. Collapsed, it reads `✦ Dream consolidated N memory files` with the cost and token count, and the aborted variant starts with `Dream stopped early`. Ctrl+o adds the dream's own summary. A failed dream uses a warning notification instead, so errors stay visible, and a manual `/dream` that was gated reports the reason.

`/pause-memory` flips a per-session flag using Claude Code's notice wording. While paused, `before_agent_start` injects neither the prompt nor a recall message, and `agent_settled` does not arm the dream timer. The flag resets at `session_start`.

## API

No `registerTool`. Model-facing behavior comes from the injected prompt and the recall message. Everything else is commands, events and renderers.

### Commands

| Command | Purpose |
|---|---|
| `/memory` | Picks a memory file in a `ctx.ui.select` (index first, then alphabetical) and opens it in an `ExtensionEditorComponent`. Ctrl+G hands off to the `externalEditor` setting, then `$VISUAL`, then `$EDITOR`, then nano. Cancel returns undefined, unchanged content is not written, and the saved file gains a trailing newline. TUI only. |
| `/dream` | Runs a consolidation now. TUI only, and notifies `A dream is already running.` when one is in flight. Bypasses the automatic toggle, the time window, the scan throttle and the session count (gates 4 to 7), and still takes the lock. Notifies the gate reason when nothing runs. |
| `/dream-log` | Opens the dream run pane. TUI only. The pane is a bottom-anchored full-width overlay docked above the footer (`anchor: "bottom-center"`, width `100%`, max height 60%, bottom margin 3, inner viewport 45% of the terminal rows). It re-reads `dreams.jsonl` on open and on `r`. Up, down, page up and page down scroll, enter expands an entry, and escape or `q` closes. Entries are colored by status, and an expanded entry lists the model and the created, edited and removed files. |
| `/dream-auto` | Toggles `memory.dream.enabled` in the global `settings.json`, preserving every other key through a temp-file write and rename. Warns when a project-level `memory.dream.enabled` overrides the global value. |
| `/pause-memory` | Toggles the per-session paused flag. |

### Events

- `session_start` resets `paused`, clears pending memory writes, cancels the dream timer, sets the dream status context, rebuilds the ledger from the session transcript, and snapshots the index when memory is enabled.
- `session_compact` resets the ledger and re-snapshots the index.
- `tool_result` stashes `write` and `edit` calls that land inside the memory directory, keyed by tool call id.
- `message_end` appends the `memory-write` entry for a stashed tool result, skipping errors.
- `before_agent_start` cancels the idle dream timer, then returns the joined system prompt and, when recall is enabled, the recall message. It returns nothing when memory is paused or disabled.
- `agent_settled` arms the idle dream timer in the TUI when memory and automatic dreaming are enabled.
- `input` from an interactive source and `user_bash` cancel the pending dream timer.
- `session_shutdown` cancels the timer, aborts an in-flight dream and waits up to 2,000 ms (`DREAM_SHUTDOWN_WAIT_MS`) for it, then clears the status line.

### Renderers

- `registerEntryRenderer("memory-write")` renders the memory write row and adds the full path when expanded.
- `registerMessageRenderer("memory-recall")` renders the recall row and expands to the injected text.
- `registerEntryRenderer("dream-outcome")` renders the fired dream headline and expands to the dream's summary.

### Config

`settings.json` under a `memory` key. The global and project scopes are read through `SettingsManager`, the project wins, and nested blocks deep-merge so unset fields keep their defaults.

```jsonc
"memory": {
  "enabled": true,                     // whole system on or off
  "promptVariant": "auto",             // "auto" | "full" | "terse"
  "recall": {
    "enabled": true,
    "provider": "deepseek",            // must resolve in the model registry
    "model": "deepseek-flash",
    "reasoning": "off"                 // pi thinking levels
  },
  "dream": {
    "enabled": false,                  // automatic dreaming is opt-in
    "model": "deepseek/deepseek-v4-pro",
    "effort": "max",                   // shared subagent-models effort scale
    "minHours": 24,                    // gate 5
    "minSessions": 5,                  // gate 7, main sessions only
    "idleDelayMs": 300000,             // idle timer
    "maxTurns": 30,
    "maxCostUsd": 5,
    "transcriptBudgetBytes": 96000     // session excerpt budget
  }
}
```

### Environment variables

- `PI_MEMORY_DIR` replaces the memory directory and keeps a trailing separator.
- `PI_DISABLE_AUTO_MEMORY` forces `enabled: false` for any of `1`, `true`, `yes`, `on`, and wins over the settings file. It mirrors Claude Code's `CLAUDE_CODE_DISABLE_AUTO_MEMORY`.

### Notable module exports

Internals that tests import directly.

- `src/paths.ts`: `projectSlug`, `memoryDir`, `memoryIndexPath`.
- `src/prompt.ts`: `MEMORY_INDEX_FILENAME`, `INDEX_MAX_LINES` (200), `INDEX_MAX_CHARS` (25_000), `buildFullMemoryPrompt`, `buildTerseMemoryPrompt`.
- `src/index-file.ts`: `truncateIndex`, `readIndex`, `formatIndexSection`.
- `src/variant.ts`: `resolveVariant`, `claudeCodeClassification`, `wantsVerbosePrompt`.
- `src/settings.ts`: `loadMemorySettings`, `parseMemorySettings`, `DEFAULT_MEMORY_SETTINGS`, `DEFAULT_RECALL_SETTINGS`, `REASONING_LEVELS`.
- `src/candidates.ts`: `listMemoryCandidates`, `parseFrontmatter`, `formatCandidateLine`, `packageCandidates`, `MAX_CANDIDATES` (200).
- `src/selector.ts`: `selectMemories`, `parseSelectedFilenames`, `buildSelectorPrompt`, `SELECTOR_SYSTEM_PROMPT`, `MAX_SELECTED` (5).
- `src/recall-model.ts`: `createSelectorComplete`.
- `src/recall.ts`: `runRecall`, `MAX_SESSION_BYTES` (60_000), `hasSelectableQuery`.
- `src/recall-ledger.ts`: `RecallLedger`, `RECALL_MESSAGE_TYPE` (`memory-recall`), `recalledPathsFromEntry`.
- `src/injection.ts`: `formatRecalledMemories`, `memoryHeader`, `stalenessNote`, `ageInDays`, `wrapSystemReminder`, `RECALL_PREAMBLE`.
- `src/dream/index.ts`: `maybeDream`, `runDreamNow`.
- `src/dream/gate.ts`: `evaluateGates`, `SCAN_THROTTLE_MS`.
- `src/dream/run.ts`: `runDream`.
- `src/dream/tools.ts`: `buildDreamTools`, `confineToolDefinition`, `isAllowedDreamCommand`, `isInsideMemoryDir`, `READ_ONLY_COMMANDS`.
- `src/dream/lock.ts`: `acquireLock`, `rollbackLock`, `readLastConsolidatedAt`, `LOCK_FILENAME`, `LOCK_STALE_MS`.
- `src/dream/sessions.ts`: `sessionsTouchedSince`, `serializeSessions`.
- `src/dream/prompt.ts`: `buildDreamPrompt`, `DREAM_TOOL_CONSTRAINTS`.
- `src/dream/log.ts`: `appendDreamLog`, `readDreamLog`, `buildDreamLogEntry`, `DREAM_LOG_FILENAME` (`dreams.jsonl`).
- `src/dream/outcome.ts`: `buildDreamOutcomeData`, `renderDreamOutcome`, `DREAM_OUTCOME_ENTRY` (`dream-outcome`).
- `src/dream/log-pane.ts`: `DreamLogPane`, `showDreamLogPane`.
- `src/dream/settings.ts`: `persistDreamAutoEnabled`, `projectOverridesDreamEnabled`, `parseDreamSettings`, `parseDreamScope`, `DEFAULT_DREAM_SETTINGS`.

## Examples

1. Save a memory. The agent writes `feedback_testing.md` with frontmatter and appends a one-line pointer to `MEMORY.md`. The transcript then shows `✦ memory saved: feedback_testing.md` and `✦ memory index updated`. The updated index reaches the system prompt at the next session start or compaction, while the new body reaches the model through recall or a `read`.
2. Recall on a turn. A question such as "what did we decide about the merge freeze?" sends the candidate list to `deepseek/deepseek-flash` with a 512 token cap. Two matches come back, the footer shows `✦ recalled 2 memories`, and a collapsed row expands to the two `<system-reminder>` blocks. The ledger marks both, so a resume does not inject them again.
3. Consolidate with `/dream`. After several days of work, `/dream` skips the scheduling gates, takes the lock, and runs the confined child on `deepseek/deepseek-v4-pro` at effort max. It appends `✦ Dream consolidated 3 memory files · $0.12 · 48.2k tok.`, ctrl+o shows the summary, and `/dream-log` shows the history. The lock mtime then blocks idle dreams for 24 hours.
4. Pause and configure. `/pause-memory` stops prompt injection and recall for the session and resets at the next session start. `"recall": { "enabled": false }` removes the per-turn selector call, and `"dream": { "enabled": true }` or `/dream-auto` turns on idle dreaming. Idle dreaming is off by default.
