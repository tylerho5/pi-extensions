# @tylerho/pi-expanded-footer

Replaces the default footer with a Claude Code-style layout: model, context usage, cost, branch, worktree.

## Install

`pi install npm:@tylerho/pi-expanded-footer`

---

# Expanded footer

Expanded footer replaces pi's built-in footer with a Claude Code-shaped one: model, thinking effort, context use and cost on line 1, path, branch, worktree and session token stats on line 2, and extension statuses on their own lines. It reads live session state on every frame, so the counts it shows come from `sessionManager.getEntries()`, `getContextUsage()` and the footer data provider rather than from anything it stores.

## Claude Code lineage

The footer is a layout port, not a text port. The line order, the `model · effort | context | cost` arrangement, and the context format (`12.3k tokens [6.2%]`, and `[30.0% 1.0M | 150% 200k]` above a 200k window) follow Claude Code's status line. The header comment records Claude Code's ANSI colors for each field (`\033[36m` model, `\033[35m` path, `\033[33m` branch, `\033[94m` worktree) and maps them onto pi theme colors instead of reusing them. The file was named `claude-style-footer.ts` until the rename on 2026-08-12. No Claude Code version appears in the source, the commit messages, or the earlier docs, and the extension predates the repository baseline, so the release the layout came from is not recorded.

## How it works

On `session_start` the extension captures the context once, detects the worktree, reloads the cache timer config, and calls `ctx.ui.setFooter` with a factory. The factory returns an object with `render(width)`, `dispose()` and a no-op `invalidate()`. Inside the factory, `footerData.onBranchChange(() => tui.requestRender())` re-renders when the git branch changes, and a one-second `setInterval` re-renders so the cache countdown ticks. `dispose()` unsubscribes and clears the interval. The ticker handle is module scope, so a new session clears the previous interval before installing its own.

Each render walks `sessionManager.getEntries()` and sums usage. Assistant messages contribute `input`, `output`, `cacheRead`, `cacheWrite` and `cost.total`. Tool result messages contribute `cost.total` only. `branch_summary` and `compaction` entries contribute all four counters and cost. The cache hit rate comes from the last assistant message in the list: `cacheRead / (input + cacheRead + cacheWrite)`.

Line 1 starts with `ctx.model?.id || "no-model"` in accent. The effort tag comes from the module-level `currentThinkingLevel`, which the `thinking_level_select` event overwrites and which starts at `"off"`. It renders as `· <level>` in dim only when the active model reports `reasoning` and the level is not `"off"`.

Context follows on line 1, from `getContextUsage()`. The window resolves to `contextUsage.contextWindow`, then `ctx.model.contextWindow`, then 200000. The token count is computed from the percentage as `round(percent / 100 * contextWindow)` rather than read from `ContextUsage.tokens`, so the figure is an estimate that matches the percentage. The field is green below 34, warning from 34 up to but not including 67, and error at 67 and above. A window larger than 200k renders `[30.0% 1.0M | 150% 200k]`, where the second figure is `round(percent * window / 200000)`. When the percentage is null, which happens right after compaction before the next response, the field renders `? tokens [?]` in dim. Cost comes last on line 1, only when the session cost is nonzero: `$0.041`. When `childCostTotal()` is above 0.0005 USD, the term ` +$0.123 agents` follows the main figure inside that same block, so child spend alone shows no cost term.

Line 2 starts with `ctx.cwd`, with the `$HOME` or `$USERPROFILE` prefix replaced by `~`, colored as `customMessageLabel`. The branch from `footerData.getGitBranch()` follows in warning color, then the worktree tag `· wt:<name>` in `syntaxVariable`. `detectWorktree` runs `git rev-parse --git-dir` in the session directory with a two-second timeout, swallows failures, and matches the trailing `/worktrees/<name>` that a linked worktree reports. The right side of line 2 holds the token stats in dim: the cache countdown token from `cacheStatText(...)`, then `↑input`, `↓output`, `R` and `W` with the cache-read and cache-write token counts, and `CH` with the hit rate. Each token appears only when its value is nonzero, and the hit rate appears only when the session has cache traffic.

