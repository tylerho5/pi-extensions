# @tylerho/pi-memory

Claude Code-style persistent file-based memory, with per-turn recall and idle-triggered consolidation dreams.

## Install

`pi install npm:@tylerho/pi-memory`

---

# Memory (auto-memory system)

Claude Code's persistent file-based memory, ported to pi. One fact per markdown file in a per-working-directory directory (`<agentDir>/memory/<--cwd-slug-->/`), indexed by `MEMORY.md` which is loaded into the system prompt every session. **No new model-facing tools** — the agent reads and writes memory files with the standard `read`/`write`/`edit` tools, taught by a memory prompt injected via `before_agent_start`. The extension's own machinery is invisible plumbing: a per-turn relevance recall (a cheap model picks which memories to inject), an idle-triggered consolidation "dream" that runs a confined child session, a pause toggle, and a dream run log.

## Key concepts

- **Per-cwd memory dir.** `memoryDir(cwd)` = `<agentDir>/memory/<projectSlug(cwd)>/`, where `projectSlug` encodes the cwd exactly like pi's `sessions/` directory names (`--<cwd with / and : → ->--`), so memory sits beside the sessions it was written in. `PI_MEMORY_DIR` overrides the whole directory (used by tests/sandboxes). The dir always carries a trailing separator so the prompt reads it as a directory.
- **The index is loaded, not the files.** `MEMORY.md` (the only file always in context) is snapshotted once per `session_start`/`session_compact` into `indexSection` and kept stable for prompt caching. It is capped at 200 lines / 25,000 chars (`INDEX_MAX_LINES`/`INDEX_MAX_CHARS`); when cut, the model sees a `> WARNING:` block with the overage and the "one line under ~200 chars" reminder. Memory bodies are read on demand by the agent (or by recall).
- **Prompt variant per model.** `resolveVariant` reproduces Claude Code's per-model choice: `auto` serves the verbose `full` prompt (types XML + worked examples) to everything not carrying Claude Code's `lean_prompt` capability — in practice all pi models get `full`; `terse` (short reminder) goes to `claude-opus-4.8/5`, `claude-fable-5`, `claude-mythos-5`, and `-eap` ids. `promptVariant: "full" | "terse"` pins it. The prompt text is a verbatim port of CC 2.1.220 with three marked adaptations (tool names lowercase, CLAUDE.md→AGENTS.md, CC plan-mode bullets dropped).
- **Recall = per-turn relevance prefetch.** On every `before_agent_start`, if `recall.enabled`, the turn is *blocked* on a cheap selector call: `listMemoryCandidates` (recursive `.md` walk, max 200, newest first, frontmatter-only — `name`/`description`/`type` parsed tolerantly, bodies never read at list time) → `selectMemories` (a one-shot completion on `recall.provider`/`recall.model`, default `deepseek/deepseek-v4-flash`, 512 max tokens, 8s timeout, reasoning off) → bodies read → formatted into one message of `<system-reminder>` blocks (first carries the "Retrieved for possible relevance" preamble; memories >1 day old get a staleness caveat; each starts with `Memory: <path>:`) and delivered as a single user message. Fail-open: any selector failure (missing model/key, timeout, bad reply) surfaces nothing and the turn proceeds.
- **Recall dedupe survives restarts.** `RecallLedger` marks injected paths and counts bytes (60 KB session budget, `MAX_SESSION_BYTES`); a single bare-token query is skipped (`hasSelectableQuery`, CJK exempt). The ledger is **rebuilt from the session transcript** at every `session_start` (resume/reload/fork don't rebuild the conversation, so surfaced memories stay marked) and reset only on `session_compact`, where the conversation is rebuilt. Recall rows are transcript messages of custom type `memory-recall`, rendered collapsed as one muted "✦ recalled N memories: …" line, expanded to the exact reminder text the model saw.
- **Dream = background consolidation.** A confined child session (`SessionManager.inMemory()`, so it never writes a session file that would count itself in gate 7) runs the ported "Dream: Memory Consolidation" prompt (4 phases: orient, gather from serialized session excerpts, consolidate, prune+index; reconcile against AGENTS.md). Triggered by `/dream` (manual) or idle: `agent_settled` arms a timer (`dream.idleDelayMs`, default 300 s) that `input`/`user_bash`/`before_agent_start` cancel; an in-flight dream is **never aborted by user activity** — only by shutdown or a cap — so a half-written merge is never left without its replacement.
- **Dream confinement.** The child gets only `read` + `bash`/`write`/`edit` replaced by confined versions (`buildDreamTools`): writes/edits must resolve inside the memory dir; bash runs with cwd = memory dir and is limited to a read-only command allowlist (`ls cat head tail wc grep rg diff stat pwd echo nl cut tr comm sort uniq`) plus `rm -f <file>.md` inside the memory dir; pipes are allowed only between read-only stages; `` ` ; < > & $() || `` are rejected outright. Each tool call is wrapped in `runWithToolCallTimeout` (30 min). The prompt's `DREAM_TOOL_CONSTRAINTS` block states exactly this, and the tests assert prompt and handler agree.
- **Dream gates & lock.** `evaluateGates` runs 8 gates in order: (1) TUI only, (2) memory enabled, (3) not paused, (4) `dream.enabled` (auto only), (5) ≥ `minHours` (24) since last consolidation, (6) last scan > 10 min ago (per-process throttle), (7) ≥ `minSessions` (5) main sessions touched since then (excluding the current), (8) lock acquired. `/dream` bypasses 4–7 but respects 1–3 and 8. The lock is `.consolidate-lock` in the memory dir (filename matches Claude Code): **mtime = last-consolidated timestamp, contents = owning PID**; stale after 1 h, PID readback resolves takeover races. `failed` rolls the lock back (a config fix lets the next idle dream retry); `aborted` (cap trip, cancel) and `completed` keep it, so a half-dream consumes the window rather than retry-looping its spend. Caps: `maxTurns` 30, `maxCostUsd` $5.
- **Dream sources.** `sessionsTouchedSince` scans `<agentDir>/sessions/<cwd-slug>/<flat-iso>_<uuid>.jsonl`, classifying main vs subagent/`btw` runs by scanning the first 8 KB for a `session_info` entry named `subagent: …`/`btw: …` (btw session files keep that entry before the inherited parent context so it always lands in range). Only mains count toward gate 7; subagent transcripts ride along in serialization so their facts aren't lost. **btw sessions are excluded from the pipeline entirely** — never counted, never serialized: a side-question answer is user-facing output, and its file duplicates the main conversation. `serializeSessions` budgets `transcriptBudgetBytes` (96 KB): mains first (newest), then subagents fill the remainder; every block passes through `redactSecrets` before the dream sees it — an unredacted credential would become a permanent memory.
- **Everything is logged.** Every dream attempt — fired or gated — appends one JSON line to `dreams.jsonl` in the memory dir (status, trigger, reason, model, duration, turns, cost, tokens, files touched, summary). The dream's own `rm` can't delete it (`.md` operands only) and nothing tells the dream to edit it. `/dream-log` renders it.

## API

No `registerTool`, no `registerShortcut`. Model-facing behavior comes entirely from the injected prompt + recall message; everything else is commands, events, and renderers.

### Commands

| Command | Purpose |
|---|---|
| `/memory` | Pick a memory file from a `ctx.ui.select` (index first, then alphabetical) and edit it in an `ExtensionEditorComponent` (Ctrl+G hands off to the `externalEditor` setting → `$VISUAL` → `$EDITOR` → nano). Undefined when cancelled; unchanged content is not written; `indexSection` reloaded after save. TUI only. |
| `/dream` | Run a consolidation now. TUI only; notifies "A dream is already running" if one is in flight. Bypasses the auto-toggle, time window, scan throttle, and session count (gates 4–7), still takes the lock. Appends a `dream-outcome` entry — collapsed headline with cost + tokens, the dream's summary behind ctrl+o — or the reason when gated. |
| `/dream-log` | Open the persistent dream run log pane (TUI only). Right-anchored overlay (`anchor: "right-center"`, width 60%, min 72, max 90% height); re-reads `dreams.jsonl` on open and on `r`; ↑↓/pgup/pgdn scroll, enter expands an entry (model, duration, touched files, wrapped summary), esc/q close. |
| `/dream-auto` | Toggle `memory.dream.enabled` in the **global** settings.json, preserving all other keys (temp-file + rename write; read errors surface rather than risk a silent wipe). Warns when a project-level `memory.dream.enabled` overrides the global value. `/dream` manual always works regardless. |
| `/pause-memory` | Toggle the per-session `paused` flag with Claude Code's own notice wording. While paused, `before_agent_start` skips both prompt injection and recall, and the idle dream is never armed. |

### Events

- `session_start` — reset `paused`, clear pending memory-write stashes, cancel the dream timer, set the dream status context, rebuild the `RecallLedger` from the session transcript (empty for a fresh session, marks everything for a resumed one), then snapshot the index if memory is enabled.
- `session_compact` — `recallLedger.reset()` (the conversation is rebuilt here) and re-snapshot the index so anything saved this session lands in the prompt.
- `tool_result` — stash `write`/`edit` calls whose resolved path is inside the memory dir, keyed by `toolCallId`.
- `message_end` — for a `toolResult` message with a stashed path: append a `memory-write` transcript entry (`"saved"` / `"updated"` / `"index updated"` for MEMORY.md). This is the "a memory changed" row that lands directly under the tool row.
- `before_agent_start` — the core hook: cancel the idle dream timer (user is active); if not paused and enabled, join `[existing prompt, memory prompt (variant-selected), indexSection]`; if recall enabled, run `recall()` and attach the `<system-reminder>` message (`customType: "memory-recall"`). Returns `{ systemPrompt, message }`. The status line shows "✦ recalled N memories" (`RECALL_STATUS_KEY = "memory"`).
- `agent_settled` — arm the idle dream timer (TUI only, not paused, `dream.enabled`) for `idleDelayMs`, `.unref()`'d.
- `input` / `user_bash` — cancel the pending dream timer (never the in-flight dream).
- `session_shutdown` — cancel the timer; if a dream is running, `abort()` it and wait up to 2 s (`DREAM_SHUTDOWN_WAIT_MS`); clear the dream status line.

### Renderers

- `registerEntryRenderer("memory-write")` — collapsed: `✦ memory saved: <name>.md` / `✦ memory index updated`; expanded adds the full path.
- `registerMessageRenderer("memory-recall")` — collapsed: `✦ recalled N memories: <names>`; expanded shows the exact `<system-reminder>` content the model received, so what the user sees and what the model saw never diverge.
- `registerEntryRenderer("dream-outcome")` — the fired-dream result row. Collapsed: `✦ Dream consolidated 3 memory files · $0.03 · 53k tok.` (or the `Dream stopped early —` variant); expanded adds the dream's own summary. Failed dreams still use a warning notification — errors stay visible. The summary once rode along in a notification verbatim; the entry hides it until ctrl+o and survives resume as a one-liner.

### Config (`settings.json`, `"memory"` key)

Read via `SettingsManager` global + project scopes (project wins), deep-merged so unset fields keep defaults. `PI_DISABLE_AUTO_MEMORY` (mirrors `CLAUDE_CODE_DISABLE_AUTO_MEMORY`) forces `enabled: false` and wins over both.

```jsonc
"memory": {
  "enabled": true,                     // whole system on/off (default true)
  "promptVariant": "auto",             // "auto" | "full" | "terse"
  "recall": {
    "enabled": true,
    "provider": "deepseek",            // selector model, must be in the registry
    "model": "deepseek-v4-flash",
    "reasoning": "off"                 // pi thinking levels: off|minimal|low|medium|high|xhigh|max
  },
  "dream": {
    "enabled": false,                  // auto-dreaming is opt-in; /dream bypasses
    "model": "deepseek/deepseek-v4-pro",
    "effort": "max",                   // shared subagent-models Effort scale
    "minHours": 24,                    // gate 5
    "minSessions": 5,                  // gate 7 (main sessions)
    "idleDelayMs": 300_000,            // idle timer
    "maxTurns": 30,                    // per-dream cap
    "maxCostUsd": 5,
    "transcriptBudgetBytes": 96_000    // serialized session excerpt budget
  }
}
```

### Environment variables

- `PI_MEMORY_DIR` — override the memory directory wholesale (trailing separator ensured).
- `PI_DISABLE_AUTO_MEMORY` — force `enabled: false` ("1"/"true"/"yes"/"on").

### Notable module exports (internals, tested directly)

`src/paths.ts`: `projectSlug`, `memoryDir`, `memoryIndexPath`. `src/prompt.ts`: `MEMORY_INDEX_FILENAME`, `INDEX_MAX_LINES` (200), `INDEX_MAX_CHARS` (25_000), `buildFullMemoryPrompt`, `buildTerseMemoryPrompt`. `src/index-file.ts`: `truncateIndex`, `readIndex`, `formatIndexSection`. `src/variant.ts`: `resolveVariant`, `claudeCodeClassification`, `wantsVerbosePrompt`. `src/settings.ts`: `loadMemorySettings`, `parseMemorySettings`, `DEFAULT_MEMORY_SETTINGS`, `REASONING_LEVELS`. `src/candidates.ts`: `listMemoryCandidates`, `parseFrontmatter`, `formatCandidateLine`, `packageCandidates`, `MAX_CANDIDATES` (200). `src/selector.ts`: `selectMemories`, `parseSelectedFilenames`, `SELECTOR_SYSTEM_PROMPT`, `MAX_SELECTED` (5). `src/recall-model.ts`: `createSelectorComplete`. `src/recall.ts`: `runRecall`, `MAX_SESSION_BYTES` (60_000), `hasSelectableQuery`. `src/recall-ledger.ts`: `RecallLedger`, `RECALL_MESSAGE_TYPE` ("memory-recall"). `src/injection.ts`: `formatRecalledMemories`, `stalenessNote`, `RECALL_PREAMBLE`. `src/dream/index.ts`: `maybeDream`, `runDreamNow`. `src/dream/gate.ts`: `evaluateGates`, `SCAN_THROTTLE_MS`. `src/dream/run.ts`: `runDream`. `src/dream/tools.ts`: `buildDreamTools`, `isAllowedDreamCommand`, `isInsideMemoryDir`, `READ_ONLY_COMMANDS`. `src/dream/lock.ts`: `acquireLock`, `rollbackLock`, `readLastConsolidatedAt`, `LOCK_FILENAME`, `LOCK_STALE_MS`. `src/dream/sessions.ts`: `sessionsTouchedSince`, `serializeSessions`. `src/dream/prompt.ts`: `buildDreamPrompt`, `DREAM_TOOL_CONSTRAINTS`. `src/dream/log.ts`: `appendDreamLog`, `readDreamLog`, `buildDreamLogEntry`, `DREAM_LOG_FILENAME` ("dreams.jsonl"). `src/dream/outcome.ts`: `buildDreamOutcomeData`, `renderDreamOutcome`, `DREAM_OUTCOME_ENTRY` ("dream-outcome"). `src/dream/log-pane.ts`: `DreamLogPane`, `showDreamLogPane`. `src/dream/settings.ts`: `persistDreamAutoEnabled`, `projectOverridesDreamEnabled`, `parseDreamSettings`, `DEFAULT_DREAM_SETTINGS`.

## Examples

1. **Save a memory** — the agent writes `feedback_x.md` with frontmatter and appends `- [x](feedback_x.md) — hook` to `MEMORY.md`. After each write/edit inside the memory dir, the transcript shows a `✦ memory saved: feedback_x.md` row under the tool row; after the MEMORY.md edit, `✦ memory index updated`. On the next turn the updated index section is already in the system prompt.
2. **Recall fires on a turn** — user asks "what did I decide about the merge freeze?" The turn blocks briefly on the selector (`deepseek/deepseek-v4-flash`, 512 tokens); a status line `✦ recalled 2 memories` appears, and two `<system-reminder>` blocks (preamble, staleness note if >1 day old, `Memory: <path>:` header, body) arrive as the first user message. The ledger marks them, so after a reload/`fork` they are not re-injected; a compaction resets it.
3. **Consolidate with `/dream`** — after a week of sessions, run `/dream`: it skips gates 4–7 but takes the lock, spawns the confined child (`deepseek/deepseek-v4-pro`, effort max), reads redacted session excerpts (mains first), and appends `✦ Dream consolidated 3 memory files · $0.12 · 48.2k tok.` — ctrl+o reveals the dream's summary inline; `/dream-log` shows the full history (statuses, reasons, costs); the lock's mtime now blocks idle dreams for 24 h.
4. **Pause & configure** — `/pause-memory` stops prompt injection and recall for the session (its notice says so). `settings.json` under `"memory"` toggles everything persistently: `"dream": { "enabled": true }` opts into idle dreaming (or `/dream-auto`), `"recall": { "enabled": false }` kills the per-turn selector call, and a project-level `"memory"` block overrides the global one.
