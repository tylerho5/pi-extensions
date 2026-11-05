import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatElapsedBetween, type SubagentSnapshot } from "../domain.ts";
import { formatCompactTokens, formatCost } from "../format.ts";
import type { SubagentReadModel } from "../manager.ts";
import { spinnerGlyph } from "./activity-row.ts";
import {
  nextExpiry,
  PANEL_MAX_ROWS,
  panelRows,
  panelWindow,
  type PanelRow,
} from "./panel-model.ts";

/** Window for the down double-tap that focuses the panel. */
export const DOUBLE_TAP_MS = 500;

/**
 * Focus and selection for the agent panel under the prompt. Membership comes
 * from `panelRows`; this only tracks where the user is in it.
 */
export class TaskRailController {
  expanded = false;
  selectedId: string | undefined;
  private selectedIndex = 0;
  private scrollTop = 0;
  private lastDownTapAt: number | undefined;
  private requestRender: (() => void) | undefined;

  attach(requestRender: () => void) {
    this.requestRender = requestRender;
  }

  reset() {
    this.expanded = false;
    this.selectedId = undefined;
    this.selectedIndex = 0;
    this.scrollTop = 0;
    this.lastDownTapAt = undefined;
    this.requestRender?.();
  }

  /**
   * A down tap while unfocused. A lone tap returns false so the key reaches
   * the editor; a second tap inside DOUBLE_TAP_MS focuses the panel.
   */
  handleCollapsedDown(now: number, rows: ReadonlyArray<PanelRow>): boolean {
    const previous = this.lastDownTapAt;
    this.lastDownTapAt = now;
    if (previous === undefined || now - previous > DOUBLE_TAP_MS) return false;
    this.lastDownTapAt = undefined;
    if (rows.length === 0) return false;
    this.expanded = true;
    this.selectedId = rows[0]!.snap.id;
    this.selectedIndex = 0;
    this.requestRender?.();
    return true;
  }

  clearTap() {
    this.lastDownTapAt = undefined;
  }

  /** Reconcile against the current rows; a focused panel that emptied closes. */
  window(rows: ReadonlyArray<PanelRow>, max = PANEL_MAX_ROWS) {
    const view = panelWindow(
      rows,
      {
        selectedId: this.expanded ? this.selectedId : undefined,
        selectedIndex: this.selectedIndex,
        scrollTop: this.scrollTop,
      },
      max,
    );
    this.scrollTop = view.scrollTop;
    if (this.expanded) {
      this.selectedId = view.selectedId;
      if (view.selectedId === undefined) this.expanded = false;
      else
        this.selectedIndex = rows.findIndex(
          (row) => row.snap.id === view.selectedId,
        );
    }
    return view;
  }

  /** Move without wrapping; "atTop" lets the caller hand focus back. */
  move(
    rows: ReadonlyArray<PanelRow>,
    delta: number,
  ): "moved" | "atTop" | "atBottom" {
    this.window(rows);
    if (rows.length === 0) return "atBottom";
    const index = Math.max(0, this.selectedIndex);
    if (delta < 0 && index === 0) return "atTop";
    if (delta > 0 && index === rows.length - 1) return "atBottom";
    this.selectedIndex = index + delta;
    this.selectedId = rows[this.selectedIndex]?.snap.id;
    this.requestRender?.();
    return "moved";
  }
}

export function railRows(view: SubagentReadModel, now = Date.now()) {
  return panelRows(view.list(), now);
}

function glyph(snap: SubagentSnapshot, theme: Theme, frame: number) {
  switch (snap.status) {
    case "running":
      return theme.fg("warning", spinnerGlyph(frame));
    case "done":
      return theme.fg("success", "✔");
    case "error":
      return theme.fg("error", "✘");
    case "cancelled":
      return theme.fg("warning", "✘");
  }
}

function activity(
  snap: SubagentSnapshot,
  progress: string | undefined,
  theme: Theme,
  selected: boolean,
) {
  if (snap.status === "error")
    return theme.fg(
      "error",
      `Failed: ${(snap.errorText ?? "error").split("\n")[0]}`,
    );
  if (snap.status === "cancelled") return theme.fg("warning", "Stopped");
  const text = progress || snap.description;
  return selected ? theme.fg("text", text) : theme.fg("dim", text);
}

function stats(snap: SubagentSnapshot, theme: Theme, now: number) {
  const end = snap.status === "running" ? now : (snap.settledAt ?? now);
  const parts = [
    formatElapsedBetween(snap.runStartedAt ?? snap.createdAt, end),
  ];
  if (snap.usage.tokens && snap.usage.tokens > 0)
    parts.push(`↓ ${formatCompactTokens(snap.usage.tokens)} tokens`);
  const cost = formatCost(snap.usage.costUsd);
  if (cost) parts.push(cost);
  const queued = snap.queued.length;
  return (
    theme.fg("dim", parts.join(" · ")) +
    (queued > 0 ? theme.fg("warning", ` · ${queued} queued`) : "")
  );
}

