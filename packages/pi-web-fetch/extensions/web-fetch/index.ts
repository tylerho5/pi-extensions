/**
 * web-fetch — URL fetching for pi, modeled on Claude Code's WebFetch tool
 * (reconstructed from the CC binary) plus a Jina reader fallback.
 *
 * Pipeline: validate URL (no userinfo, http/https only) → upgrade to https →
 * block private addresses → direct fetch with manual same-host redirects →
 * HTML→markdown extraction → Jina reader fallback when the direct path fails,
 * is bot-blocked, returns binary content, or extracts to almost nothing →
 * optionally, a cheap "apply" model answers the caller's prompt against the
 * content (CC's second-round-trip design; default deepseek-v4-flash,
 * configurable via /web-fetch-model).
 *
 * Cross-host redirects are NOT followed; the tool returns a REDIRECT DETECTED
 * notice and the agent re-calls with the redirect URL. Fetched markdown is
 * cached for 15 minutes per normalized URL.
 */

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  applyPromptToMarkdown,
  APPLY_CONTENT_MAX_CHARS,
  makeApplyDeps,
  ApplyError,
} from "./src/apply.ts";
import { cacheKeyFor, fetchCache, type CachedPage } from "./src/cache.ts";
import { htmlToMarkdown, visibleCharCount } from "./src/extract.ts";
import {
  DIRECT_TIMEOUT_MS,
  fetchPageDirect,
  formatBytes,
  MAX_EXTRACT_INPUT_CHARS,
} from "./src/fetch.ts";
import { fetchViaJina, jinaFallbackEnabled } from "./src/jina.ts";
import {
  WEB_FETCH_PARAMETER_DESCRIPTIONS,
  WEB_FETCH_PROMPT_GUIDELINES,
  WEB_FETCH_PROMPT_SNIPPET,
  WEB_FETCH_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import {
  DEFAULT_WEB_FETCH_SETTINGS,
  loadWebFetchSettings,
  modelKey,
  saveWebFetchSettings,
} from "./src/settings.ts";
import {
  parseAndValidateUrl,
  resolvesToPrivate,
  upgradeToHttps,
} from "./src/url.ts";

const RAW_RESULT_MAX_CHARS = 100_000;
/** Below this much visible text, the page is treated as an extraction miss. */
const SHORT_CONTENT_THRESHOLD = 300;
/** In-flight fetches per key, so parallel identical calls share one fetch. */
const inflightFetches = new Map<string, Promise<FetchOutcome>>();

interface WebFetchDetails {
  url: string;
  status: number;
  contentType: string;
  bytes: number;
  chars: number;
  via: "direct" | "jina";
  cached: boolean;
  /** True when markdown exceeded the apply cap or the raw-result cap. */
  truncated: boolean;
  applyModel?: string;
  applyDurationMs?: number;
  answerTruncated?: boolean;
}

/** pi tools signal errors by throwing; the message reaches the agent. */
function toolError(message: string): never {
  throw new Error(message);
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(ms)])
    : AbortSignal.timeout(ms);
}

function classifyContent(
  contentType: string,
  body: string,
): "html" | "text" | "binary" {
  if (!contentType) {
    const head = body.slice(0, 500).trim().toLowerCase();
    if (
      head.startsWith("<!doctype html") ||
      head.includes("<html") ||
      head.includes("<head")
    ) {
      return "html";
    }
    return "text";
  }
  if (contentType === "text/html" || contentType === "application/xhtml+xml") {
    return "html";
  }
  if (contentType.startsWith("text/")) return "text";
  if (
    [
      "application/json",
      "application/xml",
      "application/javascript",
      "application/x-javascript",
    ].includes(contentType)
  ) {
    return "text";
  }
  return "binary";
}

function redirectNotice(direct: {
  originalUrl: string;
  redirectUrl: string;
  status: number;
}): AgentToolResult<{ redirect: boolean; redirectUrl: string }> {
  return {
    content: [
      {
        type: "text",
        text:
          `REDIRECT DETECTED: The URL redirects to a different host.\n\n` +
          `Original URL: ${direct.originalUrl}\n` +
          `Redirect URL: ${direct.redirectUrl}\n` +
          `Status: ${direct.status}\n\n` +
          `To complete your request, call web_fetch again with:\n` +
          `- url: "${direct.redirectUrl}"\n` +
          `- prompt: "..." (if one was given)`,
      },
    ],
    details: { redirect: true, redirectUrl: direct.redirectUrl },
  };
}

