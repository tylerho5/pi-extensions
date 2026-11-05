/** All model-facing strings for the subagents tools. */

import type { DelegationTier } from "../../shared/subagent-models.ts";
import { formatElapsed, type SubagentSnapshot } from "./domain.ts";
import { formatContextTokens } from "./format.ts";
import { MAX_RUNNING } from "./manager.ts";

/** Describes subagent_spawn, including tiers, the fixed concurrency cap, and the never-block contract. */
export const SUBAGENT_SPAWN_TOOL_DESCRIPTION =
  "Spawn a subagent: a fully autonomous, headless agent with its own context window and pi's normal host permissions. Subagents run on the native pi harness, where agents may delegate to native pi children when the session enables nesting and has remaining depth. Normal tasks pick a tier: fast (bounded mechanical work, focused lookup, low-risk bulk work), standard (normal coding, research, review), or deep (uncertain, cross-cutting, or adversarial work). Agents run in the background by default and results arrive automatically as follow-up messages; set run_in_background to false only when your next action depends on this agent's result and nothing else could usefully happen while it runs — wanting the result next is not enough on its own. After a background spawn you know nothing about its results: never fabricate or predict them, and if the user asks before the result lands, say the agent is still running. The prompt must be self-contained. Only use trusted working directories. Max ${MAX_RUNNING} subagents run across the whole root tree.";

/** Adds background subagent delegation to the parent model's available-tools prompt. */
export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
  "Spawn a subagent on a semantic tier (native pi) for a self-contained task";

export function buildNestingPrompt(options: {
  depth: number;
  maxDepth: number;
  enabled: boolean;
}) {
  if (!options.enabled)
    return `You are at subagent depth ${options.depth}. No live owning manager is available, so do not use subagent tools.`;
  if (options.depth >= options.maxDepth)
    return `You are at subagent depth ${options.depth} of ${options.maxDepth}. You may manage direct children, but you cannot spawn another subagent.`;
  return `You are at subagent depth ${options.depth} of ${options.maxDepth}. You may spawn native pi children up to depth ${options.maxDepth}.`;
}

/** Guides the parent model to delegate standalone tasks on a tier and never hold the turn waiting. */
export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
  "Use subagent_spawn to delegate self-contained tasks that can run in the background; the child cannot see this conversation, so give it a complete, standalone prompt.",
  "Use subagent_spawn with a tier as a preset for model and reasoning_effort: fast, standard, or deep on the native pi harness. Omit tier to get standard.",
  "Explicit model or reasoning_effort fields override the matching part of the tier's preset. The result reports the resolved parameters.",
  "Set subagent_spawn's model or reasoning_effort only when the user explicitly named that model or asked for an override; a tier already carries the user's configured model and effort.",
  "Pick subagent_spawn's tier from the task, not from its size or cost; do not choose a model yourself because a task looks small or cheap.",
  "Give subagent_spawn a short description. Add a name when you may address the agent later: the name becomes its id verbatim, so pass that same string to subagent_send and subagent_cancel. Without a name, use the generated id returned by subagent_spawn.",
  "After subagent_spawn, keep working or end your turn; the result arrives automatically as a follow-up message. If the result is all you need, end your turn rather than polling subagent_list or requesting a progress update. Never fabricate or predict a pending result — if the user asks, say the agent is still running. Use subagent_send for substantive course corrections, not routine progress requests.",
];

