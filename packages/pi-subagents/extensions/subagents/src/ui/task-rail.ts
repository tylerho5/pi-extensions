import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatElapsed, type SubagentSnapshot } from "../domain.ts";
import type { SubagentReadModel } from "../manager.ts";

export class TaskRailController {
  expanded = false;
  showFinished = false;
  selectedId: string | undefined;
  private requestRender: (() => void) | undefined;

  attach(requestRender: () => void) {
    this.requestRender = requestRender;
  }

  reset() {
    this.expanded = false;
    this.selectedId = undefined;
    this.requestRender?.();
  }

  /**
   * Reveal finished subagents alongside running ones. Used by the keyboard
   * handler when the user navigates to the bottom of the running list, or
   * when opening the rail with no running subagents to show.
   */
  revealFinished() {
    if (this.showFinished) return false;
    this.showFinished = true;
    // Don't reset `selectedId` here: the next render will reconcile against
    // the new visible list and preserve a selection that is still in scope.
    this.requestRender?.();
    return true;
  }

  toggleExpanded() {
    this.expanded = !this.expanded;
    this.requestRender?.();
  }

  reconcile(visible: ReadonlyArray<SubagentSnapshot>) {
    if (visible.some((snap) => snap.id === this.selectedId)) return;
    this.selectedId = visible[0]?.id;
  }

  /**
   * Move the selection by `delta` without wrapping. Returns:
   * - `"moved"` when the selection changed,
   * - `"atTop"` when `delta` was negative and the selection was already at
   *   the first item (callers close the rail in response),
   * - `"atBottom"` when `delta` was positive and the selection was already
   *   at the last item (callers may reveal finished subagents).
   */
  move(
    visible: ReadonlyArray<SubagentSnapshot>,
    delta: number,
  ): "moved" | "atTop" | "atBottom" {
    this.reconcile(visible);
    if (visible.length === 0) return "atBottom";
    const index = Math.max(
      0,
      visible.findIndex((snap) => snap.id === this.selectedId),
    );
    if (delta < 0 && index === 0) return "atTop";
    if (delta > 0 && index === visible.length - 1) return "atBottom";
    this.selectedId = visible[index + delta]?.id;
    this.requestRender?.();
    return "moved";
  }
}

function active(snap: SubagentSnapshot) {
  return snap.status === "running";
}

export function visibleRailSubagents(
  view: SubagentReadModel,
  controller: TaskRailController,
) {
  const all = view.list().filter((snap) => snap.origin === "model");
  const running = all.filter(active);
  return controller.showFinished
    ? [...running, ...all.filter((snap) => !active(snap))]
    : running;
}

function summary(view: SubagentReadModel) {
  const all = view.list().filter((snap) => snap.origin === "model");
  const running = all.filter(active).length;
  const finished = all.length - running;
  return { running, finished };
}

function stateText(snap: SubagentSnapshot, theme: Theme) {
  if (snap.status === "running") return theme.fg("warning", "running");
  if (snap.status === "done") return theme.fg("success", "done");
  return theme.fg("error", "failed");
}

export function createTaskRail(
  view: SubagentReadModel,
  controller: TaskRailController,
  theme: Theme,
  requestRender: () => void,
) {
  controller.attach(requestRender);
  const unsubscribe = view.subscribe(requestRender);

  return {
    dispose() {
      unsubscribe();
    },
    invalidate() {},
    render(width: number) {
      const { running, finished } = summary(view);
      if (running === 0 && finished === 0) return [];

      const visible = visibleRailSubagents(view, controller);
      controller.reconcile(visible);
      const header = controller.showFinished ? "Subagents · all" : "Subagents";
      const hint = controller.expanded ? "enter view" : "↓↓ focus";
      // Segments joined with dim separators (rather than one muted wrap) so
      // the colored count squares don't reset the surrounding styling.
      const segments = [
        theme.fg("accent", "↗ ") + theme.fg("toolTitle", header),
      ];
      if (running > 0)
        segments.push(theme.fg("success", `■ ${running} running`));
      if (finished > 0)
        segments.push(
          theme.fg("warning", `■ ${finished} finished`) +
            (controller.showFinished ? "" : theme.fg("dim", " hidden")),
        );
      segments.push(theme.fg("muted", hint));
      const lines = [
        truncateToWidth(segments.join(theme.fg("dim", " · ")), width),
      ];
      if (!controller.expanded) return lines;

      for (const snap of visible.slice(0, 8)) {
        const selected = snap.id === controller.selectedId;
        const marker = selected ? theme.fg("accent", "❯") : " ";
        const title = selected
          ? theme.fg("accent", snap.title)
          : theme.fg("text", snap.title);
        const right =
          theme.fg("muted", ` · ${formatElapsed(snap)} · `) +
          stateText(snap, theme);
        const left = `${marker} ${title}${theme.fg("dim", ` ${snap.id}`)}`;
        const available = Math.max(1, width - visibleWidth(right));
        lines.push(truncateToWidth(left, available) + right);
      }
      if (visible.length === 0)
        lines.push(theme.fg("dim", "  no running subagents"));
      if (visible.length > 8)
        lines.push(theme.fg("dim", `  … ${visible.length - 8} more`));
      return lines;
    },
  };
}
