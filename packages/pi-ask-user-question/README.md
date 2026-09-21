# @tylerho/pi-ask-user-question

Claude Code-shaped batch questions: 1-4 per call, each with a header, 2-4 options, optional multi-select and per-option previews.

## Install

`pi install npm:@tylerho/pi-ask-user-question`

---

# Ask user question

`ask_user_question` puts 1-4 structured questions to the user in one tabbed dialog, each with a short header, 2-4 options, optional multi-select, optional markdown previews and per-answer notes. The design and wording follow Claude Code 2.1.274's `AskUserQuestion` tool. The running implementation is upstream [`@juicesharp/rpiv-ask-user-question`](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question) 2.10.1, wrapped here so this extension owns the model-facing text and adds a transcript record, a chat escape and a quiet working spinner.

## Claude Code lineage

The batch shape comes from CC: 1-4 questions per call, headers of 12 characters or fewer, 2-4 options per question, `multiSelect`, per-option previews, per-answer notes, an appended free-form row, and Esc to abandon the questionnaire. The clarify feedback in `chat.ts` is CC's text, kept verbatim in substance. The batch shape replaced a local single-question `ask_user` tool, which is gone. The version records where the design and the copied text were last taken from, not which CC release runs today.

Four things differ from CC on purpose.

| | Claude Code 2.1.274 | Here |
|---|---|---|
| Header cap | 12 characters, enforced at the plugin API rather than in the schema | 12 in the field description and `maxLength`. Upstream still tolerates up to 16 at runtime, so an over-long header renders wide instead of failing the call. |
| Free-form row label | `Other` | `Type something.` Upstream's label is an inline literal in its locale files, not configuration, so matching CC's word would mean forking the package. |
| Chat escape | A `Chat about this` row on every single-select question | `ctrl+r` plus a hint row. Upstream's row kinds are closed at `option`, `other` and `next`, so a real row would mean reimplementing its dialog wiring. The model-facing result is CC's. |
| Result shape | `answers`, per-answer `annotations`, `metadata.source` | Upstream's own envelope (`tool/response-envelope.ts`). |

## How it works

`index.ts` exports the default `(pi: ExtensionAPI) => void`. It registers an entry renderer for `ask-user-answers` with `pi.registerEntryRenderer`, then hands a `Proxy` of `pi` to upstream's extension function. The proxy intercepts `registerTool` and re-registers the tool through four wrappers in order: `tuneRegisteredTool` from `prompt.ts`, `withChatAction` from `chat.ts`, `withQuietQuestionnaire` from `quiesce.ts` and `recordQuestionnaire` from `transcript.ts`. Every other member passes through bound to the real `pi`, so upstream's remaining registrations work unchanged. The dialog, the state machine, the RPC fallback and the renderers are upstream's code.

Upstream ships about 1,245 tokens of always-on tool definition, measured at 4,980 model-visible characters: a 1,641-character description, 1,214 characters of guidelines across four bullets, a 92-character snippet and a 2,033-character schema whose every field carries a paragraph. `prompt.ts` restates the load-bearing facts in 2,073 characters, a 58.4% cut. The description is 335 characters, the snippet 88, the guidelines 648 across three bullets, and the schema 1,002. The system-prompt share of that (snippet plus guidelines) is 736 characters, about 184 tokens by the `chars / 4` estimate. A test holds the tuned total under 2,300 characters and below half of upstream's 4,980, so the weight cannot creep back up unnoticed.

The tuner lowers `header.maxLength` from 16 to 12 and drops the field text for option `label`, option `description` and `multiSelect`, because the guidelines already state those rules. It keeps five short field descriptions (`questions`, `question`, `header`, `options`, `preview`) and clones the schema with `structuredClone` before editing it, so upstream's module-level object and its own validation stay untouched.

Upstream is a dependency, not an installed pi package. It is declared in `~/.pi/agent/package.json` as `^2.10.1` and imported directly. Installing it as a pi package would register `ask_user_question` a second time, and pi resolves a same-name collision by unsorted directory read order, so which registration won would be luck.

The dialog renders 1-4 questions as tabs with a Submit step. The free-form row is appended to every question and its label is reserved: the model must not author `Other` or `Type something.`, and upstream rejects reserved labels at runtime. A preview on any option switches a single-select question to a side-by-side layout, options on the left and markdown on the right. Multi-select questions cannot show one. The tool sets `executionMode: "sequential"`, because two overlapping dialogs fight over pi's single editor slot and orphan the first component, whose `done` then never fires.

