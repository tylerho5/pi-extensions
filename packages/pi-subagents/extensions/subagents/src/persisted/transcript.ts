/**
 * Lazy loader for FULL persisted subagent transcripts.
 *
 * Both subagent backends persist their native session files, and the manager
 * only keeps a bounded in-memory transcript (512 items, 64 KiB per text). The
 * full conversation survives on disk:
 *
 * - pi:        `~/.pi/agent/sessions/<escaped-cwd>/<timestamp>_<id>.jsonl`
 *              (`SubagentMeta.sessionFilePath`, i.e. `session.sessionFile`)
 * - Claude:    `~/.claude/projects/<escaped-cwd>/<sessionId>.jsonl` (and
 *              `subagents/<workflow>/agent-*.jsonl` for nested agents)
 *
 * `readPersistedTranscript` is a lazy async generator: calling it performs no
 * I/O, and the file is streamed line by line (never slurped whole), so a
 * transcript of any size costs memory proportional to one record. The format
 * is auto-detected from the first parseable record; malformed lines are
 * skipped exactly like pi's own `parseSessionEntries`.
 *
 * Records are normalized into the shared `TranscriptItem` union
 * (`src/domain.ts`), so the existing takeover renderer and any consumer of
 * snapshots can display persisted transcripts unchanged. The one addition the
 * loader relies on is the optional `toolResult.output` field, which carries
 * the full multi-line tool output (the live pipeline only keeps the
 * single-line `outputPreview`).
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { isBtwContextEnd, isBtwContextStart } from "../by-the-way.ts";
import type { TranscriptItem } from "../domain.ts";
import { createClaudeParser, type ClaudeParser } from "./claude.ts";
import { parsePiEntry } from "./pi.ts";
import { isRecord, parseJsonLine } from "./shared.ts";

export type SessionFormat = "pi" | "claude";

/** pi record types. `session` is the header; `message` carries transcript content. */
const PI_TYPES = new Set([
  "session",
  "message",
  "model_change",
  "thinking_level_change",
  "session_info",
  "compaction",
  "custom_message",
]);

/** Claude Code record types (conversation + bookkeeping). */
const CLAUDE_TYPES = new Set([
  "user",
  "assistant",
  "attachment",
  "system",
  "result",
  "last-prompt",
  "mode",
  "permission-mode",
  "worktree-state",
  "bridge-session",
  "file-history-snapshot",
  "queue-operation",
  "ai-title",
]);

/**
 * Detect the session format from one record. Returns undefined when the
 * record is ambiguous (or the file is not a session file).
 */
export function detectSessionFormat(entry: unknown): SessionFormat | undefined {
  if (!isRecord(entry)) return undefined;
  const type = entry.type;
  if (typeof type === "string") {
    if (PI_TYPES.has(type)) return "pi";
    if (CLAUDE_TYPES.has(type)) return "claude";
  }
  // Every Claude record carries sessionId/agentId; pi records never do.
  if (
    typeof entry.sessionId === "string" ||
    typeof entry.agentId === "string"
  ) {
    return "claude";
  }
  return undefined;
}

/**
 * Stream a persisted session file as normalized transcript items.
 *
 * Lazy: no file is opened until the returned iterator is first pulled. The
 * file is read incrementally (one line at a time); early abandonment closes
 * the file stream. Malformed lines and bookkeeping records (model changes,
 * compaction summaries, Claude attachments/system/result records, ...) are
 * skipped. Throws the underlying fs error (e.g. ENOENT) on the first pull.
 */
export async function* readPersistedTranscript(
  filePath: string,
): AsyncGenerator<TranscriptItem> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let format: SessionFormat | undefined;
    let claude: ClaudeParser | undefined;
    // btw session files carry the inherited parent conversation, fenced with
    // custom entries; the takeover view shows only the aside itself.
    let inInheritedContext = false;
    for await (const line of rl) {
      const entry = parseJsonLine(line);
      if (entry === undefined) continue;
      format ??= detectSessionFormat(entry);
      if (format === "claude") {
        claude ??= createClaudeParser();
        for (const item of claude.parse(entry)) yield item;
      } else if (format === "pi") {
        if (!inInheritedContext && isBtwContextStart(entry)) {
          inInheritedContext = true;
          continue;
        }
        if (inInheritedContext) {
          if (isBtwContextEnd(entry)) inInheritedContext = false;
          continue;
        }
        const item = parsePiEntry(entry);
        if (item) yield item;
      }
    }
  } finally {
    // Releases the fd on both completion and early return/break.
    rl.close();
    stream.destroy();
  }
}

/** Drain `readPersistedTranscript` into an array (use only for finite files). */
export async function loadPersistedTranscript(
  filePath: string,
): Promise<ReadonlyArray<TranscriptItem>> {
  const items: TranscriptItem[] = [];
  for await (const item of readPersistedTranscript(filePath)) items.push(item);
  return items;
}
