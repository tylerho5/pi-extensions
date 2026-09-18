import * as fs from "node:fs";
import * as path from "node:path";
import {
  branchNameFor,
  commitsAheadOfBase,
  ensureInfoExclude,
  errorText,
  getDefaultBranch,
  getRepoRoot,
  git,
  isGitRepo,
  isInside,
  isMergedIntoUpstream,
  listWorktrees,
  randomWorktreeName,
  resolveBase,
  samePath,
  tryGit,
  validateSlug,
} from "./git.ts";
import { type ActiveWorktree, WorktreeStateStore } from "./state.ts";
import { resolveWorktreeRoot, type WorktreeConfig } from "./config.ts";

/** Refusal messages that the model is expected to read and act on. */
export class WorktreeSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeSessionError";
  }
}

export interface WorktreeDeps {
  sessionCwd: string;
  sessionId: string;
  stateDir: string;
  config?: Partial<WorktreeConfig>;
  /** Asked before entering an existing worktree outside the managed root. Absent (headless) = refuse. */
  confirmEnterPath?: (target: string) => Promise<boolean>;
}

export interface EnterWorktreeInput {
  name?: string;
  path?: string;
}

export interface EnterWorktreeResult {
  state: ActiveWorktree;
  message: string;
}

export interface ExitWorktreeInput {
  action: "keep" | "remove";
  discard_changes?: boolean;
}

export interface ExitWorktreeResult {
  action: "keep" | "remove";
  originalCwd: string;
  worktreePath: string;
  worktreeBranch: string | null;
  discardedFiles: number;
  discardedCommits: number;
  message: string;
}

export interface WorktreeChangeCounts {
  changedFiles: number;
  commits: number;
}

export async function worktreeChanges(
  worktreePath: string,
  baseCommit: string,
): Promise<WorktreeChangeCounts | null> {
  try {
    const status = await git(worktreePath, "status", "--porcelain");
    const changedFiles = status
      .split("\n")
      .filter((l) => l.trim() !== "").length;
    return {
      changedFiles,
      commits: await commitsAheadOfBase(worktreePath, baseCommit),
    };
  } catch {
    return null;
  }
}

function managedRootFor(repoRoot: string, config?: Partial<WorktreeConfig>) {
  return resolveWorktreeRoot(repoRoot, config);
}

