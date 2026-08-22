import type { SubagentOrigin } from "./domain.ts";

export const BTW_TITLE_MAX_LENGTH = 60;

/**
 * Boundary markers for the parent conversation a btw child session file
 * inherits (seeded by the pi backend before createAgentSession). The inherited
 * range is fenced with two plain custom entries so transcript readers can hide
 * it — the takeover view shows the aside, not the whole parent conversation.
 * The markers never reach the LLM: custom entries do not participate in
 * session context.
 */
export const BTW_CONTEXT_START = "btw-context-start";
export const BTW_CONTEXT_END = "btw-context-end";

function isCustomEntry(entry: unknown, customType: string) {
  return (
    typeof entry === "object" &&
    entry !== null &&
    (entry as { type?: unknown }).type === "custom" &&
    (entry as { customType?: unknown }).customType === customType
  );
}

export function isBtwContextStart(entry: unknown) {
  return isCustomEntry(entry, BTW_CONTEXT_START);
}

export function isBtwContextEnd(entry: unknown) {
  return isCustomEntry(entry, BTW_CONTEXT_END);
}

/**
 * Prefix injected into every btw prompt. btw children run without tools and
 * inherit the parent conversation, so the model must answer from that context
 * alone. Mirrors Claude Code's side-question system reminder.
 */
export const BTW_PROMPT_PREFIX =
  "This is a side question from the user. You must answer this question directly in a single response.\n" +
  "\n" +
  "IMPORTANT CONTEXT:\n" +
  "- You are a separate, lightweight agent spawned to answer this one question\n" +
  "- The main agent is NOT interrupted - it continues working independently in the background\n" +
  "- You share the conversation context but are a completely separate instance\n" +
  '- Do NOT reference being interrupted or what you were "previously doing" - that framing is incorrect\n' +
  "\n" +
  "CRITICAL CONSTRAINTS:\n" +
  "- You have NO tools available - you cannot read files, run commands, search, or take any actions\n" +
  "- This is a one-off response - there will be no follow-up turns\n" +
  "- You can ONLY provide information based on what you already know from the conversation context\n" +
  '- NEVER say things like "Let me try...", "I\'ll now...", "Let me check...", or promise to take any action\n' +
  "- If you don't know the answer, say so - do not offer to look it up or investigate\n" +
  "\n" +
  "Simply answer the question with the information you have.";

/** Build a compact dashboard title from the first non-empty prompt line. */
export function deriveBtwTitle(prompt: string) {
  const firstLine = prompt
    .split("\n")
    .find((line) => line.trim())
    ?.trim();
  const title = firstLine?.replace(/\s+/g, " ") ?? "";
  if (!title) return "by the way";
  const codePoints = Array.from(title);
  if (codePoints.length <= BTW_TITLE_MAX_LENGTH) return title;
  return `${codePoints.slice(0, BTW_TITLE_MAX_LENGTH - 1).join("")}…`;
}

/** User asides are hidden from model tools and the /subagents dashboard; the user revisits them via /btw. */
export function isModelVisible(snap: { readonly origin: SubagentOrigin }) {
  return snap.origin === "model";
}
