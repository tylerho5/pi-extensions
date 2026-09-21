/**
 * The live per-run rail: a `belowEditor` widget that mirrors the subagents
 * task rail for workflow runs. It reads the active-runs map through a getter on
 * every render, so run details that mutate in place (currentPhase, the growing
 * agents array) stay current without a subscription.
 *
 * The widget is hidden while nothing runs. While a run is live, a 1 Hz tick
 * repaints the elapsed times, and `updateIndicator()` additionally calls
 * `requestRender` on state transitions so a launch or settle shows immediately
 * instead of waiting for the next tick.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  countStates,
  formatElapsed,
  stateSquare,
  statusSquare,
  type WorkflowDetails,
  type WorkflowStatus,
} from "./model.ts";

/** Rows the rail can occupy; longer lists collapse into a `… N more` line. */
export const MAX_RAIL_ROWS = 8;

export interface WorkflowRailRow {
  runId: string;
  label: string;
  status: WorkflowStatus;
  phase?: string;
  done: number;
  total: number;
  elapsed: string;
}

export interface WorkflowRailModel {
  running: number;
  finished: number;
  rows: WorkflowRailRow[];
  hidden: number;
}

/** Newest-first rows over the active runs, capped at `MAX_RAIL_ROWS`. */
export function workflowRailModel(
  active: ReadonlyMap<string, WorkflowDetails>,
  finished: number,
): WorkflowRailModel {
  const runs = [...active.values()].sort((a, b) => b.startedAt - a.startedAt);
  const rows = runs.slice(0, MAX_RAIL_ROWS).map((details) => {
    const { done, failed } = countStates(details);
    return {
      runId: details.runId,
      label: details.name ?? details.runId,
      status: details.status,
      ...(details.currentPhase ? { phase: details.currentPhase } : {}),
      done: done + failed,
      total: details.agents.length,
      elapsed: formatElapsed(details.startedAt, details.finishedAt),
    };
  });
  return {
    running: runs.length,
    finished,
    rows,
    hidden: Math.max(0, runs.length - MAX_RAIL_ROWS),
  };
}

/** Rail lines for one model. Every line is truncated to the terminal width. */
export function renderWorkflowRail(
  model: WorkflowRailModel,
  theme: Theme,
  width: number,
): string[] {
  if (model.running === 0) return [];
  const segments = [
    theme.fg("accent", "↗ ") + theme.fg("toolTitle", "workflows"),
    // The square is colored by stateSquare and the count separately, matching
    // formatActivityStatus without nesting one color reset inside another.
    stateSquare("running", theme) +
      theme.fg("warning", ` ${model.running} running`),
    stateSquare("done", theme) +
      theme.fg("success", ` ${model.finished} finished`),
  ];
  const lines = [truncateToWidth(segments.join(theme.fg("dim", " · ")), width)];
  for (const row of model.rows) {
    let line =
      `  ${statusSquare(row.status, theme)} ` + theme.fg("accent", row.label);
    if (row.phase) line += theme.fg("dim", ` · ${row.phase}`);
    line += theme.fg(
      "dim",
      ` · ${row.done}/${row.total} agents · ${row.elapsed}`,
    );
    lines.push(truncateToWidth(line, width));
  }
  if (model.hidden > 0)
    lines.push(
      truncateToWidth(theme.fg("dim", `  … ${model.hidden} more`), width),
    );
  return lines;
}

/** The widget component: hidden while idle, fresh state on every render. */
export function createWorkflowRail(
  getActive: () => Map<string, WorkflowDetails>,
  getFinished: () => number,
  theme: Theme,
  requestRender: () => void,
) {
  // Elapsed times tick at 1 Hz. The tick is skipped while idle so a hidden
  // rail does not repaint the TUI; state transitions repaint through
  // updateIndicator instead.
  const ticker = setInterval(() => {
    if (getActive().size === 0) return;
    requestRender();
  }, 1000);

  return {
    dispose() {
      clearInterval(ticker);
    },
    invalidate() {},
    render(width: number) {
      const active = getActive();
      if (active.size === 0) return [];
      return renderWorkflowRail(
        workflowRailModel(active, getFinished()),
        theme,
        width,
      );
    },
  };
}
