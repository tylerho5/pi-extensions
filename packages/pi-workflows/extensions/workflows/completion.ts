/**
 * The background-run completion follow-up. The model-facing report text is
 * unchanged from the plain user message it replaced; only the delivery envelope
 * (customType + details) and the transcript rendering change, so the full report
 * is not painted verbatim under every settled run.
 */

import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import {
  countStates,
  formatElapsed,
  shortenHome,
  statusWord,
  type WorkflowDetails,
  type WorkflowStatus,
} from "./model.ts";

/** Cap on the report text the expanded renderer paints. */
export const COMPLETION_REPORT_MAX_CHARS = 4000;

export interface WorkflowCompletionDetails {
  runId: string;
  name?: string;
  status: WorkflowStatus;
  elapsed: string;
  agents: { total: number; done: number; failed: number };
  currentPhase?: string;
  artifactsDir: string;
}

/** The digest the completion renderer reads, kept out of the model context. */
export function buildWorkflowCompletionDetails(
  details: WorkflowDetails,
  runDir: string,
): WorkflowCompletionDetails {
  const { done, failed } = countStates(details);
  return {
    runId: details.runId,
    ...(details.name ? { name: details.name } : {}),
    status: details.status,
    elapsed: formatElapsed(details.startedAt, details.finishedAt),
    agents: { total: details.agents.length, done, failed },
    ...(details.currentPhase ? { currentPhase: details.currentPhase } : {}),
    artifactsDir: runDir,
  };
}

function capReport(text: string): { text: string; truncated: boolean } {
  if (text.length <= COMPLETION_REPORT_MAX_CHARS)
    return { text, truncated: false };
  return { text: text.slice(0, COMPLETION_REPORT_MAX_CHARS), truncated: true };
}

export const renderWorkflowCompletion: MessageRenderer<
  WorkflowCompletionDetails
> = (message, { expanded }, theme) => {
  const details = (message.details ?? {}) as Partial<WorkflowCompletionDetails>;
  const content = typeof message.content === "string" ? message.content : "";
  const label = details.name ?? details.runId ?? "workflow";
  const total = details.agents?.total ?? 0;
  const header =
    theme.fg("accent", "✦ ") +
    theme.fg("toolTitle", theme.bold("workflow ")) +
    theme.fg("accent", label) +
    theme.fg(
      "muted",
      ` · ${details.status ? statusWord(details.status) : "done"} · ${total} agent${
        total === 1 ? "" : "s"
      }${details.elapsed ? ` · ${details.elapsed}` : ""}`,
    );

  if (!expanded) {
    let text = header;
    if (details.runId)
      text += `\n  ${theme.fg("dim", `/workflows ${details.runId}`)}`;
    return new Text(text, 0, 0);
  }

  const container = new Container();
  container.addChild(new Text(header, 0, 0));
  const capped = capReport(content);
  container.addChild(new Text(theme.fg("toolOutput", capped.text), 0, 0));
  if (capped.truncated) {
    container.addChild(
      new Text(
        theme.fg(
          "dim",
          `…[report truncated at ${COMPLETION_REPORT_MAX_CHARS} chars, full report in the run directory]`,
        ),
        0,
        0,
      ),
    );
  }
  const dir = details.artifactsDir ? shortenHome(details.artifactsDir) : "";
  const dashboard = details.runId
    ? `/workflows ${details.runId}`
    : "/workflows";
  const pointer = dir
    ? `Full report in ${dir} (result.json and report.md, press s in ${dashboard})`
    : `Full report in ${dashboard} (press s for report.md)`;
  container.addChild(new Text(theme.fg("dim", pointer), 0, 0));
  return container;
};
