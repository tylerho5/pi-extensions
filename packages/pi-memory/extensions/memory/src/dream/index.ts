/**
 * Orchestrates one dream: evaluate the gates, run the confined child session,
 * and handle the lock by outcome. `maybeDream` is the idle-triggered path, gated
 * on `memory.dream.enabled` (the automatic-dreaming toggle). `runDreamNow` is
 * `/dream` — manual invocation always works regardless of that toggle, bypassing
 * it along with the time window, scan throttle, and session count (gates 4–7),
 * but it still takes the lock.
 *
 * Lock handling by status: `"failed"` rolls the lock back so a config fix lets
 * the next idle dream retry; `"aborted"` (user cancel, shutdown, or cap trip)
 * and `"completed"` keep it, so a half-dream consumes the 24h window and the
 * next dream repairs leftovers rather than retry-looping its spend.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { memoryDir } from "../paths.ts";
import { loadMemorySettings } from "../settings.ts";
import { evaluateGates } from "./gate.ts";
import { rollbackLock } from "./lock.ts";
import { runDream, type DreamResult } from "./run.ts";

export interface DreamRunState {
  paused: boolean;
  lastScanAt: number;
  signal: AbortSignal;
  now?: number;
  agentDir?: string;
  onProgress?: (p: { turn: number; maxTurns: number; costUsd: number }) => void;
  onSkip?: (gate: number, reason: string) => void;
  deps?: Partial<OrchestrateDeps>;
}

export interface DreamOutcome {
  fired: boolean;
  reason?: string;
  result?: DreamResult;
}

export interface OrchestrateDeps {
  evaluateGates: typeof evaluateGates;
  runDream: typeof runDream;
  rollbackLock: (memoryDir: string, priorMtime: number) => Promise<void>;
}

const DEFAULT_ORCHESTRATE_DEPS: OrchestrateDeps = {
  evaluateGates,
  runDream,
  rollbackLock,
};

function currentSessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId();
  } catch {
    return undefined;
  }
}

async function orchestrate(
  ctx: ExtensionContext,
  state: DreamRunState,
  manual: boolean,
): Promise<DreamOutcome> {
  const deps = { ...DEFAULT_ORCHESTRATE_DEPS, ...state.deps };
  const settings = loadMemorySettings(ctx.cwd);
  const dir = memoryDir(ctx.cwd, state.agentDir);
  const now = state.now ?? Date.now();

  const gate = await deps.evaluateGates({
    mode: ctx.mode,
    memoryEnabled: settings.enabled,
    paused: state.paused,
    dreamEnabled: settings.dream.enabled,
    minHours: settings.dream.minHours,
    minSessions: settings.dream.minSessions,
    cwd: ctx.cwd,
    memoryDir: dir,
    agentDir: state.agentDir,
    currentSessionId: currentSessionId(ctx),
    now,
    lastScanAt: state.lastScanAt,
    manual,
    onSkip: state.onSkip,
  });

  if (!gate.fire) return { fired: false, reason: gate.reason };

  const result = await deps.runDream({
    cwd: ctx.cwd,
    memoryDir: dir,
    sessions: gate.sessions,
    settings: settings.dream,
    modelRegistry: ctx.modelRegistry,
    projectTrusted: ctx.isProjectTrusted(),
    signal: state.signal,
    onProgress: state.onProgress,
  });

  if (result.status === "failed") {
    await deps.rollbackLock(dir, gate.priorMtime);
  }

  return { fired: true, result };
}

export function maybeDream(
  ctx: ExtensionContext,
  state: DreamRunState,
): Promise<DreamOutcome> {
  return orchestrate(ctx, state, false);
}

export function runDreamNow(
  ctx: ExtensionContext,
  state: DreamRunState,
): Promise<DreamOutcome> {
  return orchestrate(ctx, state, true);
}
