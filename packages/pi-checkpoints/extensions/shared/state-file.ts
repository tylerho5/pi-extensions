import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Cold-start-safe JSON state I/O: read-with-fallback and atomic write.
 * Consolidates the hand-rolled helpers in worktree/state.ts and
 * summaries/src/config.ts. Import-free beyond node:* so any package can copy
 * this file standalone.
 */

export function readJsonOrDefault<T>(
  file: string,
  fallback: T,
  parse?: (raw: unknown) => T,
): T {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return parse ? parse(raw) : (raw as T);
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(
  file: string,
  value: unknown,
  mode?: number,
): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      tmp,
      JSON.stringify(value, null, 2),
      mode !== undefined ? { mode } : undefined,
    );
    renameSync(tmp, file);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw error;
  }
}
