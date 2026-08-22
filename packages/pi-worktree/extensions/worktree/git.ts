import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

/** Runs git; throws GitError on failure. Returns trimmed stdout. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    throw new GitError(`git ${args.join(" ")} failed: ${errorText(err)}`);
  }
}

/** Runs git, returning null instead of throwing. For probes and best-effort cleanup. */
export async function tryGit(
  cwd: string,
  ...args: string[]
): Promise<string | null> {
  try {
    return await git(cwd, ...args);
  } catch {
    return null;
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  return (await tryGit(cwd, "rev-parse", "--is-inside-work-tree")) === "true";
}

export async function getRepoRoot(cwd: string): Promise<string> {
  return git(cwd, "rev-parse", "--show-toplevel");
}

/** Default branch from origin/HEAD, falling back to the local branch name. */
export async function getDefaultBranch(repoRoot: string): Promise<string> {
  const fromOrigin = await tryGit(
    repoRoot,
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  );
  if (fromOrigin && fromOrigin.startsWith("origin/")) {
    return fromOrigin.slice("origin/".length);
  }
  const local = await tryGit(repoRoot, "symbolic-ref", "--short", "HEAD");
  if (local && local !== "HEAD") return local;
  return "main";
}

/**
 * Base ref for a new worktree. "fresh" (the default) branches from
 * origin/<default-branch> for a clean tree, falling back to HEAD when the
 * remote ref does not exist; "head" branches from the local HEAD.
 */
export async function resolveBase(
  repoRoot: string,
  baseRef: "fresh" | "head",
): Promise<string> {
  if (baseRef === "head") return "HEAD";
  const defaultBranch = await getDefaultBranch(repoRoot);
  const upstream = await tryGit(
    repoRoot,
    "rev-parse",
    "--verify",
    `origin/${defaultBranch}`,
  );
  return upstream ? `origin/${defaultBranch}` : "HEAD";
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string;
}

export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
  const out = await git(repoRoot, "worktree", "list", "--porcelain");
  const entries: WorktreeInfo[] = [];
  let current: { path?: string; branch?: string | null; head?: string } | null =
    null;
  const unquote = (s: string) =>
    s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
  for (const line of out.split("\n")) {
    if (line === "") {
      if (current?.path && current.head) entries.push(current as WorktreeInfo);
      current = null;
      continue;
    }
    if (!current) current = {};
    if (line.startsWith("worktree ")) {
      current.path = unquote(line.slice("worktree ".length));
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    } else if (line === "detached") {
      current.branch = null;
    }
  }
  if (current?.path && current.head) entries.push(current as WorktreeInfo);
  return entries;
}

/** True when `branch` is an ancestor of `upstream` (its work was merged). */
export async function isMergedIntoUpstream(
  repoRoot: string,
  branch: string,
  upstream: string,
): Promise<boolean> {
  return (
    (await tryGit(
      repoRoot,
      "merge-base",
      "--is-ancestor",
      branch,
      upstream,
    )) !== null
  );
}

export async function hasUncommittedChanges(
  worktreePath: string,
): Promise<boolean> {
  const status = await tryGit(worktreePath, "status", "--porcelain");
  return status !== null && status.trim() !== "";
}

export async function commitsAheadOfBase(
  worktreePath: string,
  baseCommit: string,
): Promise<number> {
  const count = await tryGit(
    worktreePath,
    "rev-list",
    "--count",
    `${baseCommit}..HEAD`,
  );
  if (count === null) return 0;
  return parseInt(count, 10) || 0;
}

const SLUG_SEGMENT = /^[a-zA-Z0-9._-]+$/;

/** CC's naming rule: "/"-separated segments of letters, digits, dots, underscores, dashes; <= 64 chars. */
export function validateSlug(name: string): void {
  if (name.length === 0 || name.length > 64) {
    throw new Error("Worktree names must be between 1 and 64 characters long.");
  }
  for (const segment of name.split("/")) {
    if (!SLUG_SEGMENT.test(segment)) {
      throw new Error(
        `Invalid worktree name "${name}": each "/"-separated segment may contain only letters, digits, dots, underscores, and dashes.`,
      );
    }
  }
}

const ADJECTIVES = [
  "brave",
  "calm",
  "eager",
  "lucky",
  "mellow",
  "nimble",
  "quiet",
  "rapid",
  "silent",
  "sunny",
  "vivid",
  "witty",
];

const NOUNS = [
  "falcon",
  "harbor",
  "lantern",
  "maple",
  "otter",
  "pebble",
  "quill",
  "raven",
  "summit",
  "thistle",
  "willow",
  "zephyr",
];

export function randomWorktreeName(): string {
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(Math.random() * items.length)]!;
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}

export function branchNameFor(slug: string): string {
  return `pi-worktrees/${slug}`;
}

export function samePath(a: string, b: string): boolean {
  const realA = safeRealpath(a);
  const realB = safeRealpath(b);
  if (realA && realB) return realA === realB;
  return path.resolve(a) === path.resolve(b);
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Hides the managed worktrees directory from `git status` without touching
 * tracked files: .git/info/exclude is repo-local and never committed.
 * Skipped when the checkout's .git is a linked-worktree gitdir file.
 */
export async function ensureInfoExclude(
  repoRoot: string,
  dir: string,
): Promise<void> {
  const rel = path.relative(repoRoot, dir);
  if (rel === "" || rel.startsWith("..")) return;
  const gitDir = path.join(repoRoot, ".git");
  try {
    if (!fs.statSync(gitDir).isDirectory()) return;
  } catch {
    return;
  }
  const excludePath = path.join(gitDir, "info", "exclude");
  let existing = "";
  try {
    existing = fs.readFileSync(excludePath, "utf8");
  } catch {
    // Missing file: create below.
  }
  const pattern = `${rel.split(path.sep).join("/")}/`;
  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(pattern) || lines.includes(pattern.slice(0, -1))) return;
  const line = `${pattern}\n`;
  fs.appendFileSync(
    excludePath,
    existing === "" || existing.endsWith("\n") ? line : `\n${line}`,
  );
}
