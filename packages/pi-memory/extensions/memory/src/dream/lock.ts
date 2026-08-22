/**
 * `.consolidate-lock` does double duty, and that is the whole design:
 *   - its mtime is the last-consolidated timestamp (absent → 0, so a fresh
 *     install is immediately eligible);
 *   - its contents are the owning PID.
 *
 * The filename matches Claude Code so an existing CC memory directory's
 * timestamp is honored. Getting rollback wrong means one crashed dream silently
 * suppresses consolidation for 24 hours, so it restores the prior mtime exactly.
 */

import {
  mkdir,
  stat,
  readFile,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

export const LOCK_FILENAME = ".consolidate-lock";
export const LOCK_STALE_MS = 3_600_000;

export function lockPath(memoryDir: string): string {
  return join(memoryDir, LOCK_FILENAME);
}

/** Last-consolidated timestamp in ms; 0 when the lock does not exist. */
export async function readLastConsolidatedAt(
  memoryDir: string,
): Promise<number> {
  try {
    return (await stat(lockPath(memoryDir))).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * `process.kill(pid, 0)` never delivers a signal; it only probes existence.
 * ESRCH means the process is gone; EPERM means it exists but is not ours to
 * signal — still alive. A malformed PID counts as dead so a garbage lock is
 * taken over rather than trusted forever.
 */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Returns the prior mtime on success (0 if the lock was absent), or null when a
 * live, fresh holder blocks us. The PID readback is the race resolution: two
 * processes can both take over a stale lock, both write, and last-writer-wins;
 * only the one whose PID stuck proceeds. It must not be dropped as redundant.
 */
export async function acquireLock(memoryDir: string): Promise<number | null> {
  const path = lockPath(memoryDir);

  let priorMtime = 0;
  try {
    const stats = await stat(path);
    priorMtime = stats.mtimeMs;
    const fresh = Date.now() - stats.mtimeMs < LOCK_STALE_MS;
    if (fresh) {
      const holder = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
      if (pidAlive(holder)) return null;
    }
  } catch {
    priorMtime = 0; // absent (or unreadable) — treat as free
  }

  await mkdir(memoryDir, { recursive: true });
  await writeFile(path, `${process.pid}`, "utf8");
  const readback = (await readFile(path, "utf8")).trim();
  if (readback !== `${process.pid}`) return null;
  return priorMtime;
}

/**
 * Undo a failed acquire so it does not consume the 24h window. A prior mtime of
 * 0 means the lock was created by us and had no history — remove it. Otherwise
 * clear the PID (empty content = no live owner) and restore the timestamp.
 */
export async function rollbackLock(
  memoryDir: string,
  priorMtime: number,
): Promise<void> {
  const path = lockPath(memoryDir);
  if (priorMtime === 0) {
    await unlink(path).catch(() => undefined);
    return;
  }
  await writeFile(path, "", "utf8").catch(() => undefined);
  const seconds = priorMtime / 1000;
  await utimes(path, seconds, seconds).catch(() => undefined);
}
