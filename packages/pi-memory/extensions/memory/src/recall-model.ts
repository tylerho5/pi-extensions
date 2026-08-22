/**
 * Wiring the selector to a real model. Claude Code fixes this to Sonnet (`AC`);
 * pi resolves the configured recall model against the live registry and builds
 * a one-shot completion, mirroring how the summaries extension calls
 * `completeSimple`. Returns undefined — never throws — when the model is not
 * registered or has no credentials, so a missing key silently disables recall
 * rather than breaking the turn.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { RecallSettings } from "./settings.ts";
import type { SelectorComplete } from "./selector.ts";

/** Claude Code's selector `max_tokens` (`D2y`). */
const SELECTOR_MAX_TOKENS = 512;

/** A qualifying turn should not stall on the selector; fail open past this. */
const SELECTOR_TIMEOUT_MS = 8_000;

type CompletionContent = Awaited<ReturnType<typeof completeSimple>>["content"];

function reasoningOptions(reasoning: RecallSettings["reasoning"]) {
  return reasoning === "off" ? {} : { reasoning };
}

function assistantText(content: CompletionContent) {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export async function createSelectorComplete(
  modelRegistry: ModelRegistry,
  settings: RecallSettings,
): Promise<SelectorComplete | undefined> {
  const model = modelRegistry.find(settings.provider, settings.model);
  if (!model) return undefined;

  const auth = await modelRegistry
    .getApiKeyAndHeaders(model)
    .catch(() => undefined);
  if (!auth?.ok) return undefined;

  return async (system, user, signal) => {
    const response = await completeSimple(
      model,
      {
        systemPrompt: system,
        messages: [{ role: "user", content: user, timestamp: Date.now() }],
      },
      {
        apiKey: auth.apiKey,
        env: auth.env,
        headers: auth.headers,
        maxTokens: SELECTOR_MAX_TOKENS,
        maxRetries: 1,
        signal,
        timeoutMs: SELECTOR_TIMEOUT_MS,
        ...reasoningOptions(settings.reasoning),
      },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(
        response.errorMessage ?? "recall selector request failed",
      );
    }
    return assistantText(response.content);
  };
}
