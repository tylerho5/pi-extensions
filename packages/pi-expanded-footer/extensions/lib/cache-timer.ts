/**
 * Cache timer logic for the footer extensions.
 *
 * Computes how long the prompt cache stays valid for the currently active
 * model. The TTL depends on the active model: each provider has its own
 * documented cache lifetime, and `PI_CACHE_RETENTION=long` switches
 * supported providers to their extended retention. The countdown counts
 * from the last request that read or wrote cache (cache traffic refreshes
 * the cache for most providers; pi also rewrites cache breakpoints on
 * every turn).
 *
 * Configuration (optional): ~/.pi/agent/cache-timer.json
 *   {
 *     "defaultTtlMs": 300000,
 *     "providers": { "deepseek": 14400000, "google": 3600000 }
 *   }
 *
 * TTL sources (checked 2026-01):
 *   - Anthropic:   5-minute minimum lifetime ("ephemeral"); 1h with cache_control.ttl "1h"
 *   - OpenAI:      default retention 24h (non-ZDR orgs); in_memory under ZDR.
 *                  GPT-5.6+ models: prompt_cache_options.ttl 30m (only supported value)
 *   - DeepSeek:    disk cache auto-cleared after disuse, "usually within a few hours" — approximate
 *   - Groq:        "automatically expires after 2 hours without use"
 *   - Google:      implicit caching, no official TTL — ~1h community estimate
 *   - Bedrock:     cache point "default" = 5 min; ONE_HOUR when long retention
 *   - xAI/Mistral/others: no documented TTL (eviction-based) — default bucket
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MIN = 60_000;
const HOUR = 3_600_000;

export const DEFAULT_TTL_MS = 5 * MIN;

/** Documented default cache TTL per provider (ms). */
const PROVIDER_TTL_MS: Record<string, number> = {
  anthropic: 5 * MIN, // cache_control "ephemeral" — 5-minute minimum lifetime
  "ant-ling": 5 * MIN,
  openai: 24 * 3_600_000, // default retention policy for non-ZDR orgs
  "openai-codex": 24 * 3_600_000,
  "azure-openai-responses": 24 * 3_600_000,
  "amazon-bedrock": 5 * MIN, // cachePoint "default" = 5 min
  google: 1 * HOUR, // implicit caching — no official TTL, ~1h estimate
  "google-vertex": 1 * HOUR,
  deepseek: 2 * HOUR, // "usually within a few hours" of disuse — approximate
  groq: 2 * HOUR, // "automatically expires after 2 hours without use"
};

/** Extended TTLs used when PI_CACHE_RETENTION=long (supported providers only). */
const LONG_RETENTION_TTL_MS: Record<string, number> = {
  anthropic: 1 * HOUR, // cache_control.ttl "1h"
  "ant-ling": 1 * HOUR,
  "amazon-bedrock": 1 * HOUR, // CachePointType.ONE_HOUR
  openai: 24 * 3_600_000, // prompt_cache_retention "24h"
  "openai-codex": 24 * 3_600_000,
  "azure-openai-responses": 24 * 3_600_000,
};

/** GPT-5.6+ models use prompt_cache_options.ttl = 30m (minimum lifetime). */
const OPENAI_SHORT_TTL_MS = 30 * MIN;
const GPT56_RE = /gpt-5\.[6-9]|gpt-6\b/i;

const OPENAI_FAMILY = new Set([
  "openai",
  "openai-codex",
  "azure-openai-responses",
]);

/** OpenRouter model ids are "upstream/model", e.g. "anthropic/claude-sonnet-5". */
const OPENROUTER_UPSTREAM_SLUGS: Record<string, string> = {
  "x-ai": "xai",
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  deepseek: "deepseek",
  groq: "groq",
  mistral: "mistral",
  "amazon-bedrock": "amazon-bedrock",
};

export interface TtlConfig {
  defaultTtlMs?: number;
  providers?: Record<string, number>;
}