/** Fetches (or falls back), caches, and resolves to a page or a redirect. */
type FetchOutcome =
  | { page: CachedPage }
  | { redirect: { originalUrl: string; redirectUrl: string; status: number } };

async function fetchAndCachePage(
  url: URL,
  key: string,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
): Promise<FetchOutcome> {
  const directSignal = withTimeout(signal, DIRECT_TIMEOUT_MS);
  onUpdate?.({
    content: [{ type: "text", text: `Fetching ${url.hostname}…` }],
    details: undefined,
  });

  // Every hop re-validates through the caller's privacy check (hostnames can
  // change via www-stripping on a same-host redirect).
  const direct = await fetchPageDirect(url, directSignal, (hostname) =>
    resolvesToPrivate(hostname),
  );

  if (direct.kind === "redirect") return { redirect: direct };

  if (direct.kind === "error") {
    const fallback = await jinaFallback(
      url,
      `Direct fetch failed (${direct.message})`,
      signal,
      (message) =>
        onUpdate?.({
          content: [{ type: "text", text: message }],
          details: undefined,
        }),
    );
    if ("error" in fallback) {
      return toolError(
        `Fetch failed: ${direct.message}. Jina fallback also failed: ${fallback.error}`,
      );
    }
    fetchCache.set(key, fallback.page);
    return { page: fallback.page };
  }

  const classification = classifyContent(direct.contentType, direct.body);
  const antiBotStatus =
    direct.status >= 400 && direct.status !== 404 && direct.status !== 410;

  if (antiBotStatus || classification === "binary") {
    const reason = antiBotStatus
      ? `Direct fetch got HTTP ${direct.status}`
      : `Content is ${direct.contentType || "binary"} (${formatBytes(direct.bytes)})`;
    const fallback = await jinaFallback(
      new URL(direct.url),
      reason,
      signal,
      (message) =>
        onUpdate?.({
          content: [{ type: "text", text: message }],
          details: undefined,
        }),
    );
    if ("error" in fallback) {
      if (antiBotStatus) {
        return toolError(
          `The server returned HTTP ${direct.status} ${direct.statusText}. Jina fallback also failed: ${fallback.error}. If this URL requires authentication, use gh or curl via bash instead.`,
        );
      }
      return toolError(
        `Content is ${direct.contentType || "binary"} (${formatBytes(direct.bytes)}), which web_fetch cannot extract. Jina fallback also failed: ${fallback.error}`,
      );
    }
    fetchCache.set(key, fallback.page);
    return { page: fallback.page };
  }

  if (direct.status === 404 || direct.status === 410) {
    return toolError(
      `The server returned HTTP ${direct.status} ${direct.statusText}. If this URL requires authentication, use gh or curl via bash instead of web_fetch.`,
    );
  }

  const markdown =
    classification === "html"
      ? htmlToMarkdown(direct.body.slice(0, MAX_EXTRACT_INPUT_CHARS))
      : direct.body.trim();

  let page: CachedPage;
  if (visibleCharCount(markdown) < SHORT_CONTENT_THRESHOLD) {
    const fallback = await jinaFallback(
      new URL(direct.url),
      "Extracted almost no content from the page",
      signal,
      (message) =>
        onUpdate?.({
          content: [{ type: "text", text: message }],
          details: undefined,
        }),
    );
    page =
      "error" in fallback
        ? {
            url: direct.url,
            status: direct.status,
            statusText: direct.statusText,
            contentType: direct.contentType,
            bytes: direct.bytes,
            via: "direct",
            markdown,
            fetchedAt: Date.now(),
          }
        : fallback.page;
  } else {
    page = {
      url: direct.url,
      status: direct.status,
      statusText: direct.statusText,
      contentType: direct.contentType,
      bytes: direct.bytes,
      via: "direct",
      markdown,
      fetchedAt: Date.now(),
    };
  }
  fetchCache.set(key, page);
  return { page };
}

