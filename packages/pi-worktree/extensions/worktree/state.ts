import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { readJsonOrDefault, writeJsonAtomic } from "../shared/state-file.ts";
import {
  parseWorktreeBinding,
  type WorktreeBinding,
} from "../shared/effective-cwd.ts";

export interface ActiveWorktree extends WorktreeBinding {
  branch: string | null;
  /** The commit the worktree was at when created/entered; removal guards compare against it. */
  baseCommit: string;
  /** Directory the session was opened in (the session cwd, never the worktree). */
  originalCwd: string;
  /** True when the session entered a pre-existing worktree instead of creating one. */
  enteredExisting: boolean;
  pid: number;
  createdAt: number;
}

export interface WorktreeLock {
  pid: number;
  sessionId: string;
  createdAt: number;
  worktreePath: string;
}

const STATE_FILE = "worktree-state.json";
const LOCKS_DIR = "worktree-locks";

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Persists the active worktree session and per-worktree liveness locks under
 * the agent dir (~/.pi/agent), so state survives pi restarts and reloads.
 * Locks are pid-liveness checked: a lock held by a dead process is stale.
 */
export class WorktreeStateStore {
  private readonly stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  private stateFile(): string {
    return path.join(this.stateDir, STATE_FILE);
  }

  private lockDir(): string {
    return path.join(this.stateDir, LOCKS_DIR);
  }

  load(): ActiveWorktree | null {
    // The shared leaf owns the on-disk shape: a record that cannot name its
    // session and its tree is not a binding, and callers treat it as absent.
    const raw = readJsonOrDefault<unknown>(this.stateFile(), null);
    return parseWorktreeBinding(raw) ? (raw as ActiveWorktree) : null;
  }

  save(state: ActiveWorktree): void {
    writeJsonAtomic(this.stateFile(), state);
  }

  clear(): void {
    try {
      fs.rmSync(this.stateFile(), { force: true });
    } catch {
      // Nothing to clear.
    }
  }

  lockPathFor(worktreePath: string): string {
    const hash = crypto
      .createHash("sha256")
      .update(worktreePath)
      .digest("hex")
      .slice(0, 32);
    return path.join(this.lockDir(), `${hash}.json`);
  }

  readLock(worktreePath: string): WorktreeLock | null {
    return readJsonOrDefault<WorktreeLock | null>(
      this.lockPathFor(worktreePath),
      null,
    );
  }

  writeLock(lock: WorktreeLock): void {
    writeJsonAtomic(this.lockPathFor(lock.worktreePath), lock);
  }

  releaseLock(worktreePath: string): void {
    try {
      fs.rmSync(this.lockPathFor(worktreePath), { force: true });
    } catch {
      // Nothing to release.
    }
  }

  isLockLive(worktreePath: string): boolean {
    const lock = this.readLock(worktreePath);
    if (!lock) return false;
    if (lock.pid === process.pid) return true;
    return pidAlive(lock.pid);
  }
}
