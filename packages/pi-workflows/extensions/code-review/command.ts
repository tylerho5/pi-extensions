/**
 * `/code-review` argument parsing and effort resolution — pure, no I/O, so it
 * unit-tests cleanly. The effort scale is code-review's own (review depth), NOT
 * the model thinking-level scale from shared/subagent-models.ts.
 */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * How the review runs: `fanout` is the multi-agent pipeline (one agent per
 * angle → verify → sweep); `inline` is a single agent that sweeps the diff in
 * one context, no verify — the port of CC's per-model inline family, decoupled
 * from the model into an explicit choice. Default is `fanout`.
 */
export type Mode = "inline" | "fanout";

export const EFFORT_LEVELS: readonly Effort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export const MODES: readonly Mode[] = ["inline", "fanout"];

export interface ParsedArgs {
  /** A recognized level token, when one was typed. */
  explicit?: Effort;
  /** `inline` or `fanout`; defaults to `fanout`. Not persisted. */
  mode: Mode;
  /** PR number, branch, range, or path — "" when none. */
  target: string;
  fix: boolean;
  comment: boolean;
  /** The `ultra` subcommand (cloud-only in CC; a local max review here). */
  ultra: boolean;
  /** A first token that looked like a mistyped level (warned, then ignored). */
  unrecognizedLevel?: string;
  /** `--post`/`--no-post` were present; they are ultra-only, so ignored. */
  postIgnored: boolean;
}

export interface ResolvedEffort {
  level: Effort;
  source: "explicit" | "last-used" | "default" | "ultra";
}

function isEffort(token: string): token is Effort {
  return (EFFORT_LEVELS as readonly string[]).includes(token);
}

function isMode(token: string): token is Mode {
  return (MODES as readonly string[]).includes(token);
}

export function parseArgs(raw: string): ParsedArgs {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);

  let fix = false;
  let comment = false;
  let postIgnored = false;
  const positionals: string[] = [];

  for (const token of tokens) {
    if (token === "--fix") fix = true;
    else if (token === "--comment") comment = true;
    else if (token === "--post" || token === "--no-post") postIgnored = true;
    else if (token.startsWith("--"))
      continue; // unknown flag: ignore
    else positionals.push(token);
  }

  let explicit: Effort | undefined;
  let mode: Mode = "fanout";
  let ultra = false;
  let unrecognizedLevel: string | undefined;

  // The leading positionals hold an optional mode token and an optional level
  // slot, in either order (`inline high` or `high inline`). Consume each once;
  // stop at the first token that fits neither — that starts the target.
  let modeFilled = false;
  let levelFilled = false;
  while (positionals.length > 0) {
    const t = positionals[0]!;
    if (!modeFilled && isMode(t)) {
      mode = t;
      modeFilled = true;
    } else if (!levelFilled && t === "ultra") {
      ultra = true;
      levelFilled = true;
    } else if (!levelFilled && isEffort(t)) {
      explicit = t;
      levelFilled = true;
    } else break;
    positionals.shift();
  }

  // A bare all-letters word left in an unfilled level slot reads as a mistyped
  // level (warned, not silently treated as a branch). Anything target-shaped
  // (a PR number, a slash/dot/hyphen in the name, mixed case) stays a target.
  const first = positionals[0];
  if (!levelFilled && first !== undefined && /^[a-z]+$/.test(first)) {
    unrecognizedLevel = first;
    positionals.shift();
  }

  return {
    explicit,
    mode,
    target: positionals.join(" "),
    fix,
    comment,
    ultra,
    unrecognizedLevel,
    postIgnored,
  };
}

export function resolveEffort(
  parsed: ParsedArgs,
  lastUsed?: Effort,
): ResolvedEffort {
  if (parsed.ultra) return { level: "max", source: "ultra" };
  if (parsed.explicit) return { level: parsed.explicit, source: "explicit" };
  if (lastUsed) return { level: lastUsed, source: "last-used" };
  return { level: "medium", source: "default" };
}
