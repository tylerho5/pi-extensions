# @tylerho/pi-git-info

On-demand /lg diff browser and /pr lookup for the current branch's local changes and open pull request.

## Install

`pi install npm:@tylerho/pi-git-info`

---

# Git info

Two on-demand git helpers for the interactive TUI. `/lg` opens a two-pane overlay for browsing local changes, with per-file addition and deletion counts and the diff for the selected file, and `/pr` reports the open pull request for the current branch. Both run only when invoked, because branch and worktree state already appear in the session footer, so nothing here polls.

## How it works

The extension holds one `ManagedRuntime` from `createRuntime()`, which is `CommandRunnerLive` with `NodeServices.layer` provided. The runtime is allocated on first use, shared by both commands, and disposed on `session_shutdown`. Every git and gh call runs as an Effect program through it.

`CommandRunner` in `src/process.ts` is the command layer. It is an Effect `Context.Service` that wraps `ChildProcessSpawner` from `effect/unstable/process`, and it turns every outcome into a `CommandResult` so no caller handles a thrown exception:

- A timeout returns `{ code: -1, stderr, stdout }` through `Effect.timeoutOrElse`. The child process gets `forceKillAfter: "5 seconds"`.
- A spawn or platform failure returns `code: 1` with the message prefixed as `Failed to run <command>: <message>`.
- Any other outcome carries the real exit code.
- Stdout and stderr stream from pipes. Each stream is capped at 10 MiB, and output past the cap ends with `\n[command output truncated]\n`.

Paths and diff text come from the repository, so `sanitizeTerminalText` strips OSC, CSI and escape sequences and stray control characters before the overlay applies theme styling. The same function cleans the display name and path on each file entry.

`/lg` loads through `loadChangedFiles`. It runs `git rev-parse --show-toplevel` first, and a nonzero exit means the directory is not a repository. Inside a repository it runs two commands in parallel: `git status --porcelain=v1 -z --untracked-files=all`, parsed as NUL-separated records where rename and copy records consume the following old path and entries are deduplicated by new path, and `git rev-parse --verify HEAD`, which reports whether a commit exists. A nonzero exit from the status command also returns null. Each changed path then gets two parallel `git diff` calls with a 10 second timeout: `--unified=3 --no-color --no-ext-diff` for the diff text and `--numstat` for the counts. An untracked file, or any file in a repository with no HEAD commit, diffs against `/dev/null` with `--no-index`. A numstat count of `-` becomes null and the file renders as `binary`. Diffs are capped at 20,000 lines with a truncation line, and an empty diff renders as `No textual diff available.`

`showChangedFiles` draws the overlay with `ctx.ui.custom`: anchored center, 95% width, up to 90% height, at least 60 columns. The body is `max(8, floor(terminal rows * 0.8) - 2)` lines tall. The files pane holds between 24 and 48 columns and gives each file a name row and a path row, so the pane scrolls by whole files, wraps at either end, and keeps the selected one in view. The diff pane fills the rest. Focus has two modes, `files` and `diff`, and the selected file's row takes `selectedBg` while the files pane has focus and `customMessageBg` while the diff pane does. In the files pane, `j`/`k` and the arrow keys move, `g`/`G` and home/end jump, `enter`, `space`, `l` or right opens the diff, and `esc` closes the overlay. In the diff pane, `j`/`k` and the arrow keys scroll by 5 lines, `ctrl-d`/`ctrl-u` page by half the body, `g`/`G` and home/end jump to an end, and `esc`, `h` or left returns to the files pane. Diff lines take a color from the active theme by line type: `+` success, `-` error, `@@` mdHeading, `---` and `+++` muted, `diff --git` and `index` accent and bold, the truncation line warning. `showChangedFiles` returns without drawing when the session is not in TUI mode.

