/**
 * Cross-extension child-agent cost accumulator: "how much have agents
 * spawned from this session cost?" The subagents backends (pi and claude)
 * and the workflow runner publish per-message/run costs here; the
 * expanded-footer reads the total to show it next to the main session cost.
 *
 * Both sides import this leaf module — neither extension imports the other.
 * Sources report USD deltas under their own key ("subagents", "workflows");
 * `childCostTotal()` is the sum across sources. State resets on session
 * start (the footer calls `resetChildCost()`), matching the session-scoped
 * main cost it sits next to.
 */

// Held on `globalThis`, not a module-level variable: pi's extension loader
// creates a fresh jiti instance per extension with `moduleCache: false`, so a
// module singleton would be a different object in each importing extension.
// `globalThis` is process-global, so state survives module duplication.
const KEY = Symbol.for("pi.shared.child-cost");

interface Store {
  cost: Map<string, number>;
}

type StoreGlobal = typeof globalThis & { [key: symbol]: Store | undefined };

const g = globalThis as StoreGlobal;
const store: Store = (g[KEY] ??= { cost: new Map() });

/** Add a USD cost delta for a source. Non-finite and non-positive deltas are ignored. */
export function addChildCost(source: string, usd: number) {
  if (!Number.isFinite(usd) || usd <= 0) return;
  store.cost.set(source, (store.cost.get(source) ?? 0) + usd);
}

/** Total accumulated child cost in USD across all sources. */
export function childCostTotal() {
  let total = 0;
  for (const usd of store.cost.values()) total += usd;
  return total;
}

/** Drop all accumulated cost, e.g. when a new session starts. */
export function resetChildCost() {
  store.cost.clear();
}
