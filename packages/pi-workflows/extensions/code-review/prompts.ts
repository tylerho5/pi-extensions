/**
 * Ported review prompt text and the per-level config table. Angle bodies,
 * Phase 0, verify verdicts, the sweep, lead-ins, and the candidate-shape note
 * are ported verbatim from `.claude/plans/2026-08-14-code-review-ported-prompts.md`
 * (Claude Code 2.1.233). The finder/verifier/sweep agents return via the
 * runtime structured-output schema; the aggregated result is what the extension
 * renders and what the model re-reports on --fix.
 */

import type { Effort } from "./command.ts";
import type { Finding } from "./findings.ts";
import type { ReviewScope } from "./target.ts";

export interface AnglePrompt {
  key: string;
  body: string;
}

// --- Correctness angles ---------------------------------------------------

const ANGLE_A: AnglePrompt = {
  key: "diff-scan",
  body: `### Angle A — line-by-line diff scan

Read every hunk in the diff, line by line. Then Read the enclosing function for
each hunk — bugs in unchanged lines of a touched function are in scope (the PR
re-exposes or fails to fix them). For every line ask: what input, state, timing,
or platform makes this line wrong? Look for inverted/wrong conditions,
off-by-one, null/undefined deref, missing \`await\`, falsy-zero checks,
wrong-variable copy-paste, error swallowed in catch, unescaped regex metachars.`,
};

const ANGLE_B: AnglePrompt = {
  key: "removed-behavior",
  body: `### Angle B — removed-behavior auditor

For every line the diff DELETES or replaces, name the invariant or behavior it
enforced, then search the new code for where that invariant is re-established.
If you can't find it, that's a candidate: a removed guard, a dropped error
path, a narrowed validation, a deleted test that was covering a real case.`,
};

const ANGLE_C: AnglePrompt = {
  key: "cross-file",
  body: `### Angle C — cross-file tracer

For each function the diff changes, find its callers (Grep for the symbol) and
check whether the change breaks any call site: a new precondition, a changed
return shape, a new exception, a timing/ordering dependency. Also check callees:
does a parallel change in the same PR make a call unsafe?`,
};

const ANGLE_D: AnglePrompt = {
  key: "language-pitfalls",
  body: `### Angle D — language-pitfall specialist

Scan for the classic pitfalls of the diff's language/framework — for example:
JS falsy-zero, \`==\` coercion, closure-captured loop var; Python mutable default
args, late-binding closures; Go nil-map write, range-var capture; SQL injection;
timezone/DST drift; float equality. Flag any instance the diff introduces.`,
};

const ANGLE_E: AnglePrompt = {
  key: "wrapper-proxy",
  body: `### Angle E — wrapper/proxy correctness

When the PR adds or modifies a type that wraps another (cache, proxy, decorator,
adapter): check that every method routes to the wrapped instance and not back
through a registry/session/global — e.g. a caching provider holding a
\`delegate\` field that resolves IDs via \`session.get(...)\` instead of
\`delegate.get(...)\` will re-enter the cache or recurse. Also check that the
wrapper forwards all the methods the callers actually use.`,
};

// --- Cleanup angles -------------------------------------------------------

const REUSE: AnglePrompt = {
  key: "reuse",
  body: `### Reuse

The angles above hunt for bugs; this one and the next two hunt for cleanup in
the changed code. Flag new code that re-implements something the codebase
already has — Grep shared/utility modules and files adjacent to the change,
and name the existing helper to call instead.`,
};

const SIMPLIFICATION: AnglePrompt = {
  key: "simplification",
  body: `### Simplification

Flag unnecessary complexity the diff adds: redundant or derivable state,
copy-paste with slight variation, deep nesting, dead code left behind. Name
the simpler form that does the same job.`,
};

const EFFICIENCY: AnglePrompt = {
  key: "efficiency",
  body: `### Efficiency

Flag wasted work the diff introduces: redundant computation or repeated I/O,
independent operations run sequentially, blocking work added to startup or
hot paths. Also flag long-lived objects built from closures or captured
environments — they keep the entire enclosing scope alive for the object's
lifetime (a memory leak when that scope holds large values); prefer a
class/struct that copies only the fields it needs. Name the cheaper
alternative.`,
};

