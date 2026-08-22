/**
 * The dream prompt — background memory consolidation. The text is the Claude
 * Code 2.1.220 "Dream: Memory Consolidation" prompt, adapted to pi. Each
 * divergence is marked PI:, matching the convention in `src/prompt.ts`.
 *
 * PI (1): Claude Code tells the model to `grep -rn` the raw JSONL transcripts.
 *   Here the transcripts arrive pre-serialized and secret-redacted, so Phase 2
 *   reads the excerpt embedded below and the grep command line is removed.
 * PI (2): pi has no `logs/YYYY/MM/DD/` activity stream, so the Phase 1 `ls -R
 *   logs/` bullet is dropped and Phase 2's first source is the session excerpts.
 * PI (3): the reconciliation subsection reads AGENTS.md, the context file pi
 *   loads first, in place of CLAUDE.md.
 * PI (4): the team-memory block is not ported (absent throughout).
 * PI (5): tool names are lowercase (write, edit, read, bash) to match pi's registry.
 * PI (6): an empty session list still runs as a tidy-only pass.
 * PI (7): Claude Code's Phase 4 states two different numbers — "under ~150
 *   characters" as the target, "over ~200 chars" as the actual demote trigger —
 *   leaving a live gap a model can leave a line in. The trigger is tightened to
 *   ~150 so it matches the stated target.
 */

import { INDEX_MAX_CHARS, INDEX_MAX_LINES } from "../prompt.ts";
import { READ_ONLY_COMMANDS } from "./tools.ts";
import type { SessionRef } from "./sessions.ts";

/**
 * The per-run constraint block. Single source of truth for what the dream may
 * do; `dream-tools.ts` enforces exactly this and the tests assert the two agree.
 * If the prompt claimed a permission the handler denies, the model would burn
 * turns discovering that.
 */
export const DREAM_TOOL_CONSTRAINTS = `## Tools available for this dream

You have a deliberately restricted toolset for this pass:

- \`read\` — read any file you need.
- \`write\` and \`edit\` — only for files inside the memory directory.
- \`bash\` — read-only commands only (${READ_ONLY_COMMANDS.join(", ")}), plus \`rm -f <file>.md\` to delete a memory file inside the memory directory. No redirects (\`>\`), pipes into writing commands, command chaining (\`;\`, \`&&\`, \`||\`), or command substitution. bash runs with its working directory set to the memory directory.

Everything else is denied — do not attempt subagents, network access, or any write outside the memory directory.`;

const INTRO = `# Dream: Memory Consolidation

You are performing a dream — a reflective pass over your memory files. Synthesize what you've learned recently into durable, well-organized memories so that future sessions can orient quickly.`;

// PI (2): the Phase 1 `ls -R logs/` bullet is gone — pi has no activity-log stream.
const PHASE_1 = `## Phase 1 — Orient

- \`ls\` the memory directory to see what already exists
- read \`MEMORY.md\` to understand the current index
- skim existing topic files so you improve them rather than creating duplicates`;

// PI (1)+(2): source 1 is the serialized session excerpts below; the raw-JSONL
// grep instruction is removed and source 3 points at the embedded excerpt.
const PHASE_2 = `## Phase 2 — Gather recent signal

Look for new information worth persisting. Sources in rough priority order:

1. **Session excerpts** (embedded below, newest first) — the serialized, secret-redacted transcripts of the sessions touched since the last consolidation. Main sessions carry the user's corrections and decisions; subagent runs are labeled as such.
2. **Existing memories that drifted** — facts that contradict something you see now
3. **The transcript excerpt below** — when you need specific context (e.g., "what was the error message from yesterday's build failure?"), read the relevant part of the embedded excerpt rather than guessing

Don't exhaustively re-read the excerpts. Look only for things you already suspect matter.`;

const PHASE_3 = `## Phase 3 — Consolidate

For each thing worth remembering, write or update a memory file at the top level of the memory directory. Use the memory file format and type conventions from your system prompt's auto-memory section — it's the source of truth for what to save, how to structure it, and what NOT to save.

Focus on:
- Merging new signal into existing topic files rather than creating near-duplicates
- Converting relative dates ("yesterday", "last week") to absolute dates so they remain interpretable after time passes
- Deleting contradicted facts — if today's investigation disproves an old memory, fix it at the source`;

