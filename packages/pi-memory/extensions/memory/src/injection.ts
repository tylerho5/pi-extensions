/**
 * Formatting recalled memories for injection, reproducing Claude Code's
 * `relevant_memories` renderer, `Ww` system-reminder wrapper, memory header
 * (`D$o`), and staleness note (`Yds`) from the bundled CLI (2.1.220, ~byte
 * 237.7M / 230.8M / 238.06M).
 *
 * The result is one message body: each memory in its own `<system-reminder>`
 * block, the first carrying the "retrieved for possible relevance" preamble.
 * Pi delivers it as a single injected user message (`before_agent_start` allows
 * one), where Claude Code emits one isMeta message per memory — the model sees
 * the same text either way.
 */

const DAY_MS = 86_400_000;

/** Preamble on the first block (`relevant_memories` renderer, `r`). */
export const RECALL_PREAMBLE =
  "Retrieved for possible relevance — use only if it actually applies to what the user asked.";

/** Appended to the preamble when citation tagging is on (flag `Ioo`). */
export const CITE_CLAUSE =
  ' When you use or cite content from one of these memories in your reply, wrap the entire sentence in <cc-memory filenames="{comma separated memory file names}">{sentence}</cc-memory> tags (never inside tool inputs).';

export interface RecalledMemory {
  readonly path: string;
  readonly mtimeMs: number;
  readonly body: string;
}

export interface InjectionOptions {
  /** Reference time for the staleness age; injected for deterministic tests. */
  readonly now: number;
  /** Emit the `<cc-memory>` citation instruction. Off unless a tag parser runs. */
  readonly cite?: boolean;
}

/** Whole days since `mtimeMs`, never negative (`lo_`). */
export function ageInDays(mtimeMs: number, now: number) {
  return Math.max(0, Math.floor((now - mtimeMs) / DAY_MS));
}

/** Claude Code's `Yds`: empty for ≤1 day, else the point-in-time caveat. */
export function stalenessNote(mtimeMs: number, now: number) {
  const days = ageInDays(mtimeMs, now);
  if (days <= 1) return "";
  return (
    `This memory is ${days} days old. ` +
    "Memories are point-in-time observations, not live state — " +
    "claims about code behavior or file:line citations may be outdated. " +
    "Verify against current code before asserting as fact."
  );
}

/** Claude Code's `D$o`: staleness note (if any) then `Memory: <path>:`. */
export function memoryHeader(path: string, mtimeMs: number, now: number) {
  const stale = stalenessNote(mtimeMs, now);
  const head = `Memory: ${path}:`;
  return stale ? `${stale}\n\n${head}` : head;
}

/** Claude Code's `Ww`. */
export function wrapSystemReminder(text: string) {
  return `<system-reminder>\n${text}\n</system-reminder>`;
}

function block(
  memory: RecalledMemory,
  first: boolean,
  options: InjectionOptions,
) {
  const preamble = options.cite
    ? RECALL_PREAMBLE + CITE_CLAUSE
    : RECALL_PREAMBLE;
  const parts = first ? [preamble] : [];
  parts.push(
    memoryHeader(memory.path, memory.mtimeMs, options.now),
    memory.body,
  );
  return wrapSystemReminder(parts.join("\n\n"));
}

/** The full injected message body, or "" when there is nothing to inject. */
export function formatRecalledMemories(
  memories: RecalledMemory[],
  options: InjectionOptions,
) {
  if (memories.length === 0) return "";
  return memories
    .map((memory, index) => block(memory, index === 0, options))
    .join("\n\n");
}
