/**
 * Loading MEMORY.md into context, including Claude Code's truncation and the
 * warning it appends when an index outgrows its budget (`Rtr`/`EDt` in the
 * bundled CLI, 2.1.220 around byte offset 229.07M).
 */

import { readFile } from "node:fs/promises";
import {
  INDEX_MAX_CHARS,
  INDEX_MAX_LINES,
  MEMORY_INDEX_FILENAME,
} from "./prompt.ts";

export interface LoadedIndex {
  /** What the model sees, warning included when the index was cut. */
  content: string;
  lineCount: number;
  charCount: number;
  truncatedByLines: boolean;
  truncatedByChars: boolean;
}

/** Claude Code's byte formatter, used in the truncation warning. */
function formatSize(chars: number) {
  const kb = chars / 1024;
  if (kb < 1) return `${chars} bytes`;
  if (kb < 1024) return `${kb.toFixed(1).replace(/\.0$/, "")}KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1).replace(/\.0$/, "")}MB`;
  return `${(mb / 1024).toFixed(1).replace(/\.0$/, "")}GB`;
}

/**
 * Trim the index to whichever limit trips first. When the line cut still leaves
 * too many characters, it is cut again at the last newline inside the budget so
 * the model never sees half an entry.
 */
export function truncateIndex(raw: string): LoadedIndex {
  const trimmed = raw.trim();
  const lineCount = trimmed.split("\n").length;
  const charCount = trimmed.length;
  const truncatedByLines = lineCount > INDEX_MAX_LINES;
  const truncatedByChars = charCount > INDEX_MAX_CHARS;

  if (!truncatedByLines && !truncatedByChars) {
    return {
      content: trimmed,
      lineCount,
      charCount,
      truncatedByLines,
      truncatedByChars,
    };
  }

  let cut = truncatedByLines
    ? trimmed.split("\n").slice(0, INDEX_MAX_LINES).join("\n")
    : trimmed;
  if (cut.length > INDEX_MAX_CHARS) {
    const lastNewline = cut.lastIndexOf("\n", INDEX_MAX_CHARS);
    cut = cut.slice(0, lastNewline > 0 ? lastNewline : INDEX_MAX_CHARS);
  }

  const overage =
    truncatedByChars && !truncatedByLines
      ? `${formatSize(charCount)} (limit: ${formatSize(INDEX_MAX_CHARS)}) — index entries are too long`
      : truncatedByLines && !truncatedByChars
        ? `${lineCount} lines (limit: ${INDEX_MAX_LINES})`
        : `${lineCount} lines and ${formatSize(charCount)}`;

  const warning =
    `${MEMORY_INDEX_FILENAME} is ${overage}. Only part of it was loaded. ` +
    `Keep index entries to one line under ~200 chars; move detail into topic files.`;

  return {
    content: `${cut}\n\n> WARNING: ${warning}`,
    lineCount,
    charCount,
    truncatedByLines,
    truncatedByChars,
  };
}

/** Null when the index does not exist yet or holds nothing but whitespace. */
export async function readIndex(indexPath: string) {
  try {
    const raw = await readFile(indexPath, "utf8");
    if (!raw.trim()) return null;
    return truncateIndex(raw);
  } catch {
    return null;
  }
}

/**
 * The index as a system-prompt section. The header is Claude Code's, which
 * labels MEMORY.md the same way it labels the AGENTS.md-equivalent files it
 * loads beside it. The empty-state line is Claude Code's too, borrowed from the
 * agent-memory variant of the same index.
 */
export function formatIndexSection(
  indexPath: string,
  index: LoadedIndex | null,
) {
  if (!index) {
    return [
      `## ${MEMORY_INDEX_FILENAME}`,
      "",
      `Your ${MEMORY_INDEX_FILENAME} is currently empty. When you save new memories, they will appear here.`,
    ].join("\n");
  }
  return [
    `Contents of ${indexPath} (user's auto-memory, persists across conversations):`,
    "",
    index.content,
  ].join("\n");
}
