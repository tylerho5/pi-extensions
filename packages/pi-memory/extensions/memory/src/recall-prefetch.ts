/**
 * Holds the one in-flight recall prefetch for a session. Claude Code starts
 * the selector eagerly at the start of a turn and consumes the settled result
 * at the next attachment point, aborting it if the run ends first (`K2r` and
 * `X2r` in the 2.1.290 CLI). This class mirrors that: `start` launches without
 * awaiting, `take` removes a settled result once, and `abort` drops an
 * unconsumed one. A new start supersedes the previous prefetch.
 *
 * `hasLaterRequest` is the attach gate: a result is only consumed when the run
 * will issue another request, so a recall that settles after the final
 * response is dropped rather than deferred to the next user prompt.
 */

import type { RecallResult } from "./recall.ts";

export type RecallPrefetchRun = (
  signal: AbortSignal,
) => Promise<RecallResult | undefined>;

/** The boundary fields that decide whether another request will be issued. */
export interface BoundaryEventLike {
  readonly toolResults: readonly unknown[];
  readonly context: { readonly pendingMessages: readonly unknown[] };
}

/**
 * Whether the run continues after this turn. A tool result means the loop will
 * request again to feed the result back, and a queued steering or follow-up
 * message keeps the loop alive. Claude Code's prefetch is consumed on exactly
 * these continuations.
 */
export function hasLaterRequest(event: BoundaryEventLike): boolean {
  return (
    event.toolResults.length > 0 || event.context.pendingMessages.length > 0
  );
}

export class RecallPrefetch {
  private current:
    | {
        controller: AbortController;
        settled: boolean;
        result: RecallResult | undefined;
      }
    | undefined;

  start(run: RecallPrefetchRun): void {
    this.abort();
    const controller = new AbortController();
    const entry = {
      controller,
      settled: false,
      result: undefined as RecallResult | undefined,
    };
    this.current = entry;
    void run(controller.signal).then(
      (result) => {
        entry.settled = true;
        entry.result = result;
      },
      () => {
        entry.settled = true;
        entry.result = undefined;
      },
    );
  }

  /**
   * The settled result, consumed once. Returns undefined while the prefetch is
   * still pending, when it settled with nothing, and after a previous take.
   */
  take(): RecallResult | undefined {
    const entry = this.current;
    if (!entry || !entry.settled) return undefined;
    this.current = undefined;
    return entry.result;
  }

  /** Drop a pending or settled prefetch without consuming it. */
  abort(): void {
    const entry = this.current;
    if (!entry) return;
    this.current = undefined;
    entry.controller.abort();
  }
}
