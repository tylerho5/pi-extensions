/**
 * pi session-file parser: normalizes one JSONL record into transcript items.
 *
 * Session files (`~/.pi/agent/sessions/<escaped-cwd>/<timestamp>_<id>.jsonl`)
 * append one JSON object per line: a `session` header, bookkeeping records
 * (`model_change`, `thinking_level_change`, `session_info`, `compaction`,
 * `custom_message`, ...), and `message` records whose `message` field carries
 * the same roles/parts the live pi backend translates into SubagentEvents
 * (`user`, `assistant`, `toolResult`). The mapping here mirrors the live
 * translation in `backends/pi.ts`, except that no preview bounds are applied:
 * this loader exists to recover the FULL persisted transcript.
 */

import type { TranscriptItem, TranscriptPart } from "../domain.ts";
import { isRecord, previewOf, safeJsonPreview, textOf } from "./shared.ts";

/**
 * Normalize one pi session-file record. Returns a transcript item, or null
 * for bookkeeping records and messages that carry no transcript content.
 */
export function parsePiEntry(entry: unknown): TranscriptItem | null {
  if (!isRecord(entry) || entry.type !== "message") return null;
  const message = entry.message;
  if (!isRecord(message)) return null;

  if (message.role === "user") {
    const text = textOf(message.content);
    return text.trim() ? { kind: "user", text } : null;
  }

  if (message.role === "assistant") {
    const parts = assistantParts(message.content);
    return parts.length > 0 ? { kind: "assistant", parts } : null;
  }

  if (message.role === "toolResult") {
    const toolId =
      typeof message.toolCallId === "string" ? message.toolCallId : "";
    const name =
      typeof message.toolName === "string" ? message.toolName : "Tool";
    const output = textOf(message.content);
    return {
      kind: "toolResult",
      toolId,
      name,
      isError: message.isError === true,
      outputPreview: previewOf(output),
      // Full multi-line output; the live pipeline only keeps a one-line preview.
      output,
    };
  }

  // custom / hookMessage and any future roles are display bookkeeping.
  return null;
}

function assistantParts(content: unknown): TranscriptPart[] {
  if (!Array.isArray(content)) return [];
  const parts: TranscriptPart[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "thinking") {
      parts.push({
        type: "thinking",
        text: typeof part.thinking === "string" ? part.thinking : "",
        ...(part.redacted === true ? { redacted: true } : {}),
      });
    } else if (
      part.type === "toolCall" &&
      typeof part.id === "string" &&
      typeof part.name === "string"
    ) {
      parts.push({
        type: "toolCall",
        toolId: part.id,
        name: part.name,
        argsPreview: safeJsonPreview(part.arguments),
      });
    }
  }
  return parts;
}
