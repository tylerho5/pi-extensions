/**
 * Claude Code project-file parser: normalizes one JSONL record into
 * transcript items.
 *
 * Project files (`~/.claude/projects/<escaped-cwd>/<sessionId>.jsonl`, and
 * subagent files under `<sessionId>/subagents/.../agent-*.jsonl`) append one
 * JSON object per line. Conversation content lives in `user` and `assistant`
 * records; everything else (`system` init, `result`, `attachment`,
 * `last-prompt`, `mode`, ...) is session bookkeeping with no transcript
 * content.
 *
 * Unlike pi, Claude Code has no dedicated tool-result record: tool results
 * arrive as `tool_result` blocks inside the *following* user message, keyed
 * only by `tool_use_id`. The parser therefore keeps the id→name map from
 * assistant `tool_use` blocks across records (stateful, but still pure: no
 * I/O), so results normalize to `toolResult` items with real tool names.
 */

import type { TranscriptItem, TranscriptPart } from "../domain.ts";
import { isRecord, previewOf, safeJsonPreview, textOf } from "./shared.ts";

export interface ClaudeParser {
  /** Parse one project-file record into transcript items (usually 0 or 1). */
  parse(entry: unknown): ReadonlyArray<TranscriptItem>;
}

export function createClaudeParser(): ClaudeParser {
  const toolNames = new Map<string, string>();
  return { parse: (entry) => parseEntry(entry, toolNames) };
}

function parseEntry(
  entry: unknown,
  toolNames: Map<string, string>,
): TranscriptItem[] {
  if (!isRecord(entry)) return [];
  if (entry.type === "assistant") return parseAssistant(entry, toolNames);
  if (entry.type === "user") return parseUser(entry, toolNames);
  // system/result/attachment and other bookkeeping records carry no content.
  return [];
}

function parseAssistant(
  entry: Record<string, unknown>,
  toolNames: Map<string, string>,
): TranscriptItem[] {
  const message = entry.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  const parts: TranscriptPart[] = [];
  for (const block of message.content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push({ type: "text", text: block.text });
    } else if (
      block.type === "thinking" &&
      typeof block.thinking === "string"
    ) {
      parts.push({ type: "thinking", text: block.thinking });
    } else if (block.type === "redacted_thinking") {
      // The reasoning payload is encrypted; only the opaque blob remains.
      parts.push({ type: "thinking", text: "", redacted: true });
    } else if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      toolNames.set(block.id, block.name);
      parts.push({
        type: "toolCall",
        toolId: block.id,
        name: block.name,
        argsPreview: safeJsonPreview(block.input),
      });
    }
  }
  return parts.length > 0 ? [{ kind: "assistant", parts }] : [];
}

function parseUser(
  entry: Record<string, unknown>,
  toolNames: Map<string, string>,
): TranscriptItem[] {
  const message = entry.message;
  if (!isRecord(message)) return [];
  const content = message.content;
  if (typeof content === "string") {
    return content.trim() ? [{ kind: "user", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const items: TranscriptItem[] = [];
  const textParts: string[] = [];
  const flushText = () => {
    if (textParts.length === 0) return;
    const text = textParts.join("\n");
    textParts.length = 0;
    if (text.trim()) items.push({ kind: "user", text });
  };

  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      // Keep part order: a steer can interleave text and tool results.
      textParts.push(block.text);
    } else if (block.type === "tool_result") {
      flushText();
      const toolId =
        typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      const output = toolResultText(block.content);
      items.push({
        kind: "toolResult",
        toolId,
        name: toolNames.get(toolId) ?? "Tool",
        isError: block.is_error === true,
        outputPreview: previewOf(output),
        // Full multi-line output; the live pipeline only keeps a one-line preview.
        output,
      });
    }
    // image / document blocks: no text content to represent.
  }
  flushText();
  return items;
}

/** tool_result content: a plain string, or an array of text/image blocks. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return textOf(content);
  return "";
}
