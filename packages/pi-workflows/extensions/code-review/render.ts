/**
 * Renders the `code-review-findings` message: a severity-ranked list (the
 * orchestrator ranks before reporting), one row per finding, expandable to each
 * finding's failure scenario, with a verdict badge and a --fix outcome glyph.
 */

import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { completionDigest } from "./findings.ts";
import type {
  CompletionNotification,
  FailureNotification,
  Finding,
  FindingsReport,
} from "./findings.ts";

const OUTCOME_GLYPH: Record<NonNullable<Finding["outcome"]>, string> = {
  fixed: "✓",
  skipped: "⊘",
  no_change_needed: "·",
};

const CLEANUP = new Set([
  "efficiency",
  "reuse",
  "simplification",
  "altitude",
  "conventions",
]);

type Theme = Parameters<MessageRenderer>[2];
type ThemeColor = Parameters<Theme["fg"]>[0];

function dotColor(category: string): ThemeColor {
  if (category === "correctness") return "error";
  if (CLEANUP.has(category)) return "muted";
  return "warning";
}

function header(report: Partial<FindingsReport>, theme: Theme): string {
  const count = report.findings?.length ?? 0;
  return (
    theme.fg("accent", theme.bold("code review")) +
    (report.level ? theme.fg("muted", ` · ${report.level}`) : "") +
    theme.fg("muted", ` · ${count} finding${count === 1 ? "" : "s"}`)
  );
}

function rowLine(f: Finding, theme: Theme): string {
  const dot = theme.fg(dotColor(f.category), "●");
  const loc = theme.fg("accent", `${f.file}:${f.line}`);
  const cat = theme.fg("muted", f.category);
  const verdict = f.verdict
    ? theme.fg(f.verdict === "CONFIRMED" ? "warning" : "dim", ` [${f.verdict}]`)
    : "";
  const outcome = f.outcome
    ? theme.fg("success", ` ${OUTCOME_GLYPH[f.outcome]}`)
    : "";
  return `  ${dot} ${loc} ${cat}${verdict}${outcome}  ${theme.fg("toolOutput", f.short_summary)}`;
}

/**
 * The completion renderer paints a digest, not the report: the accent header,
 * the verdict counts, up to five findings rows, and a pointer to the findings
 * message and the run directory. The findings rows own expansion (ctrl+o), so
 * the digest has none. The message content stays the full machine-usable
 * report for the parent model.
 */
export const renderCompletionNotification: MessageRenderer<
  CompletionNotification
> = (message, _options, theme) => {
  const details = (message.details ?? {}) as Partial<CompletionNotification>;
  const digest = completionDigest({
    level: details.level ?? "medium",
    findings: details.findings ?? [],
    runId: details.runId,
    scope: details.scope,
    fix: details.fix,
  });

  let head = theme.fg("accent", theme.bold("code review complete"));
  head += theme.fg("muted", ` · ${digest.level}`);
  if (digest.scope) head += theme.fg("muted", ` · ${digest.scope}`);
  if (digest.fix) head += theme.fg("warning", " · fix");

  const lines = [
    head,
    theme.fg(
      "muted",
      `${digest.count} finding${digest.count === 1 ? "" : "s"} · ` +
        `${digest.confirmed} confirmed · ${digest.plausible} plausible`,
    ),
  ];
  for (const f of digest.top) lines.push(rowLine(f, theme));
  lines.push(
    theme.fg(
      "dim",
      `findings below${digest.runId ? ` · /workflows ${digest.runId}` : ""} · report.md in the run directory`,
    ),
  );

  return {
    render: (width: number) =>
      lines.map((line) => truncateToWidth(line, width)),
    invalidate: () => {},
  };
};

export const renderFailureNotification: MessageRenderer<FailureNotification> = (
  message,
  _options,
  theme,
) => {
  const content = typeof message.content === "string" ? message.content : "";
  return new Text(theme.fg("error", content), 0, 0);
};

export const renderFindings: MessageRenderer<FindingsReport> = (
  message,
  { expanded },
  theme,
) => {
  const report = (message.details ?? {}) as Partial<FindingsReport>;
  const findings = report.findings ?? [];
  const head = header(report, theme);

  if (findings.length === 0) {
    return new Text(`${head}\n  ${theme.fg("success", "no findings")}`, 0, 0);
  }

  if (!expanded) {
    let text = head;
    for (const f of findings) text += `\n${rowLine(f, theme)}`;
    text += `\n${theme.fg("muted", "(ctrl+o to expand)")}`;
    return new Text(text, 0, 0);
  }

  const container = new Container();
  container.addChild(new Text(head, 0, 0));
  for (const f of findings) {
    container.addChild(new Text(rowLine(f, theme), 0, 0));
    container.addChild(
      new Text(`      ${theme.fg("dim", f.failure_scenario)}`, 0, 0),
    );
  }
  return container;
};
