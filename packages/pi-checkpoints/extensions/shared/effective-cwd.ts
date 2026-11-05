/**
 * The one reader of a session's active working tree.
 *
 * pi bakes each built-in tool's cwd at creation, and the worktree extension enters a
 * worktree by re-registering the file tools as proxies that resolve against the
 * active worktree while `ctx.cwd` stays the session's original directory. Anything
 * that resolves a path against `ctx.cwd` alone then acts on a same-named file in the
 * wrong tree. This leaf owns the on-disk shape of `worktree-state.json`;
 * `WorktreeStateStore.load()` delegates here, so the format has one reader.
 *
 * Import-free beyond node:* so any consumer can pull it in without a cycle.
 */

import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** The three fields that tie a worktree state record to one session and one tree. */
export interface WorktreeBinding {
  sessionId: string;
  sessionCwd: string;
  worktreePath: string;
}

const STATE_FILE = "worktree-state.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/**
 * The binding a state record carries, or null when it carries none. Null for a
 * record missing any of the three, holding a non-string, or holding an empty
 * string: a record that cannot name its session and its tree cannot be trusted to
 * scope one.
 */
export function parseWorktreeBinding(raw: unknown): WorktreeBinding | null {
  if (!isRecord(raw)) return null;
  const { sessionId, sessionCwd, worktreePath } = raw;
  if (
    !nonEmptyString(sessionId) ||
    !nonEmptyString(sessionCwd) ||
    !nonEmptyString(worktreePath)
  ) {
    return null;
  }
  return { sessionId, sessionCwd, worktreePath };
}

const isDirectory = (target: string): boolean => {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The directory a session's file tools actually resolve against: the recorded
 * worktree when the record belongs to this session, was taken in this session cwd,
 * and still exists; the session cwd otherwise. Never writes.
 */
export function effectiveCwd(
  stateDir: string,
  sessionId: string,
  sessionCwd: string,
): string {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(stateDir, STATE_FILE), "utf8"));
  } catch {
    return sessionCwd;
  }
  const binding = parseWorktreeBinding(raw);
  if (!binding) return sessionCwd;
  if (binding.sessionId !== sessionId) return sessionCwd;
  if (resolve(binding.sessionCwd) !== resolve(sessionCwd)) return sessionCwd;
  return isDirectory(binding.worktreePath) ? binding.worktreePath : sessionCwd;
}
