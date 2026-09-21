import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatElapsed, type SubagentSnapshot } from "../domain.ts";
import { formatContextUtilization, formatCost } from "../format.ts";
import type { SubagentReadModel } from "../manager.ts";

/** Window for the collapsed down double-tap that opens the rail. */
export const DOUBLE_TAP_MS = 500;

export class TaskRailController {
  expanded = false;
  showFinished = false;
  selectedId: string | undefined;
  private scrollTop = 0;
  private lastDownTapAt: number | undefined;
  private requestRender: (() => void) | undefined;

  attach(requestRender: () => void) {
    this.requestRender = requestRender;
  }

  reset() {
    this.expanded = false;
    this.selectedId = undefined;
    this.scrollTop = 0;
    this.lastDownTapAt = undefined;
    this.requestRender?.();
  }

  /**
   * A down tap while the rail is collapsed. A lone tap returns false so the
   * key reaches normal editor navigation; a second tap inside DOUBLE_TAP_MS
   * opens the rail and returns true so the caller consumes it.
   */
  handleCollapsedDown(now: number): boolean {
    const previous = this.lastDownTapAt;
    this.lastDownTapAt = now;
    if (previous === undefined || now - previous > DOUBLE_TAP_MS) return false;
    this.lastDownTapAt = undefined;
    this.toggleExpanded();
    return true;
  }

  /** Drop a pending first tap when the gesture no longer applies. */
  clearTap() {
    this.lastDownTapAt = undefined;
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
   * First index of the rendered window: keeps the selection on screen by
   * scrolling only when it would leave the `rows`-sized window, and clamps
   * against a list that shrank since the last render.
   */
  windowOffset(visible: ReadonlyArray<SubagentSnapshot>, rows: number) {
    this.reconcile(visible);
    const index = visible.findIndex((snap) => snap.id === this.selectedId);
    if (index < 0) return 0;
    if (index < this.scrollTop) this.scrollTop = index;
    if (index >= this.scrollTop + rows) this.scrollTop = index - rows + 1;
    const maxOffset = Math.max(0, visible.length - rows);
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxOffset));
    return this.scrollTop;
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

/** Rows the expanded rail can occupy; longer lists scroll with the selection. */
const MAX_RAIL_ROWS = 8;

/** Running rows the auto (unexpanded) rail shows before a `… N more` line. */
const MAX_AUTO_ROWS = 4;

/** Braille spinner frames; the rail's ticker advances one per second. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⢼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
  switch (snap.status) {
    case "running":
      return theme.fg("warning", "running");
    case "done":
      return theme.fg("success", "done");
    case "cancelled":
      return theme.fg("warning", "cancelled");
    default:
      return theme.fg("error", "failed");
  }
}

/**
 * One auto row: spinner, description, then cost, elapsed, and ctx% as dim
 * segments. Under width pressure the segments drop in the order cost, ctx%,
 * elapsed; after that the description truncates but keeps an 8-column floor.
 */
function autoRow(
  snap: SubagentSnapshot,
  theme: Theme,
  width: number,
  frame: string,
) {
  const segments = [
    { key: "cost", text: formatCost(snap.usage.costUsd) },
    { key: "ctx", text: formatContextUtilization(snap.usage) },
    { key: "elapsed", text: formatElapsed(snap) },
  ].filter((segment) => segment.text.length > 0);
  const prefix = theme.fg("warning", frame) + " ";
  let kept = segments;
  const compose = (parts: typeof segments) =>
    prefix +
    theme.fg("text", snap.description) +
    (parts.length
      ? theme.fg("dim", " · ") +
        parts
          .map((segment) => theme.fg("dim", segment.text))
          .join(theme.fg("dim", " · "))
      : "");
  for (const key of ["cost", "ctx", "elapsed"]) {
    const row = compose(kept);
    if (visibleWidth(row) <= width) return row;
    kept = kept.filter((segment) => segment.key !== key);
  }
  const suffix = kept.length
    ? theme.fg("dim", " · ") +
      kept
        .map((segment) => theme.fg("dim", segment.text))
        .join(theme.fg("dim", " · "))
    : "";
  const available = Math.max(
    8,
    width - visibleWidth(prefix) - visibleWidth(suffix),
  );
  const description = truncateToWidth(
    theme.fg("text", snap.description),
    available,
  );
  return truncateToWidth(prefix + description + suffix, width);
}

export function createTaskRail(
  view: SubagentReadModel,
  controller: TaskRailController,
  theme: Theme,
  requestRender: () => void,
) {
  controller.attach(requestRender);
  let spinnerFrame = 0;
  let ticker: ReturnType<typeof setInterval> | undefined;
  const anyRunning = () => summary(view).running > 0;
  // The ticker exists only while something runs: it animates the auto rows'
  // spinner, so an idle rail pays nothing.
  const syncTicker = () => {
    if (anyRunning()) {
      ticker ??= setInterval(() => {
        spinnerFrame += 1;
        requestRender();
      }, 1000);
      return;
    }
    if (ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
  };
  syncTicker();
  const unsubscribe = view.subscribe(() => {
    syncTicker();
    requestRender();
  });

  return {
    dispose() {
      if (ticker !== undefined) clearInterval(ticker);
      ticker = undefined;
      unsubscribe();
    },
    invalidate() {},
    render(width: number) {
      const { running, finished } = summary(view);
      const selectable = controller.expanded;
      // Collapsed and idle: the rail is fully hidden. The down double-tap
      // still expands for browsing finished agents.
      if (!selectable && running === 0) return [];

      const header = controller.showFinished ? "Subagents · all" : "Subagents";
      const hint = selectable ? "enter view" : "↓↓ select";
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

      if (!selectable) {
        // Auto state: running model-origin agents only, no selection state.
        const rows = view
          .list()
          .filter((snap) => snap.origin === "model" && active(snap))
          .slice(0, MAX_AUTO_ROWS);
        const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!;
        for (const snap of rows) lines.push(autoRow(snap, theme, width, frame));
        const more = running - rows.length;
        if (more > 0) lines.push(theme.fg("dim", `  … ${more} more`));
        return lines;
      }

      const visible = visibleRailSubagents(view, controller);
      const start = controller.windowOffset(visible, MAX_RAIL_ROWS);
      const windowed = visible.slice(start, start + MAX_RAIL_ROWS);
      for (const snap of windowed) {
        const selected = snap.id === controller.selectedId;
        const marker = selected ? theme.fg("accent", "❯") : " ";
        const label = selected
          ? theme.fg("accent", snap.description)
          : theme.fg("text", snap.description);
        const right =
          theme.fg("muted", ` · ${formatElapsed(snap)} · `) +
          stateText(snap, theme);
        const left = `${marker} ${label}${theme.fg("dim", ` ${snap.id}`)}`;
        const available = Math.max(1, width - visibleWidth(right));
        lines.push(truncateToWidth(left, available) + right);
      }
      if (visible.length === 0)
        lines.push(theme.fg("dim", "  no running subagents"));
      const above = start;
      const below = visible.length - start - windowed.length;
      const indicators = [
        ...(above > 0 ? [`↑ ${above} above`] : []),
        ...(below > 0 ? [`… ${below} more`] : []),
      ];
      if (indicators.length > 0)
        lines.push(theme.fg("dim", `  ${indicators.join(" · ")}`));
      return lines;
    },
  };
}
