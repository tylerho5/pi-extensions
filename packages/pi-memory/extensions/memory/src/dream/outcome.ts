/**
 * The dream outcome transcript entry. A fired dream (completed or aborted)
 * appends one `dream-outcome` entry: collapsed it is the same one-line
 * headline the old notification showed; expanded (ctrl+o) it adds the dream's
 * own summary, which used to be dumped into chat verbatim.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatCompactTokens } from "../../../shared/context-utilization.ts";
import type { DreamResult } from "./run.ts";

export const DREAM_OUTCOME_ENTRY = "dream-outcome";

export interface DreamOutcomeEntryData {
  headline: string;
  summary?: string;
}

/** The collapsed line, identical to the old notification minus the glyph. */
export function buildDreamOutcomeData(
  result: DreamResult,
): DreamOutcomeEntryData {
  const count = result.filesTouched.length;
  const noun = count === 1 ? "file" : "files";
  const head =
    result.status === "aborted"
      ? "Dream stopped early —"
      : "Dream consolidated";
  const cost =
    result.costUsd !== undefined ? ` · $${result.costUsd.toFixed(2)}` : "";
  const tokens =
    result.usage?.tokens !== undefined
      ? ` · ${formatCompactTokens(result.usage.tokens)} tok`
      : "";
  const data: DreamOutcomeEntryData = {
    headline: `${head} ${count} memory ${noun}${cost}${tokens}.`,
  };
  if (result.summary) data.summary = result.summary;
  return data;
}

export function renderDreamOutcome(
  data: DreamOutcomeEntryData,
  expanded: boolean,
  theme: Theme,
) {
  let text = theme.fg("accent", "✦ ") + theme.fg("muted", data.headline ?? "");
  if (expanded && data.summary) {
    text += `\n${theme.fg("dim", data.summary)}`;
  }
  return new Text(text, 0, 0);
}
