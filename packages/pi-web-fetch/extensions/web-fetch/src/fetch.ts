/**
 * Direct fetch with manual redirects, following Claude Code's WebFetch
 * design: same-host redirects are followed (www-stripped, same protocol and
 * port, no userinfo, max 10 hops); cross-host redirects are handed back to
 * the caller as a "REDIRECT DETECTED" notice instead of being followed.
 */

export const USER_AGENT = "pi-agent (web_fetch; +https://pi.dev)";
export const DIRECT_TIMEOUT_MS = 30_000;
export const MAX_CONTENT_BYTES = 10 * 1024 * 1024;
export const MAX_REDIRECTS = 10;
/** Raw HTML longer than this is sliced before extraction (regex safety). */
export const MAX_EXTRACT_INPUT_CHARS = 5 * 1024 * 1024;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type DirectFetch =
  | {
      kind: "ok";
      status: number;
      statusText: string;
      contentType: string;
      body: string;
      bytes: number;
      url: string;
    }
  | {
      kind: "redirect";
      originalUrl: string;
      redirectUrl: string;
      status: number;
    }
  | { kind: "error"; message: string };

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** CC's rule: same host after stripping a leading "www.", protocol, and port. */
export function isSameHostForRedirect(from: URL, to: URL): boolean {
  const stripWww = (host: string) => host.replace(/^www\./, "");
  const normPort = (u: URL) => {
    if (u.port === "443" && u.protocol === "https:") return "";
    if (u.port === "80" && u.protocol === "http:") return "";
    return u.port;
  };
  return (
    from.protocol === to.protocol &&
    normPort(from) === normPort(to) &&
    stripWww(from.hostname) === stripWww(to.hostname) &&
    !to.username &&
    !to.password
  );
}

export async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; exceeded: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(0), exceeded: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { bytes: new Uint8Array(0), exceeded: true };
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: out, exceeded: false };
}

function detectCharset(contentTypeHeader: string, head: string): string {
  const headerMatch = /charset=["']?([\w-]+)/i.exec(contentTypeHeader);
  if (headerMatch) return headerMatch[1];
  const metaMatch = /charset=["']?([\w-]+)/i.exec(head.slice(0, 2_000));
  return metaMatch?.[1] ?? "utf-8";
}

function decodeBody(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export async function fetchPageDirect(
  startUrl: URL,
  signal: AbortSignal,
  hostValidator?: (
    hostname: string,
  ) => Promise<{ blocked: boolean; detail?: string }>,
): Promise<DirectFetch> {
  let current = startUrl;
  let validatedHost = "";
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Re-check the host on each hop: www-stripping changes the origin, and a
    // same-host redirect may resolve to different addresses (DNS rebinding).
    if (current.hostname !== validatedHost) {
      if (hostValidator) {
        const check = await hostValidator(current.hostname);
        if (check.blocked) {
          return {
            kind: "error",
            message: `Refusing to fetch ${current.hostname} (${check.detail ?? "private address"}) — private and local addresses are blocked.`,
          };
        }
      }
      validatedHost = current.hostname;
    }

    let response: Response;
    try {
      response = await fetch(current, {
        redirect: "manual",
        signal,
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/markdown, text/html, */*",
        },
      });
    } catch (error) {
      if (signal.aborted) {
        return { kind: "error", message: "Fetch cancelled." };
      }
      return {
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      // Don't hold the socket while deciding; the body is never read here.
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      if (!location) {
        return {
          kind: "error",
          message: `HTTP ${response.status} ${response.statusText} with no Location header.`,
        };
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return {
          kind: "error",
          message: `Invalid redirect Location: ${location}`,
        };
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        return {
          kind: "error",
          message: `Refusing redirect to non-http(s) protocol: ${next.protocol}`,
        };
      }
      if (!isSameHostForRedirect(current, next)) {
        return {
          kind: "redirect",
          originalUrl: startUrl.href,
          redirectUrl: next.href,
          status: response.status,
        };
      }
      current = next;
      continue;
    }

    const contentTypeHeader = response.headers.get("content-type") ?? "";
    const contentType = contentTypeHeader.split(";")[0].trim().toLowerCase();

    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_CONTENT_BYTES) {
      return {
        kind: "error",
        message: `Content too large (${formatBytes(contentLength)}; limit is ${formatBytes(MAX_CONTENT_BYTES)}).`,
      };
    }

    let bytes: Uint8Array;
    let exceeded = false;
    try {
      ({ bytes, exceeded } = await readBounded(response, MAX_CONTENT_BYTES));
    } catch (error) {
      if (signal.aborted) {
        return { kind: "error", message: "Fetch cancelled." };
      }
      return {
        kind: "error",
        message: `Connection dropped mid-body: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (exceeded) {
      return {
        kind: "error",
        message: `Content too large (exceeded ${formatBytes(MAX_CONTENT_BYTES)}).`,
      };
    }

    const head = new TextDecoder("utf-8").decode(bytes.subarray(0, 2_000));
    const body = decodeBody(bytes, detectCharset(contentTypeHeader, head));
    return {
      kind: "ok",
      status: response.status,
      statusText: response.statusText,
      contentType,
      body,
      bytes: bytes.byteLength,
      url: current.href,
    };
  }
  return {
    kind: "error",
    message: `Too many redirects (exceeded ${MAX_REDIRECTS}).`,
  };
}
