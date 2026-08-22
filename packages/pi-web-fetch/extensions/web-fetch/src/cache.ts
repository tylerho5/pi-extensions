/**
 * Small in-memory cache for fetched pages (Claude Code caches WebFetch
 * results for 15 minutes per URL). Keyed on a normalized URL — hash and
 * default ports stripped — which fixes CC's pre-normalization key bug.
 * Caches extracted markdown, not apply-model answers (prompts differ).
 */

export const CACHE_TTL_MS = 15 * 60_000;
export const CACHE_MAX_ENTRIES = 32;

export interface CachedPage {
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly via: "direct" | "jina";
  readonly markdown: string;
  readonly fetchedAt: number;
}

export function cacheKeyFor(url: URL): string {
  const normalized = new URL(url);
  normalized.hash = "";
  if (normalized.protocol === "https:" && normalized.port === "443") {
    normalized.port = "";
  }
  if (normalized.protocol === "http:" && normalized.port === "80") {
    normalized.port = "";
  }
  return normalized.href;
}

interface Entry {
  readonly expiresAt: number;
  readonly page: CachedPage;
}

class TtlCache {
  private entries = new Map<string, Entry>();

  get(key: string): CachedPage | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh recency so the eviction order is LRU-ish.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.page;
  }

  set(key: string, page: CachedPage, ttlMs: number = CACHE_TTL_MS): void {
    if (this.entries.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { page, expiresAt: Date.now() + ttlMs });
  }
}

export const fetchCache = new TtlCache();
