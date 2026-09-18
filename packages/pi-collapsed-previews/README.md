# @tylerho/pi-collapsed-previews

Collapses hidden thinking blocks and edit-tool diffs to one-line summaries via runtime prototype patches on pi's TUI.

## Install

`pi install npm:@tylerho/pi-collapsed-previews`

---

> **Prototype:** This package patches pi internals and may break with pi version updates. Pin your pi version and expect to update it when pi changes.

# Collapsed previews

This extension patches two of pi's TUI components at runtime so collapsed rows carry useful text. Hidden thinking blocks show a snippet of the reasoning instead of a bare label, and `edit` tool diffs collapse to a header line with a `+added -removed` count.

## How it works

The extension imports `AssistantMessageComponent` and `ToolExecutionComponent` from `@earendil-works/pi-coding-agent` and replaces methods on their prototypes. The package re-exports the same class objects, and extensions share pi's module instance, so the patches affect pi's UI directly. The extension changes no dist files. Both patches install at module import time, before the exported init function runs.

A `Symbol.for("pi-collapsed-previews.patched")` marker on each prototype stops the wrappers from stacking. `Symbol.for` survives `/reload` within one process, so each handler installs once.

The thinking snippet patch wraps `updateContent`. The wrapper calls the original first, then returns unless `hideThinkingBlock` is on. It groups consecutive `thinking` blocks into runs, the same grouping pi uses to render them under one collapsed label. Each run is joined, whitespace-collapsed, and trimmed. For every run the wrapper appends ` · <snippet> (ctrl+t)` to the matching hidden-state label `Text` child, where the snippet is the run's first 160 characters with `…` appended when the run is longer. A label child is a `Text` node whose whole ANSI-stripped content equals `hiddenThinkingLabel`. Markdown blocks hold longer prose, so they never match. The `session_start` handler sets the label to `💭 thinking` through `ctx.ui.setHiddenThinkingLabel(...)`, which gives the patch a stable target. pi's default label is `Thinking...`.

The edit diff patch wraps `updateDisplay`. The wrapper calls the original first, then returns unless the tool is `edit`, the component is not expanded, the call renderer has more than one child, and the preview has no `error` field. It keeps the header child, removes the body children that hold the diff lines, and rewrites the header to `<header>  · +N -M diff (ctrl+o)`. The counts come from body lines that start with `+` or `-`. When the diff has neither, the counts drop and the header reads `<header>  · diff (ctrl+o)`. Ctrl+O expands the full diff like any other tool output.

## API

No tools, no commands, no shortcuts, and no config files. The surface is three items.

- Default export `export default function (pi: ExtensionAPI)`. It registers the one event handler.
- Event `session_start`, handled by `ctx.ui.setHiddenThinkingLabel("💭 thinking")`. This call is a no-op in RPC mode.
- Module-level side effects at import: `patchAssistantMessage()` and `patchToolExecution()`. Constants are `THINKING_LABEL = "💭 thinking"` and `SNIPPET_MAX = 160`.

## Examples

- With thinking hidden (Ctrl+T), a reasoning-heavy answer renders as `💭 thinking · The user wants me to refactor the auth middleware, so let me check the current test cov… (ctrl+t)`.
- After an `edit` tool call, the diff body is replaced by `Edit: src/foo.ts  · +12 -3 diff (ctrl+o)`. Ctrl+O expands the diff inline.
- An `edit` call whose preview carries an error keeps its full body. Errors never collapse.
- After `/reload` exactly one patch stays active, and `session_start` re-asserts the thinking label.
