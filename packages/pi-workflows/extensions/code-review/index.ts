/**
 * code-review: a port of Claude Code's `/code-review`. Resolves the review
 * scope, then launches the TS phase engine as a programmatic run through the
 * shared workflow-runtime (tracked live in /workflows), and renders findings
 * via the report_findings tool + renderer. The command turn never blocks on the
 * review; findings are presented when the run settles.
 *
 * The launch lifecycle itself lives in launch.ts, shared with the model-facing
 * `code_review` tool. This module keeps the command adapter and the wiring.
 */

import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  EFFORT_LEVELS,
  MODES,
  parseArgs,
  resolveEffort,
  type ParsedArgs,
} from "./command.ts";
import { createFindingsStore, registerReportFindings } from "./findings.ts";
import { createReviewLauncher, type ReviewLauncher } from "./launch.ts";
import { loadLastEffort, saveLastEffort } from "./state.ts";
import type { Runner } from "./target.ts";
import { registerCodeReviewTool } from "./tool.ts";

const COMPLETIONS = [...EFFORT_LEVELS, ...MODES, "ultra", "--fix", "--comment"];

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

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

export function createReviewHandler(
  launch: ReviewLauncher,
): (rawArgs: string, ctx: ExtensionCommandContext) => Promise<void> {
  return async (rawArgs: string, ctx: ExtensionCommandContext) => {
    const parsed = parseArgs(rawArgs);
    const resolved = resolveEffort(parsed, loadLastEffort());
    if (parsed.explicit) await saveLastEffort(parsed.explicit);

    for (const note of argNotes(parsed)) ctx.ui.notify(note, "warning");

    try {
      await launch(
        {
          target: parsed.target,
          level: resolved.level,
          mode: parsed.mode,
          fix: parsed.fix,
          comment: parsed.comment,
        },
        ctx,
      );
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
  };
}

export default function codeReview(pi: ExtensionAPI) {
  const store = createFindingsStore();
  registerReportFindings(pi, store);

  const launch = createReviewLauncher(pi, store, exec);
  const handler = createReviewHandler(launch);
  registerCodeReviewTool(pi, launch);

  pi.on("resources_discover", () => ({
    skillPaths: [join(EXTENSION_DIR, "skills")],
  }));

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