/** Try the Jina fallback; when disabled or failing, explain what happened. */
async function jinaFallback(
  url: URL,
  reason: string,
  signal: AbortSignal | undefined,
  onUpdate?: (message: string) => void,
): Promise<{ page: CachedPage } | { error: string }> {
  if (signal?.aborted) return { error: "Fetch cancelled." };
  if (!jinaFallbackEnabled()) {
    return {
      error: `${reason}; the Jina fallback is disabled (WEB_FETCH_NO_JINA=1).`,
    };
  }
  onUpdate?.(`${reason} — falling back to Jina reader…`);
  const result = await fetchViaJina(
    url,
    process.env.JINA_API_KEY,
    signal ?? new AbortController().signal,
  );
  if (!result.ok) return { error: result.error };
  return {
    page: {
      url: url.href,
      status: result.status,
      statusText: "OK",
      contentType: "text/markdown",
      bytes: new TextEncoder().encode(result.markdown).byteLength,
      via: "jina",
      markdown: result.markdown,
      fetchedAt: Date.now(),
    },
  };
}

function webFetchParams() {
  return Type.Object({
    url: Type.String({
      minLength: 1,
      description: WEB_FETCH_PARAMETER_DESCRIPTIONS.url,
    }),
    prompt: Type.Optional(
      Type.String({
        description: WEB_FETCH_PARAMETER_DESCRIPTIONS.prompt,
      }),
    ),
  });
}