Both content lines fit themselves to the terminal width. Line 1 truncates from the right with a dim ellipsis. Line 2 keeps the right-side stats and gives the path the remaining columns. When the path and its suffix do not fit, `fitPath` gives up detail in this order:

1. Middle truncate the path to `head…tail`, keeping the branch and worktree suffixes.
2. Middle truncate the path and drop the `· wt:<name>` suffix.
3. Show the path as an eight-column stub and middle truncate the branch.
4. Truncate the path from the right.

When the stats line is empty, the path takes the full width.

After line 1, the footer appends the `subagents` status as its own line when that key is set, then line 2, then every other status key joined on one final line. The other keys are sorted alphabetically and each text is stripped of line breaks and repeated spaces. The footer therefore renders two to four lines. No extension in the tree sets the `subagents` key today, so that rail is dormant. The keys in use are `prompt-stash`, `summaries`, `workflows`, `worktree`, `memory` and `dream`.

`currentThinkingLevel`, `cacheTimerEnabled`, `cacheConfig` and the ticker handle live at module scope. They survive `/new` and `/resume` in one process and reset on `/reload`. `cache-timer.json` is read on each `session_start`, so an edit takes effect on the next session or reload.

## API

### Command

| Command | Description | Behavior |
|---|---|---|
| `/cache-timer` | `Toggle the cache countdown timer in the footer` | No arguments. Flips module-level `cacheTimerEnabled` (default `true`) and calls `ctx.ui.notify` with `Cache timer enabled` or `Cache timer disabled`, level `info`. |

### Events

| Event | Handler |
|---|---|
| `thinking_level_select` | Stores `event.level` in `currentThinkingLevel`, which only affects the effort tag. |
| `session_start` | Resets child cost when `event.reason` is `"new"` or `"startup"`, detects the worktree, calls `loadConfig()`, and installs the footer factory with the captured context. |

### Footer factory

`ctx.ui.setFooter(factory)` takes a factory that receives `(tui, theme, footerData)` and returns:

| Member | Purpose |
|---|---|
| `render(width: number): string[]` | Builds the lines. |
| `dispose(): void` | Unsubscribes from branch changes and clears the ticker. |
| `invalidate(): void` | No-op. |

`footerData` is pi's read-only footer data provider:

| Method | Returns |
|---|---|
| `getGitBranch()` | `string \| null` |
| `getExtensionStatuses()` | `ReadonlyMap<string, string>` |
| `onBranchChange(callback)` | Unsubscribe function. |

### Config

`~/.pi/agent/cache-timer.json`, or `$PI_CODING_AGENT_DIR/cache-timer.json` when that variable is set:

```json
{ "defaultTtlMs": 300000, "providers": { "deepseek": 14400000, "google": 3600000 } }
```

Values are in milliseconds. A `providers` entry overrides every built-in TTL for that provider. `defaultTtlMs` is the fallback for a provider with no table entry. `PI_CACHE_RETENTION=long` moves supported providers to their extended TTL. A missing or malformed file yields an empty config. The tables and the resolution order are in [lib.md](lib.md).

### Exports

`export default function (pi: ExtensionAPI)` is the only export. The extension registers no tools and no shortcuts.

## Examples

1. Effort tag: a reasoning model at high effort renders `claude-sonnet-5 · high | 12k tokens [6.2%] | $0.041`. A non-reasoning model leaves the tag off.
2. Large window: a 1M window at 30 percent renders `gpt-5.6 · high | 300k tokens [30.0% 1.0M | 150% 200k] | $0.132`.
3. Child spend: after a subagent batch costs 0.123 USD, the cost term reads `$0.041 +$0.123 agents`.
4. Token stats: line 2 ends with `cache 4m/5m ↑1.2k ↓305 R4.3k W1.1k CH79.6%`. A DeepSeek session renders the TTL as `2h`, a lapsed window renders `cache expired`, and a model switch renders `cache invalidated`.
5. Status lines: with the `prompt-stash`, `summaries` and `worktree` keys set, the last line reads `stashed: <preview> ✦ summarizing run… 🌳 <slug>`. A set `subagents` key would instead occupy its own line between line 1 and line 2.
6. Cache timer off: `/cache-timer` removes the `cache …` token from line 2 and notifies `Cache timer disabled`. Line 1 and the status lines are unchanged.