const ALTITUDE: AnglePrompt = {
  key: "altitude",
  body: `### Altitude

Check that each change is implemented at the right depth, not as a fragile
bandaid. Special cases layered on shared infrastructure are a sign the fix
isn't deep enough — prefer generalizing the underlying mechanism over adding
special cases.`,
};

const CONVENTIONS: AnglePrompt = {
  key: "conventions",
  body: `### Conventions (CLAUDE.md)

Find the CLAUDE.md files that govern the changed code: the user-level
~/.claude/CLAUDE.md, the repo-root CLAUDE.md, plus any CLAUDE.md or
CLAUDE.local.md in a directory that is an ancestor of a changed file (a
directory's CLAUDE.md only applies to files at or below it). Read each one
that exists, then check the diff for clear violations of the rules they state.

Only flag a violation when you can quote the exact rule and the exact line
that breaks it — no style preferences, no vague "spirit of the doc"
inferences. In the finding, name the CLAUDE.md path and quote the rule so the
report can cite it. If no CLAUDE.md applies, return nothing for this angle.`,
};

const LOW_HUNK_SCAN: AnglePrompt = {
  key: "hunk-scan",
  body: `low effort → 1 diff pass → no verify → ≤4 findings

## Turn 1 — read
One tool call: read the unified diff (\`git diff @{upstream}...HEAD; git diff HEAD\`
to cover both committed and uncommitted changes, or \`git diff main...HEAD\` /
the target passed as an argument). Skip test/fixture hunks (\`test/\`, \`spec/\`,
\`__tests__/\`, \`*_test.*\`, \`*.test.*\`, \`fixtures/\`, \`testdata/\`). No subagents,
no full-file reads.

## Turn 2 — findings
Flag runtime-correctness bugs visible from the hunk alone: inverted/wrong
condition, off-by-one, null/undefined deref where adjacent lines show the value
can be absent, removed guard, falsy-zero check, missing \`await\`,
wrong-variable copy-paste, error swallowed in a catch that should propagate.
Also flag — still from the hunk alone — new code that duplicates an existing
helper visible in the diff context, and dead code the diff leaves behind.
Do not flag style, naming, perf, missing tests, or anything outside the hunk.
Report at most 4 findings, most-severe first.`,
};

// --- Shared prompt fragments ---------------------------------------------

/** Phase 0 (uqe), ported verbatim. The port pre-gathers the diff; kept for fidelity. */
export const PHASE_0 = `## Phase 0 — Gather the diff

Run \`git diff @{upstream}...HEAD\` (or \`git diff main...HEAD\` / \`git diff HEAD~1\`
if there's no upstream) to get the unified diff under review. If there are
uncommitted changes, or the range diff is empty, also run \`git diff HEAD\` and
include the working-tree changes in scope — the review often runs before the
commit. If a PR number, branch name, or file path was passed as an argument,
review that target instead. Treat this diff as the review scope.`;

/** Candidate shape for cleanup angles (wgr), ported verbatim. */
export const CANDIDATE_SHAPE = `Cleanup, altitude, and conventions candidates use the same
\`file\`/\`line\`/\`summary\` shape; in \`failure_scenario\`, state the concrete
cost (what is duplicated, wasted, harder to maintain, or which CLAUDE.md rule
is broken) instead of a crash. Correctness bugs always outrank cleanup,
altitude, and conventions findings when the output cap forces a cut.`;

/** Precision 3-state verdicts (P6w), ported verbatim. */
export const PRECISION_VERDICTS = `- **CONFIRMED** — can name the inputs/state that trigger it and the wrong
  output or crash. Quote the line.
- **PLAUSIBLE** — mechanism is real, trigger is uncertain (timing, env,
  config). State what would confirm it.
- **REFUTED** — factually wrong (code doesn't say that) or guarded elsewhere.
  Quote the line that proves it.`;

/** Recall-biased "PLAUSIBLE by default" verdicts (O6w), ported verbatim. */
export const RECALL_VERDICTS = `**PLAUSIBLE by default** — do not refute a candidate for being "speculative" or
"depends on runtime state" when the state is realistic: concurrency races,
nil/undefined on a rare-but-reachable path (error handler, cold cache, missing
optional field), falsy-zero treated as missing, off-by-one on a boundary the
code does not exclude, retry storms / partial failures, regex/allowlist that
lost an anchor. These are PLAUSIBLE.

**REFUTED** only when constructible from the code: factually wrong (quote the
actual line); provably impossible (type/constant/invariant — show it); already
handled in this diff (cite the guard); or pure style with no observable effect.`;

