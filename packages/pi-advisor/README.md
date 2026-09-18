# @tylerho/pi-advisor

A stronger reviewer model the main agent can consult mid-turn for strategic guidance, ported from Claude Code.

## Install

`pi install npm:@tylerho/pi-advisor`

---

# Advisor

Ports Claude Code 2.1.227's advisor tool to pi. The main agent calls an `advisor` tool to consult a stronger reviewer model mid-turn, and the advisor returns strategic guidance on the work so far. The advisor runs on a model configured independently of the main agent, through `~/.pi/agent/advisor.json` or `/advisor`.

## Claude Code lineage

Claude Code implements the advisor server-side, as Anthropic's `advisor_20260301` beta tool. pi is multi-provider and cannot call that tool, so this extension is a client-side port. It serializes the session into a plain-text transcript and makes a one-shot completion against a model from the local registry.

The tool description, prompt snippet and guidelines come from Claude Code 2.1.227's "# Advisor Tool" system-prompt block. Claude Code keeps its advisor prompt server-side, so `ADVISOR_SYSTEM_PROMPT` here is original. The rule that only the primary thread consults the advisor also comes from Claude Code.

Version 2.1.227 is the release the current port text was pulled from. The extension has one feature commit, `9efa7ea feat(advisor): port CC advisor` (2026-08-12), and no later commit changed the prompt constants.

## How it works

The forwarded transcript is plain text, not a copy of the provider messages. Raw message forwarding across providers carries block types (thinking signatures, `tool_use` pairs) that another provider's API rejects. `serializeAdvisorTranscript` renders each session entry as a labelled block instead, redacts secrets, caps tool arguments and results, and middle-elides the whole transcript when it exceeds 200 KB.

Only the primary session receives the tool. Subagent sessions spawn without extension custom tools, which matches Claude Code's rule that only the primary thread consults the advisor.

Registration follows the enabled flag. The tool and its `promptSnippet` and `promptGuidelines` are registered only while the advisor is enabled, so the "when to call advisor" rules leave the system prompt when the advisor is off. pi has no unregister API, so the extension registers the tool once and adds or removes it from the active tool set with `setActiveTools`. A tool registered earlier in the process stays in the registry for sessions created later, so the `session_start` handler re-checks the settings.

A consultation resolves the configured model through the model registry, pulls its credentials with `getApiKeyAndHeaders`, and calls `completeSimple` with `ADVISOR_SYSTEM_PROMPT` and the transcript wrapped in `<conversation>` tags. The configured effort is clamped to a level the model supports. The call allows 10 minutes and one retry. The advisor receives no tools and no session state.

The config sits at `~/.pi/agent/advisor.json`, outside the extension directory, and every field falls back to a default on its own. A missing, corrupt or half-edited file therefore cannot break the main session. Writes go to a temp file and are renamed into place.

## API

### Tool

`advisor` takes no parameters (`Type.Object({})`). The whole conversation is forwarded automatically. Its description carries the when-to-call rules: before substantive work and before committing to an approach, after the orientation reads the task requires, when stuck, when considering a change of approach, and before declaring done on a task longer than a few steps. The description also tells the agent to make a deliverable durable before a completion check, because the call takes time and a written file survives a session that ends during it.

`execute` returns `{ content: [{ type: "text", text: <advice> }], details: { model, effort, durationMs, truncated } }`, where `model` is `"<provider>/<model>"` and `truncated` is true when the advisor reached its output cap. When the advisor is disabled, `execute` returns text telling the agent to run `/advisor` instead of throwing.

`AdvisorError` carries every failure back to the agent as a tool error: disabled, model missing from the registry, no usable credentials (the message points to `/login <provider>` or `/advisor`), a transport or provider failure, and `stopReason: "error" | "aborted"`. A `stopReason: "length"` does not throw. It appends an output-cap note to the advice and sets `truncated`.

`renderCall` shows `advisor <provider>/<model>`, or `advisor (disabled)`. `renderResult` shows a dim header of `model · effort · seconds` above the advice, and appends `[advice truncated]` in warning color when the cap was hit.

### Command

`/advisor`, described as "Configure the advisor: a stronger model the agent can consult mid-turn", sets the advisor model.

| Argument | Behavior |
|---|---|
| none | In the TUI, opens an interactive picker. Otherwise it notifies the current status. |
| `on` | Saves `enabled: true` and syncs the tool. |
| `off` | Saves `enabled: false`, removes the tool from the active set, and drops its prompting from the system prompt. |
| `status` | Notifies `enabled · <provider>/<model> · <effort>` or `disabled`. Writes nothing. |
| `<provider>/<model>` | Resolves the pair in the registry, saves it with `enabled: true`, and asks for a thinking effort in the TUI. |
| a bare model id | Matches on model id when the argument has no `provider/` prefix. Exactly one registry match is required. |
| anything else | Warns `"<arg>" is not an available model. Run /advisor with no arguments to pick one.` |

The picker lists `curatedModels` cheapest first, labels each entry `provider/model · $<output price>/Mtok out`, marks the current model with `· current`, and appends a row that turns the advisor off or on. Picking a model then opens `ThinkingSelectorComponent` restricted to the levels that model supports. `getArgumentCompletions` suggests `on`, `off`, and `status`. A successful pick notifies `Advisor: <provider>/<model> · <effort>`.

