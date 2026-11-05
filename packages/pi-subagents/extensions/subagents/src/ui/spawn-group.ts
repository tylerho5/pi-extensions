import type { DelegationTier } from "../../../shared/subagent-models.ts";

export interface SpawnCallArgs {
  description?: string;
  name?: string;
  tier?: DelegationTier;
  harness?: string;
  [key: string]: unknown;
}

export interface SpawnDetails {
  id: string;
  description: string;
  cwd: string;
  harness: string;
  tier: DelegationTier | "explicit";
  model: string | undefined;
  effort: string;
}

export interface SpawnBatchCall {
  /** User-message id shared by spawns in one assistant response cycle. */
  responseCycleId: string;
  toolCallId: string;
  toolName: string;
  args: SpawnCallArgs;
}

export interface SpawnResult {
  details?: SpawnDetails;
  isError: boolean;
  message?: string;
}

export interface SpawnGroupMember {
  toolCallId: string;
  args: SpawnCallArgs;
  result?: SpawnResult;
}

export type SpawnGroupView =
  | { kind: "single"; members: SpawnGroupMember[] }
  | { kind: "first"; members: SpawnGroupMember[] }
  | { kind: "sibling"; members: SpawnGroupMember[] };

export interface SpawnGroupCoordinator {
  recordAssistantBatch(calls: readonly SpawnBatchCall[]): void;
  registerRow(toolCallId: string, invalidate: () => void): void;
  recordResult(toolCallId: string, result: SpawnResult): void;
  viewFor(toolCallId: string): SpawnGroupView;
  reset(): void;
}

interface StoredCall extends SpawnBatchCall {
  result?: SpawnResult;
}

/** Value equality for results that renderers rebuild on every pass. */
function sameResult(
  stored: SpawnResult | undefined,
  next: SpawnResult,
): boolean {
  if (!stored) return false;
  if (stored.isError !== next.isError || stored.message !== next.message)
    return false;
  const a = stored.details;
  const b = next.details;
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.description === b.description &&
    a.cwd === b.cwd &&
    a.harness === b.harness &&
    a.tier === b.tier &&
    a.model === b.model &&
    a.effort === b.effort
  );
}

/** Tracks spawn calls by their parent user-message identity. */
export function createSpawnGroupCoordinator(): SpawnGroupCoordinator {
  const calls = new Map<string, StoredCall>();
  const invalidators = new Map<string, () => void>();
  const batches = new Map<string, string[]>();
  const keyOf = (call: SpawnBatchCall) =>
    `${call.responseCycleId}\0${call.toolName}`;

  const coordinator: SpawnGroupCoordinator = {
    recordAssistantBatch(batch) {
      const changed: string[] = [];
      for (const call of batch) {
        if (call.toolName !== "subagent_spawn") continue;
        const previous = calls.get(call.toolCallId);
        if (
          previous &&
          (previous.responseCycleId !== call.responseCycleId ||
            previous.toolName !== call.toolName)
        )
          continue;
        if (!previous) changed.push(call.toolCallId);
        calls.set(call.toolCallId, { ...call, result: previous?.result });
        const key = keyOf(call);
        const ids = batches.get(key) ?? [];
        if (!ids.includes(call.toolCallId)) ids.push(call.toolCallId);
        batches.set(key, ids);
      }
      const affected = new Set<string>();
      for (const id of changed) {
        const item = calls.get(id);
        if (!item) continue;
        const siblings = batches.get(keyOf(item)) ?? [];
        if (siblings.length < 2) continue;
        for (const sibling of siblings) affected.add(sibling);
      }
      for (const id of affected) invalidators.get(id)?.();
    },
    registerRow(toolCallId, invalidate) {
      invalidators.set(toolCallId, invalidate);
    },
    recordResult(toolCallId, result) {
      const call = calls.get(toolCallId);
      if (!call) return;
      if (sameResult(call.result, result)) return;
      call.result = result;
      const siblings = batches.get(keyOf(call)) ?? [];
      if (siblings.length < 2) return;
      for (const id of siblings) invalidators.get(id)?.();
    },
    viewFor(toolCallId) {
      const call = calls.get(toolCallId);
      if (!call) return { kind: "single", members: [] };
      const ids = batches.get(keyOf(call)) ?? [toolCallId];
      const members = ids.map((id) => {
        const member = calls.get(id)!;
        return {
          toolCallId: member.toolCallId,
          args: member.args,
          ...(member.result === undefined ? {} : { result: member.result }),
        };
      });
      if (members.length < 2) return { kind: "single", members };
      return {
        kind: ids[0] === toolCallId ? "first" : "sibling",
        members,
      };
    },
    reset() {
      calls.clear();
      batches.clear();
      invalidators.clear();
    },
  };
  return coordinator;
}