`/pr` resolves through `lookupPullRequest`. `git rev-parse --is-inside-work-tree` must exit 0 and print `true`. `git branch --show-current` gives the branch name, and an empty name reports the branch as `detached HEAD`. Then `gh pr view <branch> --json number,url,state,isDraft` runs with a 10 second timeout. `parsePullRequest` accepts the result only when `number` is a number, `url` is a string, and `state` is `OPEN`, and it sets `isDraft` only when the field is exactly `true`. A nonzero gh exit or unparseable JSON means no open PR.

## API

### Commands

| Command | Description | Behavior |
|---|---|---|
| `/lg` | `Browse changed files and their diffs` | Outside the TUI it notifies `The local changes viewer requires the interactive TUI` as a warning. A failed repository check notifies `Not a git repository` as a warning. An empty file list notifies `Working tree is clean` as info. Otherwise it opens the overlay. Takes no arguments. |
| `/pr` | `Show the open pull request for the current branch` | A failed repository check notifies `Not a git repository` as a warning. An open PR notifies `PR #<n> (draft): <url>` as info, with the `(draft)` part present only for a draft. Otherwise it notifies `No open PR found for <branch>` as info. Takes no arguments. |

Both handlers take `(args, ctx)` and pass `ctx.signal` into `runEffect`, so cancellation throws `Loading changed files was cancelled.` or `Pull request lookup was cancelled.`

### Events

`session_shutdown` clears the stored runtime and disposes it, so the next session builds a new one. Disposal releases child process resources that would otherwise outlive the session.

### Exports

- `index.ts` default export `gitInfo(pi: ExtensionAPI)`.
- `src/process.ts` exports `interface CommandResult { code: number; stderr: string; stdout: string }`, `CommandRunner` (an Effect `Context.Service` tagged `git-info/CommandRunner` with `run(command, args, cwd, timeout): Effect<CommandResult>`), `CommandRunnerLive` (the layer that requires `ChildProcessSpawner`), and `runCommand(command, args, cwd, timeout)`.
- `src/runtime.ts` exports `createRuntime()`, `type GitInfoRuntime`, and `runEffect(runtime, effect, { signal?, interruptMessage? })`. `runEffect` returns the value on success, throws `interruptMessage` (default `Operation was aborted.`) when the cause holds only interrupts, and throws the first pretty error message otherwise.
- `src/changed-files-view.ts` exports `loadChangedFiles(cwd): Effect<ChangedFile[] | null>`, where null means the directory is not a repository, `showChangedFiles(ctx, files)`, which returns without drawing outside the TUI, `sanitizeTerminalText(text)`, and `interface ChangedFile { additions: number | null; deletions: number | null; diff: string[]; name: string; path: string }`.

### Constants

`GIT_TIMEOUT_MS` 3,000 for the repository and branch checks and `GH_TIMEOUT_MS` 10,000 for `gh pr view` in `index.ts`. `MAX_STREAM_CHARS` 10 MiB and `TRUNCATED_MARKER` in `src/process.ts`. `DIFF_SCROLL_STEP` 5 and `MAX_DIFF_LINES` 20,000 in `src/changed-files-view.ts`, where each diff and numstat command also uses a 10,000 ms timeout.

It registers no tools and no shortcuts, and reads no config file.

## Examples

1. The user asks "what did I change locally?" and the agent sends `/lg`. The overlay opens on the files pane. `j` and down move through the file list, `enter` opens the highlighted file, and `esc` on the files pane closes the overlay. Each file takes two rows, a name row with `+n -m` (or `binary`) and a path row. The selected file's name row is prefixed with `›`.
2. The user asks "is there a PR for this branch?" and the agent sends `/pr`. The notification reads `PR #42: https://github.com/owner/repo/pull/42`. A draft prints `PR #42 (draft): ...`, and a branch with no open PR prints `No open PR found for feature/x`.
3. Running `/lg` outside a git work tree notifies `Not a git repository`, and running it in a clean repository notifies `Working tree is clean`. Both confirm state without reading the footer.
4. Another extension can call `runEffect(createRuntime(), loadChangedFiles(cwd))` to get the `ChangedFile[]` list, or the null that means no repository, without opening the overlay. `sanitizeTerminalText` is exported for any text that came from a repository.
