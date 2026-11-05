/**
 * Claude Code's per-file recall limits. The reader caps a memory body at 200
 * lines or 4096 bytes (`Uve`/`tte`, applied by `mre` in the 2.1.290 CLI) and
 * appends a notice naming the limit that tripped, so the model knows the rest
 * is still on disk. Pi reads the same limits and renders the notice through
 * `truncationNotice`.
 */

export const RECALL_MAX_BYTES = 4_096;
export const RECALL_MAX_LINES = 200;

export interface TruncatedBody {
  readonly text: string;
  /** Which limit tripped, or undefined when the body fit whole. */
  readonly truncatedBy: "bytes" | "lines" | undefined;
}

/** Cut at a UTF-8 boundary so a multi-byte character is never split. */
function capBytes(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return { text: buffer.subarray(0, end).toString("utf8"), truncated: true };
}

/**
 * Cut a memory body to the recall limits. The line limit applies first, then
 * the byte limit, and a byte cut is reported ahead of a line cut the way
 * Claude Code's notice does.
 */
export function truncateMemoryBody(
  body: string,
  maxBytes = RECALL_MAX_BYTES,
  maxLines = RECALL_MAX_LINES,
): TruncatedBody {
  let text = body;
  let truncatedByLines = false;
  const lines = text.split("\n");
  if (lines.length > maxLines) {
    text = lines.slice(0, maxLines).join("\n");
    truncatedByLines = true;
  }
  const capped = capBytes(text, maxBytes);
  if (capped.truncated) return { text: capped.text, truncatedBy: "bytes" };
  return {
    text: capped.text,
    truncatedBy: truncatedByLines ? "lines" : undefined,
  };
}