Every write goes through `saveAdvisorSettings`, and a failed save notifies `Could not save the advisor config.` and changes nothing.

### Events

`session_start` re-runs `syncAdvisorTool(loadAdvisorSettings().enabled)` so tool visibility and the system-prompt rules match the config in each new session.

### Config file

`ADVISOR_SETTINGS_PATH` is `join(getAgentDir(), "advisor.json")`, which resolves to `~/.pi/agent/advisor.json`. The file is per machine and gitignored.

```json
{
  "enabled": true,
  "provider": "openrouter",
  "model": "anthropic/claude-opus-4.8",
  "effort": "high",
  "maxTokens": 32000
}
```

`DEFAULT_ADVISOR_SETTINGS` is `enabled: true`, `openrouter`/`anthropic/claude-opus-4.8`, `effort: "high"`, and `maxTokens: 32_000`. Claude Code pairs its advisor with Opus, and the default mirrors that on the OpenRouter side. `maxTokens` bounds total output per call, thinking plus text. It must be a finite number of at least 1000, or the default applies. `effort` must be one of the shared `EFFORTS`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

`parseAdvisorSettings(value: unknown)` falls back per field, and a non-object value returns the full defaults. `loadAdvisorSettings()` returns the defaults when the file is missing or unreadable. `saveAdvisorSettings(settings)` writes to `<path>.<pid>.<uuid>.tmp` and renames that file over the target.

### Module exports

- `index.ts` exports `advisor(pi: ExtensionAPI)` by default. It registers the tool, the `/advisor` command, and the `session_start` handler.
- `src/settings.ts` exports `AdvisorSettings` (`enabled`, `provider`, `model`, `effort`, `maxTokens`), `DEFAULT_ADVISOR_SETTINGS`, `ADVISOR_SETTINGS_PATH`, `modelKey(settings)` (returns `"<provider>/<model>"` for a settings pair, distinct from the registry-model `modelKey` in `shared/subagent-models.ts`), `parseAdvisorSettings(value)`, `loadAdvisorSettings()`, and `saveAdvisorSettings(settings)`.
- `src/consult.ts` exports `consultAdvisor({ deps, settings, transcript, signal })`, which returns `ConsultResult { advice, durationMs, truncated }`. `makeConsultDeps(modelRegistry)` wires `findModel`, `getAuth` and `complete` to the live registry, while `ConsultDeps` stays injectable for tests. `AdvisorError` is the thrown class, `ADVISOR_TIMEOUT_MS` is 10 minutes, and `ADVISOR_MAX_RETRIES` is 1.
- `src/transcript.ts` exports `serializeAdvisorTranscript(entries, maxBytes = TRANSCRIPT_MAX_BYTES)`, which renders `SessionEntry[]` as `USER`, `ASSISTANT`, `TOOL CALL <name>`, `TOOL RESULT <name> (error)`, `USER SHELL (exit N)` and `EXTENSION <type>` blocks, where the error and exit markers appear only when applicable. `redactSecrets(text)` strips bearer and basic tokens, `sk-`, `gh*` and JWT patterns, secret-looking `key: value` assignments, and secret query parameters. `TOOL_ARGUMENT_MAX_BYTES` is 2000, `TOOL_RESULT_MAX_BYTES` is 8000, and `TRANSCRIPT_MAX_BYTES` is 200000.
- `src/prompt.ts` exports `ADVISOR_PROMPT_SNIPPET`, `ADVISOR_TOOL_DESCRIPTION`, `ADVISOR_PROMPT_GUIDELINES` (5 bullets), `ADVISOR_SYSTEM_PROMPT`, and `buildAdvisorRequest(transcript)`, which wraps the transcript in `<conversation>` tags.

The five guidelines tell the agent to call the advisor before substantive work and before building on an assumption, to make the deliverable durable before declaring the task complete, to call when stuck or when considering a different approach, to give the advice serious weight while adapting when a step fails empirically or primary-source evidence contradicts a specific claim, and to surface a conflict between retrieved evidence and the advice in one more advisor call instead of switching without telling the advisor.

`advisor.test.ts` has 14 tests covering settings parsing and per-field fallback, transcript rendering, redaction and middle-elision, the consult success, truncation and failure paths, and `buildAdvisorRequest`.

## Examples

1. The agent calls `advisor()` with no arguments after its orientation reads. The extension serializes the session, sends it to the configured model, and returns the advice as tool output. The result's `details` carries the model, effort, duration and truncation flag, and the call row shows `advisor openrouter/anthropic/claude-opus-4.8`.
2. `/advisor` with no arguments opens the picker. Selecting `deepseek/deepseek-v4-pro` opens the effort selector, and choosing `high` saves `{ "enabled": true, "provider": "deepseek", "model": "deepseek-v4-pro", "effort": "high" }` alongside the existing `maxTokens`. The notify reads `Advisor: deepseek/deepseek-v4-pro · high`.
3. `/advisor off` saves `enabled: false`, removes `advisor` from the active tool set, and drops its snippet and guidelines from the system prompt, so the agent stops trying to call it.
4. An agent that calls `advisor` while the advisor is disabled gets back a message saying the advisor is disabled and to run `/advisor`, rather than a thrown error. The agent can pass that instruction to the user.
