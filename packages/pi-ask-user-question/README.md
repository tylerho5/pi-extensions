# @tylerho/pi-ask-user-question

Claude Code-shaped batch questions: 1-4 per call, each with a header, 2-4 options, optional multi-select and per-option previews.

## Install

`pi install npm:@tylerho/pi-ask-user-question`

---

# Ask User Question

A batch question tool for the model: `ask_user_question` puts 1–4 structured questions to the user in one tabbed dialog, each with a short header and 2–4 options, optional multi-select, optional per-option markdown previews, and per-answer notes. The dialog closes with either the answers, a custom answer, or an explicit dismissal.

The implementation is upstream [`@juicesharp/rpiv-ask-user-question`](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question) 2.10.1. This extension exists to own the model-facing text: upstream ships roughly 1,245 tokens of always-on tool definition (a 1,641-character description, four guidelines totalling 1,214 characters, and a schema whose every field carries a paragraph), and `prompt.ts` here restates the load-bearing facts in about 513 tokens. Everything else — the dialog, the state machine, the RPC fallback, the renderers — is upstream's code.

## Key concepts

- **Batch, not one-at-a-time.** One call takes 1–4 questions. The dialog renders them as tabs with a Submit step, so the user answers a related set of decisions in one pass. This is Claude Code's `AskUserQuestion` shape, and the reason this replaced the local single-question `ask_user`.
- **Upstream registers the tool; this extension retunes it.** `index.ts` wraps `pi` in a `Proxy` and intercepts `registerTool`, replacing description, snippet and guidelines from `prompt.ts`, tightening the header cap to 12 characters, and stripping paragraph-length field descriptions from the schema. `execute`, the renderers and the reconciler stay upstream's.
- **Upstream is a dependency, not an installed package.** Installing `@juicesharp/rpiv-ask-user-question` as a pi package would register `ask_user_question` a second time; pi resolves same-name collisions by unsorted directory read order, so which registration won would be luck. It is declared in `~/.pi/agent/package.json` and imported directly.
- **The free-form row is always appended** and its label is reserved. The model must never author `Other` or `Type something.`; upstream rejects reserved labels at runtime.
- **Previews are single-select only.** A preview with any option present switches the dialog to a side-by-side layout (options left, markdown right). Multi-select questions cannot show one.
- **Dialogs are serialized.** The tool sets `executionMode: "sequential"`, because two overlapping dialogs fight over pi's single editor slot and orphan the first component, whose `done` never fires. Upstream does not set this itself.
- **Every finished questionnaire leaves a transcript record.** `recordQuestionnaire` in `transcript.ts` wraps the tool's `execute`: once upstream resolves, it appends an `ask-user-answers` entry holding the questions, answers, notes and any global note, then returns upstream's result untouched. Collapsed, the row reads `◆ ask_user_question · 3 asked, 2 answered · 1 note`; ctrl+o expands to the per-question list, where a skipped question shows as `→ no answer`. Entry data stays out of LLM context and is written to the session, so the record survives a restart. Previews are deliberately not recorded — an answer can carry thousands of characters of preview, and the model-facing envelope already echoes it.
- **Config file.** Upstream reads `~/.config/rpiv-ask-user-question/config.json` (XDG-aware). Its `guidance.description` / `promptSnippet` / `promptGuidelines` are overwritten by this extension, so wording is tuned in `prompt.ts` and nowhere else. `collapseKey` (default `ctrl+]`) still applies from that file.

### Deliberate divergences from Claude Code

| | Claude Code 2.1.274 | Here |
|---|---|---|
| Header cap | 12 characters; stated in the description, enforced at the plugin API, not in the schema | 12 in the field description and `maxLength`; upstream still tolerates up to 16 at runtime, so an over-long header renders wide rather than failing the call |
| Free-form row label | `Other` | `Type something.` — upstream's label is an inline literal in its locale files, not configuration; matching CC's word would mean forking the package |
| Result shape | `answers`, per-answer `annotations`, `metadata.source` | upstream's own envelope (`tool/response-envelope.ts`) |

