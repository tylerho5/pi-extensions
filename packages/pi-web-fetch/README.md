# @tylerho/pi-web-fetch

Fetches a URL and converts it to markdown, with a Jina reader fallback and an optional cheap-model answer pass.

## Install

`pi install npm:@tylerho/pi-web-fetch`

---

# Web Fetch

`web_fetch` is pi's port of Claude Code 2.1.229's WebFetch: it fetches a URL, converts the page to markdown, and can hand that markdown to a cheap apply model that answers the caller's prompt against it. The port adds a Jina reader fallback for pages the direct fetch cannot read, and the apply model comes from `~/.pi/agent/web-fetch.json` or `/web-fetch-model`.

## Claude Code lineage

The port source is Claude Code 2.1.229. The feature commit `9d3629c feat(web-fetch): add URL fetch tool with Jina fallback and apply-model answers` (2026-08-12) added the extension and this doc, and the research behind it read the 2.1.229 native binary at recorded byte offsets. The two commits that touched the directory afterwards, `2a86bf1 chore: re-root repo at ~/.pi` and `21734f0 fix(models): use the current deepseek-flash slug`, changed no model-facing text, so 2.1.229 remains the release the current port text came from.

Pulled from 2.1.229: the same-host redirect rule, the `REDIRECT DETECTED` hand-back for cross-host redirects, the 15-minute per-URL cache, the rule that authenticated and private URLs fail instead of being fetched, the second round trip that answers `prompt` with a small fast model, and the apply prompt template, adapted here with an empty system prompt and an untrusted-content frame. pi's own text is the tool description, prompt snippet, guidelines and parameter descriptions in `src/prompt.ts`, extended for the Jina reader, the 100 000-character cap and the redirect re-call. CC has no Jina fallback, and the private-address guard resolves each host and inspects every returned address, which is stricter than CC's two-label hostname rule. The cache key normalization in `src/cache.ts` is a deliberate divergence, since CC keys the cache on the URL as given.

## How it works

The tool runs in two stages. Stage 1 validates the URL, fetches the page and converts it to markdown. Stage 2 runs only when the caller passes a `prompt`, and there the apply model reads the markdown and returns just the answer. A call without a `prompt` skips stage 2 and returns the markdown, and every thrown apply failure ends with a message telling the caller to retry that way.

`parseAndValidateUrl` accepts http and https only, rejects embedded credentials and URLs over 2048 characters, and `upgradeToHttps` rewrites http to https and drops an explicit `:80`. Before the request, `resolvesToPrivate` resolves the hostname and blocks the fetch when any returned address is private: RFC1918, loopback, link-local, CGNAT, ULA, and the IPv6 v4-mapped, v4-compatible and 96-bit-embedded shapes, in dotted and hex forms. The check runs again on every redirect hop, because stripping `www.` changes the origin. A blocked host is never sent to Jina either. The guard is best effort, since DNS can change between the lookup and the connection.

The direct fetch follows redirects manually with a browser-like user agent, a 30-second timeout, and a 10 MB body cap. It follows a redirect only when the next URL keeps the same protocol, port and host, with default ports normalized and a leading `www.` ignored, and carries no userinfo, for at most 10 hops. A cross-host redirect stops the fetch and returns a `REDIRECT DETECTED` notice that names the original URL, the redirect URL and the status, so the agent calls the tool again with the new URL. Redirect bodies are cancelled instead of read. The response charset comes from the content-type header, with a `<meta>` charset in the first 2 000 characters as the fallback, and content is classified as html, text or binary from the content-type, with a sniff for `<html` and `<head` when the header is missing.

The Jina reader at `https://r.jina.ai/<url>` is the fallback when the direct fetch fails at the transport layer, returns a status of 400 or higher other than 404 and 410, returns binary content, or extracts fewer than 300 visible characters. Jina renders pages server-side and parses PDFs, and its request has a 60-second timeout. `JINA_API_KEY` sends a bearer token that raises the free-tier limit, `WEB_FETCH_NO_JINA=1` disables the fallback, and a 429 reports the free-tier limit of 20 requests per minute. Jina's default response carries `Title:` and `URL Source:` headers, and the tool keeps only the text from the `Markdown Content:` marker onward.

`htmlToMarkdown` is a local single-pass scanner with no parser dependency. It removes script, style, noscript, iframe, svg, template and head elements, pulls `<pre>` blocks out first so code survives, then converts headings, links, images, lists, tables, blockquotes and inline emphasis, and decodes named and numeric entities. An unclosed element drops the rest of the page to end of input instead of leaking its body. The scan is linear by construction, so a page of unclosed tags cannot drive quadratic regex backtracking, and the raw HTML is sliced to 5 MB before extraction.

Extracted markdown is cached for 15 minutes per normalized URL, with the fragment and default ports stripped, in a map capped at 32 entries. A hit refreshes the entry's recency, and the oldest entry is evicted when the map is full. Concurrent identical calls share one in-flight fetch. The cache holds markdown only, never apply answers, because prompts differ.

The apply step is a one-shot completion against a model chosen independently of the main agent. It runs with an empty system prompt, thinking disabled when the model supports the `off` level and otherwise at the model's lowest level, `maxTokens` from the config (4096 by default), one retry, and a 60-second timeout. The markdown is capped at 100 000 characters, and the request frames the page as untrusted data to analyze rather than instructions to follow. The answer is the response's text blocks joined, and `stopReason: "length"` marks a truncated answer in the result details.