export async function enterWorktree(
  deps: WorktreeDeps,
  input: EnterWorktreeInput,
): Promise<EnterWorktreeResult> {
  const { sessionCwd, sessionId, stateDir, config } = deps;
  if (!(await isGitRepo(sessionCwd))) {
    throw new WorktreeSessionError(
      "Cannot create a worktree: not in a git repository. Run pi from inside a git repo.",
    );
  }
  const repoRoot = await getRepoRoot(sessionCwd);
  const store = new WorktreeStateStore(stateDir);
  const stored = store.load();
  const active = stored && stored.sessionId === sessionId ? stored : null;

  if (input.name !== undefined && input.path !== undefined) {
    throw new WorktreeSessionError(
      "Provide at most one of `name` or `path`, not both.",
    );
  }
  if (active && input.path === undefined) {
    throw new WorktreeSessionError(
      "Already in a worktree session. Pass `path` to switch into another existing worktree, or use exit_worktree to leave this one before creating a new worktree.",
    );
  }

  const worktrees = await listWorktrees(repoRoot);

  if (input.path !== undefined) {
    const target = path.resolve(sessionCwd, input.path);
    const existing = worktrees.find((wt) => samePath(wt.path, target));
    if (!existing) {
      throw new WorktreeSessionError(
        `"${target}" is not a registered worktree of this repository (not in \`git worktree list\`). Pass the path of an existing worktree, or create one with \`name\`.`,
      );
    }
    const managedRoot = managedRootFor(repoRoot, config);
    if (!isInside(managedRoot, existing.path)) {
      const ok = deps.confirmEnterPath
        ? await deps.confirmEnterPath(existing.path)
        : false;
      if (!ok) {
        throw new WorktreeSessionError(
          `Entering a worktree outside the managed root (${managedRoot}) requires interactive confirmation. Use a worktree under ${managedRoot}, or confirm the prompt when asked.`,
        );
      }
    }
    if (store.readLock(existing.path) && !store.isLockLive(existing.path)) {
      store.releaseLock(existing.path);
    }
    const state: ActiveWorktree = {
      worktreePath: existing.path,
      branch: existing.branch,
      baseCommit: existing.head,
      originalCwd: sessionCwd,
      sessionCwd,
      enteredExisting: true,
      sessionId,
      pid: process.pid,
      createdAt: Date.now(),
    };
    store.save(state);
    store.writeLock({
      pid: state.pid,
      sessionId: state.sessionId,
      createdAt: state.createdAt,
      worktreePath: state.worktreePath,
    });
    return {
      state,
      message: `Entered worktree at ${state.worktreePath}${
        state.branch ? ` on branch ${state.branch}` : ""
      }. The session is now working in the worktree; the previous directory was left untouched. Use exit_worktree to leave.`,
    };
  }

  // Create (or reuse) a named worktree.
  const name = input.name ?? randomWorktreeName();
  try {
    validateSlug(name);
  } catch (err) {
    throw new WorktreeSessionError(errorText(err));
  }
  const managedRoot = managedRootFor(repoRoot, config);
  const targetPath = path.join(managedRoot, name);
  const existing = worktrees.find((wt) => samePath(wt.path, targetPath));

  let action: "created" | "reused" | "resumed" = "created";
  let branch: string | null = null;
  let enteredExisting = false;

  if (existing) {
    const lock = store.readLock(existing.path);
    if (lock && store.isLockLive(existing.path) && lock.pid !== process.pid) {
      throw new WorktreeSessionError(
        `Another pi session (pid ${lock.pid}) is using the worktree at ${existing.path}. Wait for it to exit, or choose a different name.`,
      );
    }
    if (lock) store.releaseLock(existing.path);
    const defaultBranch = await getDefaultBranch(repoRoot);
    const upstream = await tryGit(
      repoRoot,
      "rev-parse",
      "--verify",
      `origin/${defaultBranch}`,
    );
    const merged =
      existing.branch && upstream
        ? await isMergedIntoUpstream(repoRoot, existing.branch, upstream)
        : false;
    if (merged) {
      await tryGit(repoRoot, "worktree", "remove", "--force", existing.path);
      if (existing.branch) {
        await tryGit(repoRoot, "branch", "-D", existing.branch);
      }
      fs.rmSync(existing.path, { recursive: true, force: true });
      action = "reused";
    } else {
      action = "resumed";
      enteredExisting = true;
      branch = existing.branch;
    }
  } else if (fs.existsSync(targetPath)) {
    throw new WorktreeSessionError(
      `"${targetPath}" already exists but is not a registered worktree of this repository. Remove that directory, or pass a different name.`,
    );
  }

  if (action !== "resumed") {
    fs.mkdirSync(managedRoot, { recursive: true });
    await ensureInfoExclude(repoRoot, managedRoot);
    const base = await resolveBase(repoRoot, config?.baseRef ?? "fresh");
    branch = branchNameFor(name);
    await git(repoRoot, "worktree", "add", "-b", branch, targetPath, base);
  }

  const info = (await listWorktrees(repoRoot)).find((wt) =>
    samePath(wt.path, targetPath),
  );
  branch = info?.branch ?? branch;
  const baseCommit = info?.head ?? (await git(repoRoot, "rev-parse", "HEAD"));

  const state: ActiveWorktree = {
    worktreePath: targetPath,
    branch,
    baseCommit,
    originalCwd: sessionCwd,
    sessionCwd,
    enteredExisting,
    sessionId,
    pid: process.pid,
    createdAt: Date.now(),
  };
  store.save(state);
  store.writeLock({
    pid: state.pid,
    sessionId: state.sessionId,
    createdAt: state.createdAt,
    worktreePath: state.worktreePath,
  });

  const verb =
    action === "created"
      ? "Created"
      : action === "reused"
        ? "Reused"
        : "Resumed";
  const onBranch = state.branch ? ` on branch ${state.branch}` : "";
  const note =
    action === "reused"
      ? " A worktree with this name already existed; its previous work was fully merged upstream, so it was reset to the current base."
      : action === "resumed"
        ? " A worktree with this name already existed and was resumed as-is — it may carry an earlier session's commits. Pass a different name if you wanted a fresh worktree."
        : "";
  return {
    state,
    message: `${verb} worktree at ${state.worktreePath}${onBranch}.${note} The session is now working in the worktree. Use exit_worktree to leave mid-session; leaving pi keeps the worktree in place.`,
  };
}

