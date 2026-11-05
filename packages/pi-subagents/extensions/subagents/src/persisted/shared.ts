/**
 * Shared parsing helpers for persisted session files (pi JSONL sessions,
 * Claude Code project JSONL). All functions are pure: no I/O, no state.
 */

import { redactSecrets } from "../../../shared/transcript.ts";

/** Parse one JSONL line. Blank and malformed lines yield undefined (skipped). */
export function parseJsonLine(line: string): unknown | undefined {
  // A UTF-8 BOM at the start of the first line would otherwise fail JSON.parse.
  const trimmed = line.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Single-line preview of a (possibly multi-line) text: the first non-empty
 * line, trimmed — the same shape the live backends put in `outputPreview`.
 */
export function previewOf(text: string): string | undefined {
  return (
    text
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? undefined
  );
}

/**
 * Single-line JSON.stringify of tool-call arguments, redacted (skips {} and
 * unserializable values). This is the collapsed-view preview.
 */
export function safeJsonPreview(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value);
    return !text || text === "{}" ? undefined : redactSecrets(text);
  } catch {
    return undefined;
  }
}

/**
 * Full pretty-printed, redacted tool-call arguments for the expanded view.
 * The persisted loader reads these off disk, so unlike the live pipeline's
 * bounded preview nothing is truncated.
 */
export function safeJsonArgs(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value, null, 2);
    return !text || text === "{}" ? undefined : redactSecrets(text);
  } catch {
    return undefined;
  }
}

/**
 * Join the text blocks of a content array (pi `{type:"text",text}` parts,
 * Claude `{type:"text",text}` blocks) into one string. A bare string content
 * (older pi files, Claude string prompts) passes through unchanged.
 */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
