# @tylerho/pi-worktree

Lets the agent create, enter, and exit isolated git worktrees for parallel work in one repo.

## Install

`pi install npm:@tylerho/pi-worktree`

---

# Worktree

A port of Claude Code 2.1.229's worktree tooling. `enter_worktree` creates an isolated git worktree and switches the session into it, and `exit_worktree` returns the session to its original directory with the choice to keep or delete the worktree. Worktrees are how several agents work in one repository at once: create one worktree per feature, then point each subagent at its own with `subagent_spawn` and `working_dir`.

## Claude Code lineage

The tool names, prompt text, refusal messages and exit behavior come from Claude Code's worktree tooling as shipped in the 2.1.229 CLI. Version 2.1.229 is the release the current port text was pulled from. The port landed in `57d43c6` (2026-08-13). Three commits followed: `2a86bf1` (2026-08-18) re-rooted the repository under `~/.pi` and only moved paths, `673d551` (2026-08-22) switched the store to the shared state-file helper, and `10a35ed` (2026-09-08) keyed state by session and added the keep/remove prompt on quit. None names a different Claude Code release, so the port stays at 2.1.229.

Claude Code behavior that carries over:

- On quit, an owned worktree that is clean is removed without asking, and anything else defaults to keep. Claude Code calls this the `WorktreeExitDialog`.
- A recorded worktree that no longer exists clears the binding and the session continues in the current directory. This is Claude Code's `worktree-gone` behavior.
- A worktree the session entered instead of created is not the session's to remove.
- Names follow Claude Code's slug rule: `/`-separated segments of letters, digits, dots, underscores and dashes, at most 64 characters.
- The managed root `<repo>/.pi/worktrees` parallels Claude Code's `.claude/worktrees/`.

The pi implementation departs from Claude Code where the two runtimes differ:

- pi has no real chdir. A session's cwd is fixed, and each built-in tool bakes its cwd at creation, so entering a worktree is a set of cwd-aware proxies over the built-ins rather than a directory change.
- The keep/remove prompt at exit is time-boxed to 5 seconds. On an interactive quit pi tears down the TUI before `session_shutdown`, so the prompt may never resolve, and the timeout defaults to keep.
- Active state lives in `~/.pi/agent/worktree-state.json` keyed by session id, alongside per-worktree lock files.

## How it works

The session keeps its original cwd. pi bakes each built-in tool's cwd at creation (`createXToolDefinition(cwd)`), and a session's cwd never moves. On `session_start` the extension re-registers `bash`, `read`, `write`, `edit`, `grep`, `find` and `ls` as proxies that delegate to freshly created built-in definitions for the effective cwd: the active worktree while one is set, the session cwd otherwise. Per-cwd instances are cached in Maps. The proxies forward `renderCall` and `renderResult` with the effective cwd written into `ToolRenderContext.cwd`, so edit-diff previews and displayed paths match where execution happens. The session header cwd, session storage and footer path stay untouched.

A proxy applies only when the caller's cwd matches the cwd recorded on the active state. A child session with its own cwd therefore sees no change.

State is a file, and it is scoped to the session. `WorktreeStateStore` keeps the active worktree at `~/.pi/agent/worktree-state.json`, keyed by the session's own id. On `session_start`, state whose `sessionId` matches the current session restores the entry, refreshes the lock pid and notifies how to leave. If the recorded worktree no longer exists, the binding is cleared and the session continues in the current directory. A different session in the same repo never inherits the worktree. `/worktree reset` clears desynced state without touching the worktree.

Liveness locks guard against reuse. Each worktree gets a lock file at `worktree-locks/<sha256 of the path, first 32 hex characters>.json` holding the pid, session id, timestamp and worktree path. `process.kill(pid, 0)` checks liveness. A lock from a dead process is stale and auto-released, and a live foreign pid blocks reuse of a named worktree. Entering an existing worktree by `path` only clears a stale lock.

New worktrees go under `<repo>/.pi/worktrees/<slug>` by default, overridable through `worktreeRoot` in `~/.pi/agent/worktree.json`. A relative root resolves against the repo root. When the root sits inside the repo, `ensureInfoExclude` appends the pattern to `.git/info/exclude`, which is repo-local and never committed. The append is skipped when `.git` is a file, as in a linked worktree. The base ref comes from `baseRef`: `"fresh"` (the default) branches from `origin/<default-branch>` and falls back to `HEAD` when the remote ref is missing, so a new worktree starts clean of unpushed commits, while `"head"` branches from the local `HEAD`. Branches are named `pi-worktrees/<slug>` and deleted with the worktree on remove.

