# @tylerho/pi-ask-user

A multiple-choice question tool that lets the model ask the user to pick an option or answer freely.

## Install

`pi install npm:@tylerho/pi-ask-user`

---

# Ask User

A single multiple-choice question tool for the model: `ask_user` shows the user a question with 2–5 model-provided options in a TUI popup, always appends a free-form "Write my own answer…" fallback, and reports the outcome (selection, custom answer, or dismissal) back to the model. It exists so the model can enumerate likely answers instead of asking in plain text — and so the user can decline or answer freely without the model guessing.

## Key concepts

- **Single-shot, stateless.** One question per call; no state is kept between calls. The tool is meant for branching decisions mid-task (proceed? which option? how much?), not surveys.
- **Model builds the options; UI does the rest.** The model supplies `question` + 2–5 options (label + optional one-line description). The extension appends a `Write my own answer…` option automatically — the model must never include one itself (enforced via prompt text, not validation).
- **Three outcomes.** The user picks an option, writes a custom answer (inline editor), or dismisses (Esc). Dismissal is reported explicitly so the model does not invent an answer.
- **TUI-only.** Outside TUI mode the tool does not block — it returns a message telling the model to ask in plain text instead.
- **Validation before UI.** Option count is checked (2–5) and throws a descriptive error before any UI is shown, so the model can retry with corrected parameters.
- **Custom overlay with self-drawn chrome.** The popup is rendered via `ctx.ui.custom` with its own full-width `─` title bar and bottom rule; every line is truncated to the overlay width (`truncateToWidth`), and rendering is cached between inputs.
- **Keyboard model.** `↑`/`↓` cycle options, number keys `1`–`N` jump straight to an option, `Enter` confirms, `Esc` on the options dismisses; inside the custom-answer editor `Enter` submits and `Esc` returns to the options.
- **Abort handling.** The UI subscribes to the tool-call abort signal; aborts and Effect interrupts both resolve to a "Cancelled" result rather than hanging or throwing.

## API

### Tool

`ask_user` — "Ask User". Registered via `pi.registerTool` with `promptSnippet` and `promptGuidelines` so the model learns when to use it.

Parameters (TypeBox `AskUserParams`):

| Name | Type | Constraints | Description |
|---|---|---|---|
| `question` | string | — | The question to ask the user |
| `options` | array of `{ label: string, description?: string }` | 2–5 items | Answer options; `label` = "Short display label for this option", `description` = "Optional one-line description shown below the label" |

Return shape: `content: [{ type: "text", text }]` plus a `details` object (`AskUserDetails`): `{ question: string, options: string[], answer: string | null, wasCustom: boolean, cancelled: boolean }` (`cancelled: true` iff `answer === null`).

Result text by outcome (from `buildAskUserResultMessage`):

- **no-ui** (non-TUI mode): "No interactive UI is available, so the question could not be shown. Ask the user in plain text instead."
- **cancelled** (abort/interrupt): "Cancelled"
- **dismissed** (user pressed Esc): "User dismissed the question without answering. Do not assume an answer; proceed accordingly or ask differently."
- **custom**: "User wrote their own answer: \<answer\>"
- **selected**: "User selected option \<N\>: \<answer\>"

Error: throws `ask_user requires between 2 and 5 options (got <n>). Retry with a valid number of options.` when the option count is out of range.

Example call:

```json
{
  "question": "Two tests are failing after the refactor. Fix them now or defer?",
  "options": [
    { "label": "Fix both now", "description": "Keep working until green" },
    { "label": "Defer", "description": "Record as known failures, move on" },
    { "label": "Only investigate", "description": "Diagnose but don't change code" }
  ]
}
```

### Other exported surface

- `prompt.ts` exports (constants the tool registers with, and the result-message builder):
  - `ASK_USER_PARAMETER_DESCRIPTIONS` — the per-parameter descriptions used in the schema.
  - `ASK_USER_TOOL_DESCRIPTION` — tool description ("Ask the user a single multiple-choice question (2-5 options)…").
  - `ASK_USER_PROMPT_SNIPPET` — one-line capability snippet for the available-tools prompt.
  - `ASK_USER_PROMPT_GUIDELINES` — two rules: use `ask_user` when likely answers are enumerable; one question per call.
  - `buildAskUserResultMessage(outcome)` — maps an outcome variant (`no-ui` | `cancelled` | `dismissed` | `custom` | `selected`) to the model-facing result text.
- `index.ts` exports the `AskUserInput` type (`Static<typeof AskUserParams>`) and the default `askUser(pi: ExtensionAPI)` installer.

### UI rendering hooks

- `renderCall` — renders the call in the transcript: bold `ask_user` tool title, the question in muted, and the numbered option labels on a dim second line.
- `renderResult` — renders the outcome from `details`: warning-colored `✗ dismissed`, success `✓ (wrote) <answer>` for custom answers, `✓ N. <answer>` for selections (option number derived by looking up the answer in `details.options`).

No commands, events (`pi.on`), shortcuts, or config files — the extension is a single tool.

## Examples

1. **Branching decision mid-task** — after a check fails, ask whether to fix or defer (call above). A selection returns `content: "User selected option 1: Fix both now"` and `details.answer = "Fix both now"`, so the model acts on the chosen branch.
2. **Custom answer** — the user ignores the options and writes their own text in the editor. Result: "User wrote their own answer: …", `details.wasCustom: true`; the model must honor that text as the answer.
3. **Dismissal** — the user hits Esc on the options. Result: "User dismissed the question without answering. Do not assume an answer; proceed accordingly or ask differently." The model should pick a safe default or re-ask differently — never assume the dismissed question was answered.
4. **Non-TUI fallback** — in a non-interactive context the tool returns immediately with "No interactive UI is available…"; the model asks in plain text instead of blocking on a UI that can't render.
