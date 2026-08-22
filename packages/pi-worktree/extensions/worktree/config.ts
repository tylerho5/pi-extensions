import * as fs from "node:fs";
import * as path from "node:path";

export interface WorktreeConfig {
  /** "fresh" branches from origin/<default-branch>; "head" from local HEAD. */
  baseRef: "fresh" | "head";
  /** Where new worktrees go. Relative paths resolve against the repo root. */
  worktreeRoot?: string;
}

export const DEFAULT_WORKTREE_ROOT = ".pi/worktrees";

/**
 * Loads ~/.pi/agent/worktree.json, tolerating absence and malformed content.
 * Unknown fields are ignored so a stale config never breaks the tools.
 */
export function loadConfig(stateDir: string): WorktreeConfig {
  const out: WorktreeConfig = { baseRef: "fresh" };
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, "worktree.json"), "utf8"),
    );
    if (raw && typeof raw === "object") {
      if (raw.baseRef === "fresh" || raw.baseRef === "head") {
        out.baseRef = raw.baseRef;
      }
      if (typeof raw.worktreeRoot === "string" && raw.worktreeRoot.trim()) {
        out.worktreeRoot = raw.worktreeRoot.trim();
      }
    }
  } catch {
    // Missing or unreadable config: defaults apply.
  }
  return out;
}

export function resolveWorktreeRoot(
  repoRoot: string,
  config?: Partial<WorktreeConfig>,
): string {
  const root = config?.worktreeRoot?.trim() || DEFAULT_WORKTREE_ROOT;
  return path.isAbsolute(root)
    ? path.normalize(root)
    : path.resolve(repoRoot, root);
}
