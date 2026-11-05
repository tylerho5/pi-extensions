# @tylerho/pi-checkpoints

Snapshots the files a session's edit tools touch, one checkpoint per prompt, and restores them with the conversation through /rewind.

## Install

`pi install npm:@tylerho/pi-checkpoints`

---

# Checkpoints

Snapshots the files a session's edit tools touch, one checkpoint per user prompt, and puts them back through `/rewind`, which Escape twice also opens. A checkpoint pairs the code state with the conversation, so a prompt can be undone on either side or on both. Snapshot scope is the set of files the session's `edit` and `write` calls named, which is what bounds snapshot size and keeps a session running in `$HOME` from snapshotting a home directory.

## Claude Code lineage

The behavior text comes from Claude Code's published checkpointing documentation, retrieved 2026-10-05. No Claude Code CLI version was verified for it, so none is named here.

The shadow repository mechanism is adapted from `ilovepixelart/pi-code`'s `extensions/git-checkpoint.ts` and its `extensions/internal/{values,tool-target}.ts` helpers at commit `ff3eb5e` (2026-10-05), MIT licensed, copyright 2025 Mario Zechner and 2026 ilovepixelart. That source solved the git edge cases this port would otherwise have rediscovered: pathspec refusals, non-ASCII names, `core.autocrlf`, ignored paths, and paths under another repository. Adapted files carry the same header naming the source, its license, and the commit. Code is reformatted to this repository's prettier style.

Claude Code behavior that carries over:

- One checkpoint per user prompt, recorded before the prompt's first edit lands.
- Retention of 30 days, changed with `cleanupPeriodDays`.
- The five rewind actions and their order, including the empty editor after `Summarize up to here`.
- The 100 checkpoint cap per session.
- Files created after a checkpoint stay in place rather than being deleted by a restore.

The pi implementation departs from Claude Code where the two runtimes differ:

- `/rewind` only. Pi's `doubleEscapeAction` offers a fixed `tree | fork | none` set and no hook for another action, so the gesture is read from raw terminal input and dispatches the command itself, with the setting left at `none` so the built-in cannot also fire on the same press.
- No `/resume <previous session>` row after `/clear`. Pi records `parentSession` for both forks and session replacement, so the field does not identify the conversation that preceded a clear.
- `Summarize up to here` is refused when pi considers the session too small to compact. Pi's guards run before the compaction hook, so the extension cannot supply a boundary there.
- Symlinked paths are restored at their target rather than skipped with a warning. The port tracks files at their real location so a restore covers them.
- Snapshot garbage collection is git's. Claude Code additionally deletes snapshot files no remaining checkpoint references, to keep each file's first snapshot as a baseline for its editor diffs, and there is no diff consumer here.
- Subagent edits are not captured, which matches Claude Code's default. Nested tool calls made through codemode's `executeTool` do fire `tool_call` and are captured.
- Bash-modified files are not tracked, which matches Claude Code, where it is a documented limitation.
- A checkpoint recorded under another work tree is refused. Pi can change a session's tool directory mid-session through the `worktree` extension, and Claude Code has no equivalent.

## How it works

### Storage

Each session owns a bare git repository at `~/.pi/agent/checkpoints/<sessionId>/`, driven with `--git-dir` and `--work-tree` so the project's own repository, index, and config are never touched. Every call adds `-c core.autocrlf=false`, because the Windows default would rewrite every restored file's line endings, and every commit adds `-c commit.gpgsign=false -c core.hooksPath=/dev/null`, so the user's global signing and hook configuration cannot fail a checkpoint.

A `pi-work-tree` sidecar inside the repository records the work tree it snapshots. A session whose work tree changes gets `<sessionId>-<cwdSlug>` instead, where `cwdSlug` is the resolved directory's basename with non-word characters replaced by `_`, a dash, and the first eight hex characters of the path's sha256. That covers a session resumed elsewhere and one that enters or leaves a worktree part way through. Resuming back in the recorded directory takes the original repository and its checkpoints again.

The repository's `.git/info/exclude` is mirrored into the shadow on every session start, so files the user excluded locally are neither snapshotted nor restored. The global excludes file stays untouched, since `core.excludesFile` is single-valued and repointing it would drop the user's own rules.

