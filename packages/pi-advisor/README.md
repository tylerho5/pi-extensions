# @tylerho/pi-advisor

A stronger reviewer model the main agent can consult mid-turn for strategic guidance, ported from Claude Code.

## Install

`pi install npm:@tylerho/pi-advisor`

---

# Advisor

Claude Code's advisor tool, ported to pi as a client-side feature: a stronger reviewer model the main agent consults mid-turn. The advisor sees the whole conversation (redacted transcript), returns strategic guidance, and is configured independently of the main agent's model via `~/.pi/agent/advisor.json` or `/advisor`.

## Key concepts

- **Client-side port, because pi is multi-provider.** Claude Code implements the advisor server-side (Anthropic's `advisor_20260301` beta tool); pi cannot. This extension instead serializes the current session to a plain-text transcript and makes a one-shot completion against the configured advisor model.
- **Primary thread only.** Only the primary session gets the tool — subagent sessions spawn without extension custom tools, mirroring CC's "only the primary thread consults it" rule.
- **Enabled ⇄ tool registered.** The tool (and its `promptSnippet`/`promptGuidelines`) is only registered while the advisor is enabled, so the "when to call advisor" prompting stays out of the system prompt while disabled. `syncAdvisorTool(enabled)` adds/removes `advisor` from the active tool set; since pi has no unregister API, registration is one-shot and the settings gate the calls. `session_start` re-checks settings because a tool registered earlier in the process stays in the registry for sessions created later.
- **Plain-text transcript, not raw LLM messages.** Cross-provider forwarding of raw messages carries provider-specific block types (thinking signatures, `tool_use` pairs) that a different provider's API rejects; text is universally safe. The serializer redacts secrets, caps tool arguments (2 KB) and results (8 KB), and middle-elides at 200 KB.
- **One-shot completion, no memory.** The advisor model sees only the forwarded transcript — no session state, no tools. Call path: `modelRegistry.find()` → `getApiKeyAndHeaders()` → `completeSimple()` (same as the memory/summaries extensions), with the configured thinking effort clamped via `getSupportedThinkingLevels` and a 10-minute timeout / 1 retry.
- **Independent config.** `advisor.json` lives at the agent dir (`~/.pi/agent/advisor.json`), not inside the extension. Every field falls back independently (per-field defaults) so a corrupt or half-edited file can never break the main session; writes are atomic (temp file + rename).
- **Prompt lineage.** The tool description/snippet/guidelines are ported from Claude Code 2.1.227's "# Advisor Tool" system-prompt block; the advisor's own system prompt (`ADVISOR_SYSTEM_PROMPT`) is original — CC's advisor prompt is server-side and unrecoverable.

## API

### Tool

`advisor` — consult the configured reviewer model. **Takes NO parameters** (`Type.Object({})`); the entire conversation is forwarded automatically. The description tells the agent when to call: before substantive work (after orientation), when it believes it's done (deliverable made durable first), when stuck, and before changing approach; at least once before committing to an approach and once before declaring done on multi-step tasks.

- **Execute** returns `{ content: [{ type: "text", text: <advice> }], details: { model: "<provider>/<model>", effort, durationMs, truncated } }`. When disabled it returns a message telling the agent to run `/advisor` instead of throwing.
- **Failure modes** (thrown as `AdvisorError`, message goes back to the agent): disabled, model not in registry, no usable credentials (suggests `/login <provider>` or `/advisor`), transport/provider failure, `stopReason: "error" | "aborted"`. `stopReason: "length"` appends a truncation note and sets `truncated: true`.
- **Custom rendering**: `renderCall` shows `advisor <provider/model>` (or `(disabled)`); `renderResult` shows a dim meta header (`model · effort · seconds`) plus the advice, with `[advice truncated]` in warning color when the output cap was hit.

### Command

`/advisor` — configure the advisor model, independent of the main agent's model rotation.

| Arg | Behavior |
|---|---|
| *(none)* | TUI: interactive picker (curated models, cheapest first, current one marked `· current`, plus a toggle row to turn on/off). Non-TUI: notify current status. |
| `on` | Enable with current settings. |
| `off` | Disable (removes the tool from the active set and the prompting from the system prompt). |
| `status` | Show `enabled · <provider>/<model> · <effort>` or `disabled`; no write. |
| `<provider>/<model>` | Resolve against the model registry; sets `enabled: true` with that model. In TUI, then asks for a thinking effort via `ThinkingSelectorComponent` (only levels the model supports). |
| anything else | Warning: `"<arg>" is not an available model. Run /advisor with no arguments to pick one.` |

`getArgumentCompletions` suggests `on`, `off`, `status`.

### Events

- `session_start` — re-runs `syncAdvisorTool(loadAdvisorSettings().enabled)` so the tool visibility matches the config for each new session (a tool registered earlier in the process stays in the registry for later sessions).

### Config file

`~/.pi/agent/advisor.json` (`ADVISOR_SETTINGS_PATH` = `join(getAgentDir(), "advisor.json")`):

```json
{
  "enabled": true,
  "provider": "openrouter",
  "model": "anthropic/claude-opus-4.8",
  "effort": "high",
  "maxTokens": 32000
}
```

`DEFAULT_ADVISOR_SETTINGS`: `enabled: true`, `openrouter`/`anthropic/claude-opus-4.8` (CC pairs its advisor with Opus; mirrored on the openrouter half), `effort: "high"`, `maxTokens: 32_000`. `maxTokens` bounds total output (thinking + text) per call; values must be finite numbers ≥ 1000 or the default applies. `effort` must be one of the shared `EFFORTS` (`off | minimal | low | medium | high | xhigh | max`).

### Module exports (src/)

- **`src/settings.ts`** — `AdvisorSettings` (interface: `enabled`, `provider`, `model`, `effort`, `maxTokens`), `DEFAULT_ADVISOR_SETTINGS`, `ADVISOR_SETTINGS_PATH`, `modelKey(settings)` (→ `"<provider>/<model>"`), `parseAdvisorSettings(value: unknown)`, `loadAdvisorSettings()`, `saveAdvisorSettings(settings)` (atomic: temp file + rename).
- **`src/consult.ts`** — `consultAdvisor({ deps, settings, transcript, signal })` → `ConsultResult { advice, durationMs, truncated }`; `makeConsultDeps(modelRegistry)` wires `findModel`/`getAuth`/`complete` to the live registry; `ConsultDeps` interface (injectable for tests); `AdvisorError`; constants `ADVISOR_TIMEOUT_MS` (10 min), `ADVISOR_MAX_RETRIES` (1).
- **`src/transcript.ts`** — `serializeAdvisorTranscript(entries, maxBytes = TRANSCRIPT_MAX_BYTES)` turns `SessionEntry[]` into a `USER / ASSISTANT / TOOL CALL <name> / TOOL RESULT <name> (error?) / USER SHELL (exit N) / EXTENSION <type>` text transcript; `redactSecrets(text)` (Bearer/Basic tokens, `sk-`/`gh*`/JWT patterns, `key: value` assignments, query params); constants `TOOL_ARGUMENT_MAX_BYTES` (2 000), `TOOL_RESULT_MAX_BYTES` (8 000), `TRANSCRIPT_MAX_BYTES` (200 000).
- **`src/prompt.ts`** — `ADVISOR_PROMPT_SNIPPET` (tool-list line), `ADVISOR_TOOL_DESCRIPTION` (full schema description with when-to-call rules), `ADVISOR_PROMPT_GUIDELINES` (5 guidelines bullets), `ADVISOR_SYSTEM_PROMPT` (what the advisor model sees), `buildAdvisorRequest(transcript)` (wraps the transcript in `<conversation>…</conversation>`).

## Examples

1. **Agent consults before substantive work** (mid-turn tool call): the agent calls `advisor()` with no arguments after doing orientation reads; the extension serializes the session and returns the advisor's advice as tool output with `details.model`/`effort`/`durationMs`/`truncated` metadata.
2. **User reconfigures the advisor model**: `/advisor` → pick `deepseek/deepseek-v4-pro` from the picker → pick `high` thinking → the tool stays/becomes active and the tool-line shows the new model.
3. **User disables the advisor**: `/advisor off` — the tool is removed from the active set and the "when to call advisor" prompting leaves the system prompt, so the agent stops trying to call it.
4. **Agent with a disabled advisor**: calling `advisor` returns "The advisor is disabled — run /advisor to pick a model…" instead of failing, so the agent can relay the instruction to the user.
