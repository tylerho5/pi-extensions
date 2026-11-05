export interface DelegationIdentity {
  readonly rootId: string;
  readonly agentId: string;
  readonly parentId: string | null;
  readonly depth: number;
  readonly maxDepth: number;
}

const key = Symbol.for("pi.shared.child-delegation");
const global = globalThis as typeof globalThis & { [key]: Map<string, object> };
const bindings = (global[key] ??= new Map<string, object>());

export function registerChildDelegation<T extends object>(
  sessionId: string,
  binding: T,
): () => void {
  if (bindings.has(sessionId))
    throw new Error(
      `Child delegation already registered for session "${sessionId}".`,
    );
  bindings.set(sessionId, binding);
  return () => {
    if (bindings.get(sessionId) === binding) bindings.delete(sessionId);
  };
}

export function getChildDelegation<T extends object>(
  sessionId: string,
): T | undefined {
  return bindings.get(sessionId) as T | undefined;
}