CC's chat escape is a `Chat about this` row on every single-select question. Picking it abandons the questionnaire and hands the model a feedback message that restates each question with the answer given so far under "The user wants to clarify these questions." Upstream exposes no seam for another row kind, so here the same outcome is a key. `installChatTrigger` registers `ctx.ui.onTerminalInput` and rewrites `ctrl+r` to Escape, upstream's cancel action, which keeps the answers given. `withChatAction` routes `ctx.ui.custom` through the hint wrapper and forwards upstream's own `onHandle`, so the trigger learns its overlay handle. `withChatHint` appends one dim row naming the key, skipped while the dialog is collapsed and once the request has fired. `clarifyResult` swaps the envelope text for CC's clarify text and sets `chat: true` on the details, so the answers survive and the record can tell a chat from a dismissal. The listener returns undefined on hosts with no raw input hook (RPC, print), where the tool behaves exactly as before. It also guards on the overlay handle so an overlay stacked on top keeps its keys, and it swallows kitty-protocol repeats and releases so one tap does not fire Escape twice.

While a questionnaire is open, the working spinner would otherwise keep animating: pi-tui's `Loader` redraws a frame every 80ms for the whole turn, every frame is terminal output, and scroll-following terminals (kitty, Terminal.app, iTerm2 by default) snap the viewport to the bottom on output, so the conversation cannot be scrolled while answering. `quiesce.ts` freezes the spinner for the duration of the call: `ctx.ui.setWorkingIndicator` with a single frame makes the `Loader` clear its animation interval, so pi writes nothing while the dialog waits, the user can scroll, and the panel moves down out of view the way Claude Code's does. The next keypress re-renders the dialog and the view returns. The default animated indicator is restored in a `finally`, re-applied to the live indicator, however the questionnaire ends. The working row stays visible holding a static glyph, because hiding it with `setWorkingVisible(false)` would reflow the live region twice for no gain, and nothing else in this setup calls `setWorkingIndicator`, so the restore overwrites no configuration. Hosts without the hook (RPC, print) run the tool exactly as before.

Every finished questionnaire leaves a transcript record. Upstream registers no `renderResult`, so without this a finished questionnaire leaves only the model-facing envelope. `recordQuestionnaire` wraps `execute`: after upstream resolves, it appends an `ask-user-answers` entry holding the questions, answers, notes and any global note, then returns the result untouched. `pi.appendEntry` content is written to the session and stays out of LLM context, so the record survives a restart at no token cost. Collapsed, the row reads `◆ ask_user_question · 3 asked, 2 answered · 1 note`. ctrl+o expands to the per-question list, where a skipped question shows `→ no answer`. Previews are not recorded, because an answer can carry a few thousand characters of preview and the model-facing envelope already echoes it.

Upstream reads its config from `<XDG_CONFIG_HOME>/rpiv-ask-user-question/config.json`, defaulting to `~/.config/rpiv-ask-user-question/config.json` with a legacy fallback to the same path. Its `guidance.description`, `guidance.promptSnippet` and `guidance.promptGuidelines` are overwritten by `prompt.ts`, so that file is not the place to tune wording. `collapseKey` still applies and is set to `ctrl+j` here, replacing upstream's default `ctrl+]`. ctrl+j is not free on a legacy terminal: it sends the same `\n` byte as Ghostty's shift+enter mapping, and pi-tui matches that byte as ctrl+j in both kitty-protocol and legacy modes, so a `\n` produced by a text mapping collapses the dialog instead of adding a line.

With `ctx.hasUI` false the tool returns a rejection (`Error: UI not available (running in non-interactive mode)`) instead of blocking, so headless children and `--print` runs never hang. Upstream's reconciler strips `ask_user_question` from the tool list while no UI is available and restores it when one appears. RPC and ACP hosts that report a UI without a rendering primitive go through upstream's native-dialog walker. Children never receive the tool: `CHILD_EXCLUDED_TOOL_NAMES` in [shared/child-session.ts](shared.md) lists `ask_user_question`.

The tests pin the text, the caps, the model-visible size budget, the transcript record, the chat text and keys, and the spinner freeze and restore. No test file can import `index.ts`, because node refuses to strip types inside `node_modules`, so a change to the wiring needs a load of the extension with a fake `pi` under bun that drives the real dialog.

## API

`ask_user_question` carries the label "Ask User Question". `extensions/ask-user-question/index.ts` registers it through `tuneRegisteredTool`.

| Field | Value |
|---|---|
| `description` | `ASK_USER_QUESTION_DESCRIPTION`, 335 characters: the shape, the appended free-form row, the reserved labels |
| `promptSnippet` | `ASK_USER_QUESTION_PROMPT_SNIPPET`, 88 characters |
| `promptGuidelines` | three rules: when not to ask, how to shape a call, when a preview is worth it. Every bullet names `ask_user_question`, because the guidelines land in the system prompt's flat list |
| `executionMode` | `"sequential"` |
| `parameters` | upstream's schema with `header.maxLength` 16 to 12, five short field descriptions kept, and the `label`, `description` and `multiSelect` field text dropped |

