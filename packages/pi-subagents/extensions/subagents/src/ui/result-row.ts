import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatCost } from "../format.ts";

function clipped(text: string, width: number) {
  return truncateToWidth(text, Math.max(0, width));
}

/**
 * `⏺ Agent "<description>" finished · 2m14s · $0.031`, in Claude Code's
 * completion format with the run cost kept. The dot carries the status color.
 */
export function completionHeaderText(options: {
  id: string;
  description?: string;
  status: "done" | "error" | "cancelled" | "running";
  elapsed?: string;
  costUsd?: number;
  errorText?: string;
  theme: Theme;
  width: number;
}) {
  const { id, description, status, elapsed, costUsd, errorText, theme, width } =
    options;
  const color =
    status === "done" ? "success" : status === "error" ? "error" : "warning";
  const error = errorText?.split("\n")[0];
  const outcome =
    status === "done"
      ? "finished"
      : status === "error"
        ? `failed${error ? `: ${error}` : ""}`
        : status === "cancelled"
          ? "was stopped"
          : "is running";
  const facts = [elapsed, formatCost(costUsd)].filter(Boolean);
  return clipped(
    `${theme.fg(color, "⏺")} Agent "${description || id}" ${outcome}${facts.length ? theme.fg("dim", ` · ${facts.join(" · ")}`) : ""}`,
    width,
  );
}

export function digestLineText(summary: string, theme: Theme, width: number) {
  return clipped(theme.fg("muted", summary), width);
}
