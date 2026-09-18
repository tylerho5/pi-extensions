# @tylerho/pi-prompt-stash

Saves and restores the editor's draft text in a single slot via ctrl+s, Claude Code style.

## Install

`pi install npm:@tylerho/pi-prompt-stash`

---

# Prompt Stash

Prompt Stash saves the editor draft to a single in-memory slot and clears the editor. Pressing the shortcut again with an empty editor puts the draft back. A footer status line shows a preview while the slot holds a draft.

## Claude Code lineage

The stash semantics come from Claude Code's `chat:stash` action: one slot that overwrites on a second stash, raw untrimmed text, a whitespace-only editor counting as empty, and a restore that clears the slot. Claude Code binds the action to `ctrl+s` in its chat context, so this extension binds `ctrl+shift+s` and leaves the `ctrl+s` builtins alone. No Claude Code version appears in the source, the commit messages, or the earlier docs, so the release the semantics came from is not recorded.

## How it works

`ctrl+shift+s` and `/stash` call the same handler and do the same thing. The handler reads the editor text and the slot, then picks one of three actions.

- Editor has text: store the text raw and untrimmed and clear the editor. The text keeps its leading and trailing whitespace and newlines. A second stash overwrites the first, so the slot holds one draft and never stacks.
- Editor is empty or whitespace-only and the slot has a draft: restore the draft and empty the slot.
- Editor is empty and the slot is empty: do nothing.

The slot is a module-level `string | undefined`, outside any session. It survives session rebinds such as `/new`, `/resume` and `/fork` within one process. A full `/reload` re-imports the module and drops the draft. The slot holds text only, because pi's editor API exposes no pasted images.

A held key autorepeats, and pi filters key releases but not repeats. Without a guard the held key would cycle stash and restore. The handler ignores toggles closer than `REPEAT_WINDOW_MS = 300` milliseconds and writes the timestamp even on a suppressed toggle, so a long hold stays suppressed until the key is released.

A stash calls `ctx.ui.setStatus("prompt-stash", "stashed: <preview>")` and sends no notification, because clearing the editor is visible feedback on its own. A restore calls `ctx.ui.setStatus("prompt-stash", undefined)` and `ctx.ui.notify("Draft restored", "info")`.

The extension binds `ctrl+shift+s` because `ctrl+s` is pi's built-in `app.thinking.save`, plus the picker-scoped `app.models.save` and `app.session.toggleSort`. An extension shortcut on `ctrl+s` shadows the builtin and warns at load.

## API

No tools, no events, no config files, no settings. Two registrations plus three exported functions.

The shortcut registration is `pi.registerShortcut("ctrl+shift+s", { description: "Stash the current prompt draft, or restore the stashed draft", handler: toggleStash })`. The handler type is `(ctx: ExtensionContext) => Promise<void> | void`, and it runs from the default editor's key handling.

The command registration is `pi.registerCommand("stash", { description: "Stash the current prompt draft, or restore the stashed draft (same as ctrl+shift+s)", handler: async (_args, ctx) => toggleStash(ctx) })`. It ignores arguments and behaves the same as the shortcut.

The handler uses four `ctx.ui` methods plus a headless guard:

- `getEditorText(): string` reads the current draft.
- `setEditorText(text)` clears the editor on a stash and fills it on a restore.
- `setStatus("prompt-stash", string | undefined)` sets the footer status. Any footer that renders status keys shows it, for example [expanded-footer.md](expanded-footer.md).
- `notify("Draft restored", "info")` reports a restore.
- `if (!ctx.hasUI) return;` keeps headless sessions from toggling.

The extension exports three pure functions for its tests. `shouldToggle(now, lastToggleAtMs)` returns true when `now - lastToggleAtMs >= 300`. `decideStashAction(editorText, stashedText)` returns `{ action: "stash", text }`, `{ action: "restore", text }` or `{ action: "noop" }`, and the stash text is the raw editor text. `stashPreview(text, max = 40)` squashes whitespace runs into single spaces, trims the result and truncates to `max` characters ending in `…`. The default export has type `(pi: ExtensionAPI) => void`, and importing `./index.ts` has no side effects.

## Examples

1. Stash a half-written prompt. Mid-draft, `ctrl+shift+s` clears the editor and the footer shows `prompt-stash: stashed: <first 40 characters, whitespace squashed>…`. With an empty editor, `ctrl+shift+s` restores the draft byte for byte and shows the `Draft restored` notification.
2. Run `/stash` instead. The command does the same work without a key binding, which helps in RPC and other non-TUI contexts.
3. Overwrite the slot. Stash draft A, type draft B and stash again. Draft A is gone and a restore yields draft B.
4. Do nothing. With an empty editor and an empty slot, `ctrl+shift+s` changes no status and sends no notification. A whitespace-only editor counts as empty and restores when the slot has a draft.