A `.gitignore` containing `*` is written into the store root on the first bind, so the store stays out of any repository that happens to contain it. The store holds a copy of every file a session edited, dotfiles included, and an enclosing repository's own `.gitignore` cannot cover every install. An existing file there is left alone.

### Scope

The tracked set is the absolute paths this session's edit tools named. `read` is deliberately absent. Path resolution follows pi's rules before resolving against the effective cwd: a leading `@` is stripped, `~` is expanded, a `file://` URL is decoded, and unicode spaces are folded. A path that reaches its file through a symlinked directory is tracked at its real location, because git refuses a pathspec that passes through a symlink, and the real directory is mapped back under the work tree as the session spells it.

Three cases need care, and each one costs the whole checkpoint if missed.

- Ignored paths are dropped before staging. Git rejects an entire pathspec when one entry is ignored.
- A path outside the work tree, such as one under another repository, a submodule, or `$HOME`, is written to the index directly with `hash-object -w` and `update-index`. `git add` exits zero on such a path and stages nothing, which would leave the edit unsnapshotted while the restore still reported success.
- If a batched add fails, each path is added alone and any path git still refuses is dropped from the tracked set. One bad path then costs its own checkpoint and nobody else's.

A file the session deleted stages its removal, because the committed path set still matches it as a pathspec.

Every path handed to git is a literal pathspec. Git pathspecs glob by default, so a tracked file named `note[1].txt` also matches `note1.txt`: `git add` would stage the sibling, and a restore would overwrite it with the checkpoint's content. That is data loss on a file the session never touched, so `add`, `ls-files`, and `checkout` receive `:(literal)` per path. `check-ignore` is the one exception. It rejects pathspec magic outright and treats its arguments as plain pathnames already.

### Baselines

A file first edited part way through a run is absent from that run's pre-run snapshot, so a rewind could not undo that first edit. Before the tool writes, the file's pre-edit content is committed with the message `baseline`, and the run's ref moves onto it. That is a commit rather than an amend, because the run's checkpoint can be a commit an earlier checkpoint also points at.

### Restore plan

Gating and restoring share one function, so the menu cannot offer an action the engine would refuse. `planRestore` returns the file list a restore would write: every path in the checkpoint's tree at the content that tree holds, and every path whose first addition after the checkpoint is a `baseline` commit, at the baseline content.

The second group is why gating cannot look at the checkpoint tree alone. A checkpoint taken before any edit has an empty tree, and a file the session first edited in a later run exists in that later run's checkpoint as its pre-edit baseline. Rewinding to the earlier checkpoint must still put that file back.

The code actions are offered when the plan is non-empty and at least one planned path is missing on disk or hashes differently from the plan's blob. The comparison uses `hash-object`, which reads no index and so cannot disturb the next snapshot. `applyRestore` runs one sequential `checkout -f` per source ref, because git takes the shadow repository's index lock, and refuses outright when the sidecar names a different work tree.

### Effective working directory

Pi bakes each built-in tool's cwd at creation, and the `worktree` extension enters a worktree by re-registering `edit`, `write`, `read`, `bash`, `grep`, `find`, and `ls` as proxies that resolve against the active worktree while `ctx.cwd` stays the session's original directory. Resolving a touched path against `ctx.cwd` alone would snapshot and later overwrite a same-named file in the session directory instead of the file the model edited. The effective cwd comes from `shared/effective-cwd.ts` and is read at `session_start`, `turn_start`, and `tool_call`. The last of those matters because a worktree can be entered part way through a turn: the model calls `enter_worktree` and then edits, so `tool_call` re-reads the directory rather than trusting the binding `turn_start` left.

### Lifecycle

| Event | Action |
|---|---|
| `session_start` | Resolve the effective cwd, initialize its shadow, inherit refs after a fork, seed the tracked set from the last commit, rebuild records from `getBranch()`, sweep expired shadows, bind the Escape gesture |
| `agent_start` | Arm a run |
| `before_agent_start` | Mark the run as prompt-started |
| `turn_start` | Take the one pre-run snapshot |
| `tool_call` | Record a newly touched path and capture its baseline |
| `turn_end` | Key the snapshot to the user message entry id and append the record |
| `session_shutdown` | Remove an ephemeral run's shadow on quit, drop the Escape listener |
| `session_before_fork` | Offer a code restore to the fork point |
| `session_before_compact` | Supply an exact compaction boundary when `/rewind` asked for one |