/** Sweep (M6w, focus rrg), ported verbatim. */
export const SWEEP = `## Phase 3 — Sweep for gaps

Run one more finder as a fresh reviewer who has the verified list. Re-read
the diff and enclosing functions looking ONLY for defects not already listed.
Do not re-derive or re-confirm anything already there — the job is gaps. Focus
on what the first pass tends to miss: moved/extracted code that dropped a guard
or anchor; second-tier footguns (dataclass default evaluated once, \`hash()\`
non-determinism, lock-scope shrink, predicate methods with side effects);
setup/teardown asymmetry in tests; config defaults flipped.

Surface up to 8 additional candidates, each naming a defect not already on
the list. If nothing new, return an empty sweep — do not pad.`;

// --- Per-level lead-ins (arg / lrg / crg), ported verbatim ---------------

const LEAD_IN_MEDIUM = `You are reviewing for **precision** at medium effort: every finding you surface should be one a maintainer would act on.`;
const LEAD_IN_HIGH = `You are reviewing for **recall** at high effort: catch every real bug a careful reviewer would catch in one sitting. At this level, catching real bugs matters more than avoiding false positives. Err on the side of surfacing.`;
const leadInCrg = (level: "maximum" | "extra-high") =>
  `You are reviewing for **recall** at ${level} effort: catch every real bug. At this level, catching real bugs matters more than avoiding false positives — a missed bug ships. Err on the side of surfacing.`;

// --- Inline (single-agent) family, ported from CC's inline cells ---------
// CC 2.1.233 routes some model families to a single-context review that works
// every angle in one pass with no subagents and no verify pass (grg/N6w/frg).
// The pi port exposes it as the `inline` mode. Lead-ins are the inline cells'
// own wording (yrg is recall-leaning "correctness bugs", not the fanout
// "precision" lead-in). Angle bodies are reused from above; the single agent
// returns candidates via the runtime structured-output schema (port
// adaptation), and pi dedups/ranks/caps in TS.

/** Inline lead-ins keyed by effort (yrg / _rg / N6w; max mirrors the crg pattern). */
const INLINE_LEAD_IN: Partial<Record<Effort, string>> = {
  medium: `You are reviewing for **correctness bugs**: surface every plausible bug. At this
level, catching real bugs matters more than avoiding false positives — err on
the side of surfacing.`,
  high: LEAD_IN_HIGH,
  xhigh: `You are reviewing for **recall** at extra-high effort: catch every real bug. At
this level, catching real bugs matters more than avoiding false positives — a
missed bug ships. Err on the side of surfacing.`,
  max: `You are reviewing for **recall** at maximum effort: catch every real bug. At
this level, catching real bugs matters more than avoiding false positives — a
missed bug ships. Err on the side of surfacing.`,
};

/** Phase 2 for inline (grg): dedup, no verify. */
const INLINE_DEDUP = `## Phase 2 — Dedup only (no verify)

Pool all candidates. Dedup near-duplicates only (same defect, same location,
same reason → keep one). Do NOT run verifiers; do NOT re-judge. Sort by
severity.`;

/** In-context sweep for inline xhigh/max (c_c Phase 3 + the rrg focus, no subagent). */
const INLINE_SWEEP = `## Phase 3 — Sweep for gaps

Take one more pass yourself (same context, no subagent) as a fresh reviewer who
has the deduplicated list. Re-read the diff and enclosing functions looking ONLY
for defects not already listed: moved/extracted code that dropped a guard or
anchor; second-tier footguns (dataclass default evaluated once, \`hash()\`
non-determinism, lock-scope shrink, predicate methods with side effects);
setup/teardown asymmetry in tests; config defaults flipped.`;

// --- Flag appendices, ported verbatim (W6w+Crg / z6w port adaptation) ----

