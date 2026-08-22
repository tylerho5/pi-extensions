/**
 * The dream trigger gates, in order. Adapted from Claude Code 2.1.220, dropping
 * its kairos and remote gates as inapplicable and substituting pi's mode check:
 *
 *   1. interactive TUI only (suppresses the child session's own copy)
 *   2. memory extension enabled
 *   3. not paused for this session
 *   4. memory.dream.enabled — automatic dreaming toggle
 *   5. >= minHours since the last consolidation
 *   6. last scan > 10 min ago (per-process throttle)
 *   7. >= minSessions main sessions touched, excluding the current one
 *   8. lock acquired
 *
 * `memory.dream.enabled` gates automatic (idle-triggered) dreaming only. A
 * manual `/dream` invocation (`manual: true`) bypasses gates 4–7 — the toggle,
 * the time window, the scan throttle, and the session count — but still
 * respects 1–3 (TUI mode, memory enabled, paused) and 8 (the lock), since those
 * are safety/consistency properties, not scheduling.
 *
 * Every non-firing outcome carries a reason, and `onSkip` reports each so a
 * dream suppressed by its own time window is visible at debug level — Claude
 * Code instruments only gates 7 and 8. Gates 1–4 are pure and short-circuit
 * before any filesystem call; the fs seams are injectable for testing.
 */

import { acquireLock, readLastConsolidatedAt } from "./lock.ts";
import { sessionsTouchedSince, type SessionRef } from "./sessions.ts";

export const SCAN_THROTTLE_MS = 600_000;
export const HOUR_MS = 3_600_000;

export type GateOutcome =
  | { fire: true; sessions: SessionRef[]; priorMtime: number }
  | { fire: false; reason: string };

export interface GateDeps {
  readLastConsolidatedAt: (memoryDir: string) => Promise<number>;
  sessionsTouchedSince: (
    cwd: string,
    since: number,
    excludeIds: readonly string[],
    agentDir?: string,
  ) => Promise<SessionRef[]>;
  acquireLock: (memoryDir: string) => Promise<number | null>;
}

const DEFAULT_GATE_DEPS: GateDeps = {
  readLastConsolidatedAt,
  sessionsTouchedSince,
  acquireLock,
};

export interface GateInputs {
  mode: string;
  memoryEnabled: boolean;
  paused: boolean;
  dreamEnabled: boolean;
  minHours: number;
  minSessions: number;
  cwd: string;
  memoryDir: string;
  agentDir?: string;
  currentSessionId?: string;
  now: number;
  lastScanAt: number;
  /** `/dream` bypasses the auto-dream toggle, time window, scan throttle, and session count (4–7). */
  manual?: boolean;
  deps?: Partial<GateDeps>;
  onSkip?: (gate: number, reason: string) => void;
}

export async function evaluateGates(inputs: GateInputs): Promise<GateOutcome> {
  const deps = { ...DEFAULT_GATE_DEPS, ...inputs.deps };
  const block = (gate: number, reason: string): GateOutcome => {
    inputs.onSkip?.(gate, reason);
    return { fire: false, reason };
  };

  if (inputs.mode !== "tui") {
    return block(1, `not the interactive TUI (mode: ${inputs.mode})`);
  }
  if (!inputs.memoryEnabled) return block(2, "memory extension is disabled");
  if (inputs.paused) return block(3, "memory is paused for this session");
  if (!inputs.manual && !inputs.dreamEnabled) {
    return block(4, "memory.dream.enabled is false");
  }

  // --- filesystem access begins here ---
  const lastConsolidatedAt = await deps.readLastConsolidatedAt(
    inputs.memoryDir,
  );

  if (!inputs.manual) {
    const elapsed = inputs.now - lastConsolidatedAt;
    if (elapsed < inputs.minHours * HOUR_MS) {
      return block(
        5,
        `last consolidation was ${Math.round(elapsed / HOUR_MS)}h ago (need ${inputs.minHours}h)`,
      );
    }
    if (inputs.now - inputs.lastScanAt < SCAN_THROTTLE_MS) {
      return block(6, "scanned within the last 10 minutes");
    }
  }

  const excludeIds = inputs.currentSessionId ? [inputs.currentSessionId] : [];
  const sessions = await deps.sessionsTouchedSince(
    inputs.cwd,
    lastConsolidatedAt,
    excludeIds,
    inputs.agentDir,
  );

  if (!inputs.manual) {
    const mains = sessions.filter((session) => session.kind === "main");
    if (mains.length < inputs.minSessions) {
      return block(
        7,
        `${mains.length} main session(s) since last consolidation (need ${inputs.minSessions})`,
      );
    }
  }

  const priorMtime = await deps.acquireLock(inputs.memoryDir);
  if (priorMtime === null) {
    return block(8, "another process holds the consolidation lock");
  }

  return { fire: true, sessions, priorMtime };
}
