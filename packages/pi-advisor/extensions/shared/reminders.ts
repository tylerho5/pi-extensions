/**
 * System-reminder registry — shared leaf module.
 *
 * Extensions register reminder generators here; the reminders extension
 * (extensions/reminders/) runs them before every LLM call and injects the
 * resulting text as a `<system-reminder>` user message (Claude Code's
 * attachment-pipeline semantics: per-request, delta-based, cache-preserving —
 * the reminder is appended after the cached prefix, never part of the system
 * prompt).
 *
 * This module is intentionally import-free so any extension or package can
 * use it without pulling in pi's extension API.
 */

export interface ReminderGenerator {
  /** Stable id; registering twice with the same id replaces the previous generator. */
  id: string;
  /**
   * Return reminder text to inject for this request, or null for nothing.
   * `force` is true when the generator's `interval` has elapsed — standing
   * reminders should return their text when forced; delta generators may
   * ignore it and keep returning null.
   */
  compute(force: boolean): string | null;
  /** Re-run compute(force=true) every N LLM calls, even when it returned null. */
  interval?: number;
  /** Called on session start so per-conversation state (announced names) resets. */
  reset?(): void;
}

// Held on `globalThis`, not a module-level variable: pi's extension loader
// creates a fresh jiti instance per extension with `moduleCache: false`, so a
// module singleton would be a different object in each importing extension.
// `globalThis` is process-global, so registrations survive module duplication.
const GENERATORS_KEY = Symbol.for("pi.shared.reminders.generators");

type GeneratorsGlobal = typeof globalThis & {
  [key: symbol]: Map<string, ReminderGenerator> | undefined;
};

const g = globalThis as GeneratorsGlobal;
const generators = (g[GENERATORS_KEY] ??= new Map<string, ReminderGenerator>());

export function registerReminderGenerator(generator: ReminderGenerator): void {
  generators.set(generator.id, generator);
}

export function unregisterReminderGenerator(id: string): boolean {
  return generators.delete(id);
}

export function getReminderGenerators(): readonly ReminderGenerator[] {
  return [...generators.values()];
}

export function resetReminderGenerators(): void {
  for (const generator of generators.values()) generator.reset?.();
}

export interface AnnouncedDeltaOptions {
  id: string;
  /** Current names — the pool membership the generator tracks. */
  getCurrent: () => readonly string[];
  /**
   * Names already listed in the standing prompt (e.g. a tool description).
   * Seeded into the announced set without announcing, so only post-baseline
   * changes are reminded. Re-evaluated on reset (session start).
   */
  getBaseline?: () => readonly string[];
  renderAdded: (names: readonly string[]) => string;
  renderRemoved: (names: readonly string[]) => string;
}

/**
 * Delta generator with announced-name tracking (Claude Code's
 * `deferred_tools_delta` semantics): announces names that entered the pool
 * since the last call, names that left it, and stays silent otherwise.
 */
export function createAnnouncedDelta(
  options: AnnouncedDeltaOptions,
): ReminderGenerator {
  let announced = new Set<string>();

  const seed = () => {
    announced = new Set(options.getBaseline?.() ?? []);
  };
  seed();

  return {
    id: options.id,
    compute(force) {
      if (force) return null;
      const current = new Set(options.getCurrent());
      const added = [...current].filter((name) => !announced.has(name));
      const removed = [...announced].filter((name) => !current.has(name));
      if (added.length === 0 && removed.length === 0) return null;
      const parts: string[] = [];
      if (added.length > 0) parts.push(options.renderAdded(added));
      if (removed.length > 0) parts.push(options.renderRemoved(removed));
      announced = current;
      return parts.join("\n");
    },
    reset() {
      seed();
    },
  };
}
