/**
 * The review phase engine: deterministic TypeScript driving child agents through
 * the workflow-runtime DSL. Find (one agent per angle, barrier) → dedup → Verify
 * (per-candidate votes) → Sweep (fresh finder over the kept list) → rank + cap.
 * The only model round-trip in the whole review is --fix (handled elsewhere);
 * this engine never goes through the main model.
 */

import type { OrchestrationDSL } from "../shared/workflow-runtime.ts";
import type { Effort, Mode } from "./command.ts";
import { categoryRank, findingKey, type Finding } from "./findings.ts";
import {
  buildFinderPrompt,
  buildInlinePrompt,
  buildSweepPrompt,
  buildVerifierPrompt,
  FINDER_SCHEMA,
  LEVELS,
  VERIFIER_SCHEMA,
  type LevelConfig,
} from "./prompts.ts";
import type { ReviewScope } from "./target.ts";

type Verdict = "CONFIRMED" | "PLAUSIBLE" | "REFUTED";

function shortSummary(summary: string): string {
  const s = summary.trim();
  return s.length <= 60 ? s : `${s.slice(0, 57)}...`;
}

/** Pull finder/sweep candidates out of a (possibly null/malformed) agent result. */
function extractCandidates(result: unknown): Finding[] {
  if (!result || typeof result !== "object") return [];
  const arr = (result as { findings?: unknown }).findings;
  if (!Array.isArray(arr)) return [];
  const out: Finding[] = [];
  for (const c of arr) {
    if (!c || typeof c !== "object") continue;
    const cc = c as Record<string, unknown>;
    if (typeof cc.file !== "string" || cc.file.trim() === "") continue;
    const line = Number(cc.line);
    const summary = String(cc.summary ?? "");
    out.push({
      file: cc.file,
      line: Number.isFinite(line) ? line : 0,
      summary,
      short_summary: shortSummary(summary),
      failure_scenario: String(cc.failure_scenario ?? ""),
      category: String(cc.category ?? "correctness"),
    });
  }
  return out;
}

function extractVerdict(result: unknown): Verdict | undefined {
  if (!result || typeof result !== "object") return undefined;
  const v = (result as { verdict?: unknown }).verdict;
  return v === "CONFIRMED" || v === "PLAUSIBLE" || v === "REFUTED"
    ? v
    : undefined;
}

/** Collapse same-key candidates, keeping the one with the fullest scenario. */
function dedup(findings: Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();
  for (const f of findings) {
    const key = findingKey(f);
    const existing = byKey.get(key);
    if (
      !existing ||
      f.failure_scenario.length > existing.failure_scenario.length
    ) {
      byKey.set(key, f);
    }
  }
  return [...byKey.values()];
}

/** Verify one candidate with `verifyVotes` verifiers; return it with a verdict, or null. */
async function verifyOne(
  dsl: OrchestrationDSL,
  f: Finding,
  scope: ReviewScope,
  cfg: LevelConfig,
): Promise<Finding | null> {
  const votes = await dsl.parallel(
    Array.from(
      { length: cfg.verifyVotes },
      () => () =>
        dsl.agent(buildVerifierPrompt(f, scope, cfg), {
          schema: VERIFIER_SCHEMA,
          phase: "Verify",
          label: `verify:${f.file}:${f.line}`,
        }),
    ),
  );
  const verdicts = votes
    .map(extractVerdict)
    .filter((v): v is Verdict => v !== undefined);
  // Keep unless the refuters reach the vote count: 1-vote drops on REFUTED,
  // 2-vote (max) drops only when both refute. A failed verifier never drops.
  const refuted = verdicts.filter((v) => v === "REFUTED").length;
  if (refuted >= cfg.verifyVotes) return null;
  const verdict: "CONFIRMED" | "PLAUSIBLE" = verdicts.includes("CONFIRMED")
    ? "CONFIRMED"
    : "PLAUSIBLE";
  return { ...f, verdict };
}

async function verifyAll(
  dsl: OrchestrationDSL,
  candidates: Finding[],
  scope: ReviewScope,
  cfg: LevelConfig,
): Promise<Finding[]> {
  const results = await dsl.parallel(
    candidates.map((f) => () => verifyOne(dsl, f, scope, cfg)),
  );
  return results.filter((f): f is Finding => f !== null);
}

/** Rank most-severe first (correctness outranks cleanup), then enforce the cap. */
function rankAndCap(findings: Finding[], cap: number): Finding[] {
  return [...findings]
    .sort((a, b) => categoryRank(a.category) - categoryRank(b.category))
    .slice(0, cap);
}

/**
 * Inline mode: one agent works every angle in its own context (no fan-out, no
 * verify; an in-context sweep for xhigh/max). pi still dedups/ranks/caps the
 * returned candidates in TS.
 */
async function inlineReview(
  dsl: OrchestrationDSL,
  scope: ReviewScope,
  level: LevelConfig,
): Promise<Finding[]> {
  dsl.phase("Review");
  const result = await dsl.agent(buildInlinePrompt(scope, level), {
    schema: FINDER_SCHEMA,
    phase: "Review",
    label: `inline:${level.level}`,
  });
  return rankAndCap(dedup(extractCandidates(result)), level.cap);
}

export async function reviewOrchestration(
  dsl: OrchestrationDSL,
  cfg: { level: Effort; scope: ReviewScope; mode?: Mode },
): Promise<Finding[]> {
  const level = LEVELS[cfg.level];
  const { scope } = cfg;

  // Inline is a single-agent sweep; low is already one agent, so it takes the
  // shared path (its hunk-scan prompt is mode-agnostic).
  if (cfg.mode === "inline" && cfg.level !== "low") {
    return inlineReview(dsl, scope, level);
  }

  dsl.phase("Find");
  const finderResults = await dsl.parallel(
    level.angles.map(
      (angle) => () =>
        dsl.agent(buildFinderPrompt(angle, scope, level), {
          schema: FINDER_SCHEMA,
          phase: "Find",
          label: angle.key,
        }),
    ),
  );

  let kept = dedup(finderResults.flatMap(extractCandidates));

  if (level.verify !== "none") {
    dsl.phase("Verify");
    kept = await verifyAll(dsl, kept, scope, level);
  }

  for (let round = 0; round < level.sweeps; round++) {
    dsl.phase("Sweep");
    const sweepResult = await dsl.agent(buildSweepPrompt(kept, scope), {
      schema: FINDER_SCHEMA,
      phase: "Sweep",
      label: `sweep-${round + 1}`,
    });
    const existing = new Set(kept.map(findingKey));
    let swept = dedup(extractCandidates(sweepResult)).filter(
      (f) => !existing.has(findingKey(f)),
    );
    if (level.verify !== "none" && swept.length > 0) {
      swept = await verifyAll(dsl, swept, scope, level);
    }
    kept.push(...swept);
  }

  return rankAndCap(kept, level.cap);
}