function treePrefix(row: PanelRow, theme: Theme) {
  if (row.depth === 0) return "";
  return theme.fg(
    "dim",
    "  ".repeat(row.depth - 1) + (row.lastSibling ? "└ " : "├ "),
  );
}

/**
 * One row: pointer, tree connector, status glyph, name column, activity
 * (progress line, else description), and right-aligned stats. Under width
 * pressure the activity truncates first, then the stats.
 */
function panelLine(options: {
  row: PanelRow;
  nameWidth: number;
  selected: boolean;
  progress: string | undefined;
  theme: Theme;
  width: number;
  frame: number;
  now: number;
}) {
  const { row, nameWidth, selected, progress, theme, width, frame, now } =
    options;
  const snap = row.snap;
  const pointer = selected ? theme.fg("accent", "❯ ") : "  ";
  const prefix =
    pointer + treePrefix(row, theme) + glyph(snap, theme, frame) + " ";
  const room = Math.max(4, nameWidth - visibleWidth(treePrefix(row, theme)));
  const name = truncateToWidth(snap.id, room);
  const nameCell =
    (selected ? theme.fg("accent", name) : theme.fg("text", name)) +
    " ".repeat(Math.max(0, room - visibleWidth(name)));
  const right = truncateToWidth(
    stats(snap, theme, now),
    Math.max(0, width - 12),
  );
  const left = prefix + nameCell + "  ";
  const available = width - visibleWidth(left) - visibleWidth(right) - 1;
  const act =
    available > 0
      ? truncateToWidth(activity(snap, progress, theme, selected), available)
      : "";
  const gap = Math.max(
    1,
    width - visibleWidth(left) - visibleWidth(act) - visibleWidth(right),
  );
  return truncateToWidth(left + act + " ".repeat(gap) + right, width);
}

export function createTaskRail(
  view: SubagentReadModel,
  controller: TaskRailController,
  theme: Theme,
  requestRender: () => void,
  progressFor: (id: string) => string | undefined = () => undefined,
  clock: () => number = Date.now,
) {
  controller.attach(requestRender);
  let frame = 0;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  // The spinner ticks only while something runs; a lingering row arms one
  // timer for its expiry, so an idle panel costs nothing.
  const sync = () => {
    const snaps = view.list();
    const running = snaps.some(
      (snap) => snap.origin === "model" && snap.status === "running",
    );
    if (running) {
      ticker ??= setInterval(() => {
        frame += 1;
        requestRender();
      }, 1000);
    } else if (ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
    if (expiry !== undefined) clearTimeout(expiry);
    expiry = undefined;
    const now = clock();
    const at = nextExpiry(snaps, now);
    if (at !== undefined)
      expiry = setTimeout(() => {
        expiry = undefined;
        sync();
        requestRender();
      }, at - now);
    expiry?.unref?.();
  };
  sync();
  const unsubscribe = view.subscribe(() => {
    sync();
    requestRender();
  });

  return {
    dispose() {
      if (ticker !== undefined) clearInterval(ticker);
      if (expiry !== undefined) clearTimeout(expiry);
      ticker = undefined;
      expiry = undefined;
      unsubscribe();
    },
    invalidate() {},
    render(width: number) {
      const rows = railRows(view, clock());
      const window = controller.window(rows);
      if (rows.length === 0) return [];
      const nameWidth = Math.min(
        28,
        Math.max(
          4,
          ...rows.map(
            (row) => row.snap.id.length + (row.depth > 0 ? row.depth * 2 : 0),
          ),
        ),
      );
      const lines: string[] = [];
      if (window.above > 0)
        lines.push(theme.fg("dim", `  ↑ ${window.above} more`));
      for (const row of window.rows)
        lines.push(
          panelLine({
            row,
            nameWidth,
            selected: controller.expanded && row.snap.id === window.selectedId,
            progress: progressFor(row.snap.id),
            theme,
            width,
            frame,
            now: clock(),
          }),
        );
      if (window.below > 0)
        lines.push(theme.fg("dim", `  ↓ ${window.below} more`));
      const selected = rows.find((row) => row.snap.id === window.selectedId);
      const hint = controller.expanded
        ? [
            "↑/↓ to select",
            "enter to view",
            ...(selected?.snap.status === "running" ? ["x to stop"] : []),
            "esc to close",
            "/subagents for history",
          ]
        : ["↓↓ to manage"];
      lines.push(
        truncateToWidth(theme.fg("dim", "  " + hint.join(" · ")), width),
      );
      return lines;
    },
  };
}
