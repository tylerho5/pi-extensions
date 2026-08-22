# @tylerho/pi-skills-banner-split

Splits the startup banner's Skills section into model-invokable and user-invoked groups.

## Install

`pi install npm:@tylerho/pi-skills-banner-split`

---

> **Prototype:** This package patches pi internals and may break with pi version updates. Pin your pi version and expect to update it when pi changes.

# Skills Banner Split

Splits the startup banner's `[Skills]` section into two sections — `[Skills: Model-Invokable]` and `[Skills: User-Invoked]` — so the loaded-resources listing distinguishes skills the model can auto-load from skills gated behind explicit `/skill:name` invocation (`disable-model-invocation: true` in frontmatter).

## Key concepts

- **Runtime mutation of the live component tree, no dist patching.** pi core renders the banner in `interactive-mode.js`'s `showLoadedResources()` with no extension hook, and `ExpandableText` is a module-local class (not re-exported, so the prototype-patch approach from `collapsed-previews` is unavailable). Instead the extension walks `tui.children` (the TUI root is a `Container` whose direct children include `documentContainer` → `loadedResourcesContainer`), finds the section whose `getCollapsedText()` starts with `[Skills]`, and rewrites its `getCollapsedText`/`getExpandedText` getters in place, then calls `setExpanded(wasExpanded)` to re-render. Ctrl+O toggles keep working because pi's toggle broadcast calls `setExpanded` on the same instance, which re-invokes the new getters.
- **TUI capture via throwaway widget factory.** Extensions get no direct handle to the TUI instance, but `ctx.ui.setWidget(key, factory)` invokes the factory synchronously with the stable TUI proxy (`createInteractiveTuiReference`, which survives renderer swaps). The extension registers a zero-line widget, captures the `tui` argument, and immediately removes the widget.
- **Split source of truth is the system prompt, not the filesystem.** The model-invokable set is parsed from the `<available_skills>` `<name>` entries in `ctx.getSystemPrompt()` (which is exactly what the model sees); banner names absent from it are user-invoked. No SKILL.md scanning, no skill-path discovery.
- **Deferred application with retry.** `session_start` fires before `showLoadedResources()` populates the banner (both on startup and on `/reload`, which emits `session_start` with reason `"reload"`), and `showLoadedResources()` clears and recreates the container — so the split is applied from a `setTimeout(0)` with up to 20 retries at 100ms until the `[Skills]` section exists. Quiet-startup sessions skip the banner; retries exhaust silently.
- **No-op guards.** If the banner is already split (text contains "Model-Invokable"), or either group would be empty, the banner is left untouched.
- **Expanded view is re-bucketed by name-in-path.** The original expanded body is scope-grouped skill paths; each line is assigned to the group whose skill name appears as a `/<name>/` path segment. Scope and package header lines match no name and are dropped, so the expanded view loses scope grouping in exchange for the split.

## API

No tools, commands, events beyond one `session_start` handler, shortcuts, or config. TUI mode only (`ctx.mode !== "tui"` bails).

### Exports

- Default export: `function (pi: ExtensionAPI)` — the standard extension entry point; only public surface.

## Examples

- **Startup banner** shows `[Skills: Model-Invokable]` (skills in the system prompt's `<available_skills>`) and `[Skills: User-Invoked]` (the rest, e.g. `disable-model-invocation: true` skills) instead of one merged `[Skills]` list.
- **After editing this extension** — run `/reload`; the banner is recreated by pi and the split re-applies via the reload `session_start`.
