/**
 * Per-agent git worktree isolation, mirroring CC's `isolation: 'worktree'`.
 *
 * Expensive (a checkout per agent), so it is opt-in and only worth it when
 * agents mutate files concurrently and would otherwise collide. A worktree that
 * the agent left unchanged is removed automatically; one with uncommitted
 * changes or new commits is kept and its path and branch reported, so the work
 * is never silently discarded.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;

async function git(cwd: string, ...gitArgs: string[]) {
  const { stdout } = await run("git", gitArgs, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

export interface WorktreeRelease {
  removed: boolean;
  /** Uncommitted-file count, or -1 when the worktree could not be read. */
  changedFiles: number;
  /** Commits on the worktree branch since it was created. */
  commits: number;
  branch: string;
}

export interface Worktree {
  path: string;
  branch: string;
  /** Removes the worktree when untouched; keeps and reports it when changed. */
  release(): Promise<WorktreeRelease>;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, "rev-parse", "--is-inside-work-tree")) === "true";
  } catch {
    return false;
  }
}

/**
 * Creates a worktree on a new branch at the current HEAD. `label` only decorates
 * the branch name; uniqueness comes from the caller-supplied run and agent ids.
 */
export async function createWorktree(options: {
  cwd: string;
  runId: string;
  agentIndex: number;
  label: string;
}): Promise<Worktree> {
  const repoRoot = await git(options.cwd, "rev-parse", "--show-toplevel");
  const slug =
    options.label.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 32) || "agent";
  const branch = `wf/${options.runId}/${options.agentIndex}-${slug}`;
  const worktreePath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-")),
    slug,
  );

  await git(repoRoot, "worktree", "add", "-b", branch, worktreePath, "HEAD");
  const baseCommit = await git(repoRoot, "rev-parse", "HEAD");

  return {
    path: worktreePath,
    branch,
    async release() {
      let changedFiles = 0;
      let commits = 0;
      try {
        const status = await git(worktreePath, "status", "--porcelain");
        changedFiles = status ? status.split("\n").length : 0;
        const head = await git(worktreePath, "rev-parse", "HEAD");
        commits = Number(
          await git(repoRoot, "rev-list", "--count", `${baseCommit}..${head}`),
        );
      } catch {
        // Treat an unreadable worktree as changed and leave it in place.
        return { removed: false, changedFiles: -1, commits: 0, branch };
      }
      // A clean tree with a new commit is committed work, not an untouched
      // worktree: keeping it is the whole point of the branch.
      if (changedFiles > 0 || commits > 0)
        return { removed: false, changedFiles, commits, branch };
      try {
        await git(repoRoot, "worktree", "remove", "--force", worktreePath);
        await git(repoRoot, "branch", "-D", branch);
        fs.rmSync(path.dirname(worktreePath), {
          recursive: true,
          force: true,
        });
      } catch {
        return { removed: false, changedFiles: 0, commits: 0, branch };
      }
      return { removed: true, changedFiles: 0, commits: 0, branch };
    },
  };
}
