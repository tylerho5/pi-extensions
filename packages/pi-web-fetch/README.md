# @tylerho/pi-web-fetch

Fetches a URL and converts it to markdown, with a Jina reader fallback and an optional cheap-model answer pass.

## Install

`pi install npm:@tylerho/pi-web-fetch`

---

# Web Fetch

URL fetching for pi: the `web_fetch` tool, modeled on Claude Code's WebFetch (reconstructed from the CC binary) with a Jina reader fallback and a configurable cheap "apply" model that answers the caller's prompt against fetched content.

## Key concepts

- **Two-stage pipeline.** Stage 1 fetches the page and converts it to markdown. Stage 2 (optional) runs the caller's `prompt` against that markdown with a cheap apply model and returns only the answer. Calling without a `prompt` skips stage 2 and returns the raw markdown — so a failed apply pass has a documented escape hatch.
- **Direct fetch first, Jina reader second.** The direct fetch (manual redirects, browser-like UA, 30 s timeout, 10 MB cap) handles the common case with no third party. The Jina reader (`r.jina.ai`) is the fallback when the direct path fails: network/transport errors (including mid-body stalls and drops), any HTTP status ≥ 400 except 404/410, binary content (Jina parses PDFs), or extraction that yields under 300 visible characters. Jina responses are capped at 20 MB. `WEB_FETCH_NO_JINA=1` disables the fallback (privacy); `JINA_API_KEY` raises the free-tier rate limit (20 req/min without).
- **Redirect policy copied from CC.** Same-host redirects (www-stripped, same protocol and port — default ports normalized, no userinfo, max 10 hops) are followed manually; cross-host redirects are NOT followed — the tool returns a `REDIRECT DETECTED` notice and the agent re-calls with the redirect URL. http is upgraded to https before the first request (an explicit `:80` is dropped). Redirect response bodies are cancelled, not buffered.
- **Private-address blocking.** Before fetching, the hostname is resolved and blocked if ANY address is in a private range (RFC1918, loopback, link-local, CGNAT, ULA, IPv6 v4-mapped/compatible/96-bit-embedded forms, in both dotted and post-URL-normalization hex shapes). Re-run on every redirect hop, since www-stripping changes the origin. Best-effort (DNS can rebind), but stronger than CC's two-label hostname rule. Jina is never consulted for such hosts.
- **15-minute cache.** Extracted markdown (not apply answers — prompts differ) is cached per normalized URL (hash and default ports stripped), LRU-ish, max 32 entries. Parallel identical calls share one in-flight fetch instead of stampeding.
- **Zero dependencies.** The HTML→markdown converter is a local single-pass scanner (removes script/style/noscript/iframe/svg/template/head — unclosed ones drop to end of page, converts headings, links, images, lists, tables, code fences, entities). Linear-time by construction; a hostile page of unclosed tags cannot trigger quadratic regex backtracking. No turndown/cheerio; hard pages are the Jina fallback's job.
- **Apply model is config and independent of the main agent.** Defaults to `deepseek/deepseek-v4-flash`; see `/web-fetch-model`. The apply call is a one-shot completion with thinking disabled when the model supports it (`"off"`), else the lowest supported level, and an empty system prompt. The page content is framed as untrusted data in the apply prompt (and a guideline tells the main agent the same), so a hostile page cannot steer the answer.

## API

### Tool

`web_fetch` — fetch a URL, optionally answered by the apply model.

Parameters (TypeBox):
- `url` (string, required, minLength 1) — the URL to fetch; http is upgraded to https.
- `prompt` (string, optional) — question to answer from the content. When given, the apply model reads the page and returns only the answer; when omitted, the full markdown is returned.

Execute returns `{ content: [{ type: "text", text }], details: WebFetchDetails }` where details carry `url`, `status`, `contentType`, `bytes`, `chars`, `via: "direct" | "jina"`, `cached`, `truncated`, and (apply mode) `applyModel`, `applyDurationMs`, `answerTruncated`. The redirect result carries `details: { redirect: true, redirectUrl }`.

Errors are thrown (pi convention); the message reaches the agent:
- invalid URL / unsupported protocol / embedded credentials / over 2048 chars
- private or local address (`Refusing to fetch <host> (<ips>)`)
- cross-host redirect → `REDIRECT DETECTED` notice (not an error)
- 404/410 → `The server returned HTTP …`, with a gh/curl hint for authenticated URLs
- direct failure + Jina failure → both messages combined
- apply-model failures (`ApplyError`): model not in registry, no credentials, transport failure, empty answer (`No response from model`), each suggesting the retry-without-prompt path
- content truncation at 100 000 chars (raw mode) or at the apply cap (100 000 chars) is reported in-band, not as an error; aborted fetches report `Fetch cancelled.` without a confusing second fallback attempt

Custom rendering: `renderCall` shows the URL and a `+prompt` tag; `renderResult` collapses to a 6-line preview with a `ctrl+o to expand` hint, and the expanded view prefixes a dim meta line (`via direct|jina · size · answered by <model> · seconds`).

### Command

`/web-fetch-model` — configure the apply model.

| Arg | Behavior |
|---|---|
| *(none)* or `status` | Notify the current `provider/model · maxTokens`. |
| `default` | Reset to `deepseek/deepseek-v4-flash` / 4096. |
| `<provider>/<model>` | Validate against the model registry; save (keeps the current maxTokens). Unknown → error listing available providers. |

`getArgumentCompletions` suggests `status`, `default`.

### Config file

`~/.pi/agent/web-fetch.json` (per-field fallback, atomic writes — a corrupt file can never break the main session):

```json
{
  "provider": "deepseek",
  "model": "deepseek-v4-flash",
  "maxTokens": 4096
}
```

## Examples

1. **Read a page**: `web_fetch("https://nodejs.org/api/fs.html")` → raw markdown, truncated at 100 000 chars with a notice.
2. **Targeted question**: `web_fetch("https://.../pricing", "what are the API rate limits?")` → the apply model's short answer; the page content never enters the main context.
3. **Bot-walled site**: direct fetch gets 403 → Jina reader renders it server-side → markdown via `via: "jina"`.
4. **PDF**: direct path classifies binary → Jina parses it → markdown.
5. **Cross-host redirect**: `example.com` → `www.example.com` shortlink → tool returns REDIRECT DETECTED → agent re-calls with the redirect URL.
6. **Model change**: `/web-fetch-model openrouter/anthropic/claude-haiku-4.5` → subsequent prompts are answered by that model.
