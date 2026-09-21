/**
 * The shared review launch lifecycle. Resolves the scope, prepares command-only
 * comment output, starts the TS phase engine as a programmatic background run,
 * and hands the settled outcome to the parent model (a completion or failure
 * follow-up). The `/code-review` command and the `code_review` tool both drive
 * this one path.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getWorkflowRuntime } from "../shared/workflow-runtime.ts";
import type { Effort, Mode } from "./command.ts";
import {
  buildCommentBlock,
  deliverCompletionNotification,
  deliverFailureNotification,
  type Finding,
  type FindingsStore,
} from "./findings.ts";
import { reviewOrchestration } from "./orchestrate.ts";
import { resolveScope, type Runner } from "./target.ts";

export interface ReviewRequest {
  target: string;
  level: Effort;
  mode: Mode;
  fix: boolean;
  comment: boolean;
}

export interface ReviewLaunchResult {
  runId: string;
  scope: string;
  level: Effort;
  mode: Mode;
  fix: boolean;
}

export type ReviewLauncher = (
  request: ReviewRequest,
  ctx: ExtensionContext,
) => Promise<ReviewLaunchResult>;

/** Best-effort `owner/repo` for --comment; a placeholder when gh can't resolve it. */
async function resolveRepoSlug(run: Runner, cwd: string): Promise<string> {
  const { stdout, code } = await run(
    ["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    cwd,
  );
  return code === 0 && stdout.trim() ? stdout.trim() : "{owner}/{repo}";
}

export function createReviewLauncher(
  pi: ExtensionAPI,
  store: FindingsStore,
  run: Runner,
): ReviewLauncher {
  return async (request, ctx) => {
    const rt = getWorkflowRuntime();
    if (!rt) {
      throw new Error(
        "code-review needs the workflows extension, which is unavailable",
      );
    }

    const scope = await resolveScope(request.target, ctx.cwd, run);

    const wantComment = request.comment && scope.isPr;
    if (request.comment && !scope.isPr)
      ctx.ui.notify("--comment ignored (target is not a PR)", "warning");
    const repoSlug = wantComment ? await resolveRepoSlug(run, ctx.cwd) : "";

    // Start each review from a clean store; a later --fix report_findings merges
    // outcomes into these rows.
    store.findings = [];
    store.level = request.level;

    // Inline runs as a single "Review" agent (except low, which is already a
    // single agent on the shared Find/Verify/Sweep path).
    const inlineSingle = request.mode === "inline" && request.level !== "low";
    const phases = inlineSingle
      ? [{ title: "Review" }]
      : [{ title: "Find" }, { title: "Verify" }, { title: "Sweep" }];

    const handle = rt.launch<Finding[]>(
      {
        meta: {
          name: `code-review: ${scope.label}`,
          phases,
        },
        background: true,
        delivery: "programmatic",
        orchestrate: (dsl) =>
          reviewOrchestration(dsl, {
            level: request.level,
            scope,
            mode: request.mode,
          }),
      },
      ctx,
    );

    ctx.ui.notify(
      `Reviewing ${scope.label} at ${request.level} (${request.mode}) — see /workflows`,
      "info",
    );

    // Do not block the turn: wake the parent when the run settles. An aborted
    // run (session shutdown) stays silent; a failed run hands off to the parent.
    void handle.settled.then((outcome) => {
      if (outcome.status === "aborted") return;
      if (outcome.status !== "completed") {
        deliverFailureNotification(pi, {
          runId: outcome.runId,
          error: outcome.error ?? "no result",
        });
        return;
      }
      const findings = outcome.result ?? [];
      deliverCompletionNotification(pi, {
        level: request.level,
        findings,
        runId: outcome.runId,
        scope: scope.label,
        fix: request.fix,
        instruction: request.fix
          ? "Call report_findings, apply appropriate fixes, then call it again with an outcome for every finding."
          : "Call report_findings once, summarize the findings, and do not modify files.",
      });
      if (wantComment)
        ctx.ui.notify(buildCommentBlock(findings, scope, repoSlug), "info");
    });

    return {
      runId: handle.runId,
      scope: scope.label,
      level: request.level,
      mode: request.mode,
      fix: request.fix,
    };
  };
}