export const FIX_APPENDIX = `## Applying fixes (--fix)

The \`--fix\` flag was passed. After producing the findings list, apply the
findings to the working tree instead of stopping at the report: fix each one
directly — correctness bugs and reuse/simplification/efficiency cleanups alike.
Skip any finding whose fix would change intended behavior, require changes well
outside the reviewed diff, or that you judge to be a false positive — note the
skip rather than arguing with it. Then call report_findings again with the same
findings, each carrying an \`outcome\`: \`fixed\`, \`no_change_needed\` (the finding
was wrong or already handled), or \`skipped\` (real but not applied). Do not
repeat the findings as text; after the call, give one line per skipped finding.`;

export const COMMENT_APPENDIX = `## Preparing PR comments (--comment)

The \`--comment\` flag was passed. If the review target is a GitHub PR, format
each finding as an inline PR comment payload (path, line, body; include a
suggestion block only when it fully fixes the issue) and print a ready-to-run
\`gh api repos/{owner}/{repo}/pulls/{pr}/comments\` command for each — but DO NOT
post them yourself. Present them for the user to run. If the target is not a
PR, print the findings and note that \`--comment\` was ignored.`;

// --- Structured-output schemas (plain JSON Schema for the runtime) --------

const CANDIDATE_ITEM = {
  type: "object",
  properties: {
    file: { type: "string" },
    line: { type: "integer" },
    summary: { type: "string" },
    failure_scenario: { type: "string" },
    category: { type: "string" },
  },
  required: ["file", "line", "summary", "failure_scenario", "category"],
  additionalProperties: false,
} as const;

export const FINDER_SCHEMA = {
  type: "object",
  properties: { findings: { type: "array", items: CANDIDATE_ITEM } },
  required: ["findings"],
  additionalProperties: false,
} as const;

export const VERIFIER_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["CONFIRMED", "PLAUSIBLE", "REFUTED"] },
    reason: { type: "string" },
  },
  required: ["verdict", "reason"],
  additionalProperties: false,
} as const;

// --- Level config ---------------------------------------------------------

export interface LevelConfig {
  level: Effort;
  angles: AnglePrompt[];
  candidatesPerAngle: number;
  verify: "none" | "precision" | "recall";
  verifyVotes: 1 | 2;
  sweeps: 0 | 1 | 2;
  cap: number;
  leadIn: string;
}

const MEDIUM_HIGH_ANGLES: AnglePrompt[] = [
  ANGLE_A,
  ANGLE_B,
  ANGLE_C,
  REUSE,
  SIMPLIFICATION,
  EFFICIENCY,
  ALTITUDE,
  CONVENTIONS,
];

const XHIGH_MAX_ANGLES: AnglePrompt[] = [
  ANGLE_A,
  ANGLE_B,
  ANGLE_C,
  ANGLE_D,
  ANGLE_E,
  REUSE,
  SIMPLIFICATION,
  EFFICIENCY,
  ALTITUDE,
  CONVENTIONS,
];

export const LEVELS: Record<Effort, LevelConfig> = {
  low: {
    level: "low",
    angles: [LOW_HUNK_SCAN],
    candidatesPerAngle: 4,
    verify: "none",
    verifyVotes: 1,
    sweeps: 0,
    cap: 4,
    leadIn: "",
  },
  medium: {
    level: "medium",
    angles: MEDIUM_HIGH_ANGLES,
    candidatesPerAngle: 6,
    verify: "precision",
    verifyVotes: 1,
    sweeps: 0,
    cap: 8,
    leadIn: LEAD_IN_MEDIUM,
  },
  high: {
    level: "high",
    angles: MEDIUM_HIGH_ANGLES,
    candidatesPerAngle: 6,
    verify: "recall",
    verifyVotes: 1,
    sweeps: 0,
    cap: 10,
    leadIn: LEAD_IN_HIGH,
  },
  xhigh: {
    level: "xhigh",
    angles: XHIGH_MAX_ANGLES,
    candidatesPerAngle: 8,
    verify: "recall",
    verifyVotes: 1,
    sweeps: 1,
    cap: 15,
    leadIn: leadInCrg("extra-high"),
  },
  max: {
    level: "max",
    angles: XHIGH_MAX_ANGLES,
    candidatesPerAngle: 8,
    verify: "recall",
    verifyVotes: 2,
    sweeps: 2,
    cap: 15,
    leadIn: leadInCrg("maximum"),
  },
};