| Module | Exports |
|---|---|
| `prompt.ts` | `ASK_USER_QUESTION_DESCRIPTION`, `ASK_USER_QUESTION_PROMPT_SNIPPET`, `ASK_USER_QUESTION_PROMPT_GUIDELINES`, `HEADER_MAX_LENGTH` (12), `SchemaNode`, `tuneRegisteredTool(tool)` |
| `transcript.ts` | `ASK_USER_ANSWERS_ENTRY` (`"ask-user-answers"`), `AnswerEntryQuestion`, `AnswerEntryData`, `QuestionnaireRecorder`, `buildAnswerEntryData(params, details)`, `recordQuestionnaire(recorder, tool)`, `renderAnswerEntry(data, expanded, theme)` |
| `chat.ts` | `CHAT_RESPOND_KEY` (`"ctrl+r"`), `CHAT_HINT_LABEL` (`"Chat about this"`), `CLARIFY_PREAMBLE`, `buildClarifyText(params, details)`, `clarifyResult(params, result)`, `chatHintLine(theme, key)`, `installChatTrigger(ctx)`, `withChatHint(component, theme, trigger, key)`, `withChatAction(tool, key)`, `ChatTrigger` |
| `quiesce.ts` | `QUIET_WORKING_FRAME` (`"◐"`), `withQuietQuestionnaire(tool)` |

`buildAnswerEntryData` is pure and returns undefined when no questions were asked, so the caller appends unconditionally. It matches answers by `questionIndex` first and by question text second. `recordQuestionnaire` is generic over the tool object, so it preserves renderers and every other field. A recorder that throws is swallowed rather than failing a call the user already answered.

The transcript entry data is `{ questions: [{ header?, question, answer?, notes? }], dismissed, chat?, globalNote? }`, with one entry per question in the order asked. `answer` is absent when the user skipped the question, and multi-select answers join with `, `. `dismissed` is true when the questionnaire was cancelled, and `chat` is true when it ended in a request to talk. The collapsed row reads `◆ ask_user_question · <n> asked, <m> answered` followed by ` · ended in chat`, ` · <k> note` or `notes`, and ` · global note`. A dismissal reads `dismissed all <n>` and a questionnaire with no answers reads `<n> asked, none answered`. Expanded, each question renders as `  1. [Header] question` then `     → answer`, `     → no answer` for a skip, and `       note: …` when a note exists.

The clarify text is `CLARIFY_PREAMBLE`, then `Questions asked:` and one block per question: `- "<question>"` followed by `  Answer: <label>` or `  (No answer provided)`, plus `  User notes: <notes>` when a note exists. A committed empty custom answer reads `(no input)`. A global note appends as `Global note: <text>`. `clarifyResult` returns upstream's result with that text as the only content block and `chat: true` added to the existing details.

The config file is `<XDG_CONFIG_HOME>/rpiv-ask-user-question/config.json`, falling back to `~/.config/rpiv-ask-user-question/config.json` when the variable is unset or relative.

| Key | Effect |
|---|---|
| `guidance.description`, `guidance.promptSnippet`, `guidance.promptGuidelines` | accepted by upstream and overwritten here, so wording is tuned in `prompt.ts` and nowhere else |
| `collapseKey` | the collapse/expand key, in pi's keybinding format. Set to `ctrl+j` here. `off` disables it, and an invalid spec falls back to `ctrl+]` |

Answer semantics, dismissal, custom answers, preview rendering and the keyboard model are upstream's. Its own package docs (`docs/keyboard.md`, `docs/hosts.md`, `docs/tool-schema.md`, `docs/configuration.md`) describe them.

## Examples

1. **A CC-shaped call.** One question, header `Database`, two options with a recommendation first:
   ```json
   {
     "questions": [
       {
         "header": "Database",
         "question": "Which database should the new service use?",
         "multiSelect": false,
         "options": [
           { "label": "Postgres (Recommended)", "description": "Concurrent writes and mature ops tooling, at the cost of a running server." },
           { "label": "SQLite", "description": "One file with no setup, limited write concurrency." }
         ]
       }
     ]
   }
   ```
2. **Preview comparison.** Add `preview` (markdown) to options when the user must compare artifacts, for example a config diff or a layout mockup. Single-select questions only. With any preview present the dialog splits into options and preview panes.
3. **Notes.** The user attaches a per-answer note with `n`. Notes arrive alongside the answers and are the place to look for the reason behind a choice.
4. **No UI.** In print mode the tool returns a rejection instead of blocking, so a headless run never hangs:
   ```
   pi --print --no-builtin-tools --tools ask_user_question \
     "Ask me which database to use, Postgres or SQLite. Call the tool."
   ```