Name reuse checks the branch. Re-entering a name that exists tests whether its branch is an ancestor of `origin/<default-branch>`. If it is, the old worktree and branch are removed and a new one is created from the current base (`Reused`). If it is not, the worktree is resumed as-is with a warning that it may carry an earlier session's commits (`Resumed`). A directory under the managed root that is not a registered worktree is refused.

Children never receive the tools. `enter_worktree` and `exit_worktree` are in `CHILD_EXCLUDED_TOOL_NAMES` in `shared/child-session.ts`, so a headless child cannot move the parent session's cwd. The parent creates worktrees and points children at them with `working_dir`.

Errors are refusals. Guard failures throw `WorktreeSessionError` with messages the agent is expected to read and act on: not a git repository, `name` and `path` together, already in a worktree, an unknown or unregistered path, a live foreign lock on a named worktree, a stray directory, a dirty remove without `discard_changes`, and a remove attempted on a worktree the session entered. With no active session, `exit_worktree` refuses with an explicit no-op message rather than reporting success.

On quit, `session_shutdown` decides the fate of the worktree the exiting session is bound to. An owned worktree with 0 uncommitted files and 0 commits ahead of its base is removed. Anything dirty is kept unless the user chooses removal in a Keep/Remove `select` that times out after 5 seconds. A worktree whose change counts cannot be read is kept without prompting. The binding clears when the exit succeeds, so it never leaks to a future session.

## API

### Tools

| Tool | Parameters | Behavior |
|---|---|---|
| `enter_worktree` | `name?` (slug, random `adjective-noun` when omitted), `path?` (an existing registered worktree of this repo, mutually exclusive with `name`) | Guards: not a git repo, `name` and `path` together, already in a worktree unless `path` is given, unknown or unregistered path, a live foreign lock on a named worktree, stray directory. A `path` outside the managed root needs interactive confirmation through `ctx.ui.confirm`, gated on `hasUI`. Returns a message worded `Created`, `Reused`, `Resumed` or `Entered` and `details: { worktreePath, worktreeBranch }`. Sets the footer status to `🌳 <slug>` through `ctx.ui.setStatus("worktree", ...)`. |
| `exit_worktree` | `action`: `"keep"` or `"remove"` (`StringEnum`), `discard_changes?` (required `true` when removing with uncommitted files or commits ahead of the entry base) | No active state is a no-op refusal. `remove` on a worktree the session entered is refused. `remove` while dirty without `discard_changes` is refused with the counts of uncommitted files and commits. `keep` clears state and lock, and the work is preserved. `remove` runs `git worktree remove --force` and `git branch -D`, then reports the discarded counts. A failed git removal is reported with the manual `git worktree remove --force` command. A missing `originalCwd` is noted in the message, not fatal. Returns `details: { action, worktreePath, worktreeBranch }`. |

When the change count cannot be read, `exit_worktree` refuses before it checks `discard_changes`, so an unverifiable worktree cannot be removed through the tool.

### Command

| Command | Description | Behavior |
|---|---|---|
| `/worktree` | "Show or reset the active worktree session" | No args prints the worktree path, branch and original cwd, or "Not in a worktree session." `reset` confirms through `ctx.ui.confirm` when `hasUI` is set, releases the lock, and clears the state file and footer status. The worktree and branch stay on disk. |

### Events

- `session_start` re-registers the seven cwd-aware proxies for this session's cwd. It restores persisted state whose `sessionId` matches the current session and refreshes the lock pid, or clears the binding when the recorded worktree no longer exists. It sets or clears the footer status.
- `session_shutdown` with reason `quit` applies the keep/remove decision described above to the worktree the exiting session is bound to.

### Exported helpers