## API

`ask_user_question` — label "Ask User Question", registered by `extensions/ask-user-question/index.ts` through `tuneRegisteredTool` (`prompt.ts`).

| Field | Value |
|---|---|
| `description` | `ASK_USER_QUESTION_DESCRIPTION` — 335 chars: the shape, the appended row, the reserved labels |
| `promptSnippet` | `ASK_USER_QUESTION_PROMPT_SNIPPET` — one line, 88 chars |
| `promptGuidelines` | three rules: when not to ask, how to shape a call, when a preview is worth it |
| `executionMode` | `"sequential"` |
| `parameters` | upstream's schema, with `header.maxLength` 16 → 12, five short field descriptions kept (`questions`, `question`, `header`, `options`, `preview`), and the label/description/multiSelect field text dropped because the guidelines already state those rules |

Measured against upstream 2.10.1's own strings: 4,980 characters (~1,245 tokens by `chars / 4`) before, 2,053 characters (~513 tokens) after, a 58.8% cut. Of that, the system-prompt share (snippet plus guidelines) is 716 characters, about 179 tokens.

`prompt.ts` exports the text constants, `HEADER_MAX_LENGTH`, the `SchemaNode` type, and `tuneRegisteredTool(tool)`. The function clones the schema before editing it, so upstream's module-level schema object is never mutated.

### Transcript entry

`transcript.ts` owns the record and needs no upstream types: it reads the shapes structurally, so both modules are testable without the package installed.

| Piece | Value |
|---|---|
| Entry type | `ask-user-answers` (`ASK_USER_ANSWERS_ENTRY`) |
| Data | `{ questions: [{ header?, question, answer?, notes? }], dismissed, globalNote? }` — one entry per question asked, in order, with `answer` absent when the user skipped it and multi-select answers joined with `, ` |
| Collapsed | `◆ ask_user_question · <n> asked, <m> answered`, plus `· <k> notes` / `· global note`; `dismissed all <n>` when the questionnaire was dismissed |
| Expanded | `1. [Header] question` then `→ answer`, `note: …` per answer, `→ no answer` for skips |
| `buildAnswerEntryData(params, details)` | Pure. Returns `undefined` when no questions were asked, so the caller appends unconditionally. Matches answers by `questionIndex`, falling back to question text. |
| `recordQuestionnaire(recorder, tool)` | Generic over the tool object, so it preserves renderers and other fields; a recorder that throws is swallowed rather than failing an answered call |

Answer semantics, dismissal, custom answers, preview rendering and keyboard model are upstream's: see the package's own `docs/keyboard.md`, `docs/hosts.md`, `docs/tool-schema.md` and `docs/configuration.md`.

## Examples

1. **A CC-shaped call.** One question, header `Database`, two options with a recommendation first — the payload the model produced in the smoke test:
   ```json
   {
     "questions": [
       {
         "header": "Database",
         "question": "Which database should the new service use?",
         "multiSelect": false,
         "options": [
           { "label": "Postgres (Recommended)", "description": "Concurrent writes, mature ops tooling; needs a running server." },
           { "label": "SQLite", "description": "One file, zero setup; limited write concurrency." }
         ]
       }
     ]
   }
   ```
2. **Preview comparison.** Add `preview` (markdown) to options when the user must compare artifacts — a config diff, a layout mockup. Single-select only; with any preview present the dialog splits into options and preview panes.
3. **Notes.** The user attaches a per-answer note with `n`; notes arrive alongside the answers and are the place to look for the *why* behind a choice.
4. **No UI.** In print mode (`ctx.hasUI` false) the tool returns a rejection instead of blocking, so headless children and `--print` runs never hang. Children are also denied the tool by name: `CHILD_EXCLUDED_TOOL_NAMES` in `extensions/shared/child-session.ts` lists `ask_user_question`.
