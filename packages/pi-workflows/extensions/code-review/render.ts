/**
 * Renders the `code-review-findings` message: a severity-ranked list (the
 * orchestrator ranks before reporting), one row per finding, expandable to each
 * finding's failure scenario, with a verdict badge and a --fix outcome glyph.
 */

import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { Finding, FindingsReport } from "./findings.ts";

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
