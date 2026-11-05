/**
 * The two decisions a checkpoint run turns on, kept as pure functions so the event
 * wiring only carries out what they say.
 *
 * One snapshot per run, not per assistant turn. A retry, an overflow recovery, or a
 * queued follow-up re-enters through `agent.continue` and fires `agent_start` again;
 * those runs have no new user message, so they reuse the record already held for the
 * last user message instead of taking a second snapshot and leaving the first
 * unreferenced.
 */

import type { Checkpoint } from "./store.ts";

export interface RunInput {
  /** Whether a run is under way at all (armed on agent_start). */
  armed: boolean;
  /** Whether the run came from a prompt (before_agent_start fired), as opposed to a
   * retry, an overflow recovery, or a queued follow-up through agent.continue. */
  prompted: boolean;
  /** The settings and environment knobs say snapshotting is off. */
  disabled: boolean;
  /** Queued messages make this a new turn that needs its own checkpoint. */
  hasPendingMessages: boolean;
  /** The record already held for the last user message, if any. */
  recordedForLast: Checkpoint | undefined;
}

export type RunDecision =
  { kind: "none" } | { kind: "reuse"; ref: string } | { kind: "snapshot" };

export function decideRun(input: RunInput): RunDecision {
  if (input.disabled || !input.armed) return { kind: "none" };
  if (input.prompted || input.hasPendingMessages) return { kind: "snapshot" };
  if (input.recordedForLast !== undefined) {
    return { kind: "reuse", ref: input.recordedForLast.ref };
  }
  return { kind: "snapshot" };
}

export type TurnEndDecision =
  { kind: "none" } | { kind: "discard"; ref: string } | { kind: "record" };

/** What to do with the run's snapshot once the turn ends. A re-run's snapshot is
 * discarded in favour of the record that user message already has, and later baselines
 * keep folding into that record: the `ref` a discard carries is the recorded
 * checkpoint's, not the discarded snapshot's, because a baseline folded into a ref no
 * record names is stranded. */
export function decideTurnEnd(input: {
  pendingRef: string | undefined;
  recordedForLast: Checkpoint | undefined;
}): TurnEndDecision {
  if (input.pendingRef === undefined) return { kind: "none" };
  if (input.recordedForLast !== undefined) {
    return { kind: "discard", ref: input.recordedForLast.ref };
  }
  return { kind: "record" };
}
