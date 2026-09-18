# @tylerho/pi-worktree

Lets the agent create, enter, and exit isolated git worktrees for parallel work in one repo.

## Install

`pi install npm:@tylerho/pi-worktree`

---

# Worktree

A port of Claude Code's worktree tooling: `enter_worktree` and `exit_worktree` let the main agent create an isolated git worktree, switch the session into it, and return — the same tools the CC binary ships (v2.1.229), re-designed around pi's mechanics. Worktrees are the mechanism for parallel work in one repo: create a worktree per feature, then spawn a subagent per worktree (`subagent_spawn` with `working_dir` set to the worktree path) so several agents build concurrently without colliding.

## Key concepts

- **Virtual cwd, not a real chdir.** pi bakes each built-in tool's cwd at creation (`createXToolDefinition(cwd)`), and a session's cwd never moves. So "entering" a worktree is implemented as **cwd-aware proxies over the built-ins** — the documented tool-override pattern. On `session_start` the extension re-registers `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls` as wrappers that delegate to freshly-created built-in definitions for the *effective* cwd: the active worktree while one is set, the session cwd otherwise. Per-cwd instances are cached in Maps. Render calls (`renderCall`/`renderResult`) forward with the effective cwd rewritten into `ToolRenderContext.cwd`, so edit-diff previews and path display agree with where execution actually happens. The session header's cwd, session storage, and footer path stay untouched.
- **State is a file, scoped to the session.** The active session lives at `~/.pi/agent/worktree-state.json` (`WorktreeStateStore`), keyed by the session's own `sessionId`. On `session_start`, state whose `sessionId` matches the current session is restored: that session re-enters the worktree and a notify explains how to leave. If the recorded worktree no longer exists, the binding is cleared and the session continues in the current directory (CC's `worktree-gone` behavior). A fresh or different session — even in the same repo — never inherits the worktree; it starts in the default working tree. `/worktree reset` clears desynced state without touching the worktree.
- **Liveness locks.** Each worktree gets a lock file (`worktree-locks/<sha256>.json` with pid + sessionId). Locks are pid-liveness checked (`process.kill(pid, 0)`): a dead session's lock is stale and auto-released; a live foreign pid blocks reuse of that worktree. Removing a worktree you entered pre-existing is refused (non-owner rule).
- **Where worktrees live.** Default root `<repo>/.pi/worktrees/<slug>` (CC's `.claude/worktrees/` analog), overridable via `~/.pi/agent/worktree.json` → `worktreeRoot` (absolute, or relative to the repo root). When the root is inside the repo, the pattern is appended to `.git/info/exclude` (repo-local, never committed) so worktrees don't pollute `git status`.
- **Branching.** New worktrees branch from `origin/<default-branch>` when `baseRef: "fresh"` (the default — a clean tree without unpushed commits), from the local `HEAD` when `"head"`. Branches are named `pi-worktrees/<slug>` and deleted with the worktree on remove.
- **Name reuse is deliberate.** Re-entering an existing name checks the branch: fully merged into the upstream → the worktree is reset to the current base (`Reused`); otherwise resumed as-is with a warning it may carry an earlier session's commits (`Resumed`). A stray directory that is not a registered worktree is refused.
- **Children are walled off.** `enter_worktree`/`exit_worktree` are in `CHILD_EXCLUDED_TOOL_NAMES` (`shared/child-session.ts`) — a headless child mutating the parent session's cwd state would be CC's "subagent with a cwd override" bug, so children never receive the tools. The parent creates worktrees and points children at them via `working_dir`; the proxies only apply to the session that entered (matched by `ctx.cwd`), so a child always operates on its own cwd.
- **Errors are refusals.** Guard failures throw `WorktreeSessionError` with CC-modeled messages the agent is expected to read and act on (dirty-remove confirmation, non-owner remove, already-in-worktree, not-a-repo). The no-active-session case is an explicit no-op refusal, never a silent success.

## API

### Tools (registered for the parent LLM)

| Tool | Parameters | Behavior |
|---|---|---|
| `enter_worktree` | `name?` (slug; `/`-separated segments of `[A-Za-z0-9._-]`, ≤64 chars; random `adjective-noun` if omitted), `path?` (existing registered worktree of this repo; mutually exclusive with `name`) | Guards: not-a-git-repo, name+path together, already-in-worktree (unless `path`), unknown/registered-only paths, live foreign lock, stray directory. `path` outside the managed root requires interactive confirmation (`ctx.ui.confirm`, hasUI-gated). Returns `{ worktreePath, worktreeBranch, message }` with `Created/Reused/Resumed/Entered` wording; sets footer status `🌳 <slug>` via `ctx.ui.setStatus("worktree", …)`. |
| `exit_worktree` | `action`: `"keep"` \| `"remove"` (`StringEnum`), `discard_changes?` (required `true` when removing with uncommitted files or commits ahead of the entry base) | No active state → no-op refusal. `remove` + entered pre-existing → non-owner refusal. `remove` + dirty without `discard_changes` → refusal listing `N uncommitted files` / `M commits`. `keep` clears state + lock, work preserved. `remove` runs `git worktree remove --force` + `branch -D`, reports discarded counts; failure to remove keeps the worktree and says so. Missing `originalCwd` is noted, not fatal. |

### Commands

| Command | Description | Behavior |
|---|---|---|
| `/worktree` | "Show or reset the active worktree session" | No args → status notify (worktree path, branch, original cwd) or "Not in a worktree session." `reset` → confirms (hasUI-gated), releases the lock, clears state file and footer status; the worktree and branch stay on disk. |

### Events

- `session_start` — re-registers the seven cwd-aware proxies for this session's cwd; restores persisted state whose `sessionId` matches the current session (refreshes the lock pid, notifies), or clears the binding when the recorded worktree no longer exists; sets/clears the footer status.
- `session_shutdown` (reason `quit`) — CC's `WorktreeExitDialog`: keep/remove the worktree the exiting session is bound to. An owned worktree that is clean (0 uncommitted files, 0 commits ahead of its base) is removed automatically; anything dirty is kept unless the user chooses removal. The TUI prompt is a time-boxed Keep/Remove `select` (5s), so an interactive quit — where pi has already torn down the TUI before `session_shutdown` — degrades to `keep` rather than hanging exit or destroying work. The binding is cleared on exit either way, so it never leaks to a future session.

### Exported helpers (importable from the extension's modules)

- `index.ts`: default export `(pi: ExtensionAPI) => void` — registers tools, proxies, command.
- `core.ts`:
  - `enterWorktree(deps: WorktreeDeps, input: EnterWorktreeInput): Promise<EnterWorktreeResult>` — `WorktreeDeps { sessionCwd, sessionId, stateDir, config?, confirmEnterPath? }`; `EnterWorktreeInput { name?, path? }`; result carries the full `ActiveWorktree` state + message. Throws `WorktreeSessionError`.
  - `exitWorktree(deps, input: ExitWorktreeInput): Promise<ExitWorktreeResult>` — `ExitWorktreeInput { action, discard_changes? }`; result carries `originalCwd`, counts, message. Throws `WorktreeSessionError`.
  - `worktreeChanges(worktreePath, baseCommit): Promise<{ changedFiles, commits } | null>`.
  - `chooseExitAction(counts: WorktreeChangeCounts | null, enteredExisting: boolean): "keep" | "remove"` — CC's auto-exit decision: an owned clean worktree (0 uncommitted files, 0 commits ahead of base) is removed; anything else (dirty, unverifiable, non-owner) is kept. Used by the `session_shutdown` handler and unit-tested directly.
  - `class WorktreeSessionError extends Error`.
- `state.ts`: `interface ActiveWorktree` (worktreePath, branch, baseCommit, originalCwd, sessionCwd, enteredExisting, sessionId, pid, createdAt), `class WorktreeStateStore` (`load`, `save`, `clear`, `readLock`/`writeLock`/`releaseLock`, `isLockLive`), `pidAlive(pid)`.
- `git.ts`: `git(cwd, ...args)` (throws `GitError`), `tryGit` (null instead of throwing), `isGitRepo`, `getRepoRoot`, `getDefaultBranch`, `resolveBase`, `listWorktrees` (porcelain parser), `isMergedIntoUpstream`, `hasUncommittedChanges`, `commitsAheadOfBase`, `validateSlug`, `randomWorktreeName`, `branchNameFor`, `samePath`, `isInside`, `ensureInfoExclude`.
- `config.ts`: `interface WorktreeConfig { baseRef: "fresh" | "head", worktreeRoot? }`, `loadConfig(stateDir)`, `resolveWorktreeRoot(repoRoot, config)`.

### Config

`~/.pi/agent/worktree.json` (optional; malformed or missing → defaults):

```json
{
  "baseRef": "fresh",
  "worktreeRoot": ".pi/worktrees"
}
```

## Examples

1. **Parallel features** — `enter_worktree { name: "feature-a" }` → `{ worktreePath: "/repo/.pi/worktrees/feature-a", worktreeBranch: "pi-worktrees/feature-a", … }`. Then `subagent_spawn { prompt: "Build feature A here…", name: "a", harness: "pi", working_dir: "<worktreePath>" }` for each feature; the parent never enters at all if it only orchestrates.
2. **Work in isolation yourself** — `enter_worktree { name: "refactor-x" }`; `edit`/`bash` now run in the worktree (footer shows `🌳 refactor-x`); `exit_worktree { action: "keep" }` to go back, or `{ action: "remove", discard_changes: true }` after confirming with the user to clean up.
3. **Resume after a restart** — pi restarts mid-worktree: the state file restores the entry, a notify explains, `/worktree` shows status, `/worktree reset` clears a stale state without deleting anything.
