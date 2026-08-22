/**
 * Model-name portability for workflows authored for Claude Code.
 *
 * CC scripts select models with aliases ("haiku", "sonnet", "opus", "fable")
 * that don't exist in pi's model registry. The `modelAliases` map in
 * workflows.json gives those names pi targets, consulted only after exact
 * registry resolution fails — pi scripts passing real ids are unaffected.
 * Alias-resolved models skip the cost ceiling: like configured defaults, they
 * are user intent.
 */

/** CC's model-alias vocabulary. Unmapped known aliases fall back to the
 * configured subagent default rather than failing. */
export const CC_MODEL_ALIASES = ["haiku", "sonnet", "opus", "fable"] as const;

export interface ModelLookup<M> {
  find(provider: string, id: string): M | undefined;
  getAll(): M[];
}

export type ModelOptionResolution<M> =
  | { kind: "exact"; model: M }
  | { kind: "alias"; model: M; alias: string }
  | { kind: "default"; alias: string }
  | { kind: "unknown"; brokenAliasTarget?: string };

function findByRef<M extends { id: string }>(
  lookup: ModelLookup<M>,
  ref: string,
): M | undefined {
  const slash = ref.indexOf("/");
  if (slash > 0) {
    const found = lookup.find(ref.slice(0, slash), ref.slice(slash + 1));
    if (found) return found;
  }
  return lookup.getAll().find((m) => m.id === ref);
}

export function resolveModelOption<M extends { id: string }>(
  lookup: ModelLookup<M>,
  model: string,
  provider: string | undefined,
  aliases: Record<string, string>,
): ModelOptionResolution<M> {
  if (provider) {
    const found = lookup.find(provider, model);
    return found ? { kind: "exact", model: found } : { kind: "unknown" };
  }
  const exact = findByRef(lookup, model);
  if (exact) return { kind: "exact", model: exact };

  const target = aliases[model] ?? aliases[model.toLowerCase()];
  if (target) {
    const aliased = findByRef(lookup, target);
    return aliased
      ? { kind: "alias", model: aliased, alias: model }
      : { kind: "unknown", brokenAliasTarget: target };
  }
  if ((CC_MODEL_ALIASES as readonly string[]).includes(model.toLowerCase())) {
    return { kind: "default", alias: model };
  }
  return { kind: "unknown" };
}
