/**
 * The `/btw` panel — a Claude Code-style bottom dock listing past asides as
 * `/btw <question>` lines above the selected aside's answer. Each aside is
 * its own isolated session; ←/→ switches between them, ↑/↓ (or j/k) scrolls
 * the answer, `n` asks a new question, `c` copies the answer, ctrl+t toggles
 * reasoning (hidden by default, same collapsed style as the main session),
 * esc closes. Docked above the footer like /dream-log. pi overlays draw no
 * chrome — every line is padded to full width so chat can't bleed through.
 */

import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
  latestText,
  type SubagentSnapshot,
  type TranscriptItem,
} from "../domain.ts";
import type { SubagentReadModel } from "../manager.ts";
import { loadPersistedTranscript } from "../persisted/transcript.ts";
import { buildBtwAnswerLines, mergeTranscripts } from "./transcript.ts";
import { configuredKeys } from "./takeover.ts";

/** `"new"` asks a new question; null closes. */
export type BtwPanelResult = "new" | null;

export function openBtwPanel(
  ctx: Pick<ExtensionCommandContext, "ui">,
  view: SubagentReadModel,
) {
  return ctx.ui.custom<BtwPanelResult>(
    (tui, theme, keybindings, done) =>
      new BtwPanel(tui, theme, keybindings, view, done),
    {
      overlay: true,
      overlayOptions: {
        anchor: "bottom-center",
        width: "100%",
        maxHeight: "60%",
        margin: { bottom: 3 },
      },
    },
  );
}

const MAX_QUESTION_ROWS = 6;
const SCROLL_STEP = 3;

class BtwPanel implements Component {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private view: SubagentReadModel;
  private done: (value: BtwPanelResult) => void;