export function resolveTtlMs(
  provider: string,
  modelId: string,
  retention: "short" | "long",
  config?: TtlConfig,
): number {
  // Explicit per-provider override wins over everything
  if (config?.providers?.[provider] !== undefined)
    return config.providers[provider];

  // OpenRouter routes to upstream providers — derive TTL from the model slug
  let p = provider;
  let id = modelId;
  if (provider === "openrouter") {
    const slug = modelId.split("/")[0]!;
    const upstream = OPENROUTER_UPSTREAM_SLUGS[slug];
    if (upstream) {
      p = upstream;
      id = modelId.slice(slug.length + 1);
    }
  }

  // GPT-5.6+ OpenAI models: documented 30m minimum cache lifetime
  if (OPENAI_FAMILY.has(p) && GPT56_RE.test(id)) return OPENAI_SHORT_TTL_MS;

  if (retention === "long" && LONG_RETENTION_TTL_MS[p] !== undefined) {
    return LONG_RETENTION_TTL_MS[p];
  }
  return PROVIDER_TTL_MS[p] ?? config?.defaultTtlMs ?? DEFAULT_TTL_MS;
}

export type CacheState = "none" | "fresh" | "expired" | "invalidated";

export interface CacheInfo {
  state: CacheState;
  remainingMs: number;
  ttlMs: number;
  provider: string;
  model: string;
}

interface CacheMessage {
  provider: string;
  model: string;
  timestamp: number;
}

interface BranchEntryLike {
  type: string;
  message?: {
    role: string;
    provider?: string;
    model?: string;
    timestamp?: number;
    usage?: { cacheRead?: number; cacheWrite?: number };
  };
}

/**
 * Walk the active branch newest-first. The most recent cache activity (a
 * request that read or wrote cache) anchors the countdown. If the currently
 * active model differs from the model that produced that cache, the cache is
 * invalidated — a prompt cache never spans different models.
 */
export function computeCacheInfo(
  branch: readonly BranchEntryLike[],
  now: number,
  retention: "short" | "long",
  config?: TtlConfig,
  currentModel?: { provider: string; id: string },
): CacheInfo {
  const none: CacheInfo = {
    state: "none",
    remainingMs: 0,
    ttlMs: resolveTtlMs("", "", retention, config),
    provider: "",
    model: "",
  };

  let foundCache: CacheMessage | undefined;

  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i]!;
    if (e.type !== "message" || e.message?.role !== "assistant") continue;
    const usage = e.message.usage;
    if ((usage?.cacheRead ?? 0) > 0 || (usage?.cacheWrite ?? 0) > 0) {
      foundCache = {
        provider: e.message.provider ?? "",
        model: e.message.model ?? "",
        timestamp: e.message.timestamp ?? now,
      };
      break;
    }
  }

  if (!foundCache) return none;

  const invalidated =
    currentModel !== undefined &&
    (currentModel.provider !== foundCache.provider ||
      currentModel.id !== foundCache.model);
  const ttlMs = resolveTtlMs(
    foundCache.provider || "unknown",
    foundCache.model,
    retention,
    config,
  );
  const deadline = foundCache.timestamp + ttlMs;

  if (invalidated) {
    return {
      state: "invalidated",
      remainingMs: 0,
      ttlMs,
      provider: foundCache.provider,
      model: foundCache.model,
    };
  }
  return {
    state: deadline > now ? "fresh" : "expired",
    remainingMs: deadline - now,
    ttlMs,
    provider: foundCache.provider,
    model: foundCache.model,
  };
}

export function formatCountdown(ms: number): string {
  if (ms < MIN) return "<1m";
  const totalMin = Math.floor(ms / MIN);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`;
  return `${m}m`;
}

export function formatTtl(ms: number): string {
  if (ms % HOUR === 0 && ms > 0) return `${ms / HOUR}h`;
  if (ms % MIN === 0 && ms > 0) return `${ms / MIN}m`;
  return `${Math.round(ms / 1000)}s`;
}

export function loadConfig(): TtlConfig {
  const configDir =
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  try {
    const raw = readFileSync(join(configDir, "cache-timer.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<TtlConfig>;
    return {
      defaultTtlMs:
        typeof parsed.defaultTtlMs === "number"
          ? parsed.defaultTtlMs
          : undefined,
      providers: parsed.providers ?? undefined,
    };
  } catch {
    return {};
  }
}

export function retention(): "short" | "long" {
  return process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
}

/** Render the timer as a compact stats-line token, or undefined when there is nothing to show. */
export function cacheStatText(
  branch: readonly BranchEntryLike[],
  now: number,
  config?: TtlConfig,
  currentModel?: { provider: string; id: string },
): string | undefined {
  const info = computeCacheInfo(branch, now, retention(), config, currentModel);
  switch (info.state) {
    case "fresh":
      return `cache ${formatCountdown(info.remainingMs)}/${formatTtl(info.ttlMs)}`;
    case "expired":
      return "cache expired";
    case "invalidated":
      return "cache invalidated";
    default:
      return undefined;
  }
}