One snapshot per run rather than per assistant turn. The snapshot is taken at `turn_start` and awaited, so it captures the touched files before the model's first edit. It is keyed and persisted at `turn_end`, because the user message that started the turn is not persisted yet at `turn_start`.

A retry, an overflow recovery, or a queued follow-up re-enters through `agent.continue` and fires `agent_start` again without `before_agent_start`. Those runs have no new user message, so they reuse the record already held for the last user message instead of taking a second snapshot and leaving the first unreferenced. A queued follow-up that pi delivers as a new turn does get its own checkpoint.

The pre-run snapshot is skipped when nothing changed, decided from the index status rather than the commit exit code, since a commit can fail on the user's git configuration and reusing `HEAD` then would record a ref that predates the current tree. Records are rebuilt from `getBranch()` rather than `getEntries()`, so checkpoints from abandoned branches stay out of the rewind list.

### Records

A checkpoint is a custom session entry of type `checkpoints`, so it travels with the conversation through resume, fork, and reload:

```
{ entryId, ref, prompt, createdAt, shadow }
```

`entryId` is the session entry id of the user message that started the run. `ref` is a ref under `refs/checkpoints/`, not a raw sha, so a baseline captured later in the run can move it. `prompt` is a one-line snippet for the menu label. `shadow` names the shadow directory the ref lives in, which makes the record self-describing, so a record from a shadow bound to another work tree is listed and refused rather than attempted.

## API

### Gesture

Escape pressed twice with an empty editor opens the same menu as `/rewind`, with the same actions. It is a shortcut rather than a second implementation: the listener dispatches `/rewind` back through pi's prompt path (`sendUserMessage` with `expandPromptTemplates`, which is what makes pi treat the text as a command), so the command handler runs with the command context a typed command gets, `navigateTree` included.

The listener reads raw terminal input, which reaches it before the focused component, so the second press never gets to pi's built-in handler and the gesture can consume it. Raw input sees neither the focused component nor the session state, so every guard pi's built-in applies is repeated: an empty editor (`ctx.ui.getEditorText()`), an idle agent (`ctx.isIdle()`), and focus on the chat editor rather than a modal. The focus check walks the TUI, which the extension reaches through an inert probe widget registered purely to capture the root; the same walk lives in [subagents](subagents.md) for its task-rail gesture. An ineligible press clears a pending one, so a pair never spans a modal or a draft.

The session tree is no longer on Escape: with `doubleEscapeAction` at `none`, the key belongs to this gesture. Use `/tree`, or bind `app.session.tree` in `keybindings.json`.

### Command

| Command | Description | Behavior |
|---|---|---|
| `/rewind` | "Rewind code and/or conversation to a previous checkpoint" | Two selects, newest checkpoint first, then the action. Opened by the command or by a double Escape. Does nothing without `ctx.hasUI`, and a session with no records reports `No checkpoints recorded yet`. Cancel at either step does nothing. |

### Actions

| Action | Behavior |
|---|---|
| `Restore code and conversation` | Apply the restore plan over the working tree, then `navigateTree(entryId, { summarize: false })` and put the prompt in the editor |
| `Restore conversation` | `navigateTree(entryId, { summarize: false })`, then the prompt in the editor |
| `Restore code` | Apply the restore plan |
| `Summarize from here` | `navigateTree(entryId, { summarize: true })`, then the prompt in the editor |
| `Summarize up to here` | `ctx.compact()` with an exact boundary from `session_before_compact`. The editor is left empty, as in Claude Code |
| `Never mind` | Return without changes |

The two code actions are withheld when the plan would change nothing. A cancelled navigation after a code restore reports that the code was restored and the conversation was left unchanged. A cancelled or failed navigation is reported, and `compact` failures are reported with pi's own message, which is how a session too small to compact reaches the user.

`navigateTree`'s published type omits `editorText`, but pi's runtime returns it and its own tree command puts it in the editor. The port reads that value and falls back to the target entry's own text, so neither an undocumented field nor the entry text alone carries the behavior.

