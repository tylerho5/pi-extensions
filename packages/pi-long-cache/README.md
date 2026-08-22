# @tylerho/pi-long-cache

Forces long prompt-cache retention in-process so providers without an explicit opt-in still get caching.

## Install

`pi install npm:@tylerho/pi-long-cache`

---

# Long cache

Forces `PI_CACHE_RETENTION=long` in-process at extension load, so every provider request made by the pi process attempts the longest supported prompt cache regardless of which model is used or how pi was launched. Exists because pi's default is `"short"` retention, and non-OpenAI OpenAI-compatible endpoints (deepseek, openrouter, …) don't even send a `prompt_cache_key` without it — no prompt caching is attempted at all, which costs tokens on every request. This extension makes the "long" guarantee unconditional inside pi; `~/.zshrc` exports the same variable for anything launched outside pi's process.

## Key concepts

- **Zero-API, pure side effect.** The whole extension is one default export that runs once at extension load (startup, and again on `/reload`): `process.env.PI_CACHE_RETENTION = "long"`. The `_pi: ExtensionAPI` argument is unused (underscore-prefixed). Setting the env var before the first provider request is what matters, and extension load happens early in the pi process, so every subsequent request inherits it.
- **What `long` means** (from the header comment, matching pi core semantics; only applies to direct API calls):
  - Anthropic-style (kimi-coding, anthropic): `cache_control` with `ttl: "1h"` (default would be ~5 min).
  - OpenAI-compatible (deepseek, openrouter): `prompt_cache_key` + `prompt_cache_retention: "24h"` (default would be in-memory only).
  - Providers without long-retention support are unaffected — `"long"` is a request, not a guarantee per provider.
- **In-process vs shell.** The extension only covers pi's own process. The identical export lives in `~/.zshrc` (`export PI_CACHE_RETENTION=long`) for pi or other CLI tools launched from that shell. Both are needed: a shell export is lost when pi is launched outside a `.zshrc`-sourcing shell (GUI launcher, different shell), and the in-process set here is lost nowhere — it re-applies on every pi start and `/reload`.
- **Disable by deletion.** Removing `extensions/long-cache/index.ts` (or deleting the export line) disables it — there is no settings toggle or config file. Auto-discovery loads any top-level `*/index.ts` under `extensions/`, so merely renaming the file also disables it.
- **Related consumer.** `extensions/lib/cache-timer.ts` (used by the `expanded-footer` extension) reads the same env var: it switches to extended TTLs when retention is `long`, so its cache-lifetime countdown stays consistent with this extension's behavior. `lib/` is not auto-loaded — it is a helper only.

## API

There are **no tools, commands, events, shortcuts, or config files**. The public surface is exactly:

- **Default export** — `export default function (_pi: ExtensionAPI)` — the extension entry point. Sets `process.env.PI_CACHE_RETENTION = "long"` and returns nothing. Takes the `ExtensionAPI` (`@earendil-works/pi-coding-agent`, type-only import) and ignores it.
- **Env var written** — `PI_CACHE_RETENTION = "long"` — the entire contract. Nothing is read from settings, args, or disk.

A grep of the source confirms: no `registerTool`, no `registerCommand`, no `pi.on`, no `registerShortcut`, no `import` of shared/ modules or other extensions, no `*.test.ts`, no `.json` config.

## Examples

1. **Why this extension exists, in practice:** the agent notices deepseek/openrouter requests carrying no `prompt_cache_key`. That is the default pi behavior; this extension is what fixes it. When debugging cache misses on those providers, first confirm `extensions/long-cache/index.ts` exists and is loaded (it auto-loads as a top-level `*/index.ts`) — not a knob to set per request.
2. **Extending it:** to also cover shells, the companion `~/.zshrc` line (`export PI_CACHE_RETENTION=long   # pi: longest prompt caching for every model (1h Anthropic-style / 24h OpenAI-style)`) duplicates the guarantee for pi launched outside pi's process. If a launch path (e.g. a launcher script) misses it, add the export there, not in this extension.
3. **Disabling prompt caching:** delete `extensions/long-cache/index.ts` (or remove the export line) and remove the `~/.zshrc` line. There is no config flag. After editing, `/reload` in pi re-runs extension defaults.
