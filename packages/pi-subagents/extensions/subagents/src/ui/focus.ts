/**
 * Focus detection for the task-rail keyboard gesture.
 *
 * The down-double-tap that opens the task rail must only fire from the
 * default editor view. pi-tui tracks focus through the public
 * `Focusable.focused` flag, which is set on exactly one component at a time.
 * Overlay components live outside the TUI's children tree, so a focused
 * overlay is invisible to the walk and correctly reads as "not the editor".
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { Container, isFocusable, type Component } from "@earendil-works/pi-tui";

/**
 * Find the component that currently holds TUI focus, if any. The root is a
 * `Container` (the TUI itself) rather than `Component`: TUI's private
 * `handleInput` member makes it unassignable to `Component`, and the walk
 * only needs the children tree.
 */
export function findFocusedComponent(root: Container): Component | undefined {
  if (isFocusable(root) && root.focused) return root;
  for (const child of root.children) {
    const found = findFocusedComponentIn(child);
    if (found) return found;
  }
  return undefined;
}

function findFocusedComponentIn(component: Component): Component | undefined {
  if (isFocusable(component) && component.focused) return component;
  if (component instanceof Container) {
    for (const child of component.children) {
      const found = findFocusedComponentIn(child);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * True when the focused component is the default editor — the plain editor
 * view with no modal open. While a modal (model selector, settings, extension
 * dialogs, overlays) has focus, down/up/enter belong to that component, so
 * the task-rail gesture must not touch them.
 */
export function isDefaultEditorFocused(
  focused: Component | undefined,
): focused is CustomEditor {
  return focused instanceof CustomEditor;
}
