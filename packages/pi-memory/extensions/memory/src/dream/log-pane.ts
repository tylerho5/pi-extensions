/**
 * The `/dream-log` panel — a full-width dock that opens directly above the
 * footer (bottom-anchored overlay, so the footer stays visible underneath and
 * the whole thing reads as the footer extending upward). Newest-first, with
 * keyboard scrolling and per-entry expansion showing the dream's model, the
 * memories it created/edited/removed, and its own summary.
 *
 * Height adapts to the terminal (≤45% of rows); the log file is re-read on
 * open and on `r`, so a dream finishing while the panel is open shows up
 * without closing it. pi overlays draw no chrome of their own — every line is
 * padded to full width so chat can't bleed through.
 */

import type {
  ExtensionCommandContext,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { formatCompactTokens } from "../../../shared/context-utilization.ts";
import {
  readDreamLog,
  type DreamLogEntry,
  type DreamLogStatus,
} from "./log.ts";

/** Fraction of terminal rows the panel may occupy, borders included. */
const MAX_HEIGHT_RATIO = 0.45;
const DETAIL_INDENT = "      ";

type LineKind = "entry" | "detail" | "summary";

interface LineMeta {
  kind: LineKind;
  status?: DreamLogStatus;
}

interface Layout {
  lines: string[];
  meta: LineMeta[];
  /** For each entry, the [start, end) line range in `lines`. */
  ranges: Array<[number, number]>;
}

export class DreamLogPane {
  onClose?: () => void;
  onReload?: () => void;

  private entries: DreamLogEntry[];
  private selected = 0;
  private expanded = new Set<string>();
  private scroll = 0;
  private viewport = 8;
  private cachedWidth?: number;
  private cached?: Layout;

  constructor(entries: DreamLogEntry[]) {
    this.entries = entries;
  }

  setEntries(entries: DreamLogEntry[]): void {
    this.entries = entries;
    this.selected = Math.min(this.selected, Math.max(0, entries.length - 1));
    this.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) this.move(-1);
    else if (matchesKey(data, Key.down)) this.move(1);
    else if (matchesKey(data, Key.pageUp)) this.move(-this.viewport);
    else if (matchesKey(data, Key.pageDown)) this.move(this.viewport);
    else if (matchesKey(data, Key.enter)) this.toggleSelected();
    else if (matchesKey(data, "r")) this.onReload?.();
    else if (matchesKey(data, Key.escape) || matchesKey(data, "q"))
      this.onClose?.();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cached = undefined;
  }

  render(width: number, theme: Theme, rows = 24): string[] {
    const innerW = Math.max(10, width - 2);
    this.viewport = Math.max(
      3,
      Math.floor(rows * MAX_HEIGHT_RATIO) - 2, // minus the two border rows
    );
    const pad = (line: string) =>
      theme.fg("border", "│") +
      truncateToWidth(line, innerW, "…", true) +
      theme.fg("border", "│");

    const noun = this.entries.length === 1 ? "run" : "runs";
    const title = theme.fg(
      "accent",
      ` ✦ Dream log · ${this.entries.length} ${noun} `,
    );
    const position =
      this.entries.length > 1
        ? theme.fg("dim", ` ${this.selected + 1}/${this.entries.length} `)
        : "";

    if (this.entries.length === 0) {
      return [
        this.borderLine("top", width, theme, title),
        pad(theme.fg("dim", "  No dreams logged yet.")),
        pad(
          theme.fg(
            "dim",
            "  Run /dream now, or wait for the idle trigger — every attempt lands in dreams.jsonl.",
          ),
        ),
        this.borderLine(
          "bottom",
          width,
          theme,
          theme.fg("dim", " r reload · esc close "),
        ),
      ];
    }

    const layout = this.buildLayout(innerW);
    this.clampScroll(layout);
    const end = Math.min(layout.lines.length, this.scroll + this.viewport);
    const body: string[] = [];
    for (let i = this.scroll; i < end; i++) {
      body.push(pad(this.themeLine(layout, i, theme, innerW)));
    }

    const more = [];
    if (this.scroll > 0) more.push("↑");
    if (end < layout.lines.length) more.push("↓");
    const hints = theme.fg(
      "dim",
      ` ↑↓ move · enter details · r reload · esc close ${more.join("")} `,
    );

    return [
      this.borderLine("top", width, theme, title, position),
      ...body,
      this.borderLine("bottom", width, theme, hints),
    ];
  }

  /** A border row with embedded left/right text: `╭─ left ──── right ╮`. */
  private borderLine(
    kind: "top" | "bottom",
    width: number,
    theme: Theme,
    left = "",
    right = "",
  ): string {
    const border = (c: string) => theme.fg("border", c);
    const [lc, rc] = kind === "top" ? ["╭", "╮"] : ["╰", "╯"];
    const fill = Math.max(
      0,
      width - visibleWidth(left) - visibleWidth(right) - 3, // corners + leading dash
    );
    return (
      border(`${lc}─`) + left + border("─".repeat(fill)) + right + border(rc)
    );
  }

  private move(delta: number): void {
    if (this.entries.length === 0) return;
    const next = Math.max(
      0,
      Math.min(this.entries.length - 1, this.selected + delta),
    );
    if (next === this.selected) return;
    this.selected = next;
    this.ensureVisible();
  }

  private toggleSelected(): void {
    const entry = this.entries[this.selected];
    if (!entry) return;
    if (this.expanded.has(entry.ts)) this.expanded.delete(entry.ts);
    else this.expanded.add(entry.ts);
    this.invalidate();
    this.ensureVisible();
  }

  /** Keep the selected entry's lines inside the viewport. */
  private ensureVisible(): void {
    if (this.cachedWidth === undefined) return;
    const layout = this.buildLayout(this.cachedWidth);
    const range = layout.ranges[this.selected];
    if (!range) return;
    const [start, end] = range;
    if (start < this.scroll) this.scroll = start;
    else if (end > this.scroll + this.viewport) {
      this.scroll = Math.max(start, end - this.viewport);
    }
  }

  private clampScroll(layout: Layout): void {
    const max = Math.max(0, layout.lines.length - this.viewport);
    this.scroll = Math.max(0, Math.min(this.scroll, max));
  }

  private buildLayout(width: number): Layout {
    if (this.cached && this.cachedWidth === width) return this.cached;
    const lines: string[] = [];
    const meta: LineMeta[] = [];
    const ranges: Array<[number, number]> = [];
    for (const entry of this.entries) {
      const start = lines.length;
      lines.push(
        truncateToWidth(
          `  ${formatLogTime(entry.ts)}  ${this.headline(entry)}`,
          width - 2, // selection prefix takes two columns
        ),
      );
      meta.push({ kind: "entry", status: entry.status });
      if (this.expanded.has(entry.ts)) {
        for (const detail of this.detailLines(entry, width)) {
          lines.push(detail.text);
          meta.push({ kind: detail.kind, status: entry.status });
        }
      }
      ranges.push([start, lines.length]);
    }
    this.cached = { lines, meta, ranges };
    this.cachedWidth = width;
    return this.cached;
  }

  private themeLine(
    layout: Layout,
    index: number,
    theme: Theme,
    width: number,
  ): string {
    const line = layout.lines[index];
    const meta = layout.meta[index];
    if (meta.kind === "summary") return truncateToWidth(line, width);
    if (meta.kind === "detail") {
      return theme.fg("dim", truncateToWidth(line, width));
    }
    const selected = this.entryIndexAt(layout, index) === this.selected;
    const prefix = selected ? "▸ " : "  ";
    const color = selected ? "accent" : statusColor(meta.status);
    return theme.fg(color, truncateToWidth(prefix + line, width));
  }

  /** Entry lines are the first line of their range, so index equality finds the entry. */
  private entryIndexAt(layout: Layout, lineIndex: number): number {
    for (let i = 0; i < layout.ranges.length; i++) {
      if (layout.ranges[i][0] === lineIndex) return i;
    }
    return -1;
  }

  private headline(entry: DreamLogEntry): string {
    const stats: string[] = [];
    if (entry.durationMs !== undefined)
      stats.push(formatDuration(entry.durationMs));
    if (entry.turns !== undefined) stats.push(`${entry.turns} turns`);
    if (entry.costUsd !== undefined) stats.push(`$${entry.costUsd.toFixed(2)}`);
    if (entry.tokens !== undefined)
      stats.push(`${formatCompactTokens(entry.tokens)} tok`);
    const delta = this.fileDelta(entry);
    if (delta) stats.push(delta);

    switch (entry.status) {
      case "completed":
        return `✓ ${entry.trigger} · ${stats.join(" · ")}`;
      case "aborted":
        return `■ ${entry.trigger} · stopped early · ${stats.join(" · ")}`;
      case "failed": {
        const detail = entry.summary ? `: ${entry.summary.split("\n")[0]}` : "";
        return `✗ ${entry.trigger} · failed${detail}`;
      }
      case "skipped":
        return `· ${entry.trigger} · skipped: ${entry.reason ?? "gated"}`;
    }
  }

  /** Compact file-change tally: `+2 ~3 -1`, or a flat count for old entries. */
  private fileDelta(entry: DreamLogEntry): string | undefined {
    const c = entry.filesCreated?.length;
    const e = entry.filesEdited?.length;
    const r = entry.filesRemoved?.length;
    if (c === undefined && e === undefined && r === undefined) {
      const n = entry.filesTouched?.length ?? 0;
      return entry.status === "skipped" || entry.status === "failed"
        ? undefined
        : n > 0
          ? `${n} ${n === 1 ? "file" : "files"}`
          : "no changes";
    }
    const total = (c ?? 0) + (e ?? 0) + (r ?? 0);
    return total > 0 ? `+${c ?? 0} ~${e ?? 0} -${r ?? 0}` : "no changes";
  }

  private detailLines(
    entry: DreamLogEntry,
    width: number,
  ): Array<{ text: string; kind: LineKind }> {
    const out: Array<{ text: string; kind: LineKind }> = [];
    if (entry.status === "skipped") {
      if (entry.reason) {
        out.push(...this.wrappedDetail("reason", entry.reason, width));
      }
      return out;
    }
    if (entry.model) {
      out.push({
        text: `${DETAIL_INDENT}model: ${entry.model}`,
        kind: "detail",
      });
    }
    const groups: Array<[string, string[] | undefined]> = [
      ["created", entry.filesCreated],
      ["edited", entry.filesEdited],
      ["removed", entry.filesRemoved],
    ];
    const hasOps = groups.some(([, files]) => files !== undefined);
    if (hasOps) {
      for (const [label, files] of groups) {
        if (files && files.length > 0) {
          out.push(...this.wrappedDetail(label, basenames(files), width));
        }
      }
    } else if (entry.filesTouched && entry.filesTouched.length > 0) {
      // Older log entries predate per-op tracking.
      out.push(
        ...this.wrappedDetail("touched", basenames(entry.filesTouched), width),
      );
    }
    if (entry.summary) {
      out.push(
        ...this.wrappedDetail("summary", entry.summary, width, "summary"),
      );
    }
    return out;
  }

  /** `label: text` with a hanging indent, wrapped to the panel width. */
  private wrappedDetail(
    label: string,
    text: string,
    width: number,
    kind: LineKind = "detail",
  ): Array<{ text: string; kind: LineKind }> {
    const prefix = `${DETAIL_INDENT}${label}: `;
    const hang = " ".repeat(visibleWidth(prefix));
    const wrapped = wrapTextWithAnsi(text, Math.max(8, width - prefix.length));
    return wrapped.map((line, i) => ({
      text: truncateToWidth((i === 0 ? prefix : hang) + line, width),
      kind,
    }));
  }
}