  /** Index into the chronological aside list; starts on the newest. */
  private selection: number;
  /** First visible answer line. */
  private scroll = 0;
  /** Stick to the bottom while the selected aside is still answering. */
  private follow: boolean;
  private showThinking = false;
  private persisted = new Map<string, ReadonlyArray<TranscriptItem>>();
  private settledLoaded = new Set<string>();
  private loadingId?: string;
  private copiedFlash = false;
  private copyTimer?: ReturnType<typeof setTimeout>;
  private maxScroll = 0;
  private closed = false;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private unsubChange: () => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    view: SubagentReadModel,
    done: (value: BtwPanelResult) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.view = view;
    this.done = done;
    const subs = this.btws();
    this.selection = Math.max(0, subs.length - 1);
    const snap = subs[this.selection];
    this.follow = snap?.status === "running";
    if (snap) {
      this.ensurePersisted(snap);
      if (snap.status !== "running") this.settledLoaded.add(snap.id);
    }
    this.unsubChange = view.subscribe(() => this.onViewChange());
  }

  /** Chronological (spawn order) — oldest on top, like the CC panel. */
  private btws(): ReadonlyArray<SubagentSnapshot> {
    return this.view.list().filter((snap) => snap.origin === "btw");
  }

  private selectedSnap(): SubagentSnapshot | undefined {
    return this.btws()[this.selection];
  }

  private onViewChange() {
    const snap = this.selectedSnap();
    // Reload the persisted transcript once on settle to recover anything
    // pruned from the bounded live buffer.
    if (snap && snap.status !== "running" && !this.settledLoaded.has(snap.id)) {
      this.settledLoaded.add(snap.id);
      this.ensurePersisted(snap, true);
    }
    this.scheduleRender();
  }

  private ensurePersisted(snap: SubagentSnapshot, force = false) {
    if (this.loadingId === snap.id) return;
    if (!force && this.persisted.has(snap.id)) return;
    const path = snap.meta.sessionFilePath;
    if (!path) return;
    this.loadingId = snap.id;
    void loadPersistedTranscript(path)
      .then((transcript) => {
        if (this.closed) return;
        this.persisted.set(snap.id, transcript);
        if (this.loadingId === snap.id) this.loadingId = undefined;
        this.scheduleRender();
      })
      .catch(() => {
        if (this.loadingId === snap.id) this.loadingId = undefined;
      });
  }

  private scheduleRender() {
    if (this.renderTimer) return;
    // Streaming can emit an event per token; cap repaint rate.
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (!this.closed) this.tui.requestRender();
    }, 50);
  }

  private cleanup() {
    if (this.closed) return false;
    this.closed = true;
    this.unsubChange();
    if (this.renderTimer) clearTimeout(this.renderTimer);
    if (this.copyTimer) clearTimeout(this.copyTimer);
    return true;
  }

  private close(result: BtwPanelResult) {
    if (this.cleanup()) this.done(result);
  }

  dispose(): void {
    this.cleanup();
  }

  private move(delta: number) {
    const subs = this.btws();
    const next = Math.max(0, Math.min(subs.length - 1, this.selection + delta));
    if (next === this.selection) return;
    this.selection = next;
    this.scroll = 0;
    const snap = subs[next];
    this.follow = snap?.status === "running";
    if (snap) this.ensurePersisted(snap);
  }

  private scrollBy(delta: number) {
    this.follow = false;
    this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll + delta));
  }

  private copyAnswer() {
    const snap = this.selectedSnap();
    const text = snap ? latestText(snap).trim() : "";
    if (!text) return;
    void copyToClipboard(text).then(() => {
      if (this.closed) return;
      this.copiedFlash = true;
      this.tui.requestRender();
      if (this.copyTimer) clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => {
        this.copiedFlash = false;
        if (!this.closed) this.tui.requestRender();
      }, 1500);
    });
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.close(null);
      return;
    }
    if (matchesKey(data, Key.left)) this.move(-1);
    else if (matchesKey(data, Key.right)) this.move(1);
    else if (matchesKey(data, Key.up) || data === "k")
      this.scrollBy(-SCROLL_STEP);
    else if (matchesKey(data, Key.down) || data === "j")
      this.scrollBy(SCROLL_STEP);
    else if (this.keybindings.matches(data, "tui.editor.pageUp"))
      this.scrollBy(-this.answerViewport());
    else if (this.keybindings.matches(data, "tui.editor.pageDown"))
      this.scrollBy(this.answerViewport());
    else if (this.keybindings.matches(data, "app.thinking.toggle"))
      this.showThinking = !this.showThinking;
    else if (data === "g") {
      this.follow = false;
      this.scroll = 0;
    } else if (data === "G") this.follow = true;
    else if (data === "c") this.copyAnswer();
    else if (data === "n") {
      this.close("new");
      return;
    }
    this.tui.requestRender();
  }

  private answerViewport(): number {
    const rows = this.tui.terminal.rows || 30;
    const maxPanel = Math.max(8, Math.floor(rows * 0.6));
    const questionRows = Math.min(this.btws().length, MAX_QUESTION_ROWS);
    // Chrome: top rule + question rows + blank + hints.
    return Math.max(3, maxPanel - questionRows - 3);
  }

  private answerLines(snap: SubagentSnapshot, width: number): string[] {
    const merged = mergeTranscripts(
      this.persisted.get(snap.id),
      snap.transcript,
    );
    const lines = buildBtwAnswerLines(
      { ...snap, transcript: merged },
      width,
      this.theme,
      { showThinking: this.showThinking },
    );
    if (snap.errorText) {
      lines.unshift(
        truncateToWidth(
          this.theme.fg("error", `error: ${snap.errorText}`),
          width,
        ),
        "",
      );
    }
    return lines;
  }

  render(width: number): string[] {
    const theme = this.theme;
    const subs = this.btws();
    this.selection = Math.max(0, Math.min(this.selection, subs.length - 1));
    const pad = (line: string) => truncateToWidth(line, width, "…", true);

    const lines: string[] = [];
    // The CC panel separates from chat with a single horizontal rule.
    lines.push(theme.fg("borderAccent", "─".repeat(Math.max(1, width))));

    if (subs.length === 0) {
      lines.push(pad(theme.fg("dim", "  no by-the-way sessions yet")));
    } else {
      // Question window around the selection.
      let start = 0;
      if (subs.length > MAX_QUESTION_ROWS) {
        start = Math.min(
          Math.max(0, this.selection - Math.floor(MAX_QUESTION_ROWS / 2)),
          subs.length - MAX_QUESTION_ROWS,
        );
      }
      const visibleSubs = subs.slice(start, start + MAX_QUESTION_ROWS);
      for (let i = 0; i < visibleSubs.length; i++) {
        const snap = visibleSubs[i];
        const isSelected = start + i === this.selection;
        const prefix = isSelected
          ? theme.fg("accent", theme.bold("/btw"))
          : theme.fg("muted", "/btw");
        const label = isSelected
          ? theme.fg("text", snap.description)
          : theme.fg("dim", snap.description);
        const status =
          snap.status === "running" ? theme.fg("warning", " · running") : "";
        lines.push(pad(`  ${prefix} ${label}${status}`));
      }
      if (start > 0) {
        lines[1] = pad(theme.fg("dim", `  ... ${start} earlier`));
      }
      if (start + MAX_QUESTION_ROWS < subs.length) {
        lines[lines.length - 1] = pad(
          theme.fg(
            "dim",
            `  ... ${subs.length - start - MAX_QUESTION_ROWS} more`,
          ),
        );
      }

      lines.push(pad(""));

      const snap = subs[this.selection];
      const viewport = this.answerViewport();
      const answer = this.answerLines(snap, width - 2);
      this.maxScroll = Math.max(0, answer.length - viewport);
      if (this.follow) this.scroll = this.maxScroll;
      this.scroll = Math.max(0, Math.min(this.scroll, this.maxScroll));

      const visible = answer.slice(this.scroll, this.scroll + viewport);
      if (visible.length === 0) {
        lines.push(
          pad(
            theme.fg(
              "dim",
              snap.status === "running" ? "  …" : "  (no answer)",
            ),
          ),
        );
      } else {
        for (const line of visible) lines.push(pad(`  ${line}`));
      }
    }

    const more: string[] = [];
    if (this.scroll > 0) more.push("↑");
    if (this.scroll < this.maxScroll) more.push("↓");
    const hints = this.copiedFlash
      ? "  copied!"
      : `  ←/→ switch · ↑/↓ scroll · n new · c copy · ${configuredKeys(this.keybindings, "app.thinking.toggle")} thinking · ${configuredKeys(this.keybindings, "tui.select.cancel")} close ${more.join("")}`;
    lines.push(pad(theme.fg("dim", hints)));

    return lines;
  }

  invalidate(): void {}
}
