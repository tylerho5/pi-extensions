/**
 * Settle-time report summarizer: one cheap fast-tier call that turns a
 * subagent report into a one or two line digest for the transcript.
 *
 * The call follows web-fetch's apply pass: empty system prompt, thinking off,
 * a small token cap, one retry, a hard timeout. Deps are injected so the
 * failure paths stay unit-testable without a registry or network. Every
 * failure returns undefined, because a missing digest must never block the
 * report itself.
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
import {
  loadDelegationConfig,
  resolveDelegationTarget,
} from "../../shared/subagent-models.ts";
import type { SubagentStatus } from "./domain.ts";

export const SUMMARY_TIMEOUT_MS = 15_000;
export const SUMMARY_MAX_TOKENS = 200;

export const SUMMARY_PROMPT =
  "Summarize this subagent report in at most two lines, preferably one. Plain sentence, no markdown, no preamble. State what was done and the key outcome or finding.";

export interface SummarizeResult {
  readonly summary: string;
  /** Cost of the summary call itself, USD. */
  readonly costUsd?: number;
  /** Total tokens the summary call reported. */
  readonly tokens?: number;
}

export interface SummarizeDeps {
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

export function makeSummarizeDeps(modelRegistry: ModelRegistry): SummarizeDeps {
  return {
    findModel: (provider, modelId) =>
      modelRegistry.find(provider, modelId) ?? undefined,
    getAuth: (model) => modelRegistry.getApiKeyAndHeaders(model),
    complete: completeSimple,
  };
}

/**
 * The fast tier is always a pi target, so it resolves without a harness
 * choice. Never hardcode a provider here: the user configures the tier.
 */
export function fastSummaryTarget(): SummarizeTarget {
  const target = resolveDelegationTarget({
    config: loadDelegationConfig(),
    selection: { tier: "fast" },
    supportedHarnesses: ["pi"],
  });
  return {
    provider: target.harness === "pi" ? target.provider : undefined,
    model: target.model,
  };
}

export interface SummarizeTarget {
  readonly provider?: string;
  readonly model: string;
}

/**
 * Skip rules, kept here so they are testable apart from the extension wiring.
 * A failed or cancelled run has no report worth a digest, and a short report
 * is already a digest.
 */
export function shouldSummarize(options: {
  enabled: boolean;
  status: SubagentStatus;
  textLength: number;
  skipUnderChars: number;
}): boolean {
  if (!options.enabled) return false;
  if (options.status === "error" || options.status === "cancelled")
    return false;
  return options.textLength >= options.skipUnderChars;
}

/** The one user message: the instruction, then the report as data. */
export function buildSummarizeRequest(report: string) {
  return `${SUMMARY_PROMPT}\n\n${report}`;
}

function assistantText(content: AssistantMessage["content"]) {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * Thinking is disabled for the cheap pass when the model supports it. The type
 * omits "off", but the runtime accepts the full pi scale: openai-completions
 * (DeepSeek) maps "off" to thinking disabled, and models whose map excludes it
 * never report it as supported, so they take the lowest real level.
 */
function clampToNoThinking(model: Model<Api>): ThinkingLevel {
  const supported = getSupportedThinkingLevels(model);
  if (supported.includes("off")) return "off" as ThinkingLevel;
  return supported.find((level) => level !== "off") ?? "minimal";
}

/** `usage` and `usage.cost` are required by the type but tolerated as absent. */
function usageNumbers(response: AssistantMessage) {
  const usage = response.usage as
    { totalTokens?: number; cost?: { total?: number } } | undefined;
  return {
    tokens:
      typeof usage?.totalTokens === "number" ? usage.totalTokens : undefined,
    costUsd:
      typeof usage?.cost?.total === "number" ? usage.cost.total : undefined,
  };
}

export async function summarizeReport(options: {
  deps: SummarizeDeps;
  target: SummarizeTarget;
  report: string;
  /** Head-only cap on the report text fed to the model. */
  inputCharCap: number;
  signal?: AbortSignal;
}): Promise<SummarizeResult | undefined> {
  const { deps, target, report, inputCharCap, signal } = options;
  try {
    const model = deps.findModel(target.provider ?? "", target.model);
    if (!model) return undefined;
    const auth = await deps.getAuth(model).catch(() => undefined);
    if (!auth || !auth.ok) return undefined;

    const response = await deps.complete(
      model,
      {
        systemPrompt: "",
        messages: [
          {
            role: "user",
            content: buildSummarizeRequest(
              report.slice(0, Math.max(0, inputCharCap)),
            ),
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        env: auth.env,
        headers: auth.headers,
        reasoning: clampToNoThinking(model),
        maxTokens: SUMMARY_MAX_TOKENS,
        maxRetries: 1,
        signal,
        timeoutMs: SUMMARY_TIMEOUT_MS,
      },
    );

    if (response.stopReason === "error" || response.stopReason === "aborted") {
      return undefined;
    }
    const summary = assistantText(response.content);
    if (!summary) return undefined;
    return { summary, ...usageNumbers(response) };
  } catch {
    return undefined;
  }
}
