/** All model-facing strings for the subagents tools. */

import type { DelegationTier } from "../../shared/subagent-models.ts";
import { formatElapsed, type SubagentSnapshot } from "./domain.ts";
import { formatContextUtilization } from "./format.ts";
import { MAX_RUNNING } from "./manager.ts";

/** Describes subagent_spawn, including tiers, the fixed concurrency cap, and the never-block contract. */
export const SUBAGENT_SPAWN_TOOL_DESCRIPTION =
  "Spawn a subagent: a fully autonomous, headless agent with its own context window and the selected harness's normal host permissions. Native pi is the primary route; the `claude` tier runs on the secondary Claude Code harness. Normal tasks pick a tier: fast (bounded mechanical work, focused lookup, low-risk bulk work), standard (normal coding, research, review), deep (uncertain, cross-cutting, or adversarial work), or claude. Agents run in the background by default and results arrive automatically as follow-up messages; set run_in_background to false only when your next action depends on this agent's result and nothing else could usefully happen while it runs — wanting the result next is not enough on its own. After a background spawn you know nothing about its results: never fabricate or predict them, and if the user asks before the result lands, say the agent is still running. Children cannot orchestrate more agents/workflows or ask the user, and cannot see this conversation, so the prompt must be self-contained. Only use trusted working directories. Max ${MAX_RUNNING} subagents can be running at once across all harnesses.";

/** Adds background subagent delegation to the parent model's available-tools prompt. */
export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
  "Spawn a subagent on a semantic tier (native pi is primary; claude is the secondary harness) for a self-contained task";

/** Guides the parent model to delegate standalone tasks on a tier and never hold the turn waiting. */
export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
  "Use subagent_spawn to delegate self-contained tasks that can run in the background; the child cannot see this conversation, so give it a complete, standalone prompt.",
  "Use subagent_spawn with a tier for normal work: fast, standard, or deep on the native pi harness, or claude for the secondary Claude Code harness. Omit tier to get standard.",
  "Set subagent_spawn's harness, model, or reasoning_effort only when the user explicitly named that model or asked for an override; a tier already carries the user's configured model and effort.",
  "Pick subagent_spawn's tier from the task, not from its size or cost; do not choose a model yourself because a task looks small or cheap.",
  "Give subagent_spawn a short description, and a name when you may want to address the agent later with subagent_send; the returned id is the handle for subagent_check and subagent_cancel.",
  "After subagent_spawn, keep working or end your turn; the result arrives automatically as a follow-up message. Never fabricate or predict a pending result — if the user asks, say the agent is still running, and use subagent_check or subagent_send for status.",
];

/** Model-facing schema descriptions for subagent_spawn task and execution options. */
export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
  description:
    'Short 3-5 word task label shown in the UI and used to name the agent when no name is given, e.g. "fix login bug" (max 200 chars).',
  prompt:
    "Task prompt for the subagent. Must be self-contained: include all needed context, file paths, and what to report back.",
  name: 'Optional name for the spawned agent, used as its id verbatim. Must start with a letter or digit and contain only letters, digits, underscores, or hyphens (max 64 chars); "main", "team-lead", and agent-id shapes are reserved. Set it when you may steer or refer back to the agent later with subagent_send. Use the id with subagent_check and subagent_cancel.',
  tier: 'Semantic delegation tier: "fast", "standard", "deep", or "claude" (the secondary Claude Code harness). Omit for "standard". Cannot be combined with harness, model, or reasoning_effort.',
  workingDir:
    "Trusted working directory for the autonomous child (default: current working directory)",
  runInBackground:
    "Agents run in the background by default. Set to false only when your next action depends on this agent's result and nothing else could usefully happen while it runs — wanting the result next is not enough on its own.",
  harness:
    'Explicit harness override: "pi" (in-process pi session; inherits this environment) or "claude" (Claude Code). Requires model; only for a user-requested override.',
  model:
    'Explicit model override, interpreted by the chosen harness (pi: "provider/model-id" or model id; claude: an alias like "sonnet"). Only set this when the user explicitly asked for that model; a tier already carries the user\'s configured model and effort.',
  reasoningEffort:
    "Explicit reasoning effort on a shared scale; the harness maps it to its nearest native equivalent (pi thinking level, claude thinking budget). Only for a user-requested override.",
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
  const target = [
    delegationLabel(options.tier),
    options.harness,
    options.modelLabel,
    options.effort,
  ].join(", ");
  const tail =
    options.background === false
      ? "Waited for it; the report follows."
      : "Its result arrives automatically in a later message. In your own words, briefly tell the user what you launched — do not echo this tool result or wait for the agent. If the user asks for progress, say the agent is still running.";
  return `Spawned ${options.id} "${options.description}" (${target}). ${tail}`;
}

/** One-line model-facing status for subagent_check and subagent_list. */
export function describeSubagent(snap: SubagentSnapshot) {
  const details = [
    snap.meta.tier ? delegationLabel(snap.meta.tier) : "",
    `${snap.backend}: ${snap.meta.modelLabel ?? "?"}`,
    formatContextUtilization(snap.usage),
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
  ids: 'Subagent ids to cancel, e.g. ["fix-login-bug"]',
};

/**
 * Describes steering a running subagent or resuming a settled one in the
 * current parent session, and the run-sequence acknowledgement returned.
 */
export const SUBAGENT_SEND_TOOL_DESCRIPTION =
  "Steer a running subagent, or resume a settled subagent for another turn in the current parent session (reusing its existing child session). Works only while this session still tracks the agent; a pruned or unknown id fails. Returns the run sequence and whether the agent resumed. A resumed turn counts against the concurrency cap and its result arrives the same way as a spawn.";

/** Model-facing schema descriptions for subagent_send. */
export const SUBAGENT_SEND_PARAMETER_DESCRIPTIONS = {
  id: "Subagent id to steer or resume",
  message:
    "Message to deliver. While the agent runs this is a course correction to the active run; when the agent is settled it starts another turn. The user sees the first line as a one-line preview in the transcript, so make it a self-contained sentence saying what the message is about.",
};

/** Describes non-blocking result collection: settled runs return their report, running runs return status and guidance. */
export const SUBAGENT_CHECK_TOOL_DESCRIPTION =
  "Pull a subagent's result or status without blocking. A settled agent returns its full framed report and consumes the pending automatic delivery; a running agent returns current status and recent output — do not spawn a duplicate, the result arrives automatically as a follow-up message.";

/** The guidance appended to a subagent_check result while the agent runs. */
export function buildSubagentCheckRunningNote(snap: SubagentSnapshot) {
  return `Subagent ${snap.id} is still running. Do not spawn a duplicate. Its result arrives automatically as a follow-up message when it settles; send it a message with subagent_send if you need a progress report before then.`;
}

/** Model-facing schema description for the subagent id to inspect. */
export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = {
  id: "Subagent id",
};

/** Describes listing all tracked running and settled subagents. */
export const SUBAGENT_LIST_TOOL_DESCRIPTION =
  "List all subagents (running and finished) with their tier, harness, and status.";
