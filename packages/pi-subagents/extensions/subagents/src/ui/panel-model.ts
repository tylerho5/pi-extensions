/**
 * Membership, order, and windowing for the agent panel under the prompt. Pure
 * functions of (snapshots, now, selection) so the lifecycle can be checked
 * exhaustively: a run that finishes leaves the panel on its settle event, a
 * failed or stopped run lingers for a fixed time, and a running agent always
 * appears in the row list.
 */

import type { SubagentSnapshot, SubagentStatus } from "../domain.ts";

/** How long a settled row stays in the panel, per status. */
export const PANEL_LINGER_MS: Readonly<Record<SubagentStatus, number>> = {
  running: Number.POSITIVE_INFINITY,
  done: 0,
  error: 30_000,
  cancelled: 30_000,
};

export const PANEL_MAX_ROWS = 5;

export interface PanelRow {
  readonly snap: SubagentSnapshot;
  /** 0 for a root row; children of a shown parent nest one level deeper. */
  readonly depth: number;
  /** Last sibling under its shown parent (└ instead of ├). */
  readonly lastSibling: boolean;
}

export function inPanel(snap: SubagentSnapshot, now: number): boolean {
  if (snap.origin !== "model") return false;
  if (snap.status === "running") return true;
  const settledAt = snap.settledAt ?? 0;
  return now - settledAt < PANEL_LINGER_MS[snap.status];
}

/**
 * Shown agents in tree order: roots by creation time, each followed by its
 * shown descendants. A child whose parent left the panel is promoted to a
 * root, so a running agent never disappears with its parent.
 */
export function panelRows(
  snaps: ReadonlyArray<SubagentSnapshot>,
  now: number,
): PanelRow[] {
  const shown = snaps
    .filter((snap) => inPanel(snap, now))
    .sort((a, b) => a.createdAt - b.createdAt);
  const ids = new Set(shown.map((snap) => snap.id));
  const parentOf = (snap: SubagentSnapshot) => {
    const parent = snap.ancestry?.parentId;
    return parent && ids.has(parent) && parent !== snap.id ? parent : undefined;
  };
  const children = new Map<string, SubagentSnapshot[]>();
  for (const snap of shown) {
    const parent = parentOf(snap);
    if (parent) children.set(parent, [...(children.get(parent) ?? []), snap]);
  }
  const rows: PanelRow[] = [];
  const visit = (snap: SubagentSnapshot, depth: number, last: boolean) => {
    rows.push({ snap, depth, lastSibling: last });
    const kids = children.get(snap.id) ?? [];
    kids.forEach((kid, i) => visit(kid, depth + 1, i === kids.length - 1));
  };
  const roots = shown.filter((snap) => !parentOf(snap));
  roots.forEach((snap, i) => visit(snap, 0, i === roots.length - 1));
  return rows;
}

/** The next moment a lingering row expires, so the caller can re-render then. */
export function nextExpiry(
  snaps: ReadonlyArray<SubagentSnapshot>,
  now: number,
): number | undefined {
  let next: number | undefined;
  for (const snap of snaps) {
    if (snap.origin !== "model" || snap.status === "running") continue;
    const at = (snap.settledAt ?? 0) + PANEL_LINGER_MS[snap.status];
    if (at > now && (next === undefined || at < next)) next = at;
  }
  return next;
}

export interface PanelWindow {
  readonly rows: ReadonlyArray<PanelRow>;
  readonly above: number;
  readonly below: number;
  /** The selection after reconciling against the current rows. */
  readonly selectedId: string | undefined;
  readonly scrollTop: number;
}

/**
 * Keep the selection on a shown row (the row that took its place when it
 * left, else the last row) and scroll only as far as needed to show it.
 */
export function panelWindow(
  rows: ReadonlyArray<PanelRow>,
  selection: {
    readonly selectedId?: string;
    readonly selectedIndex?: number;
    readonly scrollTop: number;
  },
  max = PANEL_MAX_ROWS,
): PanelWindow {
  let index = rows.findIndex((row) => row.snap.id === selection.selectedId);
  if (index < 0 && selection.selectedId !== undefined && rows.length > 0)
    index = Math.min(selection.selectedIndex ?? 0, rows.length - 1);
  let top = Math.max(0, Math.min(selection.scrollTop, rows.length - max));
  if (index >= 0) {
    if (index < top) top = index;
    if (index >= top + max) top = index - max + 1;
  }
  const windowed = rows.slice(top, top + max);
  return {
    rows: windowed,
    above: top,
    below: rows.length - top - windowed.length,
    selectedId: index >= 0 ? rows[index]!.snap.id : undefined,
    scrollTop: top,
  };
}
