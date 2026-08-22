/**
 * Cross-extension child-agent activity: "is anything still running in this
 * session?" The subagents extension publishes its running count here; the
 * summaries extension subscribes so recaps never land mid-run.
 *
 * Both sides import this leaf module — neither extension imports the other.
 * Sources report integer counts under their own key ("subagents",
 * "workflows", …); `anyRunning()` is true while any source reports > 0.
 */

// Held on `globalThis`, not a module-level variable: pi's extension loader
// creates a fresh jiti instance per extension with `moduleCache: false`, so a
// module singleton would be a different object in each importing extension.
// `globalThis` is process-global, so state survives module duplication.
const KEY = Symbol.for("pi.shared.agent-activity");

interface Store {
  running: Map<string, number>;
  listeners: Set<() => void>;
}

type StoreGlobal = typeof globalThis & { [key: symbol]: Store | undefined };

const g = globalThis as StoreGlobal;
const store: Store = (g[KEY] ??= { running: new Map(), listeners: new Set() });

/** Publish a source's current running count. No-op when unchanged. */
export function reportRunning(source: string, count: number) {
  const previous = store.running.get(source) ?? 0;
  if (count === previous) return;
  if (count > 0) store.running.set(source, count);
  else store.running.delete(source);
  for (const listener of [...store.listeners]) listener();
}

export function anyRunning() {
  return store.running.size > 0;
}

/** Subscribe to count changes from any source. Returns an unsubscribe. */
export function onActivityChange(listener: () => void) {
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

/** Test helper: drop all counts without notifying listeners. */
export function resetActivity() {
  store.running.clear();
}
