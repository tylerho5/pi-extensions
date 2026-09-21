/**
 * Run-wide output-token budget, mirroring CC's `budget` script global.
 *
 * CC derives the target from a "+500k"-style directive on the user's turn. Pi
 * has no such directive, so the target comes from the tool's `budgetTokens`
 * parameter or the persisted `/workflows-budget` default. The semantics match:
 * a HARD ceiling — once spent reaches total, further agent() calls throw.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const SETTINGS_FILE = "workflow-budget.json";

export class WorkflowBudgetExceededError extends Error {
  constructor(spent: number, total: number) {
    super(
      `Workflow token budget exceeded (${spent.toLocaleString()} / ${total.toLocaleString()} output tokens). ` +
        `Stopping further agent() calls. In-flight agents will complete; their results are preserved.`,
    );
    this.name = "WorkflowBudgetExceededError";
  }
}

export interface BudgetView {
  total: number | null;
  spent: number;
  remaining: number;
}

/** Tracks output tokens spent by a run against an optional hard target. */
export class WorkflowBudget {
  readonly total: number | null;
  private spentTokens = 0;

  constructor(total: number | null) {
    this.total = total;
  }

  add(outputTokens: number) {
    this.spentTokens += Math.max(0, outputTokens);
  }

  spent() {
    return this.spentTokens;
  }

  remaining() {
    return this.total === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, this.total - this.spentTokens);
  }

  /** Throws once the target is reached; unset budgets never block. */
  assertAvailable() {
    if (this.total !== null && this.spentTokens >= this.total) {
      throw new WorkflowBudgetExceededError(this.spentTokens, this.total);
    }
  }

  /** Plain snapshot handed to the sandbox, which cannot hold a class. */
  view(): BudgetView {
    return {
      total: this.total,
      spent: this.spentTokens,
      remaining: this.remaining(),
    };
  }
}

function settingsPath() {
  return path.join(getAgentDir(), SETTINGS_FILE);
}

/** Persisted default target in output tokens, or null for unlimited. */
export function loadDefaultBudget(): number | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { tokens?: unknown }).tokens === "number" &&
      (parsed as { tokens: number }).tokens > 0
    ) {
      return Math.floor((parsed as { tokens: number }).tokens);
    }
  } catch {
    // No configured default.
  }
  return null;
}

export function saveDefaultBudget(tokens: number | null) {
  fs.writeFileSync(
    settingsPath(),
    `${JSON.stringify({ tokens }, null, 2)}\n`,
    "utf8",
  );
}

/** Accepts "500k", "1.5m", or a plain token count. */
export function parseBudget(input: string): number | null {
  const text = input.trim().toLowerCase().replace(/^\+/, "");
  if (!text || text === "off" || text === "none" || text === "unlimited") {
    return null;
  }
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(text);
  if (!match)
    throw new Error(`Invalid budget "${input}" (try 500k, 1.5m, off)`);
  const value = Number(match[1]);
  const scale = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  const tokens = Math.floor(value * scale);
  if (tokens <= 0) throw new Error(`Invalid budget "${input}"`);
  return tokens;
}

export function formatBudget(tokens: number | null): string {
  if (tokens === null) return "unlimited";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M tokens`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k tokens`;
  return `${tokens} tokens`;
}