### Configuration

| Knob | Location | Effect |
|---|---|---|
| `checkpoints.enabled` | `~/.pi/agent/settings.json` | `false` disables snapshotting, so no checkpoint is recorded and `/rewind` has nothing to offer |
| `doubleEscapeAction` | `~/.pi/agent/settings.json` | Set to `none` so the built-in double Escape does not also open the session tree; the gesture in this extension owns the key |
| `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING` | environment | `1` disables snapshotting, matching Claude Code's documented switch, and wins over the file |
| `cleanupPeriodDays` | `~/.pi/agent/settings.json` | Retention window in days, default 30. A non-positive or unreadable value keeps the default |

### Exported modules

- `index.ts` default export `(pi: ExtensionAPI) => void`. `createCheckpoints(pi, runtime)` takes a `CheckpointRuntime` of `{ shadowRoot, shadowFor, effectiveCwd, settings }`, which is how the tests point the wiring at a temporary shadow root.
- `src/shadow.ts` is the git engine: `ShadowRepo`, `ShadowDeps`, `shadowDirFor`, `recordedWorkTree`, `rememberWorkTree`, `CWD_SIDECAR`, `gitShadow`, `ensureShadow`, `mirrorLocalExcludes`, `inheritRefs`, `snapshotShadow`, `commitShadow`, `runRefFor`, `updateRunRef`, `headSha`, `committedPaths`, `treePaths`, `addablePaths`, `addPaths`, `withoutIgnored`, `firstAddedPaths`, `checkoutRef`, `refExists`, `pruneShadowRepos`, `workTreePath`, `cwdSlug`, `BASELINE_MESSAGE`.
- `src/track.ts` is the tracked set: `EDIT_TOOLS`, `asPiReadsIt`, `fileToolTarget`, `throughSymlinks`, `captureBaseline`, `seedTouched`, and re-exports of `workTreePath` and `BASELINE_MESSAGE`.
- `src/plan.ts` is the restore plan: `planRestore`, `planHasChanges`, `applyRestore`, `RestorePlanEntry`.
- `src/store.ts` is the record: `CUSTOM_TYPE`, `MAX_CHECKPOINTS_PER_SESSION`, `Checkpoint`, `parseCheckpoint`, `recordsFromBranch`, `capCheckpoints`, `promptSnippet`, `messageText`, `findLastUserMessage`, `checkpointLabel`.
- `src/run.ts` holds the two run decisions: `decideRun`, `decideTurnEnd`, `RunInput`.
- `src/gesture.ts` is the double-Escape listener: `DOUBLE_ESCAPE_WINDOW_MS`, `DoubleEscapeGesture`, `createDoubleEscapeGesture`, `EscapeGestureDeps`, `RawInputHandler`, `attachEscapeGesture`.
- `src/focus.ts` finds the focused component: `findFocusedComponent`, `isDefaultEditorFocused`.
- `src/settings.ts` reads the knobs: `CheckpointSettings`, `DEFAULT_CHECKPOINT_SETTINGS`, `parseCheckpointSettings`, `loadCheckpointSettings`.
- `src/menu.ts` is the command and its actions: `RESTORE_MODES`, `availableModes`, `runRewindCommand`, `restoreConversation`, `summarizeFromHere`, `requestSummarizeUpTo`, `handleBeforeCompact`, `MenuDeps`, `CompactDeps`, `CompactionState`.

## Examples

1. Undo a bad edit and the conversation around it. Press Escape twice, or run `/rewind`, pick the prompt before the edit, then `Restore code and conversation`. The files return to their state at that prompt and the prompt lands back in the editor, ready to rephrase.
2. Roll back code only. Choose `Restore code` to leave the conversation where it is, for example when the model's explanation was useful but its edits were not.
3. Compress a long session. Choose `Summarize up to here` to replace everything before a prompt with a summary and keep the later messages, or `Summarize from here` to summarize from the prompt forward.
4. Resume a session elsewhere. If the recorded work tree is gone or the session moved, `/rewind` still lists the checkpoints and marks them not restorable. Returning to the recorded directory takes them back.
