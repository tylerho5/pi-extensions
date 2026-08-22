/** URL validation, http→https upgrade, and private-address blocking. */

import { lookup } from "node:dns/promises";

export const MAX_URL_LENGTH = 2048;

export type UrlCheck = { url: URL } | { error: string };

export function parseAndValidateUrl(raw: string): UrlCheck {
  if (raw.length > MAX_URL_LENGTH) {
    return { error: `URL exceeds ${MAX_URL_LENGTH} characters.` };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `Invalid URL: ${raw}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      error: `Unsupported protocol "${url.protocol}". Only http and https are supported.`,
    };
  }
  if (url.username || url.password) {
    return { error: "URLs with embedded credentials are not allowed." };
  }
  return { url };
}

export function upgradeToHttps(url: URL): URL {
  if (url.protocol !== "http:") return url;
  const upgraded = new URL(url);
  upgraded.protocol = "https:";
  if (upgraded.port === "80") upgraded.port = "";
  return upgraded;
}

export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** Expand an IPv6 address to 8 16-bit groups; null when unparseable. */
export function expandIpv6(ip: string): number[] | null {
  const bare = ip.toLowerCase().replace(/%.*$/, "");
  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (part: string) =>
    part === "" ? [] : part.split(":").map((g) => parseInt(g, 16));
  const left = parseHalf(halves[0]);
  const right = halves.length === 2 ? parseHalf(halves[1]) : [];
  if (left.some((g) => Number.isNaN(g)) || right.some((g) => Number.isNaN(g))) {
    return null;
  }
  const total = left.length + right.length;
  if (total > (halves.length === 2 ? 7 : 8)) return null;
  const zeros = 8 - total;
  return [...left, ...Array(zeros).fill(0), ...right];
}

/** Dotted-quad IPv4 from the last two groups of a mapped/compatible address. */
function ipv4FromGroups(g6: number, g7: number): string {
  return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
}

export function isPrivateIpv6(ip: string): boolean {
  // Dotted-tail forms (as typed, pre-URL-normalization) go straight to IPv4.
  const dotted = /::(ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(
    ip.toLowerCase(),
  );
  if (dotted) return isPrivateIpv4(dotted[2]);
  const groups = expandIpv6(ip);
  if (!groups) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (groups.every((g, index) => g === (index === 7 ? 1 : 0))) return true; // ::1
  if (groups.every((g) => g === 0)) return true; // ::
  if ((g0 & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0) {
    // v4-mapped (::ffff:a.b.c.d), v4-compatible (::a.b.c.d),
    // and 96-bit embedded (RFC 6052-ish) forms carry an IPv4 in the tail.
    const tailIsV4 =
      (g4 === 0 && g5 === 0) || (g4 === 0 && g5 === 0xffff) || g4 === 0xffff;
    if (tailIsV4) return isPrivateIpv4(ipv4FromGroups(g6, g7));
  }
  return false;
}

export type PrivacyCheck = { blocked: boolean; detail?: string };

/** Best-effort SSRF guard: block hosts that resolve exclusively to private ranges. */
export async function resolvesToPrivate(
  hostname: string,
): Promise<PrivacyCheck> {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { blocked: true, detail: "localhost" };
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    return isPrivateIpv4(hostname)
      ? { blocked: true, detail: hostname }
      : { blocked: false };
  }
  // WHATWG hostname keeps brackets on IPv6 literals, e.g. "[::ffff:7f00:1]".
  if (hostname.startsWith("[") || hostname.includes(":")) {
    const bare = hostname.replace(/^\[|\]$/g, "");
    return isPrivateIpv6(bare)
      ? { blocked: true, detail: hostname }
      : { blocked: false };
  }
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    return { blocked: false }; // let the fetch fail with its own DNS error
  }
  if (addresses.length === 0) return { blocked: false };
  const privates = addresses.filter((a) =>
    a.family === 6 ? isPrivateIpv6(a.address) : isPrivateIpv4(a.address),
  );
  // Any private record is enough to block: mixed public/private DNS lets an
  // attacker hope the resolver picks the private one.
  if (privates.length > 0) {
    return {
      blocked: true,
      detail: privates.map((a) => a.address).join(", "),
    };
  }
  return { blocked: false };
}
