/**
 * One-line transcript rows for subagent_send. The message's first line is the
 * preview, mirroring Claude Code's SendMessage default, so the row says what
 * the message is about without a new schema field.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

/** First non-empty line of a message, trimmed; "" when the text is blank. */
export function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/** A single-line row that truncates against the width it is rendered at. */
export function rowComponent(build: (width: number) => string): Component {
  return {
    render: (width: number) => [build(width)],
    invalidate: () => {},
  };
}

function previewSuffix(message: string, theme: Theme): string {
  const preview = firstLine(message);
  return preview ? theme.fg("dim", " · ") + theme.fg("muted", preview) : "";
}

export function sendCallRowText(options: {
  id?: string;
  message: string;
  theme: Theme;
  width: number;
}): string {
  const { id, message, theme, width } = options;
  let text = theme.fg("toolTitle", theme.bold("subagent_send"));
  if (id) text += " " + theme.fg("accent", id);
  text += previewSuffix(message, theme);
  return truncateToWidth(text, width);
}

export function sendRowText(options: {
  id: string;
  restarted: boolean;
  runSequence: number;
  message: string;
  theme: Theme;
  width: number;
}): string {
  const { id, restarted, runSequence, message, theme, width } = options;
  const verb = restarted ? "resumed" : "steered";
  const text =
    theme.fg("success", "⏵ ") +
    theme.fg("accent", id) +
    theme.fg("muted", ` · ${verb} (run ${runSequence})`) +
    previewSuffix(message, theme);
  return truncateToWidth(text, width);
}
