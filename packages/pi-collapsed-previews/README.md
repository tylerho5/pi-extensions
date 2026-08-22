# @tylerho/pi-collapsed-previews

Collapses hidden thinking blocks and edit-tool diffs to one-line summaries via runtime prototype patches on pi's TUI.

## Install

`pi install npm:@tylerho/pi-collapsed-previews`

---

> **Prototype:** This package patches pi internals and may break with pi version updates. Pin your pi version and expect to update it when pi changes.

# Collapsed Previews

TUI niceties for collapsed UI states: hidden thinking blocks show a snippet of the reasoning instead of a bare label, and `edit` tool diffs are collapsed to their header plus a `+added -removed` line-count summary. Both are runtime prototype patches on pi's own component classes — no dist files are modified.

## Key concepts

- **Prototype patching, not wrapping.** The extension imports `AssistantMessageComponent` and `ToolExecutionComponent` from `@earendil-works/pi-coding-agent` and monkey-patches their prototypes. The package re-exports the same class objects and extensions share pi's module instance, so the patches affect pi's UI directly. Done at module import time (top-level side effects), not inside the exported init function.
- **`PATCHED` marker prevents stacking.** Each patch checks a `Symbol.for("pi-collapsed-previews.patched")` flag on the prototype before wrapping, and sets it after. `Symbol.for` survives `/reload` in-process, so handlers are never double-wrapped.
- **Thinking snippets (patch on `updateContent`).** The wrapper calls the original `updateContent`, then — only when `hideThinkingBlock` is on — groups the content's consecutive `thinking` blocks into "runs" (mirroring how pi renders consecutive thinking blocks under one collapsed label; runs are joined, whitespace-collapsed, trimmed), and for each run appends ` · <first 160 chars>… (ctrl+t)` to the matching hidden-state label `Text` child. Label children are identified by their full text being exactly `hiddenThinkingLabel` (ANSI-stripped) — the only `Text` children whose entire content is the label; Markdown blocks hold longer prose. The label itself is set to `💭 thinking` on `session_start` via `ctx.ui.setHiddenThinkingLabel(...)` so the match target is the extension's own label (pi's default is `Thinking...`).
- **Edit-diff collapse (patch on `updateDisplay`).** The wrapper calls the original `updateDisplay`, then — only when `toolName === "edit"`, the component is not already `expanded`, and the call-renderer's `preview` has no `error` (errors stay visible) — removes all body children of the call-renderer (the diff lines, produced by pi's `renderDiff`) and rewrites the header to `… · +N -M diff (ctrl+o)`. `+`/`-` counts come from counting diff lines starting with `+`/`-` in the stripped body text. Ctrl+O still expands the full diff like any other tool output.
- **Lifecycle.** The patches are installed once when the module loads; the only per-session work is re-asserting the thinking label on `session_start` (sessions are the unit where the hidden-label UI state lives).

## API

The extension exposes **no tools, no commands, no shortcuts, no config files** — it is entirely passive UI behavior. The full surface:

### Default export (extension entry)

`export default function (pi: ExtensionAPI)` — the standard extension init function. Registers the single event handler below.

### Events

| Event | Handler |
|---|---|
| `session_start` | Calls `ctx.ui.setHiddenThinkingLabel("💭 thinking")` (`THINKING_LABEL`). Sets the collapsed-thinking label that the `updateContent` patch matches against and annotates. Without this, the patch would match pi's default `Thinking...` label — the extension works either way, but the emoji label is the intended look. |

### Module-level side effects (installed at import, before the init function runs)

- `patchAssistantMessage()` — wraps `AssistantMessageComponent.prototype.updateContent`; appends reasoning snippets to hidden thinking labels. Constants: `THINKING_LABEL = "💭 thinking"`, `SNIPPET_MAX = 160` (chars per snippet, ellipsis appended when truncated). Rewritten label format: `💭 thinking · <snippet> (ctrl+t)`.
- `patchToolExecution()` — wraps `ToolExecutionComponent.prototype.updateDisplay`; collapses `edit` diffs. Rewritten header format: `<header>  · +<added> -<removed> diff (ctrl+o)`; stats omitted when the diff has no `+`/`-` lines.

Both are no-ops if the prototype is already marked patched.

## Examples

- **Hidden thinking shows a taste.** With thinking blocks hidden (Ctrl+T), a reasoning-heavy answer renders `💭 thinking · The user wants me to refactor the auth middleware — let me check the current test cov… (ctrl+t)` — enough context to follow the agent's reasoning without expanding, Ctrl+T for the full block.
- **`edit` diffs stop dominating the scrollback.** After an `edit` tool call, the diff body is replaced by the header line `Edit: src/foo.ts  · +12 -3 diff (ctrl+o)`. Ctrl+O expands the full diff inline; errors in the edit preview are never collapsed (kept fully visible).
- **Survives `/reload`.** Reloading extensions does not stack handlers — the `Symbol.for` marker keeps exactly one patch active.
