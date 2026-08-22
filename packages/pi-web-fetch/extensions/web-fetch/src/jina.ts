/**
 * Jina reader fallback (r.jina.ai): renders pages server-side and parses
 * PDFs. Used when the direct fetch fails, is bot-blocked, returns binary
 * content, or extracts to almost nothing. Honored env vars:
 *   JINA_API_KEY   — bearer auth, raises the free-tier rate limit
 *   WEB_FETCH_NO_JINA=1 — disable the fallback entirely (privacy)
 */

import { formatBytes, readBounded } from "./fetch.ts";

export const JINA_TIMEOUT_MS = 60_000;
/** r.jina.ai renders whole pages; cap its responses like the direct path. */
export const JINA_MAX_BYTES = 20 * 1024 * 1024;

export const jinaFallbackEnabled = () => process.env.WEB_FETCH_NO_JINA !== "1";

export type JinaFetch =
  { ok: true; markdown: string; status: number } | { ok: false; error: string };

export async function fetchViaJina(
  url: URL,
  apiKey: string | undefined,
  signal: AbortSignal,
): Promise<JinaFetch> {
  const target = `https://r.jina.ai/${url.href}`;
  const headers: Record<string, string> = {
    accept: "text/markdown",
    "x-return-format": "markdown",
    "x-timeout": "30",
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  let response: Response;
  try {
    response = await fetch(target, {
      headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(JINA_TIMEOUT_MS)]),
    });
  } catch (error) {
    if (signal.aborted) return { ok: false, error: "Fetch cancelled." };
    return {
      ok: false,
      error: `Jina reader request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (response.status === 429) {
    return {
      ok: false,
      error:
        "Jina reader rate limited (free tier: 20 requests/minute). Set JINA_API_KEY for a higher limit, or retry later.",
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: `Jina reader returned HTTP ${response.status} ${response.statusText}.`,
    };
  }

  const raw = await response.text();
  return {
    ok: true,
    markdown: stripJinaPreamble(raw),
    status: response.status,
  };
}

/** r.jina.ai's default format adds Title:/URL Source: headers; drop them. */
function stripJinaPreamble(raw: string): string {
  const marker = "Markdown Content:";
  const index = raw.indexOf(marker);
  if (index !== -1) {
    return raw.slice(index + marker.length).trimStart();
  }
  return raw
    .split("\n")
    .filter((line) => !/^(Title|URL Source|Published Time):/.test(line))
    .join("\n")
    .trim();
}
