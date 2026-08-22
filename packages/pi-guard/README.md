# @tylerho/pi-guard

Prompts for human confirmation before risky git writes, PR publishing, and recursive rm in the bash tool.

## Install

`pi install npm:@tylerho/pi-guard`

---

# Guard

Intercepts dangerous shell commands before the `bash` tool executes and asks a human to confirm. Three independent guards trip on git write operations, `gh pr` publishing, and recursive `rm`; every match pauses on a confirmation modal, and a declined prompt blocks the tool call with `Blocked by guard: <reason>`. Toggles per guard via `/guard`, persisted in `settings.json`. The prompt routing also spans subagents: a headless child session's guard prompt bubbles up to the interactive session's modal so a human still decides.

## Key concepts

- **Fires on the `tool_call` event, bash only.** `index.ts` subscribes to `tool_call`, narrows with `isToolCallEventType("bash", event)`, and runs `evaluateBashGate` over the command string. Return `undefined` → the call proceeds; return `{ block: true, reason }` → pi blocks it before execution.
- **Three matchers, one contract.** Every guard is a `Guard { id, label, match(command): string | null }` (`types.ts`); `match` returns `null` when the command is untouched, otherwise the reason string shown in the prompt. The matchers are regex-based, **unanchored** — they fire anywhere in a compound command (`git add -A; git push` still trips) and tolerate intervening global flags (`git -C /repo commit -m x`):
  - **git** (`git.ts`): `commit`, `push`, `reset`, `merge` subcommands. Regex allows global flags (`-C path`, `--git-dir=x`, `-c k=v`) between `git` and the subcommand. Read-only commands (`status`, `log`, `diff`, `show`, `remote -v`) pass. Reasons: "committing", "pushing", "resetting", "merging".
  - **pr** (`pr.ts`): `gh pr create` always flags ("creating a PR"); `gh pr edit` flags only when a body/title flag is present — `--body` (covers `--body-file`), `--title`, or short `-b`/`-t`/`-F` ("editing a PR description"). `gh pr view/list/checkout/merge/diff` and `gh pr edit` with only `--add-label`/`--add-reviewer` pass.
  - **rm** (`rm.ts`): `rm` at a command boundary (optional `sudo ` prefix or absolute path like `/bin/rm`) AND a recursive flag (any bundled short flag containing `r`/`R`, e.g. `-rf`/`-fr`/`-Rf`/`-rfv`, or `--recursive`). Non-recursive `rm` and substring lookalikes (`rmdir`, `trm`, `confirm -r`) pass. Notably also flags `git rm -r`.
- **Prompt routing is three-way** (`routePrompt` in `decision.ts`): `hasUI` → ask locally via `ctx.ui.confirm`; no UI but a parent UI registered → ask the parent (see bridge); neither → headless, decided by the configured fallback (default **deny**). The prompt title is `Guard` locally and `Guard — subagent command` when routed to the parent; body is `Confirm before <reasons joined with " and ">:\n\n  <command>`.
- **Subagent bridging** (`bridge.ts`). At the interactive session's `session_start`, `ctx.ui` is captured into a module-level `parentUi`. Headless child sessions (subagents, workflow agents — all `ctx.hasUI === false`) route their guard prompts through `confirmOnParent`, which serializes on a promise queue so concurrent subagents never collide on the modal; a rejected confirm doesn't stall the queue. No parent UI → resolves `false` (blocks).
- **Settings live in the shared `settings.json`**, not a guard-specific file: `globalSettingsPath()` = `join(getAgentDir(), "settings.json")`, under the `guard` key. `writeGuardSetting` patches only that key and preserves unrelated keys. `PI_DISABLE_GUARDS` env var (truthy: `1`/`true`/`yes`/`on`) force-disables all three toggles regardless of the file. `parseGuardSettings` is tolerant — wrong-typed fields fall back to defaults.

## API

No tools (`registerTool`) and no shortcuts are registered. Surface:

### Command: `/guard`

`pi.registerCommand("guard", ...)` — toggle or inspect the guards. Args are whitespace-split into `[id] [action]`.

| Args | Behavior |
|---|---|
| *(none)* or `status` | Notify overall status line: `guards — git: on, pr: on, rm: on (headless fallback: deny)` |
| `<id>` or `<id> status` | Notify one guard's state, e.g. `git guard is on` |
| `<id> on` / `<id> off` | Write the toggle to `settings.json` and notify `git guard ON` / `git guard OFF` |
| unknown `<id>` | Warning: `Unknown guard "<id>". Use git, pr, or rm.` |
| bad action | Warning: `Usage: /guard <id> on|off|status` |

