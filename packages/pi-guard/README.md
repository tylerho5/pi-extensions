# @tylerho/pi-guard

Prompts for human confirmation before risky git writes, PR publishing, and recursive rm in the bash tool.

## Install

`pi install npm:@tylerho/pi-guard`

---

# Guard

Blocks dangerous shell commands before the `bash` tool executes them and asks a human to confirm. Three matchers cover git write operations, `gh pr` publishing, and recursive `rm`. A declined prompt blocks the call with `Blocked by guard: <reason>`, and a prompt from a headless subagent still reaches a human through the interactive session's modal.

## Claude Code lineage

The matchers port Claude Code's `git-guard.sh`, `pr-guard.sh`, and `rm-guard.sh`, three shell scripts that toggle a `PreToolUse` hook and match the Bash command with `grep -qE` EREs, emitting `permissionDecision: "ask"` to force a prompt. `src/git.ts`, `src/pr.ts`, and `src/rm.ts` carry those expressions as JS regexes, with the `tool_call` gate standing in for the hook and `/guard` for the scripts' `jq` settings toggle. The scripts, the source comments, and the design plan record no Claude Code version, so the release the port came from is not recorded.

## How it works

The extension subscribes to `tool_call` and narrows to bash with `isToolCallEventType("bash", event)`. It runs `evaluateBashGate` over the command string. The gate returns `undefined` to let the call proceed, or `{ block: true, reason }` to stop it before execution.

Every guard has the shape `Guard { id, label, match(command): string | null }`. `match` returns `null` when the command is untouched, and the reason string otherwise. The matchers are unanchored, so they fire anywhere in a compound command.

- git (`git.ts`): the `commit`, `push`, `reset`, and `merge` subcommands. Flags such as `-C path`, `--git-dir=x`, and `-c k=v` may sit between `git` and the subcommand. Reasons: `committing`, `pushing`, `resetting`, `merging`. Read-only commands (`status`, `log`, `diff`, `show`, `remote -v`) pass.
- pr (`pr.ts`): `gh pr create` always matches, with reason `creating a PR`. `gh pr edit` matches only with a body or title flag (`--body`, which also covers `--body-file`, `--title`, or the short `-b`, `-t`, `-F`), with reason `editing a PR description`. `gh pr view`, `list`, `checkout`, `merge`, `diff`, and label-only or reviewer-only edits pass.
- rm (`rm.ts`): an `rm` invocation at a command boundary, optionally with a `sudo ` prefix or an absolute path such as `/bin/rm`, plus a recursive flag. The flag may be bundled short (`-rf`, `-fr`, `-Rf`, `-rfv`), short and split (`-v -r`), or `--recursive`. Reason: `a recursive delete (rm -r)`. Non-recursive removes and substring lookalikes (`rmdir`, `trm`, `confirm -r`) pass. `git rm -r` matches.

`routePrompt` picks one of three routes. A session with UI prompts locally. A session without UI but with a registered parent UI prompts the parent. With no UI anywhere, the session is headless and the configured fallback decides.

The bridge captures the interactive session's `ctx.ui` at `session_start`. Headless child sessions route through `confirmOnParent`, which serializes on a promise queue so concurrent subagents do not collide on the modal. A rejected confirm does not stall the queue. Without a parent UI, the prompt resolves `false`.

Settings live under the `guard` key of the shared `settings.json`, not a guard-specific file. `writeGuardSetting` patches only that key and preserves unrelated keys. `parseGuardSettings` is tolerant, so a wrong-typed field falls back to its default. `PI_DISABLE_GUARDS` (truthy values `1`, `true`, `yes`, `on`) force-disables all three guards regardless of the file.

## API

No tools and no shortcuts are registered. `pi.registerCommand("guard", ...)` carries the description "Toggle git/pr/rm command guards (on|off|status)" and splits its arguments into `[id] [action]`.

| Args | Result |
|---|---|
| none, or `status` | `guards — git: on, pr: on, rm: on (headless fallback: deny)` |
| `<id>`, or `<id> status` | `git guard is on` |
| `<id> on` / `<id> off` | writes the toggle and reports `git guard ON` / `git guard OFF` |
| unknown `<id>` | warning `Unknown guard "<id>". Use git, pr, or rm.` |
| bad action | warning `Usage: /guard <id> on\|off\|status` |

Two handlers are registered. `session_start` calls `setParentUi` with the session's `ctx.ui` when `ctx.hasUI` is true. `tool_call` runs for bash only and calls `evaluateBashGate(event.input.command, settings, { hasUI, hasParent }, { confirmLocal, confirmParent })`.

The prompt title is `Guard` locally and `Guard — subagent command` when routed to the parent. The body is `Confirm before <reasons joined with " and ">:\n\n  <command>`, and the block result joins the reasons with `, `. `id` is one of `GUARD_IDS = ["git", "pr", "rm"]`, and only `headlessFallback` requires hand-editing `settings.json`.

`~/.pi/agent/settings.json` holds `guard`: `{ "git": boolean, "pr": boolean, "rm": boolean, "headlessFallback": "deny" | "allow" }`. Defaults are `true` for all three and `headlessFallback: "deny"`. Set `headlessFallback` to `"allow"` to let a fully headless session run guarded commands without confirmation.

Only top-level `index.ts` is auto-loaded, and nothing else imports the extension. Its default export is `(pi: ExtensionAPI) => void`. `GUARD_IDS`, `isGuardId`, and `statusLine` stay module-private.

- `src/types.ts`: `GuardId = "git" | "pr" | "rm"`, `Guard`.
- `src/registry.ts`: `GUARDS: readonly Guard[]` in the order git, pr, rm, which sets reason order.
- `src/git.ts`, `src/pr.ts`, `src/rm.ts`: default-exported `Guard` implementations.
- `src/decision.ts`: `guardReasons`, `routePrompt`, `evaluateBashGate`, and the types `Route`, `PromptContext`, `GateHooks`, `GateEnv`, `GateResult`.
- `src/bridge.ts`: `setParentUi`, `hasParentUi`, `confirmOnParent`, `ConfirmUi`.
- `src/settings.ts`: `GuardSettings`, `HeadlessFallback`, `DEFAULT_GUARD_SETTINGS`, `parseGuardSettings`, `loadGuardSettings`, `writeGuardSetting`, `globalSettingsPath`.

## Examples

A force push. The agent calls `bash` with `git push --force origin main`. The git guard matches with reason `pushing`. The modal asks `Guard — Confirm before pushing:\n\n  git push --force origin main`. A decline returns `Blocked by guard: pushing` and the agent must not proceed without approval.

Per-guard toggling and bypass. `/guard git off` reports `git guard OFF` and persists to `settings.json`. `/guard status` then reports `guards — git: off, pr: on, rm: on (headless fallback: deny)`. `PI_DISABLE_GUARDS=1 pi ...` disables all three guards at load time and overrides the file.

Subagent prompt routing. A subagent with `hasUI: false` runs `rm -rf build`. Its handler routes the prompt to the parent modal, titled `Guard — subagent command`. When no parent session exists, the headless fallback decides, where `deny` blocks and `allow` passes.
