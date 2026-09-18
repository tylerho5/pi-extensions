# @tylerho/pi-long-cache

Forces long prompt-cache retention in-process so providers without an explicit opt-in still get caching.

## Install

`pi install npm:@tylerho/pi-long-cache`

---

# Long cache

Sets `process.env.PI_CACHE_RETENTION = "long"` while pi loads, so every provider request in the process attempts the longest prompt cache the provider supports. Pi defaults to `"short"` retention, and without this, OpenAI-compatible endpoints other than OpenAI (deepseek, openrouter) send no `prompt_cache_key` at all, so no prompt caching is attempted for them.

## How it works

The default export `(_pi: ExtensionAPI)` runs once at extension load, which includes startup and `/reload`, and ignores its argument. Setting the variable before the first provider request is what matters, and extension load happens early in the process.

Anthropic-style models (kimi-coding, anthropic) then send `cache_control` with `ttl: "1h"` instead of the 5-minute default. OpenAI-compatible models (deepseek, openrouter) send `prompt_cache_key` plus `prompt_cache_retention: "24h"` instead of in-memory retention. Providers without long-retention support are unaffected, because `"long"` is a request rather than a guarantee.

The extension covers pi's own process only. `~/.zshrc` holds the same export (`export PI_CACHE_RETENTION=long`) for anything launched outside pi's process. Delete `extensions/long-cache/index.ts`, or the export line inside it, to disable the extension. No settings toggle exists.
