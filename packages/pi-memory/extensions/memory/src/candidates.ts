/**
 * Listing memory files for the relevance selector. This mirrors Claude Code's
 * `ofo` (recursive readdir, capped at 200 files) and `ifo` (one cheap line per
 * file, metadata only) from the bundled CLI (2.1.220, ~byte 230.8M).
 *
 * Only frontmatter — name, description, type — plus mtime is shown to the
 * selector. File bodies are never read here; they are read after selection
 * (see `readSelectedBodies`), so listing 200 files stays cheap.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { MEMORY_INDEX_FILENAME } from "./prompt.ts";

/** Claude Code's file cap for a single selector call (`an_`). */
export const MAX_CANDIDATES = 200;

export interface MemoryCandidate {
  /** Path relative to the memory dir, POSIX separators — the selector's key. */
  readonly filename: string;
  /** Absolute path, used to read the body and to label the injected block. */
  readonly path: string;
  readonly type: string | undefined;
  readonly description: string | undefined;
  readonly mtimeMs: number;
}

interface Frontmatter {
  readonly name: string | undefined;
  readonly description: string | undefined;
  readonly type: string | undefined;
}

function stripQuotes(value: string) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    if ((first === '"' || first === "'") && trimmed.endsWith(first)) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Tolerant frontmatter reader: `name`/`description` at the top level, `type`
 * wherever it appears (top level or nested under `metadata:`). Deliberately not
 * a full YAML parser — memory frontmatter is flat and single-line by design,
 * and a bad file should yield empty fields, not throw.
 */
export function parseFrontmatter(raw: string): Frontmatter {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match)
    return { name: undefined, description: undefined, type: undefined };

  let name: string | undefined;
  let description: string | undefined;
  let type: string | undefined;
  for (const line of match[1].split("\n")) {
    const top = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (top) {
      if (top[1] === "name" && !name) name = stripQuotes(top[2]) || undefined;
      else if (top[1] === "description" && !description)
        description = stripQuotes(top[2]) || undefined;
      else if (top[1] === "type" && !type)
        type = stripQuotes(top[2]) || undefined;
      continue;
    }
    // Nested `  type:` under `metadata:` — `node_type:` is intentionally missed.
    const nested = /^\s+type:\s*(.*)$/.exec(line);
    if (nested && !type) type = stripQuotes(nested[1]) || undefined;
  }
  return { name, description, type };
}

async function walk(dir: string, root: string, out: string[], limit: number) {
  if (out.length >= limit) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (out.length >= limit) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, root, out, limit);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      // The index is always in context already; never a recall candidate.
      if (relative(root, full) === MEMORY_INDEX_FILENAME) continue;
      out.push(full);
    }
  }
}

/**
 * Recursively collect memory files, newest first, capped at `limit`. The cap is
 * applied after sorting so an overflowing dir keeps its freshest files rather
 * than whichever the filesystem happened to enumerate first.
 */
export async function listMemoryCandidates(
  dir: string,
  limit = MAX_CANDIDATES,
): Promise<MemoryCandidate[]> {
  const paths: string[] = [];
  await walk(dir, dir, paths, limit * 4);

  const stated = await Promise.all(
    paths.map(async (path) => {
      try {
        const [raw, info] = await Promise.all([
          readFile(path, "utf8"),
          stat(path),
        ]);
        const front = parseFrontmatter(raw);
        return {
          filename: relative(dir, path).split(sep).join("/"),
          path,
          type: front.type,
          description: front.description,
          mtimeMs: info.mtimeMs,
        } satisfies MemoryCandidate;
      } catch {
        return undefined;
      }
    }),
  );

  return stated
    .filter((c): c is MemoryCandidate => c !== undefined)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);
}

/** Claude Code's `ifo` line: `- [type] filename (ISO): description`. */
export function formatCandidateLine(candidate: MemoryCandidate) {
  const type = candidate.type ? `[${candidate.type}] ` : "";
  const when = new Date(candidate.mtimeMs).toISOString();
  const head = `- ${type}${candidate.filename} (${when})`;
  return candidate.description ? `${head}: ${candidate.description}` : head;
}

/** The selector's first user message (`GMu`): `Available memories:\n<list>`. */
export function packageCandidates(candidates: MemoryCandidate[]) {
  return `Available memories:\n${candidates.map(formatCandidateLine).join("\n")}`;
}
