# @tylerho/pi-expanded-footer

Replaces the default footer with a Claude Code-style layout: model, context usage, cost, branch, worktree.

## Install

`pi install npm:@tylerho/pi-expanded-footer`

---

# Expanded Footer

Replaces pi's default statusline footer with a Claude Code-style layout: model · effort | context usage | cost on line 1, path · branch · worktree | token stats on line 2, and extension statuses on line 3. It exists so the session state Tyler actually watches — model, cache countdown, context %, cumulative token/cost, current git branch and worktree — is visible at a glance, with Claude's color scheme instead of pi's defaults.

## Key concepts

- **One `setFooter` per session.** On `session_start` the extension captures `ctx` once and calls `ctx.ui.setFooter(...)` with a render closure. The closure reads `ctx.sessionManager.getEntries()` and `ctx.getContextUsage()` fresh on every render, so the footer reflects the live session. The `dispose()` returned by the closure clears the branch-change subscription and the 1-second ticker.
- **Re-renders are event + timer driven.** `footerData.onBranchChange(() => tui.requestRender())` re-renders when the git branch changes; a 1s `setInterval` re-renders so the cache countdown ticks. Both are torn down in `dispose()`.
- **Usage is aggregated across the whole session.** The render walks `sessionManager.getEntries()` and sums `usage` from assistant messages (input/output/cacheRead/cacheWrite/cost), toolResult messages (cost only), and `branch_summary`/`compaction` entries (all counters). Cache hit rate is computed from the *latest* assistant message: `cacheRead / (input + cacheRead + cacheWrite)`.
- **Context display mirrors Claude's.** `{tokens}tokens [{percent}%]`, colored success/warning/error at 34%/67% thresholds. Windows >200k render `[{percent}% {window} | {pct200k}% 200k]`. Falls back to `? tokens [?]` when the percent is unknown; `contextWindow` falls back to `ctx.model?.contextWindow ?? 200_000`.
- **Extension statuses ride the footer API.** Other extensions call `ctx.ui.setStatus(key, text)`; the footer reads them via `footerData.getExtensionStatuses()`. The `subagents` key is special-cased onto its own rail directly under line 1 (running/done counts visible at a glance); every other key is sorted alphabetically, whitespace-sanitized, and joined onto line 3. This is why any extension status shows up in the footer without this extension knowing about it.
- **Module-level state survives sessions.** `currentThinkingLevel`, `cacheTimerEnabled`, `cacheConfig`, and the ticker handle are module-scope, so they persist across `/new`/`/resume` but reset on `/reload`. `currentThinkingLevel` starts at `"off"` and is overwritten by the `thinking_level_select` event; it only renders when the active model has `reasoning`.
- **Git worktree detection** shells out to `git rev-parse --git-dir` (2s timeout, silent failure) and matches `/worktrees/<name>` to show `· wt:<name>` on line 2.
- **Width safety everywhere.** Lines are built then trimmed with `truncateToWidth`/`visibleWidth` from pi-tui; line 2 keeps the right-side stats and, when the path doesn't fit, middle-truncates the path (`head…tail`) so the `· branch` and `· wt:<name>` suffixes stay visible. It drops the worktree suffix first, then shrinks the branch, before falling back to tail truncation.

## API

### Command

| Command | Purpose |
|---|---|
| `/cache-timer` | Toggles the cache countdown shown at the left of the token stats. No args. Flips module-level `cacheTimerEnabled`, notifies via `ctx.ui.notify("Cache timer enabled|disabled", "info")`. |

### Events

| Event | Handler | Why it matters |
|---|---|---|
| `thinking_level_select` | Stores `event.level` in module-level `currentThinkingLevel`. | Keeps the `· <effort>` tag on line 1 in sync with the actual thinking level; only shown when the model has `reasoning`. |
| `session_start` | Captures `ctx`, detects the worktree, loads cache config, installs the `setFooter` render closure. | The footer is per-session; without this the closure would hold a stale `ctx`. |

### Footer data surface (read from `footerData` in the render closure)

- `onBranchChange(cb)` — subscribe to git branch changes; `tui.requestRender()` is called from it.
- `getGitBranch()` — branch name for line 2 (yellow).
- `getExtensionStatuses()` — map of `ctx.ui.setStatus()` keys → text; `subagents` gets its own rail, the rest form line 3.

### Config file

- `~/.pi/agent/cache-timer.json` (or `$PI_CODING_AGENT_DIR/cache-timer.json`) — optional TTL overrides read by `loadConfig()`:
  ```json
  { "defaultTtlMs": 300000, "providers": { "deepseek": 14400000, "google": 3600000 } }
  ```
  `providers` entries override the built-in per-provider TTL table entirely; `defaultTtlMs` is the fallback for unknown providers. The TTL tables themselves live in `lib/cache-timer.ts` (anthropic 5m/1h-long, openai 24h, gpt-5.6+ 30m, deepseek/groq 2h, google 1h, bedrock 5m/1h-long, openrouter derived from upstream slug).

### Exports

- `export default function (pi: ExtensionAPI)` — the only export; standard extension entry point. No named exports, no tools, no shortcuts.

## Examples

1. **Model shows thinking effort** — with a reasoning model active, line 1 renders like `claude-sonnet-5 · high | 12.3k tokens [6.2%] | $0.041`; effort comes from `thinking_level_select` events and is omitted for non-reasoning models.
2. **Large-context window display** — on a 1M-token window at 30%: `gpt-5.6 · high | 300k tokens [30.0% 1M | 150% 200k] | $0.132` (percent of the 1M window plus the equivalent percent of 200k).
3. **Cache timer inline stats** — line 2 right side shows `cache 4m/5m ↑1.2k ↓305 R4.3k W1.1k CH79.6%` (timer → tokens → cache read/write → hit rate, all dim). With DeepSeek active the TTL renders as `2h`; after the window passes it flips to `cache expired`; switching models shows `cache invalidated`.
4. **Extension statuses** — after `ctx.ui.setStatus("prompt-stash", "📋 Draft saved")` from prompt-stash and a running subagent batch, the footer is: line 1 (model/ctx), a `subagents` rail under it (`2 running · 1 done`), line 2 (path/branch/stats), line 3 (`📋 Draft saved`).
5. **Disable the timer** — `/cache-timer` removes the `cache …` token from line 2 and notifies "Cache timer disabled"; the rest of the footer is unaffected.
