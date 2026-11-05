/**
 * Shared activity formatting for every subagent surface: the braille spinner
 * frames, the status glyph, and the status word. Colors are pinned here so the
 * rail, dashboard, takeover header, and result rows stay consistent.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SubagentSnapshot, SubagentStatus } from "../domain.ts";

/** Braille spinner frames; tickers advance one frame per second. */
export const BRAILLE_SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⢼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

/** The spinner frame for `frame`, wrapping in both directions. */
export function spinnerGlyph(frame: number) {
  const count = BRAILLE_SPINNER_FRAMES.length;
  const index = ((Math.trunc(frame) % count) + count) % count;
  return BRAILLE_SPINNER_FRAMES[index]!;
}

/** A status value, or anything carrying one (`SubagentSnapshot`, tool details). */
export type StatusLike = SubagentStatus | Pick<SubagentSnapshot, "status">;

function statusOf(value: StatusLike): SubagentStatus {
  return typeof value === "string" ? value : value.status;
}

/** The status glyph: an animated braille frame while running, else a square. */
export function statusGlyph(status: StatusLike, theme: Theme, frame = 0) {
  switch (statusOf(status)) {
    case "running":
      return theme.fg("warning", spinnerGlyph(frame));
    case "done":
      return theme.fg("success", "■");
    case "error":
      return theme.fg("error", "■");
    case "cancelled":
      return theme.fg("warning", "■");
  }
}

/** The status word, colored to match `statusGlyph`. */
export function statusWord(status: StatusLike, theme: Theme) {
  switch (statusOf(status)) {
    case "running":
      return theme.fg("warning", "running");
    case "done":
      return theme.fg("success", "done");
    case "error":
      return theme.fg("error", "failed");
    case "cancelled":
      return theme.fg("warning", "cancelled");
  }
}
