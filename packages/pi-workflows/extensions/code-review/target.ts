/**
 * Resolve a `/code-review` target into a concrete diff scope — the port of the
 * review's Phase 0. Ports the fallback chain: no target → `@{upstream}...HEAD`,
 * else `main...HEAD`, else `HEAD~1`; pull in the working tree when the range is
 * empty or the tree is dirty. Explicit targets: a PR number → `gh pr diff`, a
 * range (`a..b`) → that range, a ref → `<ref>...HEAD`, anything else → a path.
 * The command runner is injected so this resolves against canned output in
 * tests and a real `exec` in the handler.
 */

export interface ReviewScope {
  /** The git spec (or PR number) the scope was resolved from. */
  range: string;
  /** Human label for the run title / notices. */
  label: string;
  isPr: boolean;
  diffText: string;
  changedLines: number;
}

export type Runner = (
  cmd: string[],
  cwd: string,
) => Promise<{ stdout: string; code: number }>;

async function refExists(
  run: Runner,
  cwd: string,
  ref: string,
): Promise<boolean> {
  const { code } = await run(
    ["git", "rev-parse", "--verify", "--quiet", ref],
    cwd,
  );
  return code === 0;
}

async function gitDiff(
  run: Runner,
  cwd: string,
  args: string[],
): Promise<string> {
  return (await run(["git", "diff", ...args], cwd)).stdout;
}

/** Sum added + deleted across `git diff --numstat`, skipping binary ("-") rows. */
async function numstatSum(
  run: Runner,
  cwd: string,
  args: string[],
): Promise<number> {
  const out = (await run(["git", "diff", "--numstat", ...args], cwd)).stdout;
  let total = 0;
  for (const line of out.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2) continue;
    const added = Number(cols[0]);
    const deleted = Number(cols[1]);
    if (Number.isFinite(added)) total += added;
    if (Number.isFinite(deleted)) total += deleted;
  }
  return total;
}

/** Count content +/- lines in a unified diff, excluding the +++/--- headers. */
function countDiffLines(diff: string): number {
  let total = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith("-")) total += 1;
  }
  return total;
}

async function resolveNoTarget(run: Runner, cwd: string): Promise<ReviewScope> {
  let range: string;
  if (await refExists(run, cwd, "@{upstream}")) range = "@{upstream}...HEAD";
  else if (await refExists(run, cwd, "main")) range = "main...HEAD";
  else range = "HEAD~1";

  const rangeDiff = await gitDiff(run, cwd, [range]);
  const porcelain = (await run(["git", "status", "--porcelain"], cwd)).stdout;
  const hasUncommitted = porcelain.trim().length > 0;
  const rangeEmpty = rangeDiff.trim().length === 0;

  let diffText = rangeDiff;
  let label = range;
  let changedLines = await numstatSum(run, cwd, [range]);

  if (hasUncommitted || rangeEmpty) {
    const workingDiff = await gitDiff(run, cwd, ["HEAD"]);
    changedLines += await numstatSum(run, cwd, ["HEAD"]);
    if (rangeEmpty) {
      diffText = workingDiff;
      label = "working tree (HEAD)";
    } else {
      diffText = `${rangeDiff}\n${workingDiff}`;
      label = `${range} + working tree`;
    }
  }

  return { range, label, isPr: false, diffText, changedLines };
}

export async function resolveScope(
  target: string,
  cwd: string,
  run: Runner,
): Promise<ReviewScope> {
  const spec = target.trim();

  if (spec === "") return resolveNoTarget(run, cwd);

  if (/^\d+$/.test(spec)) {
    const diffText = (await run(["gh", "pr", "diff", spec], cwd)).stdout;
    return {
      range: spec,
      label: `PR #${spec}`,
      isPr: true,
      diffText,
      changedLines: countDiffLines(diffText),
    };
  }

  if (spec.includes("..")) {
    return {
      range: spec,
      label: spec,
      isPr: false,
      diffText: await gitDiff(run, cwd, [spec]),
      changedLines: await numstatSum(run, cwd, [spec]),
    };
  }

  if (await refExists(run, cwd, spec)) {
    const range = `${spec}...HEAD`;
    return {
      range,
      label: range,
      isPr: false,
      diffText: await gitDiff(run, cwd, [range]),
      changedLines: await numstatSum(run, cwd, [range]),
    };
  }

  // A path: diff the working tree for it.
  const args = ["HEAD", "--", spec];
  return {
    range: `HEAD -- ${spec}`,
    label: spec,
    isPr: false,
    diffText: await gitDiff(run, cwd, args),
    changedLines: await numstatSum(run, cwd, args),
  };
}
