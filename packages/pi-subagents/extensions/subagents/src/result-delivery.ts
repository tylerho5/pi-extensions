import type { SubagentRunRef } from "./domain.ts";

/** Stable map key for one run: the agent id alone is not unique across resumes. */
export function runRefKey(ref: SubagentRunRef) {
  return `${ref.id}#${ref.runSequence}`;
}

export function createDeferredResultDelivery<T extends SubagentRunRef>() {
  const pending = new Map<string, T>();

  return {
    defer(result: T) {
      pending.set(runRefKey(result), result);
    },
    consume(refs: Iterable<SubagentRunRef>) {
      for (const ref of refs) pending.delete(runRefKey(ref));
    },
    drain() {
      const results = [...pending.values()];
      pending.clear();
      return results;
    },
    clear() {
      pending.clear();
    },
  };
}
