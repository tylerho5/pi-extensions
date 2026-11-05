import type { SubagentRunRef } from "./domain.ts";
import type { DeliveryReservation } from "./completion.ts";

/** Stable map key for one run: the agent id alone is not unique across resumes. */
export function runRefKey(ref: SubagentRunRef) {
  return `${ref.id}#${ref.runSequence}`;
}

export function acknowledgeDeliveredResult(
  delivery: { consume(refs: Iterable<SubagentRunRef>): void },
  message: unknown,
): boolean {
  if (!message || typeof message !== "object") return false;
  const candidate = message as {
    role?: unknown;
    customType?: unknown;
    details?: { id?: unknown; runSequence?: unknown };
  };
  if (candidate.role !== "custom" || candidate.customType !== "subagent-result")
    return false;
  const { id, runSequence } = candidate.details ?? {};
  if (
    typeof id !== "string" ||
    !Number.isSafeInteger(runSequence) ||
    (runSequence as number) < 1
  )
    return false;
  delivery.consume([{ id, runSequence: runSequence as number }]);
  return true;
}

export function createDeferredResultDelivery<T extends SubagentRunRef>(
  reserve?: (result: T) => DeliveryReservation | undefined,
) {
  const pending = new Map<string, T>();
  /** Drained but not yet sent (the digest is still computing). */
  const inFlight = new Set<string>();
  const reservations = new Map<string, DeliveryReservation>();

  return {
    defer(result: T) {
      const key = runRefKey(result);
      if (!pending.has(key) && !reservations.has(key)) {
        const reservation = reserve?.(result);
        if (reservation) reservations.set(key, reservation);
      }
      pending.set(key, result);
    },
    consume(refs: Iterable<SubagentRunRef>) {
      for (const ref of refs) {
        const key = runRefKey(ref);
        pending.delete(key);
        inFlight.delete(key);
        reservations.get(key)?.consumed();
        reservations.delete(key);
      }
    },
    /** True while a drained result may still be sent: no tool consumed it since. */
    isInFlight(ref: SubagentRunRef) {
      return inFlight.has(runRefKey(ref));
    },
    scheduled(ref: SubagentRunRef) {
      inFlight.delete(runRefKey(ref));
      reservations.get(runRefKey(ref))?.scheduled();
    },
    fail(ref: SubagentRunRef) {
      const key = runRefKey(ref);
      reservations.get(key)?.fail();
      reservations.delete(key);
      pending.delete(key);
      inFlight.delete(key);
    },
    drain() {
      const results = [...pending.values()];
      for (const key of pending.keys()) inFlight.add(key);
      pending.clear();
      return results;
    },
    clear() {
      for (const reservation of reservations.values()) reservation.fail();
      reservations.clear();
      pending.clear();
      inFlight.clear();
    },
  };
}