/** Model-facing schema descriptions for subagent_spawn task and execution options. */
export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
  description:
    'Short 3-5 word task label shown in the UI and used to name the agent when no name is given, e.g. "fix login bug" (max 200 chars).',
  prompt:
    "Task prompt for the subagent. Must be self-contained: include all needed context, file paths, and what to report back.",
  name: 'Optional addressable name for the spawned agent. It becomes the agent\'s id verbatim: name "fix-login" means subagent_send and every other id-based tool use id "fix-login". Must start with a letter or digit and contain only letters, digits, underscores, or hyphens (max 64 chars); "main", "team-lead", and agent-id shapes are reserved. Omit it when you do not need a stable semantic handle; subagent_spawn then returns a generated id.',
  tier: 'Preset for model and reasoning_effort: "fast", "standard", or "deep". Omit for "standard". Explicit model or reasoning_effort fields override the preset; the result reports the resolved parameters.',
  workingDir:
    "Trusted working directory for the autonomous child (default: current working directory)",
  runInBackground:
    "Agents run in the background by default. Set to false only when your next action depends on this agent's result and nothing else could usefully happen while it runs — wanting the result next is not enough on its own.",
  model:
    'Explicit model override: "provider/model-id" or a bare model id. Only set this when the user explicitly asked for that model; a tier already carries the user\'s configured model and effort.',
  reasoningEffort:
    "Explicit reasoning effort on a shared scale, mapped to pi's thinking level. Only for a user-requested override.",
};

/** The tier, or `explicit` for a caller-named harness/model/effort. */
export function delegationLabel(source: DelegationTier | "explicit") {
  return source === "explicit" ? "explicit" : `tier: ${source}`;
}

/** Builds the subagent_spawn result that tells the parent model the child is running. */
export function buildSubagentSpawnResult(options: {
  id: string;
  description: string;
  tier: DelegationTier | "explicit";
  harness: string;
  modelLabel: string;
  effort: string;
  background?: boolean;
}) {
  const target = `harness="${options.harness}", model="${options.modelLabel}", reasoning_effort="${options.effort}"`;
  const selection =
    options.tier === "explicit"
      ? `explicit target: ${target}`
      : `preset "${options.tier}" → ${target}`;
  const tail =
    options.background === false
      ? "Waited for it; the report follows."
      : "Its result arrives automatically in a later message. In your own words, briefly tell the user what you launched — do not echo this tool result or wait for the agent. If the user asks for progress, say the agent is still running.";
  return `Spawned ${options.id} "${options.description}" (${selection}). ${tail}`;
}

/** One-line model-facing status for subagent_list. */
export function describeSubagent(snap: SubagentSnapshot) {
  const details = [
    snap.meta.tier ? delegationLabel(snap.meta.tier) : "",
    `${snap.backend}: ${snap.meta.modelLabel ?? "?"}`,
    formatContextTokens(snap.usage),
    formatElapsed(snap),
    snap.cwd,
  ].filter(Boolean);
  return `${snap.id} [${snap.status}] "${snap.description}" (${details.join(", ")})`;
}

/** Describes aborting running subagents while retaining their partial transcripts. */
export const SUBAGENT_CANCEL_TOOL_DESCRIPTION =
  "Cancel one or more running subagents. This aborts their active work but preserves their partial session transcripts on disk.";

/** Model-facing schema description for the subagent ids to cancel. */
export const SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to cancel. A supplied name is the id; otherwise use the generated id returned by subagent_spawn, e.g. ["fix-login-bug"].',
};

/**
 * Describes steering a running subagent or resuming a settled one in the
 * current parent session, and the run-sequence acknowledgement returned.
 */
export const SUBAGENT_SEND_TOOL_DESCRIPTION =
  "Steer a running subagent, or resume a settled subagent for another turn in the current parent session (reusing its existing child session). Works only while this session still tracks the agent; a pruned or unknown id fails. Returns the run sequence and whether the agent resumed. A resumed turn counts against the concurrency cap and its result arrives the same way as a spawn.";

/** Model-facing schema descriptions for subagent_send. */
export const SUBAGENT_SEND_PARAMETER_DESCRIPTIONS = {
  id: "Subagent id to steer or resume. A supplied name is the id; otherwise use the generated id returned by subagent_spawn.",
  message:
    "Message to deliver. While the agent runs this is a course correction to the active run; when the agent is settled it starts another turn. The user sees the first line as a one-line preview in the transcript, so make it a self-contained sentence saying what the message is about.",
};

/** Describes finding tracked agents to address. */
export const SUBAGENT_LIST_TOOL_DESCRIPTION =
  "List tracked subagents to find their ids for subagent_send or subagent_cancel. Includes tier, backend, and status; not for polling completion, which arrives automatically as a follow-up message.";
