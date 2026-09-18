# @tylerho/pi-prompt-stash

Saves and restores the editor's draft text in a single slot via ctrl+s, Claude Code style.

## Install

`pi install npm:@tylerho/pi-prompt-stash`

---

# Prompt Stash

Claude Code-style prompt stash: `ctrl+shift+s` (or `/stash`) saves the editor's current draft to a single in-memory slot and clears the editor; pressing it again with an empty editor restores the draft verbatim. A footer status (`prompt-stash`) shows a one-line preview while a stash exists. Single file (`index.ts`, 84 lines) plus its test.

## Key concepts

- **Single slot, overwrite semantics** — exactly Claude Code's `chat:stash`. Editor has text → stash it *raw and untrimmed* (leading/trailing whitespace and newlines preserved), clear the editor. Editor empty or whitespace-only + stash exists → restore it and clear the slot. Editor empty + no stash → no-op. A second stash overwrites the first: there is no stack.
- **Module-level state, not session state.** `stashed` is a module-level `string | undefined`, deliberately outside any session: the stash survives session rebinds (`/new`, `/resume`, `/fork`) within the process, mirroring CC's app-level React state. A full `/reload` re-imports the module and drops the stash — also like CC losing it on process restart.
- **Key-repeat suppression.** A held `ctrl+shift+s` autorepeats (kitty CSI-u repeat events, or legacy raw bytes) and pi filters key releases but not repeats, so without a guard the shortcut would cycle stash → restore → stash while the key is held. `toggleStash` ignores toggles closer than `REPEAT_WINDOW_MS = 300` ms apart, and always updates `lastToggleAt` — even on a suppressed toggle — so a long hold stays suppressed until the key is released.
- **Pure decision logic.** The handler is a thin wrapper over three exported pure functions (`decideStashAction`, `shouldToggle`, `stashPreview`) so all semantics are unit-testable without a UI.
- **Text only.** pi's editor API exposes no pasted images; the stash holds exactly what `getEditorText()` returns.
- **Feedback asymmetry.** Stash sets status `prompt-stash` → `stashed: <preview>` (clearing the editor is its own visible feedback, so no notification). Restore clears the status and fires `ctx.ui.notify("Draft restored", "info")`.

## API

No tools (`registerTool`), no events (`pi.on`), no config files, no settings references. Two registrations plus three exported pure functions.

### Shortcut: `ctrl+shift+s`

`pi.registerShortcut("ctrl+shift+s", { description: "Stash the current prompt draft, or restore the stashed draft", handler: toggleStash })`. Handler signature `(ctx: ExtensionContext) => Promise<void> | void` (pi's declared type; `toggleStash` is `async`); fires from the default editor's key handling (editor-scoped). `ctrl+s` is pi's built-in `app.thinking.save` (plus picker-scoped `app.models.save` and `app.session.toggleSort`), so the extension binds `ctrl+shift+s` — an extension shortcut on `ctrl+s` shadows the builtin and warns at load.

### Command: `/stash`

`pi.registerCommand("stash", { description: "Stash the current prompt draft, or restore the stashed draft (same as ctrl+shift+s)", handler: async (_args, ctx) => toggleStash(ctx) })`. Args ignored; identical behavior to the shortcut. Useful when `ctrl+s` is captured by a picker-scoped builtin.

### UI contract used (via `ctx.ui`)

- `getEditorText(): string` — read the current draft.
- `setEditorText(text)` — clear on stash, fill on restore.
- `setStatus("prompt-stash", string | undefined)` — footer status line while a stash exists (any footer-rendering extension, e.g. the CC-style footer, shows it on the status line).
- `notify("Draft restored", "info")` — restore feedback.
- Guard: `if (!ctx.hasUI) return;` — headless sessions never toggle.

### Exported pure functions

| Export | Signature | Behavior |
|---|---|---|
| `shouldToggle` | `(now: number, lastToggleAtMs: number) => boolean` | `now - lastToggleAtMs >= REPEAT_WINDOW_MS` (300). |
| `decideStashAction` | `(editorText: string, stashedText: string \| undefined) => { action: "stash", text: string } \| { action: "restore", text: string } \| { action: "noop" }` | Trim-based decision; stash text is the raw untrimmed editor text. |
| `stashPreview` | `(text: string, max = 40) => string` | Squashes whitespace runs to single spaces, truncates to `max` chars ending with `…`. |

Default export: `(pi: ExtensionAPI) => void` — registers the shortcut and command. Importing `./index.ts` (as the test does) is side-effect-free: the default export is defined but never invoked at import time.

## Examples

1. **Stash a half-written prompt.** Mid-draft, the user wants to run something else: `ctrl+shift+s` saves the draft (raw, untrimmed), clears the editor, and the footer shows `prompt-stash: stashed: <first ~40 chars, whitespace-squashed>…`. Later, with an empty editor, `ctrl+shift+s` restores it byte-for-byte and shows a "Draft restored" notification.
2. **`/stash` as the explicit form.** Same behavior, no key binding — for discoverability, or as the fallback when `ctrl+s` is claimed by a picker-scoped builtin while a selector is open.
3. **Overwrite, not stack.** Draft A is stashed; the user types draft B and hits `ctrl+shift+s` again — A is gone, B occupies the single slot. Restore yields B.
4. **No-op cases.** Empty (or whitespace-only) editor with no stash: `ctrl+shift+s` does nothing — no status change, no notification. Whitespace-only editor text *with* a stash counts as "empty" and restores.
