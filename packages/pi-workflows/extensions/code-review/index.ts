/**
 * code-review: a port of Claude Code's `/code-review`. Resolves the review
 * scope, then launches the TS phase engine as a programmatic run through the
 * shared workflow-runtime (tracked live in /workflows), and renders findings
 * via the report_findings tool + renderer. The command turn never blocks on the
 * review; findings are presented when the run settles.
 */

import { execFile } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getWorkflowRuntime } from "../shared/workflow-runtime.ts";
import {
  EFFORT_LEVELS,
  MODES,
  parseArgs,
  resolveEffort,
  type ParsedArgs,
} from "./command.ts";
import {
  buildCommentBlock,
  buildFixFollowUp,
  createFindingsStore,
  presentFindings,
  registerReportFindings,
  type Finding,
  type FindingsStore,
} from "./findings.ts";
import { reviewOrchestration } from "./orchestrate.ts";
import { loadLastEffort, saveLastEffort } from "./state.ts";
import { resolveScope, type Runner } from "./target.ts";

const COMPLETIONS = [...EFFORT_LEVELS, ...MODES, "ultra", "--fix", "--comment"];

/** Real command runner: argv (no shell) with a large buffer for big diffs. */
const exec: Runner = (cmd, cwd) =>
  new Promise((resolve) => {
    execFile(
      cmd[0]!,
      cmd.slice(1),
      { cwd, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({ stdout: stdout ?? "", code });
      },
    );
  });

/** Notes for stripped/ignored/adapted arguments, surfaced to the user. */
function argNotes(parsed: ParsedArgs): string[] {
  const notes: string[] = [];
  if (parsed.unrecognizedLevel)
    notes.push(`ignored unrecognized level "${parsed.unrecognizedLevel}"`);
  if (parsed.ultra)
    notes.push(
      "ultra cloud review is Claude-Code-only; running a local max review",
    );
  if (parsed.postIgnored) notes.push("--post/--no-post ignored (ultra-only)");
  return notes;
}

/** Best-effort `owner/repo` for --comment; a placeholder when gh can't resolve it. */
async function resolveRepoSlug(run: Runner, cwd: string): Promise<string> {
  const { stdout, code } = await run(
    ["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    cwd,
  );
  return code === 0 && stdout.trim() ? stdout.trim() : "{owner}/{repo}";
}

export function createReviewHandler(
  pi: ExtensionAPI,
  store: FindingsStore,
  run: Runner,
) {
  return async (rawArgs: string, ctx: ExtensionCommandContext) => {
    const parsed = parseArgs(rawArgs);
    const resolved = resolveEffort(parsed, loadLastEffort());
    if (parsed.explicit) await saveLastEffort(parsed.explicit);

    const rt = getWorkflowRuntime();
    if (!rt) {
      ctx.ui.notify(
        "code-review needs the workflows extension, which is unavailable",
        "error",
      );
      return;
    }

    for (const note of argNotes(parsed)) ctx.ui.notify(note, "warning");

    const scope = await resolveScope(parsed.target, ctx.cwd, run);

    const wantComment = parsed.comment && scope.isPr;
    if (parsed.comment && !scope.isPr)
      ctx.ui.notify("--comment ignored (target is not a PR)", "warning");
    const repoSlug = wantComment ? await resolveRepoSlug(run, ctx.cwd) : "";

    // Start each review from a clean store; a later --fix report_findings merges
    // outcomes into these rows.
    store.findings = [];
    store.level = resolved.level;

    // Inline runs as a single "Review" agent (except low, which is already a
    // single agent on the shared Find/Verify/Sweep path).
    const inlineSingle = parsed.mode === "inline" && resolved.level !== "low";
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
            level: resolved.level,
            scope,
            mode: parsed.mode,
          }),
      },
      ctx,
    );

    ctx.ui.notify(
      `Reviewing ${scope.label} at ${resolved.level} (${parsed.mode}) — see /workflows`,
      "info",
    );

    // Do not block the turn: present findings when the run settles.
    void handle.settled.then((outcome) => {
      if (outcome.status !== "completed") {
        ctx.ui.notify(
          `Review ${outcome.status}: ${outcome.error ?? "no result"}`,
          "error",
        );
        return;
      }
      presentFindings(pi, store, resolved.level, outcome.result ?? []);
      if (wantComment)
        ctx.ui.notify(
          buildCommentBlock(store.findings, scope, repoSlug),
          "info",
        );
      if (parsed.fix)
        pi.sendUserMessage(buildFixFollowUp(store.findings, resolved.level), {
          deliverAs: "followUp",
        });
    });
  };
}

export default function codeReview(pi: ExtensionAPI) {
  const store = createFindingsStore();
  registerReportFindings(pi, store);

  const handler = createReviewHandler(pi, store, exec);

  const definition = {
    description:
      "Review the current diff (or a PR#/branch/path) for bugs and cleanups",
    getArgumentCompletions: (prefix: string) =>
      COMPLETIONS.filter((word) => word.startsWith(prefix)).map((word) => ({
        value: word,
        label: word,
      })),
    handler,
  };

  pi.registerCommand("code-review", definition);
  // No `aliases` field on RegisteredCommand; register the alias as a twin.
  pi.registerCommand("review", definition);
}
