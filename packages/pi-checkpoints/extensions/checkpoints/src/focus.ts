/**
 * Focus detection for the double-Escape gesture.
 *
 * Raw terminal input reaches an extension before the focused component, so the gesture
 * has to tell the chat editor from a modal by itself. pi-tui marks focus with
 * `Focusable.focused` on exactly one component; overlays live outside the TUI's children
 * tree, so a focused overlay reads as "not the editor", which is the right answer here.
 *
 * The same walk runs in `extensions/subagents` for its task-rail gesture. The two are
 * kept separate rather than shared, so neither extension pulls in the other's modules.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { Container, isFocusable, type Component } from "@earendil-works/pi-tui";

/**
 * Find the component that currently holds TUI focus, if any. The root is a `Container`
 * (the TUI itself) rather than `Component`: TUI's private `handleInput` member makes it
 * unassignable to `Component`, and the walk only needs the children tree.
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
 * True when the focused component is the chat editor. While a modal (model selector,
 * settings, extension dialogs, overlays) has focus, Escape belongs to that component.
 */
export function isDefaultEditorFocused(
  focused: Component | undefined,
): focused is CustomEditor {
  return focused instanceof CustomEditor;
}
