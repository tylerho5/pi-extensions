/**
 * Where memories live. Claude Code keys its memory directory by working
 * directory (`~/.claude/projects/<slug>/memory/`); this keys by pi's own cwd
 * slug instead, so memory sits beside the sessions it was written in.
 */

import { join, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { MEMORY_INDEX_FILENAME } from "./prompt.ts";

/** Pi's cwd encoding, matching the `sessions/` directory names it already writes. */
export function projectSlug(cwd: string) {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Absolute memory directory, with a trailing separator so it reads as a
 * directory in the prompt. `PI_MEMORY_DIR` overrides it wholesale, which is
 * how the test suite and one-off sandboxes point memory somewhere else.
 */
export function memoryDir(cwd: string, agentDir = getAgentDir()) {
  const override = process.env.PI_MEMORY_DIR?.trim();
  const dir = override ? override : join(agentDir, "memory", projectSlug(cwd));
  return dir.endsWith(sep) ? dir : dir + sep;
}

export function memoryIndexPath(cwd: string, agentDir = getAgentDir()) {
  return memoryDir(cwd, agentDir) + MEMORY_INDEX_FILENAME;
}
