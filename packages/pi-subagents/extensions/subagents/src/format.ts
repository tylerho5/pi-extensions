/**
 * Formatting helpers (self-contained copies of the v1 shared helpers:
 * context-utilization).
 */

export interface ContextUtilization {
  /** Current conversation context occupancy; undefined while unknown. */
  tokens?: number | null;
  /** Capacity of the model currently serving the conversation. */
  contextWindow?: number | null;
}

function usableTokens(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function formatCompactTokens(count: number) {
  if (count < 1000) return Math.round(count).toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

/**
 * Render context occupancy as a compact token count such as `40k`. The
 * capacity is deliberately not shown; `contextWindow` stays on the snapshot
 * for callers that need it.
 */
export function formatContextTokens(usage: ContextUtilization) {
  const tokens = usableTokens(usage.tokens);
  if (tokens === undefined) return "";
  return formatCompactTokens(tokens);
}

/** `$X.XXX`, matching the footer's cost formatting; omitted while unknown/empty. */
export function formatCost(usd: number | null | undefined) {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) return "";
  return `$${usd.toFixed(3)}`;
}

/**
 * Head-cap `text` at `maxChars`, reporting whether anything was dropped.
 * Render sites pair it with `truncationNotice` so a capped body still points
 * at the full report.
 */
export function capChars(text: string, maxChars: number) {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

/** Where a capped report's full text still lives. */
export function truncationNotice(sessionFilePath?: string) {
  const suffix = sessionFilePath ? ` · ${sessionFilePath}` : "";
  return `… truncated. Open the takeover view (Enter from the rail or /subagents)${suffix}`;
}