// --- Prompt assembly ------------------------------------------------------

function scopeSection(scope: ReviewScope): string {
  return `## Reviewing: ${scope.label} (${scope.changedLines} changed line(s))

The unified diff under review:

\`\`\`diff
${scope.diffText}
\`\`\``;
}

export function buildFinderPrompt(
  angle: AnglePrompt,
  scope: ReviewScope,
  cfg: LevelConfig,
): string {
  return [
    cfg.leadIn,
    scopeSection(scope),
    angle.body,
    CANDIDATE_SHAPE,
    `Surface up to ${cfg.candidatesPerAngle} candidate(s) for this angle. For each, give file, line, summary, failure_scenario, and category (a kebab-case slug). Return them via the structured output; if nothing fits this angle, return an empty array.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The inline single-agent prompt: the level's angle checklist inlined into one
 * pass, dedup-only (no verify), plus an in-context sweep for xhigh/max. One
 * agent works it all in its own context — no fan-out. Not used for `low`, whose
 * hunk-scan prompt already runs as a single agent in both modes.
 */
export function buildInlinePrompt(
  scope: ReviewScope,
  cfg: LevelConfig,
): string {
  const n = cfg.angles.length;
  const k = cfg.candidatesPerAngle;
  const wide = n >= 10; // xhigh/max shape (5 correctness + cleanup)
  const header = wide
    ? "## Phase 1 — Find candidates (5 correctness angles + 3 cleanup angles + 1 altitude angle + 1 conventions angle, up to 8 each)"
    : "## Phase 1 — Find candidates (3 correctness angles + 3 cleanup angles + 1 altitude angle + 1 conventions angle, up to 6 each)";
  const wrap = wide
    ? `Run **${n} independent finder angles** in sequence yourself, in THIS context — do NOT spawn subagents for them. Each surfaces **up to ${k} candidate findings**. Do NOT let one angle's conclusions suppress another's — if two angles flag the same line for different reasons, record both.`
    : `Run **${n} independent finder angles** in sequence yourself, in THIS context — do NOT spawn subagents for them. Each surfaces **up to ${k} candidate findings** with \`file\`, \`line\`, a one-line \`summary\`, and a concrete \`failure_scenario\`.`;
  return [
    INLINE_LEAD_IN[cfg.level],
    scopeSection(scope),
    header,
    wrap,
    cfg.angles.map((a) => a.body).join("\n\n"),
    CANDIDATE_SHAPE,
    INLINE_DEDUP,
    cfg.sweeps > 0 ? INLINE_SWEEP : "",
    `Return every candidate you keep${cfg.sweeps > 0 ? " (angle pass and sweep)" : ""} via the structured output — file, line, summary, failure_scenario, and category (a kebab-case slug). Do NOT spawn subagents and do NOT run a verify pass. If nothing qualifies, return an empty array.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildVerifierPrompt(
  f: Finding,
  scope: ReviewScope,
  cfg: LevelConfig,
): string {
  const rubric =
    cfg.verify === "precision" ? PRECISION_VERDICTS : RECALL_VERDICTS;
  return [
    "## Verify a review candidate",
    "You are given a candidate finding and the diff (Read the relevant files as needed). Return exactly one verdict of CONFIRMED / PLAUSIBLE / REFUTED.",
    scopeSection(scope),
    `Candidate:
- file: ${f.file}
- line: ${f.line}
- category: ${f.category}
- claim: ${f.summary}
- failure scenario: ${f.failure_scenario}`,
    rubric,
    "Return { verdict, reason } via the structured output.",
  ].join("\n\n");
}

export function buildSweepPrompt(kept: Finding[], scope: ReviewScope): string {
  const listed = kept.length
    ? kept.map((f) => `- ${f.file}:${f.line} — ${f.summary}`).join("\n")
    : "(none)";
  return [
    SWEEP,
    scopeSection(scope),
    `Already-listed findings (do NOT re-report these):\n${listed}`,
    "Return up to 8 NEW candidates via the structured output; each with file, line, summary, failure_scenario, and category. If nothing new, return an empty array.",
  ].join("\n\n");
}
