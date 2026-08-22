/**
 * The per-session recall ledger: which memories were injected and how many
 * bytes. Lives in its own module so the rebuild logic is testable in
 * isolation.
 *
 * The ledger is rebuilt from the session transcript at every session start
 * instead of being cleared. pi fires `session_start` with reason "resume"
 * when a process re-opens an existing session, and "reload"/"fork" when the
 * session continues in-process — in all of those the conversation is NOT
 * rebuilt, so memories surfaced before must stay marked. A brand-new session
 * file simply contains no memory-recall entries yet, so rebuilding yields an
 * empty ledger. The session-manager docs describe exactly this pattern:
 * custom entries persist extension state across reloads, and extensions scan
 * them to reconstruct internal state.
 */

/** Transcript customType of an injected recall message. */
export const RECALL_MESSAGE_TYPE = "memory-recall";

/**
 * Paths a recall transcript entry names: `details.paths` when present (the
 * current format), falling back to the `Memory: <path>:` headers in the
 * rendered content for entries written before details existed. Both are
 * unioned so a partially-populated entry still yields its paths.
 */
export function recalledPathsFromEntry(entry: unknown): string[] {
  const record = entry as { details?: unknown; content?: unknown };
  const paths: string[] = [];
  const details = record?.details as { paths?: unknown } | undefined;
  if (Array.isArray(details?.paths)) {
    for (const path of details.paths) {
      if (typeof path === "string" && !paths.includes(path)) paths.push(path);
    }
  }
  if (typeof record?.content === "string") {
    for (const match of record.content.matchAll(/^Memory: (.+):$/gm)) {
      const path = match[1] ?? "";
      if (path && !paths.includes(path)) paths.push(path);
    }
  }
  return paths;
}

/**
 * Holds the per-session injected set and byte budget. `alreadyInjected` and
 * `sessionBytes` feed the recall candidate filter and budget; `markInjected`
 * records a completed recall; `rebuildFromEntries` reconstructs state from a
 * session transcript so the dedupe survives process restarts and reloads.
 */
export class RecallLedger {
  private injected = new Set<string>();
  private bytes = 0;

  /** Paths already injected this session — the recall candidate filter. */
  get alreadyInjected(): ReadonlySet<string> {
    return this.injected;
  }

  /** Bytes already injected this session — the recall budget. */
  get sessionBytes(): number {
    return this.bytes;
  }

  /** Drop all state. Only correct where the conversation is rebuilt (compaction). */
  reset(): void {
    this.injected.clear();
    this.bytes = 0;
  }

  /** Record a completed recall. */
  markInjected(paths: readonly string[], bytes: number): void {
    for (const path of paths) this.injected.add(path);
    this.bytes += bytes;
  }

  /**
   * Rebuild state from session transcript entries. Every memory-recall
   * message marks its paths as injected and counts its full content bytes —
   * the exact context volume that was injected. That slightly overcounts the
   * body-only accounting of new recalls (the wrapper is included), which only
   * makes the budget more conservative.
   */
  rebuildFromEntries(entries: readonly unknown[]): void {
    this.reset();
    for (const entry of entries) {
      const record = entry as { type?: unknown; customType?: unknown };
      if (
        record?.type !== "custom_message" ||
        record.customType !== RECALL_MESSAGE_TYPE
      ) {
        continue;
      }
      for (const path of recalledPathsFromEntry(entry)) {
        this.injected.add(path);
      }
      const content = (entry as { content?: unknown }).content;
      if (typeof content === "string") {
        this.bytes += Buffer.byteLength(content, "utf8");
      }
    }
  }
}