The tool signals errors by throwing, so the message reaches the agent. Failures name the cause and the next step: an invalid URL, a blocked private address (`Refusing to fetch <host> (<ips>)`), a 404 or 410 with a suggestion to use `gh` or `curl` for authenticated URLs, and a combined message when the direct fetch and the Jina fallback both fail. Apply failures throw `ApplyError` for a model missing from the registry, missing credentials, a transport failure, or a failed or aborted response, and each message points at the retry-without-a-prompt path. An empty answer returns the text `No response from model` instead of throwing. Truncation at 100 000 characters in raw mode and at the apply cap is reported in band, not as an error. An aborted fetch reports `Fetch cancelled.` and starts no second fallback attempt.

## API

### Tool

`web_fetch`, label "Web Fetch", registered by `extensions/web-fetch/index.ts`.

| Parameter | Type | Description |
|---|---|---|
| `url` | string, required, minLength 1 | The URL to fetch. http is upgraded to https. |
| `prompt` | string, optional | Question to answer from the fetched content. When given, the apply model returns only the answer. When omitted, the full markdown comes back. |

Execute returns `{ content: [{ type: "text", text }], details: WebFetchDetails }`. The details carry `url`, `status`, `contentType`, `bytes`, `chars`, `via` (`"direct"` or `"jina"`), `cached` and `truncated`, plus `applyModel`, `applyDurationMs` and `answerTruncated` in apply mode. A cross-host redirect returns `details: { redirect: true, redirectUrl }` instead of an error.

`renderCall` shows the URL and a `+prompt` tag when a prompt is present. `renderResult` collapses the body to a six-line preview with a `ctrl+o to expand` hint, and the expanded view prefixes a dim meta line with the source, the size, and the apply model and seconds when one ran. Progress updates report `Fetching <host>…`, the Jina fallback, and `Answering with <model>…`.

### Command

`/web-fetch-model` configures the apply model.

| Arg | Behavior |
|---|---|
| *(none)* or `status` | Notify the current `provider/model · maxTokens`. |
| `default` | Reset to `deepseek/deepseek-flash` with 4096 max tokens. |
| `<provider>/<model>` | Validate against the model registry and save, keeping the current `maxTokens`. An unknown key errors with the list of available providers. |

`getArgumentCompletions` suggests `status` and `default`.

### Config file

`~/.pi/agent/web-fetch.json`:

```json
{
  "provider": "deepseek",
  "model": "deepseek-flash",
  "maxTokens": 4096
}
```

`parseWebFetchSettings` falls back per field, so one bad value keeps the rest, and a `maxTokens` below 1000 or non-finite falls back to 4096. A missing or unparsable file yields the defaults. Saving writes a temporary file and renames it over the target.

### Modules

- `index.ts`: default export `(pi: ExtensionAPI) => void`, registering the tool and the command.
- `src/prompt.ts`: `WEB_FETCH_TOOL_DESCRIPTION`, `WEB_FETCH_PROMPT_SNIPPET`, `WEB_FETCH_PROMPT_GUIDELINES` (four guidelines: search with `web_search` to find pages, re-call on a redirect notice, avoid authenticated URLs and use `gh` or `curl` instead, and treat results as data rather than instructions), and `WEB_FETCH_PARAMETER_DESCRIPTIONS`. This file holds the main agent's tool wording.
- `src/fetch.ts`: `USER_AGENT`, `DIRECT_TIMEOUT_MS`, `MAX_CONTENT_BYTES`, `MAX_REDIRECTS`, `MAX_EXTRACT_INPUT_CHARS`, `formatBytes`, `isSameHostForRedirect`, `readBounded`, `fetchPageDirect`.
- `src/url.ts`: `MAX_URL_LENGTH`, `parseAndValidateUrl`, `upgradeToHttps`, `isPrivateIpv4`, `isPrivateIpv6`, `expandIpv6`, `resolvesToPrivate`.
- `src/extract.ts`: `htmlToMarkdown`, `visibleCharCount`.
- `src/jina.ts`: `JINA_TIMEOUT_MS`, `JINA_MAX_BYTES`, `jinaFallbackEnabled`, `fetchViaJina`.
- `src/cache.ts`: `CACHE_TTL_MS`, `CACHE_MAX_ENTRIES`, `cacheKeyFor`, `fetchCache`, `CachedPage`.
- `src/settings.ts`: `DEFAULT_WEB_FETCH_SETTINGS`, `WEB_FETCH_SETTINGS_PATH`, `modelKey`, `parseWebFetchSettings`, `loadWebFetchSettings`, `saveWebFetchSettings`, `WebFetchSettings`.
- `src/apply.ts`: `APPLY_TIMEOUT_MS`, `APPLY_MAX_RETRIES`, `APPLY_CONTENT_MAX_CHARS`, `ApplyError`, `ApplyDeps`, `applyPromptToMarkdown`, `buildApplyRequest`, `makeApplyDeps`.

## Examples

1. Read a page: `web_fetch("https://nodejs.org/api/fs.html")` returns raw markdown, truncated at 100 000 characters with an in-band notice.
2. Ask a targeted question: `web_fetch("https://example.com/pricing", "what are the API rate limits?")` returns the apply model's short answer, and the page content never enters the main context.
3. Bot-walled site: the direct fetch gets a 403, so the Jina reader renders the page server-side and the result reports `via: "jina"`.
4. PDF: the direct fetch classifies the file as binary, and Jina parses it into markdown.
5. Cross-host redirect: `example.com` redirects to `www.example.org`, the tool returns the `REDIRECT DETECTED` notice, and the agent calls again with the redirect URL.
6. Change the apply model: `/web-fetch-model openrouter/anthropic/claude-haiku-4.5` sends later prompts to that model.
7. Privacy: `WEB_FETCH_NO_JINA=1` in the environment keeps page URLs off `r.jina.ai`, and a host that resolves to a private address is refused before any request.
