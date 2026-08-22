/**
 * The advisor consultation: a one-shot completion against the configured
 * advisor model. Follows the recall/summaries pattern — resolve the model
 * through the live registry, pull its credentials, then `completeSimple` with
 * a plain-text transcript. Injectable deps keep the failure paths unit-
 * testable without a registry or network.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
  getSupportedThinkingLevels,
  type Api,
  type AssistantMessage,
  type Model,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { ADVISOR_SYSTEM_PROMPT, buildAdvisorRequest } from "./prompt.ts";
import type { AdvisorSettings } from "./settings.ts";

/** Advisor calls are slow (thinking + long advice); let them breathe. */
export const ADVISOR_TIMEOUT_MS = 10 * 60_000;
export const ADVISOR_MAX_RETRIES = 1;

export interface ConsultResult {
  readonly advice: string;
  readonly durationMs: number;
  /** True when the output cap was hit and the advice may be truncated. */
  readonly truncated: boolean;
}

export class AdvisorError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AdvisorError";
  }
}

export interface ConsultDeps {
  findModel: (provider: string, modelId: string) => Model<Api> | undefined;
  getAuth: (model: Model<Api>) => Promise<
    | {
        ok: true;
        apiKey?: string;
        env?: Record<string, string>;
        headers?: Record<string, string>;
      }
    | { ok: false; error: string }
  >;
  complete: typeof completeSimple;
}

const DEFAULT_DEPS: ConsultDeps = {
  findModel: (provider, modelId) => undefined,
  getAuth: async () => ({ ok: false, error: "no model registry" }),
  complete: completeSimple,
};

function assistantText(content: AssistantMessage["content"]) {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** Fall back to a supported thinking level when the configured one isn't. */
function clampEffort(
  model: Model<Api>,
  effort: AdvisorSettings["effort"],
): ThinkingLevel {
  const supported = getSupportedThinkingLevels(model);
  if (effort !== "off" && supported.includes(effort)) return effort;
  if (supported.includes("high")) return "high";
  return supported.find((level) => level !== "off") ?? "minimal";
}

export function makeConsultDeps(modelRegistry: ModelRegistry): ConsultDeps {
  return {
    findModel: (provider, modelId) =>
      modelRegistry.find(provider, modelId) ?? undefined,
    getAuth: (model) => modelRegistry.getApiKeyAndHeaders(model),
    complete: completeSimple,
  };
}

export async function consultAdvisor(options: {
  deps: ConsultDeps;
  settings: AdvisorSettings;
  transcript: string;
  signal?: AbortSignal;
}): Promise<ConsultResult> {
  const { deps, settings, transcript, signal } = options;
  const started = Date.now();
  const durationMs = () => Date.now() - started;

  if (!settings.enabled) {
    throw new AdvisorError(
      'The advisor is disabled. Ask the user to run "/advisor" to pick a model, or "/advisor off" is set — enable it with "/advisor on".',
    );
  }

  const model = deps.findModel(settings.provider, settings.model);
  if (!model) {
    throw new AdvisorError(
      `Advisor model "${settings.provider}/${settings.model}" is not in the model registry. Run "/advisor" to pick an available model.`,
    );
  }

  const auth = await deps.getAuth(model).catch(() => undefined);
  if (!auth || !auth.ok) {
    throw new AdvisorError(
      `Advisor model "${settings.provider}/${settings.model}" has no usable credentials (${auth?.error ?? "unknown error"}). Run "/login ${settings.provider}" or pick another model with "/advisor".`,
    );
  }

  let response: AssistantMessage;
  try {
    response = await deps.complete(
      model,
      {
        systemPrompt: ADVISOR_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildAdvisorRequest(transcript),
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        env: auth.env,
        headers: auth.headers,
        reasoning: clampEffort(model, settings.effort),
        maxTokens: settings.maxTokens,
        maxRetries: ADVISOR_MAX_RETRIES,
        signal,
        timeoutMs: ADVISOR_TIMEOUT_MS,
      },
    );
  } catch (error) {
    throw new AdvisorError(
      `Advisor consultation failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new AdvisorError(
      response.errorMessage ?? "Advisor consultation failed or was aborted.",
    );
  }

  let advice = assistantText(response.content);
  if (response.stopReason === "length") {
    advice += "\n\n[advisor hit its output cap — the advice may be truncated]";
  }

  return {
    advice,
    durationMs: durationMs(),
    truncated: response.stopReason === "length",
  };
}
