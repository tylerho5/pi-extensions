import {
  getChildDelegation,
  registerChildDelegation,
  type DelegationIdentity,
} from "../../shared/child-delegation.ts";
import type { SubagentOwner } from "./manager.ts";
import type { SubagentSnapshot } from "./domain.ts";
import type { SubagentRuntime } from "./runtime.ts";
import { createCompletionGate, type CompletionGate } from "./completion.ts";

export interface NativeDelegationBinding {
  readonly identity: DelegationIdentity;
  readonly runtime: SubagentRuntime;
  readonly owner: SubagentOwner;
  readonly completion: CompletionGate;
  dispose(): void;
}

export function serializeAncestry(
  identity: DelegationIdentity,
): DelegationIdentity {
  return {
    rootId: identity.rootId,
    agentId: identity.agentId,
    parentId: identity.parentId,
    depth: identity.depth,
    maxDepth: identity.maxDepth,
  };
}

export function createNativeDelegationBinding(
  identity: DelegationIdentity,
  runtime: SubagentRuntime,
  owner: SubagentOwner,
): NativeDelegationBinding {
  const completion = createCompletionGate();
  const unsubscribeWork = owner.subscribeChildWork((count) =>
    completion.setChildWork(count),
  );
  let disposed = false;
  return {
    identity: serializeAncestry(identity),
    runtime,
    owner,
    completion,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeWork();
      completion.close();
    },
  };
}

export function registerNativeDelegation(
  sessionId: string,
  binding: NativeDelegationBinding,
): () => void {
  const unregister = registerChildDelegation(sessionId, binding);
  return () => {
    unregister();
    binding.dispose();
  };
}

export interface NativeDelegationResolution {
  readonly binding?: NativeDelegationBinding;
  readonly ancestry?: DelegationIdentity;
  readonly unbound: boolean;
}

function isIdentity(value: unknown): value is DelegationIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<DelegationIdentity>;
  return (
    typeof identity.rootId === "string" &&
    typeof identity.agentId === "string" &&
    (identity.parentId === null || typeof identity.parentId === "string") &&
    Number.isSafeInteger(identity.depth) &&
    identity.depth! > 0 &&
    Number.isSafeInteger(identity.maxDepth) &&
    identity.maxDepth! >= identity.depth!
  );
}

export function resolveNativeDelegation(
  sessionId: string,
  branch: readonly unknown[],
): NativeDelegationResolution {
  const binding = getChildDelegation<NativeDelegationBinding>(sessionId);
  let ancestry: DelegationIdentity | undefined;
  for (const entry of branch) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as {
      type?: unknown;
      customType?: unknown;
      data?: unknown;
    };
    if (
      (record.type === "custom" || record.customType === "subagent-ancestry") &&
      record.customType === "subagent-ancestry" &&
      isIdentity(record.data)
    )
      ancestry = serializeAncestry(record.data);
  }
  return { binding, ancestry, unbound: !!ancestry && !binding };
}

export function childDelegationEnabled(identity: DelegationIdentity): boolean {
  return identity.depth < identity.maxDepth;
}

export function isDirectChildOf(
  owner: SubagentOwner,
  snapshot: Pick<SubagentSnapshot, "ancestry">,
): boolean {
  return snapshot.ancestry?.parentId === owner.parentId;
}
