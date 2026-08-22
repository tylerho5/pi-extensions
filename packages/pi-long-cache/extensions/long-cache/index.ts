/**
 * Long prompt caching
 *
 * Sets PI_CACHE_RETENTION=long in-process so every provider request attempts
 * the longest supported prompt cache, no matter which model is used or how pi
 * was launched:
 *   - Anthropic-style (kimi-coding, anthropic): cache_control with ttl: "1h"
 *   - OpenAI-compatible (deepseek, openrouter): prompt_cache_key +
 *     prompt_cache_retention: "24h"
 *
 * Without this, pi defaults to "short" retention, and non-OpenAI
 * OpenAI-compatible endpoints (deepseek, openrouter, ...) don't even send a
 * prompt_cache_key — no caching is attempted at all. The same guarantee is
 * also exported from ~/.zshrc for anything launched outside pi's process.
 *
 * Delete this file (or remove the export below) to disable.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI) {
  process.env.PI_CACHE_RETENTION = "long";
}