// The 200-line / ~25KB / ~150-char numbers are kept verbatim from Claude Code.
// PI (7): the demote trigger below is tightened from Claude Code's "~200 chars"
// to ~150, matching the target stated in the line above instead of leaving a
// 150–200 char gap a model has no instruction to close.
const PHASE_4 = `## Phase 4 — Prune and index

Update \`MEMORY.md\` so it stays under ${INDEX_MAX_LINES} lines AND under ~${Math.round(INDEX_MAX_CHARS / 1000)}KB. It's an **index**, not a dump — each entry should be one line under ~150 characters: \`- [Title](file.md) — one-line hook\`. Never write memory content directly into it.

- Remove pointers to memories that are now stale, wrong, or superseded
- Demote verbose entries: if an index line is over ~150 chars, it's carrying content that belongs in the topic file — shorten the line, move the detail
- Add pointers to newly important memories
- Resolve contradictions — if two files disagree, fix the wrong one`;

// PI (3): CLAUDE.md → AGENTS.md throughout this subsection.
const RECONCILE = `### Reconcile memories against AGENTS.md

Project AGENTS.md instructions are loaded in your system prompt. For each memory that captures feedback or project conventions (the \`feedback\`/\`project\` types, where tagged), check whether it contradicts an AGENTS.md instruction on the same topic:

- **Memory is stale** — AGENTS.md and the memory describe different procedures for the same task: AGENTS.md is the maintained, checked-in source. Delete the memory, or rewrite it to agree if it carries context worth keeping (the *why* is still useful but the *how* is wrong).
- **AGENTS.md may be stale** — the memory is clearly dated after AGENTS.md and explicitly corrects it: do NOT edit AGENTS.md during a dream. Annotate the memory with "contradicts AGENTS.md — verify which is current" and list it in your summary so the user can update AGENTS.md.
- **Not a conflict** — the memory adds detail AGENTS.md doesn't cover, or narrows an AGENTS.md rule with a stated reason. Leave it.

A \`feedback\` memory's "Why: the user corrected me" framing is not evidence it's newer than AGENTS.md — AGENTS.md may have been updated since.`;

const CLOSING = `Return a brief summary of what you consolidated, updated, or pruned. If nothing changed (memories are already tight), say so.`;

function renderSessionList(sessions: readonly SessionRef[]): string {
  // PI (6): an empty list still runs — the dream tidies existing memories.
  if (sessions.length === 0) {
    return "## Sessions since the last consolidation\n\nNo new session activity — review and tidy existing memories.";
  }
  const lines = sessions.map((session) => {
    const kind = session.kind === "subagent" ? "subagent run" : "main session";
    const started = session.startedAt ? ` started ${session.startedAt}` : "";
    return `- ${session.id} — ${kind}${started}`;
  });
  return `## Sessions since the last consolidation\n\n${lines.join("\n")}`;
}

export function buildDreamPrompt(opts: {
  memoryDir: string;
  sessions: readonly SessionRef[];
  transcriptText: string;
  additionalContext?: string;
}): string {
  const sections = [
    INTRO,
    // PI (5): "the Write tool" is lowercase to match pi's registry.
    `Memory directory: \`${opts.memoryDir}\`\nThis directory already exists — write to it directly with the write tool (do not run mkdir or check for its existence).`,
    DREAM_TOOL_CONSTRAINTS,
    "---",
    PHASE_1,
    PHASE_2,
    PHASE_3,
    PHASE_4,
    RECONCILE,
    "---",
    renderSessionList(opts.sessions),
    `## Transcript excerpts\n\n${opts.transcriptText || "(no session activity to show)"}`,
  ];

  if (opts.additionalContext?.trim()) {
    sections.push(`## Additional context\n\n${opts.additionalContext.trim()}`);
  }

  sections.push("---", CLOSING);
  return sections.join("\n\n");
}