export async function exitWorktree(
  deps: WorktreeDeps,
  input: ExitWorktreeInput,
): Promise<ExitWorktreeResult> {
  const { sessionCwd, sessionId, stateDir } = deps;
  const store = new WorktreeStateStore(stateDir);
  const stored = store.load();
  const active = stored && stored.sessionId === sessionId ? stored : null;
  if (!active) {
    throw new WorktreeSessionError(
      "No-op: there is no active worktree session to exit. This tool only operates on worktrees created by enter_worktree in the current session — it will not touch worktrees created manually or in a previous session. No filesystem changes were made.",
    );
  }
  const { worktreePath, branch, originalCwd } = active;

  let discardedFiles = 0;
  let discardedCommits = 0;

  if (input.action === "remove") {
    if (active.enteredExisting) {
      throw new WorktreeSessionError(
        `This session is not the owner of the worktree at ${worktreePath} — it entered a pre-existing worktree — so this tool will not remove it. Use action: "keep" to return to ${originalCwd}. When no session is using it, remove it yourself with \`git worktree remove\`.`,
      );
    }
    const counts = await worktreeChanges(worktreePath, active.baseCommit);
    if (counts === null) {
      throw new WorktreeSessionError(
        `Could not verify worktree state at ${worktreePath}. Refusing to remove without explicit confirmation. Re-invoke with discard_changes: true to proceed — or use action: "keep" to preserve the worktree.`,
      );
    }
    discardedFiles = counts.changedFiles;
    discardedCommits = counts.commits;
    if (
      !input.discard_changes &&
      (counts.changedFiles > 0 || counts.commits > 0)
    ) {
      const parts: string[] = [];
      if (counts.changedFiles > 0) {
        parts.push(
          `${counts.changedFiles} uncommitted ${counts.changedFiles === 1 ? "file" : "files"}`,
        );
      }
      if (counts.commits > 0) {
        parts.push(
          `${counts.commits} ${counts.commits === 1 ? "commit" : "commits"} on ${branch ?? "the worktree branch"}`,
        );
      }
      throw new WorktreeSessionError(
        `Worktree has ${parts.join(" and ")}. Removing will discard this work permanently. Confirm with the user, then re-invoke with discard_changes: true — or use action: "keep" to preserve the worktree.`,
      );
    }
  }

  let removed = false;
  if (input.action === "remove") {
    try {
      const repoRoot = await getRepoRoot(sessionCwd);
      await git(repoRoot, "worktree", "remove", "--force", worktreePath);
      removed = true;
      if (branch) {
        await tryGit(repoRoot, "branch", "-D", branch);
      }
    } catch {
      removed = false;
    }
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }

  store.clear();
  store.releaseLock(worktreePath);

  const cwdNote = fs.existsSync(originalCwd)
    ? ""
    : ` Note: the original directory ${originalCwd} no longer exists.`;

  if (input.action === "keep") {
    return {
      action: "keep",
      originalCwd,
      worktreePath,
      worktreeBranch: branch,
      discardedFiles: 0,
      discardedCommits: 0,
      message: `Exited worktree. Your work is preserved at ${worktreePath}${
        branch ? ` on branch ${branch}` : ""
      }.${cwdNote}`,
    };
  }

  if (removed) {
    const discarded =
      discardedCommits > 0
        ? ` Discarded ${discardedCommits} ${discardedCommits === 1 ? "commit" : "commits"}`
        : "";
    const discardedTail =
      discardedFiles > 0
        ? `${discardedCommits > 0 ? " and" : " Discarded"} ${discardedFiles} uncommitted ${discardedFiles === 1 ? "file" : "files"}`
        : "";
    return {
      action: "remove",
      originalCwd,
      worktreePath,
      worktreeBranch: branch,
      discardedFiles,
      discardedCommits,
      message: `Exited and removed worktree at ${worktreePath}.${discarded}${discardedTail}${cwdNote}`,
    };
  }
  return {
    action: "remove",
    originalCwd,
    worktreePath,
    worktreeBranch: branch,
    discardedFiles,
    discardedCommits,
    message: `Exited worktree but could not remove it — kept at ${worktreePath}. Remove it manually with \`git worktree remove --force ${worktreePath}\`.${cwdNote}`,
  };
}

/**
 * Decides the auto exit-action for a session_shutdown, mirroring CC's
 * WorktreeExitDialog: an owned worktree that is clean (no uncommitted files,
 * no commits ahead of the base it was branched from) is removed without a
 * prompt; anything else defaults to keep (never destroy work on a path that
 * cannot confirm). A non-owner (enteredExisting) worktree is always kept.
 */
export function chooseExitAction(
  counts: WorktreeChangeCounts | null,
  enteredExisting: boolean,
): "keep" | "remove" {
  if (enteredExisting) return "keep";
  if (counts && counts.changedFiles === 0 && counts.commits === 0)
    return "remove";
  return "keep";
}