function basenames(paths: string[]): string {
  return paths.map((path) => path.split("/").pop() ?? path).join(", ");
}

function statusColor(status: DreamLogStatus | undefined): ThemeColor {
  switch (status) {
    case "completed":
      return "success";
    case "aborted":
      return "warning";
    case "failed":
      return "error";
    default:
      return "dim"; // skipped
  }
}

function formatLogTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export async function showDreamLogPane(
  ctx: ExtensionCommandContext,
  dir: string,
): Promise<void> {
  const pane = new DreamLogPane(await readDreamLog(dir));
  await ctx.ui.custom<undefined>(
    (tui, theme, _keybindings, done) => {
      pane.onClose = () => done(undefined);
      pane.onReload = () => {
        void readDreamLog(dir).then((fresh) => {
          pane.setEntries(fresh);
          tui.requestRender();
        });
      };
      return {
        render: (width) => pane.render(width, theme, tui.terminal.rows),
        handleInput: (data) => {
          pane.handleInput(data);
          tui.requestRender();
        },
        invalidate: () => pane.invalidate(),
      };
    },
    {
      overlay: true,
      overlayOptions: {
        // Docked above the footer: full width, lifted just clear of the
        // footer's rows, so it reads as the footer extending upward.
        anchor: "bottom-center",
        width: "100%",
        maxHeight: "60%",
        margin: { bottom: 3 },
      },
    },
  );
}