- `index.ts` default export `(pi: ExtensionAPI) => void`, which registers the tools, the proxies and the command.
- `core.ts`:
  - `enterWorktree(deps: WorktreeDeps, input: EnterWorktreeInput): Promise<EnterWorktreeResult>`, where `WorktreeDeps` is `{ sessionCwd, sessionId, stateDir, config?, confirmEnterPath? }` and `EnterWorktreeInput` is `{ name?, path? }`. The result carries the full `ActiveWorktree` state and the message. Throws `WorktreeSessionError`.
  - `exitWorktree(deps, input: ExitWorktreeInput): Promise<ExitWorktreeResult>`, where `ExitWorktreeInput` is `{ action, discard_changes? }`. The result carries `originalCwd`, `worktreePath`, `worktreeBranch`, `discardedFiles`, `discardedCommits` and the message. Throws `WorktreeSessionError`.
  - `worktreeChanges(worktreePath, baseCommit): Promise<WorktreeChangeCounts | null>`, where `WorktreeChangeCounts` is `{ changedFiles, commits }`.
  - `chooseExitAction(counts: WorktreeChangeCounts | null, enteredExisting: boolean): "keep" | "remove"`, the exit decision used by the `session_shutdown` handler and unit-tested directly.
  - `class WorktreeSessionError extends Error`.
- `prompt.ts` holds the model-facing text: `ENTER_WORKTREE_TOOL_DESCRIPTION`, `ENTER_WORKTREE_PROMPT_SNIPPET`, `ENTER_WORKTREE_PROMPT_GUIDELINES`, `ENTER_NAME_PARAM_DESCRIPTION`, `ENTER_PATH_PARAM_DESCRIPTION`, `EXIT_WORKTREE_TOOL_DESCRIPTION`, `EXIT_WORKTREE_PROMPT_SNIPPET`, `EXIT_WORKTREE_PROMPT_GUIDELINES`, `EXIT_ACTION_PARAM_DESCRIPTION`, `EXIT_DISCARD_PARAM_DESCRIPTION`.
- `state.ts`: `interface ActiveWorktree` (`worktreePath`, `branch`, `baseCommit`, `originalCwd`, `sessionCwd`, `enteredExisting`, `sessionId`, `pid`, `createdAt`), `interface WorktreeLock`, `class WorktreeStateStore` (`load`, `save`, `clear`, `lockPathFor`, `readLock`, `writeLock`, `releaseLock`, `isLockLive`), `pidAlive(pid)`.
- `git.ts`: `errorText`, `class GitError`, `git(cwd, ...args)` (throws `GitError`), `tryGit` (returns null instead of throwing), `isGitRepo`, `getRepoRoot`, `getDefaultBranch`, `resolveBase`, `interface WorktreeInfo`, `listWorktrees` (porcelain parser), `isMergedIntoUpstream`, `hasUncommittedChanges`, `commitsAheadOfBase`, `validateSlug`, `randomWorktreeName`, `branchNameFor`, `samePath`, `isInside`, `ensureInfoExclude`.
- `config.ts`: `interface WorktreeConfig { baseRef: "fresh" | "head", worktreeRoot? }`, `DEFAULT_WORKTREE_ROOT`, `loadConfig(stateDir)`, `resolveWorktreeRoot(repoRoot, config)`.

### Config

`~/.pi/agent/worktree.json` is optional. A missing or malformed file falls back to the defaults, and unknown fields are ignored.

```json
{
  "baseRef": "fresh",
  "worktreeRoot": ".pi/worktrees"
}
```

`baseRef` accepts `"fresh"` or `"head"` and defaults to `"fresh"`. `worktreeRoot` defaults to `.pi/worktrees`.

## Examples

1. Parallel features. `enter_worktree { name: "feature-a" }` returns a message naming `/repo/.pi/worktrees/feature-a` on branch `pi-worktrees/feature-a`. Then spawn one subagent per feature with `subagent_spawn { description: "feature a", prompt: "...", name: "a", working_dir: "<worktreePath>" }`. A parent that only orchestrates never enters a worktree itself.
2. Work in isolation. After `enter_worktree { name: "refactor-x" }`, `edit` and `bash` run in the worktree and the footer shows `🌳 refactor-x`. `exit_worktree { action: "keep" }` returns to the original directory with the work on disk, and `exit_worktree { action: "remove", discard_changes: true }` deletes the worktree and branch after the user confirms.
3. Resume after a restart. If pi restarts while a worktree is active, `session_start` restores the entry for that same session and notifies. `/worktree` shows the status, and `/worktree reset` clears stale state without deleting anything.