`id` must be one of the `GUARD_IDS = ["git", "pr", "rm"]` (`GuardId` type). `headlessFallback` is only editable by hand-editing `settings.json`.

### Events

| Event | Handler |
|---|---|
| `session_start` | If `ctx.hasUI`, captures `ctx.ui` via `setParentUi` so headless child sessions can route guard prompts to this session's modal. |
| `tool_call` | For `bash` events only (`isToolCallEventType("bash", event)`): loads settings, runs `evaluateBashGate(event.input.command, settings, { hasUI, hasParent }, { confirmLocal, confirmParent })`. Returns `{ block: true, reason: "Blocked by guard: <reasons>" }` when declined/unapproved, `undefined` (pass) otherwise. |

### Config

- `~/.pi/agent/settings.json` → `guard` key: `{ "git": boolean, "pr": boolean, "rm": boolean, "headlessFallback": "deny" | "allow" }`. Defaults: all `true`, `headlessFallback: "deny"`. Hand-edit `headlessFallback` to `"allow"` to let fully headless sessions (no UI anywhere) run guarded commands without confirmation.
- Env var `PI_DISABLE_GUARDS` (truthy) — overrides the file, turns all three toggles off.

### Module exports (internal surface)

Only `index.ts` is auto-loaded (top-level `*.ts`). All modules below are imported by it; nothing imports the guard extension from elsewhere.

- **index.ts** — default export `(pi: ExtensionAPI) => void` (the only export). `GUARD_IDS`, `isGuardId`, and `statusLine` are module-private helpers, not exported.
- **src/types.ts** — `GuardId = "git" | "pr" | "rm"`; `interface Guard { id, label, match(command): string | null }`.
- **src/registry.ts** — `GUARDS: readonly Guard[]` (git, pr, rm — order determines reason order).
- **src/git.ts / src/pr.ts / src/rm.ts** — default-exported `Guard` implementations (matcher regexes + reasons, see Key concepts).
- **src/decision.ts** — `guardReasons(command, settings): string[]`; `routePrompt(ctx: PromptContext): Route` (`Route = { route: "prompt-local" } | { route: "prompt-parent" } | { route: "headless"; allow: boolean }`); `evaluateBashGate(command, settings, env: GateEnv, hooks: GateHooks): Promise<GateResult>` where `GateResult = { block: true; reason: string } | undefined`; types `GateHooks { confirmLocal, confirmParent }`, `PromptContext { hasUI, hasParent, fallback }`.
- **src/bridge.ts** — `setParentUi(ui: ConfirmUi | undefined)`, `hasParentUi(): boolean`, `confirmOnParent(title, body): Promise<boolean>` (serialized; `false` with no parent UI); `interface ConfirmUi { confirm(title, body): Promise<boolean> }`.
- **src/settings.ts** — `GuardSettings`, `HeadlessFallback`, `DEFAULT_GUARD_SETTINGS`, `parseGuardSettings(value): GuardSettings`, `loadGuardSettings(path, env = process.env)`, `writeGuardSetting(path, patch: Partial<GuardSettings>)`, `globalSettingsPath()`.

## Examples

1. **Agent proposes a force push.** The agent calls `bash` with `git push --force origin main`. The git guard matches (`pushing`), a modal appears: `Guard — Confirm before pushing:\n\n  git push --force origin main`. User declines → the tool result reads `Blocked by guard: pushing` and the agent must not proceed without approval.

2. **Disable/enable per command.** `/guard git off` → `git guard OFF` (persisted to `settings.json`). `/guard status` → `guards — git: off, pr: on, rm: on (headless fallback: deny)`.

3. **Subagent tripping a guard.** A spawned subagent (headless, `hasUI: false`) runs `rm -rf build`. Its `tool_call` handler routes the prompt to the parent interactive session's modal, titled `Guard — subagent command`; the human's answer decides. If the parent session is gone (no `parentUi`), the headless fallback applies — `deny` blocks, `allow` passes.

4. **Scripted/CI bypass.** `PI_DISABLE_GUARDS=1 pi …` (or exporting it) force-disables all three guards at load time, overriding `settings.json`.
