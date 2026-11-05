/**
 * Checkpoint records: what a checkpoint is once it is written to the session file, and
 * how it is read back.
 *
 * A record is a custom session entry, so it travels with the conversation through
 * resume, fork, and reload. Rebuilding the list from `getBranch()` rather than
 * `getEntries()` keeps checkpoints from abandoned branches out of the rewind list.
 *
 * Adapted from `extensions/git-checkpoint.ts` in `ilovepixelart/pi-code` at commit
 * `ff3eb5e` (2026-10-05), MIT licensed, copyright 2025 Mario Zechner and 2026
 * ilovepixelart.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const CUSTOM_TYPE = "checkpoints";

/** The most recent checkpoints a session keeps. Older ones drop off the rewind list;
 * their commits stay in the shadow repository until the retention sweep. */
export const MAX_CHECKPOINTS_PER_SESSION = 100;

const PROMPT_SNIPPET_LENGTH = 60;

export interface Checkpoint {
  /** The session entry id of the user message that started the run. */
  entryId: string;
  /** A ref under the shadow repository's checkpoint namespace, not a raw sha, so a
   * baseline captured later in the same run can move it. */
  ref: string;
  /** A one-line snippet for the menu label. */
  prompt: string;
  createdAt: string;
  /** The shadow directory the ref lives in, which makes the record self-describing: a
   * record whose shadow is not the bound one is refused rather than attempted. */
  shadow: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** A stored record as this extension reads it, or null for anything else. `prompt` may
 * be empty (the user sent an empty message) but must be a string. */
export function parseCheckpoint(raw: unknown): Checkpoint | null {
  if (!isRecord(raw)) return null;
  const { entryId, ref, prompt, createdAt, shadow } = raw;
  if (
    !nonEmptyString(entryId) ||
    !nonEmptyString(ref) ||
    typeof prompt !== "string" ||
    !nonEmptyString(createdAt) ||
    !nonEmptyString(shadow)
  ) {
    return null;
  }
  return { entryId, ref, prompt, createdAt, shadow };
}

/** The newest records, up to the per-session cap, oldest first. */
export function capCheckpoints<T>(all: T[]): T[] {
  return all.length <= MAX_CHECKPOINTS_PER_SESSION
    ? all
    : all.slice(all.length - MAX_CHECKPOINTS_PER_SESSION);
}

/** Every checkpoint the branch holds, in branch order, ignoring other extensions'
 * custom entries and records too malformed to use. */
export function recordsFromBranch(
  entries: readonly SessionEntry[],
): Checkpoint[] {
  const records: Checkpoint[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
    const record = parseCheckpoint(entry.data);
    if (record !== null) records.push(record);
  }
  return records;
}

/** The text of a message or tool-result content, dropping thinking and tool parts. A
 * plain-string content is already the text. The separator is the caller's: a prompt
 * snippet joins with spaces, a restored prompt keeps the parts' own boundaries. */
export function messageText(content: unknown, separator = ""): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join(separator);
}

/** One line of a prompt, whitespace collapsed, cut at sixty characters. */
export function promptSnippet(content: unknown): string {
  const text = messageText(content, " ").replace(/\s+/g, " ").trim();
  if (text.length <= PROMPT_SNIPPET_LENGTH) return text;
  return `${text.slice(0, PROMPT_SNIPPET_LENGTH)}…`;
}

/** The last user message on the branch and its snippet. The user message that started a
 * run is the key a checkpoint is recorded under, because it is not persisted yet when
 * the pre-run snapshot is taken. */
export function findLastUserMessage(
  entries: readonly SessionEntry[],
): { entryId: string; prompt: string } | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "message" || entry.message.role !== "user") continue;
    return { entryId: entry.id, prompt: promptSnippet(entry.message.content) };
  }
  return undefined;
}

/** A rewind menu line. `restorable` is false for a record whose shadow is not the one
 * this session is bound to: it is listed so the user can see it, and refused if picked. */
export function checkpointLabel(
  checkpoint: Checkpoint,
  index: number,
  restorable: boolean,
): string {
  const time = new Date(checkpoint.createdAt).toLocaleTimeString();
  const marker = restorable ? "" : " [not restorable]";
  return `${index + 1}. ${time}  ${checkpoint.prompt || "(empty prompt)"}${marker}`;
}
