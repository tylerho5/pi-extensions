/**
 * Last-used review effort, persisted so `/code-review` (no level) repeats the
 * user's previous choice. Follows the advisor/subagent-models conventions:
 * call-time path resolution, per-field fallback, atomic temp-file + rename, so
 * a corrupt or half-written file can never break the command.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { EFFORT_LEVELS, type Effort } from "./command.ts";

function statePath(): string {
  return join(getAgentDir(), "code-review", "state.json");
}

function isEffort(value: unknown): value is Effort {
  return (
    typeof value === "string" &&
    (EFFORT_LEVELS as readonly string[]).includes(value)
  );
}

export function loadLastEffort(): Effort | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath(), "utf8"));
    if (parsed && typeof parsed === "object") {
      const value = (parsed as { lastEffort?: unknown }).lastEffort;
      if (isEffort(value)) return value;
    }
  } catch {
    // No state yet, or an unreadable/corrupt file.
  }
  return undefined;
}

export async function saveLastEffort(effort: Effort): Promise<void> {
  const path = statePath();
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(
      tempPath,
      `${JSON.stringify({ lastEffort: effort }, null, 2)}\n`,
      "utf8",
    );
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
