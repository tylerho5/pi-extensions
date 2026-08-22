/**
 * Which memory prompt a model gets.
 *
 * Claude Code decides this per model, not per feature: models trained on the
 * memory behavior get a short reminder, everything older gets the full scaffold
 * with worked examples. The gate is `TT`/`oug` in the bundled CLI (2.1.220,
 * around byte offset 228.08M), reproduced here.
 */

export type PromptVariant = "full" | "terse";

/** `auto` reproduces Claude Code's per-model choice; the others pin it. */
export type VariantSetting = "auto" | PromptVariant;

/**
 * Models carrying Claude Code's `lean_prompt` capability in its bundled model
 * registry. Opus 4.8 is the oldest release to have it.
 */
const LEAN_PROMPT_MODELS = [
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-fable-5",
  "claude-mythos-5",
] as const;

/** Model families Claude Code hardcodes to the verbose prompt. */
const VERBOSE_FAMILIES = ["claude-3-", "haiku", "sonnet"] as const;

/** Opus releases predating `lean_prompt`, enumerated exactly as Claude Code does. */
const VERBOSE_OPUS = [
  "claude-opus-4-0",
  "claude-opus-4-1",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
] as const;

/**
 * Pi model ids carry a provider prefix and sometimes dotted versions
 * (`openrouter/anthropic/claude-opus-4.8`), so compare on a form where those
 * differences are gone. Claude Code likewise strips its `[1m]` context suffix
 * and folds `.`/`_` to `-`. Matching is by substring for the same reason:
 * Claude Code compares bare ids for equality, pi's are prefixed.
 */
function normalize(modelId: string) {
  return modelId
    .toLowerCase()
    .replace(/\[1m\]/g, "")
    .replace(/[._]/g, "-");
}

/** Early-access ids are lean in Claude Code regardless of family. */
const isEarlyAccess = (modelId: string) => /-eap($|\[)/i.test(modelId);

/**
 * How Claude Code classifies a model. Order follows the original: early-access
 * and `lean_prompt` models are decided before the family checks, which is why
 * Opus 4.8 is lean while Opus 4.7 is not.
 */
export function claudeCodeClassification(modelId: string) {
  if (isEarlyAccess(modelId)) return "lean" as const;

  const id = normalize(modelId);
  if (LEAN_PROMPT_MODELS.some((lean) => id.includes(lean)))
    return "lean" as const;
  if (VERBOSE_FAMILIES.some((family) => id.includes(family))) {
    return "verbose" as const;
  }
  if (VERBOSE_OPUS.some((opus) => id.includes(opus))) return "verbose" as const;
  return "unrecognized" as const;
}

/**
 * Claude Code resolves an unrecognized model by provider, serving the verbose
 * prompt to Bedrock and Vertex deployments and the lean one to its own API. Pi
 * mostly runs models that were never trained on this behavior, so unrecognized
 * means verbose here.
 */
export function wantsVerbosePrompt(modelId: string | undefined) {
  if (!modelId) return true;
  return claudeCodeClassification(modelId) !== "lean";
}

export function resolveVariant(
  modelId: string | undefined,
  setting: VariantSetting,
): PromptVariant {
  if (setting !== "auto") return setting;
  return wantsVerbosePrompt(modelId) ? "full" : "terse";
}
