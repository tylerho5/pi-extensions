/**
 * The relevance selector: Claude Code's `selectRelevantMemories` (`P2y`) and its
 * system prompt (`I2y`), from the bundled CLI (2.1.220, ~byte 237.7M). A cheap
 * model is shown only the memory descriptions and the user's query, and returns
 * the filenames worth surfacing (bodies are read afterwards). No embeddings.
 *
 * Two PI adaptations, marked below:
 *  - "Claude Code" → "the assistant" (this runs in pi).
 *  - Claude Code constrains the reply with a provider-side JSON schema. Pi runs
 *    many providers that lack that, so the format is requested in the prompt and
 *    parsed defensively instead.
 */

import { packageCandidates, type MemoryCandidate } from "./candidates.ts";

/** Claude Code's file cap per selector call (`slice(0, 5)` in `Z2y`). */
export const MAX_SELECTED = 5;

/** Verbatim `I2y`, with "Claude Code" → "the assistant" (PI). */
export const SELECTOR_SYSTEM_PROMPT = `You are selecting memories that will be useful to the assistant as it processes a user's query. The first message lists the available memory files with their filenames and descriptions; subsequent messages each contain one user query.

Return a list of filenames for the memories that will clearly be useful to the assistant as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- Be especially conservative with user-profile and project-overview memories ([user], [project]). These describe the user's ongoing focus, not what every question is about. A profile saying "works on DB performance" is NOT relevant to a question that merely contains the word "performance" unless the question is actually about that DB work. Match on what the question IS ABOUT, not on surface keyword overlap with who the user is.
- Do not re-select memories you already returned for an earlier query in this conversation.

Respond with only a JSON object of the form {"selected_memories": ["exact-filename.md", ...]}, using filenames exactly as listed. Return {"selected_memories": []} when nothing clearly applies.`;

/**
 * The user turn. Claude Code sends the listing and the query as two separate
 * messages; pi folds them into one so providers that reject consecutive user
 * messages behave (PI). The query wording matches Claude Code's `P2y`.
 */
export function buildSelectorPrompt(
  candidates: MemoryCandidate[],
  query: string,
) {
  return `${packageCandidates(candidates)}\n\nSelect memories relevant to:\n${query}`;
}

function collectJsonCandidates(text: string) {
  const trimmed = text.trim();
  const out = [trimmed];
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]) out.push(match[1].trim());
  }
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const first = trimmed.indexOf(open);
    const last = trimmed.lastIndexOf(close);
    if (first !== -1 && last > first) out.push(trimmed.slice(first, last + 1));
  }
  return out;
}

function asFilenameArray(value: unknown): string[] | undefined {
  const arr = Array.isArray(value)
    ? value
    : typeof value === "object" &&
        value !== null &&
        Array.isArray((value as Record<string, unknown>).selected_memories)
      ? (value as Record<string, string[]>).selected_memories
      : undefined;
  if (!arr) return undefined;
  return arr.filter((item): item is string => typeof item === "string");
}

/**
 * Pull the selected filenames out of the model reply and keep only ones that
 * actually exist, capped at five. JSON is tried first; if the model wrapped or
 * prosed around it, any listed filename quoted in the text is a safe fallback.
 */
export function parseSelectedFilenames(text: string, known: Set<string>) {
  const seen = new Set<string>();
  const push = (name: string) => {
    if (known.has(name)) seen.add(name);
  };

  for (const candidate of collectJsonCandidates(text)) {
    try {
      const parsed = asFilenameArray(JSON.parse(candidate));
      if (parsed) {
        parsed.forEach(push);
        if (seen.size > 0) break;
      }
    } catch {
      // Try the next candidate slice.
    }
  }

  if (seen.size === 0) {
    for (const name of known) {
      if (text.includes(`"${name}"`) || text.includes(`'${name}'`)) push(name);
    }
  }

  return [...seen].slice(0, MAX_SELECTED);
}

/** A one-shot text completion, injected so the orchestration stays testable. */
export type SelectorComplete = (
  system: string,
  user: string,
  signal?: AbortSignal,
) => Promise<string>;

/** List → prompt → parse. Returns the selected candidates, at most five. */
export async function selectMemories(
  candidates: MemoryCandidate[],
  query: string,
  complete: SelectorComplete,
  signal?: AbortSignal,
): Promise<MemoryCandidate[]> {
  if (candidates.length === 0) return [];
  const byFilename = new Map(candidates.map((c) => [c.filename, c]));
  const reply = await complete(
    SELECTOR_SYSTEM_PROMPT,
    buildSelectorPrompt(candidates, query),
    signal,
  );
  const picks = parseSelectedFilenames(reply, new Set(byFilename.keys()));
  return picks
    .map((name) => byFilename.get(name))
    .filter((c): c is MemoryCandidate => c !== undefined);
}
