/**
 * Git commands: /lg browses local changes, /pr resolves the branch's open PR.
 *
 * Both run on demand. Branch and worktree state already appear in the footer,
 * so nothing polls here.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import {
  loadChangedFiles,
  showChangedFiles,
} from "./src/changed-files-view.ts";
import { runCommand } from "./src/process.ts";
import {
  createRuntime,
  runEffect,
  type GitInfoRuntime,
} from "./src/runtime.ts";

const GIT_TIMEOUT_MS = 3_000;
const GH_TIMEOUT_MS = 10_000;

interface PullRequestInfo {
  readonly number: number;
  readonly url: string;
  readonly isDraft: boolean;
}

function parsePullRequest(value: unknown) {
  if (typeof value !== "object" || value === null) return null;
  if (!("number" in value) || typeof value.number !== "number") return null;
  if (!("url" in value) || typeof value.url !== "string") return null;
  if (!("state" in value) || value.state !== "OPEN") return null;

  return {
    number: value.number,
    url: value.url,
    isDraft: "isDraft" in value && value.isDraft === true,
  } satisfies PullRequestInfo;
}

function parsePullRequestJson(value: string) {
  try {
    return parsePullRequest(JSON.parse(value));
  } catch {
    return null;
  }
}

/** Null when not a repository; a resolved branch with a null PR means none is open. */
const lookupPullRequest = (cwd: string) =>
  Effect.gen(function* () {
    const repo = yield* runCommand(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      cwd,
      GIT_TIMEOUT_MS,
    );
    if (repo.code !== 0 || repo.stdout.trim() !== "true") return null;

    const branchResult = yield* runCommand(
      "git",
      ["branch", "--show-current"],
      cwd,
      GIT_TIMEOUT_MS,
    );
    const branch = branchResult.stdout.trim();
    if (!branch) return { branch: "detached HEAD", pullRequest: null };

    const result = yield* runCommand(
      "gh",
      ["pr", "view", branch, "--json", "number,url,state,isDraft"],
      cwd,
      GH_TIMEOUT_MS,
    );
    return {
      branch,
      pullRequest:
        result.code === 0 ? parsePullRequestJson(result.stdout) : null,
    };
  });

export default function gitInfo(pi: ExtensionAPI) {
  let runtime: GitInfoRuntime | undefined;
  const getRuntime = () => (runtime ??= createRuntime());

  pi.on("session_shutdown", async () => {
    const closing = runtime;
    runtime = undefined;
    await closing?.dispose();
  });

  pi.registerCommand("lg", {
    description: "Browse changed files and their diffs",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(
          "The local changes viewer requires the interactive TUI",
          "warning",
        );
        return;
      }

      const files = await runEffect(getRuntime(), loadChangedFiles(ctx.cwd), {
        signal: ctx.signal,
        interruptMessage: "Loading changed files was cancelled.",
      });
      if (files === null) {
        ctx.ui.notify("Not a git repository", "warning");
        return;
      }
      if (files.length === 0) {
        ctx.ui.notify("Working tree is clean", "info");
        return;
      }

      await showChangedFiles(ctx, files);
    },
  });

  pi.registerCommand("pr", {
    description: "Show the open pull request for the current branch",
    handler: async (_args, ctx) => {
      const found = await runEffect(getRuntime(), lookupPullRequest(ctx.cwd), {
        signal: ctx.signal,
        interruptMessage: "Pull request lookup was cancelled.",
      });

      if (found === null) {
        ctx.ui.notify("Not a git repository", "warning");
      } else if (found.pullRequest) {
        const draft = found.pullRequest.isDraft ? " (draft)" : "";
        ctx.ui.notify(
          `PR #${found.pullRequest.number}${draft}: ${found.pullRequest.url}`,
          "info",
        );
      } else {
        ctx.ui.notify(`No open PR found for ${found.branch}`, "info");
      }
    },
  });
}
