# @tylerho/pi-skills-banner-split

Splits the startup banner's Skills section into model-invokable and user-invoked groups.

## Install

`pi install npm:@tylerho/pi-skills-banner-split`

---

> **Prototype:** This package patches pi internals and may break with pi version updates. Pin your pi version and expect to update it when pi changes.

# Skills banner split

The startup banner's `[Skills]` section lists every loaded skill in one block. This extension splits it into `[Skills: Model-Invokable]` and `[Skills: User-Invoked]`, so the banner shows which skills the model can load on its own and which ones wait behind an explicit `/skill:name` invocation (`disable-model-invocation: true` in the skill frontmatter).

## How it works

pi renders the banner in `showLoadedResources()` inside `interactive-mode.js`. That code exposes no extension hook, and `ExpandableText` is a module-local class the package does not re-export, so the prototype patch that [collapsed-previews.md](collapsed-previews.md) uses is unavailable. The extension mutates the live component tree instead.

TUI access comes from a throwaway widget. `ctx.ui.setWidget(key, factory)` calls the factory synchronously with the stable TUI proxy, which survives renderer swaps. The extension registers a zero-line widget under the key `skills-banner-split-tui-capture`, stores the `tui` argument, and removes the widget right away.

To find the section, the extension walks `tui.children` with a stack and an identity set. It looks for an object that has both `getCollapsedText` and `setExpanded` functions and whose ANSI-stripped collapsed text starts with `[Skills]`. On a match it replaces `getCollapsedText` and `getExpandedText` in place and calls `setExpanded(wasExpanded)` to re-render. Ctrl+O keeps working because pi's expand toggle calls `setExpanded` on the same instance, which runs the new getters.

The model-invokable set comes from `ctx.getSystemPrompt()`. The extension parses the `<name>` entries inside the `<available_skills>` block, which is exactly what the model sees. It then drops the `[Skills]` header line from the collapsed body, splits the rest on commas, and puts every name absent from that set into the user-invoked group. Nothing scans `SKILL.md` files.

`session_start` fires before `showLoadedResources()` fills the banner, on startup and on `/reload` alike, and `showLoadedResources()` clears and rebuilds the container. The extension therefore defers with `setTimeout(0)` and retries up to 20 attempts at 100 ms intervals until the section appears. A quiet startup skips the `[Skills]` section, and the retries then stop without effect.

Two guards leave the banner alone. The extension skips work when the collapsed text already contains `Model-Invokable`, and it skips work when either group would be empty.

The expanded view loses its scope grouping. The extension assigns each path line to the group whose skill name appears as a `/<name>/` segment. Scope and package header lines match no name and are dropped.

## API

No tools, no commands, no shortcuts, and no config files. TUI mode only, and the handler returns when `ctx.mode !== "tui"`.

- Default export `export default function (pi: ExtensionAPI)`, the extension entry point and only public surface. It registers the single `session_start` handler.
- Module constants: `ANSI_RE`, `CAPTURE_WIDGET_KEY = "skills-banner-split-tui-capture"`, and `MAX_ATTEMPTS = 20`.

## Examples

- The startup banner shows `[Skills: Model-Invokable]` with the skills listed in the system prompt's `<available_skills>` block, and `[Skills: User-Invoked]` with the rest.
- Ctrl+O expands both headers and lists each skill's path under its group. Scope headers no longer appear.
- After `/reload` pi rebuilds the banner, and the reload `session_start` re-applies the split.