export default function webFetchExtension(pi: ExtensionAPI) {
  pi.registerTool<ReturnType<typeof webFetchParams>, unknown>({
    name: "web_fetch",
    label: "Web Fetch",
    description: WEB_FETCH_TOOL_DESCRIPTION,
    promptSnippet: WEB_FETCH_PROMPT_SNIPPET,
    promptGuidelines: WEB_FETCH_PROMPT_GUIDELINES,
    parameters: webFetchParams(),

    renderCall(args, theme) {
      const p = args as { url: string; prompt?: string };
      let text =
        theme.fg("toolTitle", theme.bold("web_fetch ")) +
        theme.fg("accent", p.url || "(none)");
      if (p.prompt?.trim()) text += " " + theme.fg("dim", "+prompt");
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const first = result.content[0];
      const body = first?.type === "text" ? first.text : "";
      const details = result.details as WebFetchDetails | undefined;
      const lines = body.split("\n");
      if (!expanded) {
        const preview = lines.slice(0, 6);
        if (lines.length > 6) {
          preview.push(
            theme.fg(
              "dim",
              `... ${lines.length - 6} more lines · ctrl+o to expand`,
            ),
          );
        }
        return new Text(preview.join("\n"), 0, 0);
      }
      const meta: string[] = [];
      if (details?.via) {
        meta.push(
          `via ${details.via}${details.cached ? " (cached)" : ""} · ${formatBytes(details.bytes)}`,
        );
      }
      if (details?.applyModel) {
        meta.push(
          `answered by ${details.applyModel} · ${(details.applyDurationMs ?? 0) / 1000}s`,
        );
      }
      const header =
        meta.length > 0 ? `${theme.fg("dim", meta.join(" · "))}\n` : "";
      return new Text(header + body, 0, 0);
    },

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const p = params as { url: string; prompt?: string };
      if (!p.url?.trim()) {
        return toolError("Error: url is required.");
      }

      const parsed = parseAndValidateUrl(p.url.trim());
      if ("error" in parsed) return toolError(parsed.error);
      const url = upgradeToHttps(parsed.url);

      const privacy = await resolvesToPrivate(url.hostname);
      if (privacy.blocked) {
        return toolError(
          `Refusing to fetch ${url.hostname} (${privacy.detail ?? "private address"}) — private and local addresses are blocked.`,
        );
      }

      const key = cacheKeyFor(url);
      let page = fetchCache.get(key);
      const fromCache = page !== undefined;

      if (!page) {
        const pending = inflightFetches.get(key);
        if (pending) {
          const outcome = await pending;
          if ("redirect" in outcome) return redirectNotice(outcome.redirect);
          page = outcome.page;
        } else {
          const fetchPromise = fetchAndCachePage(url, key, signal, onUpdate);
          inflightFetches.set(key, fetchPromise);
          try {
            const outcome = await fetchPromise;
            if ("redirect" in outcome) return redirectNotice(outcome.redirect);
            page = outcome.page;
          } finally {
            inflightFetches.delete(key);
          }
        }
      }

      const prompt = p.prompt?.trim();
      const baseDetails: WebFetchDetails = {
        url: page.url,
        status: page.status,
        contentType: page.contentType,
        bytes: page.bytes,
        chars: page.markdown.length,
        via: page.via,
        cached: fromCache,
        truncated: page.markdown.length > APPLY_CONTENT_MAX_CHARS,
      };

      if (!prompt) {
        const capped =
          page.markdown.length > RAW_RESULT_MAX_CHARS
            ? page.markdown.slice(0, RAW_RESULT_MAX_CHARS)
            : page.markdown;
        const notice =
          page.markdown.length > RAW_RESULT_MAX_CHARS
            ? `\n\n[Content truncated after ${RAW_RESULT_MAX_CHARS.toLocaleString()} characters]`
            : "";
        return {
          content: [{ type: "text", text: capped + notice }],
          details: {
            ...baseDetails,
            truncated:
              page.markdown.length > RAW_RESULT_MAX_CHARS ||
              baseDetails.truncated,
          },
        };
      }

      const settings = loadWebFetchSettings();
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Answering with ${modelKey(settings)}…`,
          },
        ],
        details: undefined,
      });
      try {
        const applied = await applyPromptToMarkdown({
          deps: makeApplyDeps(ctx.modelRegistry),
          settings,
          markdown: page.markdown,
          prompt,
          signal,
        });
        const notice = applied.truncated
          ? "\n\n[Answer truncated — hit the apply model's output cap]"
          : "";
        return {
          content: [{ type: "text", text: applied.answer + notice }],
          details: {
            ...baseDetails,
            applyModel: modelKey(settings),
            applyDurationMs: applied.durationMs,
            answerTruncated: applied.truncated,
          },
        };
      } catch (error) {
        const message =
          error instanceof ApplyError
            ? error.message
            : `Apply model call failed: ${error instanceof Error ? error.message : String(error)}`;
        return toolError(
          `${message}. Retry without a prompt to get the raw markdown instead.`,
        );
      }
    },
  });

  pi.registerCommand("web-fetch-model", {
    description:
      "Configure the cheap apply model that answers web_fetch prompts",
    getArgumentCompletions: (prefix) =>
      ["status", "default"]
        .filter((word) => word.startsWith(prefix))
        .map((word) => ({ value: word, label: word })),
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();
      const current = loadWebFetchSettings();

      if (arg === "" || arg === "status") {
        ctx.ui.notify(
          `web-fetch apply model: ${modelKey(current)} · ${current.maxTokens} max tokens`,
          "info",
        );
        return;
      }

      if (arg === "default") {
        await saveWebFetchSettings(DEFAULT_WEB_FETCH_SETTINGS);
        ctx.ui.notify(
          `web-fetch apply model reset to ${modelKey(DEFAULT_WEB_FETCH_SETTINGS)}`,
          "info",
        );
        return;
      }

      const slash = arg.lastIndexOf("/");
      if (slash <= 0 || slash === arg.length - 1) {
        ctx.ui.notify(
          `"${arg}" is not a <provider>/<model> key. Use "/web-fetch-model" for status or "/web-fetch-model default" to reset.`,
          "error",
        );
        return;
      }
      const provider = arg.slice(0, slash);
      const model = arg.slice(slash + 1);
      if (!ctx.modelRegistry.find(provider, model)) {
        const providers = [
          ...new Set(ctx.modelRegistry.getAvailable().map((m) => m.provider)),
        ].join(", ");
        ctx.ui.notify(
          `"${arg}" is not in the model registry. Available providers: ${providers || "none configured"}.`,
          "error",
        );
        return;
      }
      await saveWebFetchSettings({
        provider,
        model,
        maxTokens: current.maxTokens,
      });
      ctx.ui.notify(`web-fetch apply model set to ${arg}`, "info");
    },
  });
}
