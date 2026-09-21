/**
 * Pure text logic for stacked skill invocation: find `/name` and `/skill:name`
 * tokens in a prompt and replace them with skill blocks.
 *
 * Kept free of pi imports so it can be unit-tested without a session.
 */

export const MAX_STACKED_SKILLS = 6;

/** Max skill-name length matched after a slash. */
const TOKEN_RE = /^\/(?:skill:)?([A-Za-z0-9][A-Za-z0-9_-]*)/;
const ESCAPED_TOKEN_RE = /\\\/(?:skill:)?[A-Za-z0-9][A-Za-z0-9_-]*/g;

/** Characters that may precede a skill token. */
const OPENING = new Set([" ", "\t", "\n", "(", "[", "{", '"', "'"]);
/** Characters that may follow a skill token. */
const CLOSING = new Set([
  " ",
  "\t",
  "\n",
  ")",
  "]",
  "}",
  '"',
  "'",
  ",",
  ".",
  ";",
  ":",
  "!",
  "?",
]);

export interface SkillToken {
  /** Index of the leading slash. */
  start: number;
  /** Exclusive end index of the token. */
  end: number;
  name: string;
  /** Written as `/skill:name` rather than `/name`. */
  explicit: boolean;
}

/** Decides whether a token is an invocable skill. Gets called during scanning. */
export type TokenResolver = (name: string, explicit: boolean) => boolean;

/**
 * Offsets of fenced code blocks and inline code spans, where skill tokens are
 * left alone because the author is writing about them, not invoking them.
 */
export function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let offset = 0;
  let fence: string | null = null;

  for (const line of text.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;

    const opening = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      ranges.push([lineStart, lineStart + line.length]);
      if (
        opening &&
        opening[1]![0] === fence[0] &&
        opening[1]!.length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    if (opening) {
      fence = opening[1]!;
      ranges.push([lineStart, lineStart + line.length]);
      continue;
    }
    for (const [start, end] of inlineCodeSpans(line)) {
      ranges.push([lineStart + start, lineStart + end]);
    }
  }

  return ranges;
}

function inlineCodeSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let index = 0;

  while (index < line.length) {
    if (line[index] !== "`") {
      index++;
      continue;
    }
    const openEnd = runEnd(line, index);
    const close = matchingRun(line, openEnd, openEnd - index);
    if (close === -1) break;
    spans.push([index, close + (openEnd - index)]);
    index = close + (openEnd - index);
  }

  return spans;
}

function runEnd(text: string, start: number): number {
  let end = start;
  while (end < text.length && text[end] === "`") end++;
  return end;
}

/** Index of the next backtick run of `length`, or -1. */
function matchingRun(text: string, from: number, length: number): number {
  let index = from;
  while (index < text.length) {
    if (text[index] !== "`") {
      index++;
      continue;
    }
    const end = runEnd(text, index);
    if (end - index === length) return index;
    index = end;
  }
  return -1;
}

/**
 * Skill tokens in prompt order. Tokens inside code are skipped, as are tokens
 * whose name `resolve` rejects.
 */
export function findSkillTokens(
  text: string,
  resolve: TokenResolver,
): SkillToken[] {
  const code = codeRanges(text);
  const inCode = (index: number) => {
    for (const [start, end] of code) {
      if (index >= start && index < end) return true;
    }
    return false;
  };

  const tokens: SkillToken[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "/") continue;
    if (index > 0 && !OPENING.has(text[index - 1]!)) continue;
    if (inCode(index)) continue;

    const match = TOKEN_RE.exec(text.slice(index));
    if (!match) continue;

    const end = index + match[0].length;
    if (end < text.length && !CLOSING.has(text[end]!)) continue;

    const explicit = text.startsWith("/skill:", index);
    if (!resolve(match[1]!, explicit)) continue;

    tokens.push({ start: index, end, name: match[1]!, explicit });
    index = end - 1;
  }

  return tokens;
}

export interface ExpandOptions {
  resolve: TokenResolver;
  /** Returns the skill block, or undefined to leave the token in place. */
  render: (name: string) => string | undefined;
  max?: number;
}

export interface ExpandResult {
  text: string;
  /** Names injected, in prompt order. */
  expanded: string[];
  /** Names dropped because they repeated an earlier token. */
  duplicates: string[];
  /** Names left literal because the cap was reached. */
  overflow: string[];
}

/**
 * Replaces every invocable token with its skill block, preserving the author's
 * remaining text in position. Blocks are separated from surrounding text by a
 * blank line, which is the layout core's skill-block parser expects.
 */
export function expandSkillTokens(
  text: string,
  options: ExpandOptions,
): ExpandResult {
  const max = options.max ?? MAX_STACKED_SKILLS;
  const tokens = findSkillTokens(text, options.resolve);

  const expanded: string[] = [];
  const duplicates: string[] = [];
  const overflow: string[] = [];
  const blocks = new Map<number, string>();
  const removed = new Set<number>();
  const seen = new Set<string>();

  for (const token of tokens) {
    if (seen.has(token.name)) {
      duplicates.push(token.name);
      removed.add(token.start);
      continue;
    }
    if (expanded.length >= max) {
      overflow.push(token.name);
      continue;
    }

    const block = options.render(token.name);
    if (block === undefined) continue;

    seen.add(token.name);
    blocks.set(token.start, block);
    expanded.push(token.name);
  }

  if (expanded.length === 0 && duplicates.length === 0) {
    return { text, expanded, duplicates, overflow };
  }

  const chunks: string[] = [];
  const push = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) chunks.push(trimmed);
  };

  let cursor = 0;
  for (const token of tokens) {
    const block = blocks.get(token.start);
    if (block === undefined && !removed.has(token.start)) continue;

    push(text.slice(cursor, token.start));
    if (block !== undefined) chunks.push(block);
    cursor = token.end;
  }
  push(text.slice(cursor));

  return {
    text: chunks.join("\n\n"),
    expanded,
    duplicates,
    overflow,
  };
}

/**
 * Removes the backslash from `\/name`, the escape for a literal slash token.
 *
 * Only escapes of names that `wouldExpand` accepts are unescaped, so a regex or
 * path fragment such as `\/b\/c` keeps its backslashes.
 */
export function unescapeSkillTokens(
  text: string,
  wouldExpand: TokenResolver,
): string {
  return text.replace(ESCAPED_TOKEN_RE, (match) => {
    const explicit = match.slice(1).startsWith("/skill:");
    const name = match.slice(explicit ? 8 : 2);
    return wouldExpand(name, explicit) ? match.slice(1) : match;
  });
}

const SKILL_BLOCK_RE =
  /<skill name="([^"]+)" location="([^"]*)">\n[\s\S]*?\n<\/skill>/g;

/**
 * Collapses skill blocks left in a rendered user message into a one-line
 * marker. Core renders the first block of a message as its own component, so
 * this only ever sees the stacked remainder.
 */
export function tidySkillBlocks(
  markdown: string,
  context: { messageType: string },
): string {
  if (context.messageType !== "user") return markdown;

  return markdown.replace(SKILL_BLOCK_RE, (block, name: string) => {
    const lines = block.split("\n").length;
    return `[skill: ${name} — ${lines} lines injected]`;
  });
}
