/**
 * The findings store, the `report_findings` tool, and the shared presentation
 * path. Both the post-run auto-presentation and the model-facing tool write the
 * same store and emit the same `code-review-findings` message (rendered by
 * render.ts), so `--fix` re-reports update rows by key instead of duplicating.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Effort } from "./command.ts";
import { COMMENT_APPENDIX, FIX_APPENDIX } from "./prompts.ts";
import { renderFindings } from "./render.ts";
import type { ReviewScope } from "./target.ts";

export interface Finding {
  file: string;
  line: number;
  summary: string;
  /** ≤60 chars, the claim only — used as the key suffix and the row label. */
  short_summary: string;
  failure_scenario: string;
  /** kebab slug: correctness | simplification | efficiency | reuse | … */
  category: string;
  verdict?: "CONFIRMED" | "PLAUSIBLE";
  outcome?: "fixed" | "skipped" | "no_change_needed";
}

export interface FindingsReport {
  level?: Effort;
  findings: Finding[];
}

export interface FindingsStore {
  findings: Finding[];
  level?: Effort;
}

export function createFindingsStore(): FindingsStore {
  return { findings: [] };
}

export function findingKey(f: Finding): string {
  return `${f.file}:${f.line}:${f.short_summary}`;
}

/** Merge `next` into `prev`: update matched rows by key, append new ones, keep order. */
export function mergeOutcomes(prev: Finding[], next: Finding[]): Finding[] {
  const result = prev.map((f) => ({ ...f }));
  const indexByKey = new Map(result.map((f, i) => [findingKey(f), i] as const));
  for (const n of next) {
    const key = findingKey(n);
    const at = indexByKey.get(key);
    if (at !== undefined) {
      result[at] = { ...result[at]!, ...n };
    } else {
      indexByKey.set(key, result.length);
      result.push({ ...n });
    }
  }
  return result;
}

const CLEANUP_RANK: Record<string, number> = {
  efficiency: 2,
  reuse: 3,
  simplification: 4,
  altitude: 5,
  conventions: 6,
};

/**
 * Severity rank (lower = more severe). Correctness outranks everything; a more
 * specific correctness-ish slug (test-coverage, security, …) ranks just under
 * it; the cleanup/altitude/conventions family ranks last.
 */
export function categoryRank(category: string): number {
  if (category === "correctness") return 0;
  return CLEANUP_RANK[category] ?? 1;
}

export const REPORT_FINDINGS_PARAMS = Type.Object({
  level: Type.Optional(
    StringEnum(["low", "medium", "high", "xhigh", "max"] as const),
  ),
  findings: Type.Array(
    Type.Object({
      file: Type.String(),
      line: Type.Integer(),
      summary: Type.String(),
      short_summary: Type.String(),
      failure_scenario: Type.String(),
      category: Type.String(),
      verdict: Type.Optional(StringEnum(["CONFIRMED", "PLAUSIBLE"] as const)),
      outcome: Type.Optional(
        StringEnum(["fixed", "skipped", "no_change_needed"] as const),
      ),
    }),
  ),
});

const REPORT_FINDINGS_DESCRIPTION = [
  "Report this review's results with { level, findings }. `findings` is ranked",
  "most-severe first; each has file, line, summary, short_summary (the claim",
  "compressed to ≤60 characters, no rationale or consequence clause),",
  "failure_scenario, and category (a short kebab-case slug for the angle that",
  "produced it), plus verdict when a verify pass produced one. If nothing",
  "survives, call it with an empty array. On a --fix re-report, set each",
  "finding's outcome (fixed | skipped | no_change_needed); rows update by",
  "file:line:short_summary rather than duplicating.",
].join(" ");

/** Model-facing text for the findings message (the renderer shows the rich view). */
export function findingsSummaryText(store: FindingsStore): string {
  const { findings, level } = store;
  if (findings.length === 0) {
    return `## Code review${level ? ` — ${level}` : ""}\n\nNo findings.`;
  }
  const lines = findings.map((f) => {
    const verdict = f.verdict ? ` [${f.verdict}]` : "";
    const outcome = f.outcome ? ` (${f.outcome})` : "";
    return `- ${f.file}:${f.line} — ${f.short_summary}${verdict}${outcome}`;
  });
  return [
    `## Code review${level ? ` — ${level}` : ""}`,
    "",
    `${findings.length} finding${findings.length === 1 ? "" : "s"}:`,
    ...lines,
  ].join("\n");
}

/**
 * Merge findings into the store and emit/refresh the rendered findings message.
 * Used by both the post-run auto-presentation and the report_findings tool.
 */
export function presentFindings(
  pi: ExtensionAPI,
  store: FindingsStore,
  level: Effort | undefined,
  findings: Finding[],
): void {
  store.findings = mergeOutcomes(store.findings, findings);
  if (level) store.level = level;
  pi.sendMessage(
    {
      customType: "code-review-findings",
      display: true,
      content: findingsSummaryText(store),
      details: {
        level: store.level,
        findings: store.findings,
      } satisfies FindingsReport,
    },
    {},
  );
}

/** The --fix follow-up: the ported appendix plus the findings for the model to apply. */
export function buildFixFollowUp(findings: Finding[], level?: Effort): string {
  const list =
    findings
      .map(
        (f, i) =>
          `${i + 1}. ${f.file}:${f.line} [${f.category}${
            f.verdict ? `/${f.verdict}` : ""
          }] ${f.summary}\n   ${f.failure_scenario}`,
      )
      .join("\n") || "(none)";
  return `${FIX_APPENDIX}\n\nFindings from the ${level ?? "code"} review:\n\n${list}`;
}

const shellQuote = (s: string) => s.replace(/'/g, `'\\''`);

/** Print-only PR comment commands (--comment). Never posts; the user runs them. */
export function buildCommentBlock(
  findings: Finding[],
  scope: ReviewScope,
  repoSlug: string,
): string {
  const cmds =
    findings
      .map((f) => {
        const body = `${f.summary}\n\n${f.failure_scenario}`;
        return `gh api repos/${repoSlug}/pulls/${scope.range}/comments \\
  -f path='${shellQuote(f.file)}' -F line=${f.line} -f side=RIGHT \\
  -f body='${shellQuote(body)}'`;
      })
      .join("\n\n") || "(no findings)";
  return `${COMMENT_APPENDIX}\n\nPrepared commands (review, then run yourself — nothing was posted):\n\n${cmds}`;
}

/** Register the report_findings tool and the findings message renderer. */
export function registerReportFindings(pi: ExtensionAPI, store: FindingsStore) {
  pi.registerTool({
    name: "report_findings",
    label: "Report findings",
    description: REPORT_FINDINGS_DESCRIPTION,
    parameters: REPORT_FINDINGS_PARAMS,
    async execute(_toolCallId, params) {
      const findings = params.findings as Finding[];
      presentFindings(pi, store, params.level as Effort | undefined, findings);
      return {
        content: [
          { type: "text", text: `Recorded ${findings.length} finding(s).` },
        ],
        details: { recorded: findings.length },
      };
    },
  });

  pi.registerMessageRenderer<FindingsReport>(
    "code-review-findings",
    renderFindings,
  );
}
