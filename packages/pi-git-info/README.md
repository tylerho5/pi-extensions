# @tylerho/pi-git-info

On-demand /lg diff browser and /pr lookup for the current branch's local changes and open pull request.

## Install

`pi install npm:@tylerho/pi-git-info`

---

# Git-info

Two on-demand git helpers for the interactive TUI: `/lg` opens a two-pane overlay for browsing local changes (changed files with +/- stats, per-file diffs), and `/pr` reports the open pull request for the current branch. Both run only when invoked — nothing polls, because branch and worktree state already render in the session footer.

## Key concepts

- **On-demand, lazy runtime.** The extension keeps a single `ManagedRuntime` (created by `createRuntime()`) that is allocated on first use and disposed on `session_shutdown`. All git/gh work runs as Effect programs through it.
- **Effect-based command runner (`src/process.ts`).** `CommandRunner` is an Effect `Context.Service` wrapping `ChildProcessSpawner` from `effect/unstable/process`. Spawn failures, nonzero exits, and timeouts are all normalized into a `CommandResult` — callers never handle thrown exceptions:
  - timeout → `{ code: -1, stderr, stdout }` (via `Effect.timeoutOrElse`; child gets `forceKillAfter: "5 seconds"`)
  - spawn/platform failure → `code: 1`, stderr prefixed with `Failed to run <command>: <message>`
  - real exit code otherwise
  - stdout/stderr are captured from piped streams with a 10 MiB cap; overflow appends `\n[command output truncated]\n`
- **Untrusted text is sanitized before styling.** Repository-controlled paths and diff text can contain terminal control sequences; `sanitizeTerminalText` strips OSC/CSI/escape sequences and stray control chars before any theme styling is applied.
- **`/lg` pipeline (`loadChangedFiles`).** `git rev-parse --show-toplevel` (null result → not a repo) → `git status --porcelain=v1 -z --untracked-files=all` (NUL-separated, rename/copy-aware pairing of old+new paths, deduped by new path) + `git rev-parse --verify HEAD` in parallel. Then, per file, two parallel `git diff` calls (timeout 10 s): `--unified=3 --no-color --no-ext-diff` for the diff and `--numstat` for +/- counts. Untracked files or a repo with no HEAD diff against `/dev/null` via `--no-index` (stats show `binary`/null when numstat reports `-`). Diffs are capped at 20 000 lines with a truncation marker; an empty diff renders as "No textual diff available."
- **`/lg` overlay (`showChangedFiles`).** A `ctx.ui.custom` overlay (anchor center, 95% width, up to 90% height) with a files sidebar + diff pane, two focus modes (`files`/`diff`), vim (j/k/g/G/h/l) and arrow-key bindings, ctrl-d/ctrl-u paging, and diff lines colored by type via the active theme (`+` success, `-` error, `@@` heading, `---`/`+++` muted, diff header accent). TUI-only — non-TUI sessions get a warning toast.
- **`/pr` lookup (`lookupPullRequest`).** `git rev-parse --is-inside-work-tree` → `git branch --show-current` (empty → "detached HEAD", no PR) → `gh pr view <branch> --json number,url,state,isDraft` (10 s timeout). Only `state === "OPEN"` results are reported as PRs; a nonzero gh exit or unparseable JSON means "no open PR."

## API

### Commands (registered via `pi.registerCommand`)

| Command | Description | Behavior |
|---|---|---|
| `/lg` | "Browse changed files and their diffs" | TUI-only (`ctx.ui.notify` warning otherwise). Loads changed files; `null` → "Not a git repository" (warning); empty → "Working tree is clean" (info); otherwise opens the overlay. Takes no args. |
| `/pr` | "Show the open pull request for the current branch" | `null` → "Not a git repository" (warning); open PR → `PR #<n> (draft): <url>` (info, `(draft)` only when `isDraft`); else → `No open PR found for <branch>` (info). Takes no args. |

Both handlers accept `(args, ctx)` and honor `ctx.signal` — cancellation surfaces as "Loading changed files was cancelled." / "Pull request lookup was cancelled." errors.

### Events (`pi.on`)

- `session_shutdown` — disposes the lazily-created `ManagedRuntime` (resets it to undefined so the next session re-creates it). Matters because leaked child-process resources would otherwise outlive the session.

### Exported helpers (importable from the extension or its `src/` modules)

- `index.ts`: `gitInfo(pi: ExtensionAPI)` — the default export registered as the extension.
- `src/process.ts`:
  - `interface CommandResult { code: number; stderr: string; stdout: string }`
  - `CommandRunner` — Effect `Context.Service`; `run(command, args, cwd, timeout): Effect<CommandResult>`
  - `CommandRunnerLive` — the `Layer` (provided `NodeServices.layer`) that implements the service
  - `runCommand(command, args, cwd, timeout): Effect<CommandResult>` — service accessor
- `src/runtime.ts`:
  - `createRuntime()` — builds a `ManagedRuntime` over `CommandRunnerLive`
  - `runEffect(runtime, effect, { signal?, interruptMessage? })` — runs an Effect to completion; throws with `interruptMessage` on interruption-only causes, else throws the first pretty error
  - `type GitInfoRuntime = ReturnType<typeof createRuntime>`
- `src/changed-files-view.ts`:
  - `loadChangedFiles(cwd): Effect<ChangedFile[] | null>` — `null` = not a git repository
  - `showChangedFiles(ctx: ExtensionContext, files: ChangedFile[])` — renders the TUI overlay (no-op outside TUI)
  - `sanitizeTerminalText(text): string` — strips terminal control sequences
  - `interface ChangedFile { additions: number | null; deletions: number | null; diff: string[]; name: string; path: string }`

### Constants

- `GIT_TIMEOUT_MS = 3_000` (index.ts repo/branch checks), `GH_TIMEOUT_MS = 10_000` (gh pr view), diff/stat timeout `10_000` (changed-files-view), `MAX_STREAM_CHARS = 10 MiB`, `MAX_DIFF_LINES = 20_000`, `DIFF_SCROLL_STEP = 5`.

No tools (`registerTool`), no shortcuts (`registerShortcut`), and no config files — the extension is command-only.

## Examples

1. **Browse local changes.** User: "what did I change locally?" → agent sends `/lg`. TUI opens the overlay: `j`/`↓` select a file, `enter`/`space`/`l`/`→` move to the diff pane, `h`/`←`/`esc` return, `esc` in the file pane closes. Each sidebar row shows `› name  +n -m` (or `binary`); the second row per file shows its path.
2. **Check for an open PR.** User: "is there a PR for this branch?" → agent sends `/pr` → toast `PR #42: https://github.com/owner/repo/pull/42`. A draft prints `PR #42 (draft): …`; a branch with no open PR prints `No open PR found for feature/x`.
3. **Non-repo / clean-tree handling.** Running `/lg` outside a git work tree toasts "Not a git repository"; in a clean repo it toasts "Working tree is clean" — useful for confirming state without reading the footer.
4. **Programmatic reuse.** Another extension can call `runEffect(createRuntime(), loadChangedFiles(cwd))` to get the `ChangedFile[]` list (or `null`) without opening the TUI, or use `sanitizeTerminalText` before rendering any git-sourced text.
