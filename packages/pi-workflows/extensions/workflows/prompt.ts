import {
  countStates,
  formatElapsed,
  resultJson,
  shortenHome,
  type WorkflowDetails,
} from "./model.ts";

/** Model-facing schema descriptions for workflow source, arguments, and background mode. */
export const WORKFLOW_PARAMETER_DESCRIPTIONS = {
  name: "Name of a saved workflow to run instead of an inline script (see the registry listed at the end of this description). Pass `script` as well only to override the saved definition for one run.",
  script:
    "JavaScript workflow script; required unless `name` is given. May start with `export const meta = {...}`, then use phase(), agent(), pipeline(), parallel(), log(), args, and a final `return`.",
  args: "Optional JSON string exposed to the script as `args` (parsed when valid JSON, otherwise passed through as the raw string).",
  background:
    "Defaults to true: the tool returns a run id immediately and you receive a follow-up message when the workflow finishes. Set false to block on the run and watch live progress instead.",
  resumeFromRunId:
    "Run id of a prior workflow to resume from. Completed agent() calls with unchanged (prompt, options) return their cached results instantly; only edited or new calls re-run.",
  budgetTokens:
    "Output-token target for this run, exposed to the script as `budget`. A HARD ceiling: once reached, further agent() calls throw. Defaults to the /workflow-budget setting (unlimited unless configured).",
};

/** Defines the workflow DSL, constraints, reliability guidance, and model-authored task examples. */
export const WORKFLOW_TOOL_DESCRIPTION = [
  "Run a multi-agent workflow from a JavaScript orchestration script you write inline. Workflows run in the background — this tool returns immediately with a run id, and a follow-up message arrives when the workflow completes. Use /workflows to watch live progress. Pass `background: false` only when you need to block on the result within this turn.",
  "",
  "A workflow structures work across many agents — to be comprehensive (decompose and cover in parallel), to be confident (independent perspectives and adversarial checks before committing), or to take on scale one context can't hold (migrations, audits, broad sweeps). The script is where you encode that structure: what fans out, what verifies, what synthesizes.",
  "",
  "ONLY call this tool when the user has explicitly opted into multi-agent orchestration. Workflows spawn many agents and consume a large amount of tokens; the user must request that scale, not have it inferred. Explicit opt-in means one of:",
  '- The user included the keyword "ultracode" in their prompt.',
  '- The user directly asked you to run a workflow or use multi-agent orchestration in their own words ("use a workflow", "run a workflow", "fan out agents", "orchestrate this with subagents"). The ask must be in the user\'s words — a task that would merely benefit from a workflow does not count.',
  "- The user invoked a skill or slash command whose instructions tell you to call workflow.",
  "",
  'For any other task — even one that would clearly benefit from parallelism — do NOT call this tool. Keep single small delegations in the main session, or briefly describe what a multi-agent workflow could do and roughly what it would cost, and ask the user whether to run it. Mention they can ask for one with "use a workflow" in a future message to skip the ask.',
  "",
  "When you do call it, the right move is often hybrid: scout inline first (list the files, find the call sites, scope the diff) to discover the work-list, then call workflow to fan out over it. You don't need to know the shape before the *task* — only before the *orchestration step*.",
  "",
  "Common single-phase workflows you can chain across turns:",
  "- Understand — parallel readers over relevant subsystems → structured map",
  "- Design — judge panel of N independent approaches → scored synthesis",
  "- Review — dimensions → find → adversarially verify (example below)",
  "- Research — multi-modal sweep → deep-read → synthesize",
  "- Migrate — discover sites → transform each → verify",
  "",
  "For larger work, run several in sequence — read each result before deciding the next phase. You stay in the loop; each workflow is one well-scoped fan-out.",
  "",
  "The script runs as an async function body with these primitives:",
  "• export const meta = { name, description, phases: [{ title, detail? }] } — metadata for the progress UI. Declare all phases up front.",
  "• phase(title) — mark the current phase at runtime (use titles from meta.phases).",
  "• await agent(prompt, { label?, phase?, schema?, model?, provider?, effort?, isolation? }) — run ONE subagent in an isolated context and wait for it. Without `schema`, returns its final text as a string. With `schema` (a JSON Schema), the subagent is forced to call a structured_output tool and agent() returns the validated object — no parsing needed. Returns null if the agent fails or is rejected by a cap, so filter with .filter(Boolean); the reason is recorded on the run, not in the value. Omit `model`/`provider`: agents run on the user's configured default subagent model, and a cost ceiling rejects expensive models you pick yourself. CC-style aliases (haiku/sonnet/opus) also work — they resolve through the user's `modelAliases` config or fall back to the default. `effort` sets the thinking level (off|minimal|low|medium|high|xhigh|max). `isolation: 'worktree'` runs the agent in a fresh git worktree — EXPENSIVE, use ONLY when agents mutate files in parallel and would otherwise conflict; the worktree is auto-removed if unchanged. Children receive normal built-ins and trust-appropriate extensions, settings, skills, and AGENTS.md context, but cannot recursively orchestrate or ask the user.",
  "• await pipeline(items, stage1, stage2, ...) — run each item through all stages independently, NO barrier between stages. Item A can be in stage 3 while item B is still in stage 1. This is the DEFAULT for multi-stage work. Wall-clock = slowest single-item chain, not sum-of-slowest-per-stage. Every stage callback receives (prevResult, originalItem, index) — use originalItem/index in later stages to label work without threading context through stage 1's return value. A stage that throws drops that item to `null` and skips its remaining stages, so `.filter(Boolean)` the results.",
  "• await parallel([() => agent(...), () => agent(...)], { concurrency? }) — run zero-argument thunks concurrently and return results in order. This is a BARRIER: it awaits every thunk before returning. Use ONLY when you genuinely need all results together. A thunk that throws resolves to `null` in the result array — the call itself never rejects, so `.filter(Boolean)` before using the results.",
  "• log(message) — emit a progress line to the user; it is also replayed in the run's completion report.",
  "• args — the parsed value of the `args` tool parameter (or undefined).",
  '• await workflow(name, args?) — run a saved workflow inline as a sub-step and return whatever it returns. The child shares this run\'s concurrency cap, agent counter, abort signal, and budget; its agents appear under a "▸ name" log line. Nesting is one level only: workflow() inside a nested run throws. Throws on an unknown name or a child syntax error; catch to handle gracefully.',
  "• budget: {total: number|null, spent(): number, remaining(): number} — the run's output-token target, from the `budgetTokens` parameter or the user's /workflow-budget default. `budget.total` is null if no target was set. The target is a HARD ceiling, not advisory: once `spent()` reaches `total`, further `agent()` calls throw. Use for dynamic loops: `while (budget.total && budget.remaining() > 50_000) { ... }`, or static scaling: `const FLEET = budget.total ? Math.floor(budget.total / 100_000) : 5`.",
  "",
  "Every agent() call must be awaited — the run fails if the script returns with an unawaited or unsettled call. Pass a `schema` whenever a later step branches on the result, so you get typed fields instead of prose.",
  "",
  "Workflow JavaScript runs in a restricted, killable child with no imports, eval, timers, filesystem, network, or process APIs. Concurrent agent() calls are capped run-wide at min(16, cpu cores - 2) — excess calls queue and run as slots free up, nested parallel() calls queue behind the same limit rather than multiplying it, and pipeline() holds no script-level slot at all. You can still pass 100 items to parallel()/pipeline() and they all complete; only that many run at any moment. Total agent count across a workflow's lifetime is capped at 1000 — a runaway-loop backstop set far above any real workflow; past it, calls resolve null. A single parallel()/pipeline() call accepts at most 4096 items; passing more is an explicit error, not a silent truncation. There is no overall deadline, but each agent must receive its first assistant response event within 45 seconds so silent provider requests fail clearly, goes 3 minutes without progress before being aborted as stalled, and each individual child tool call times out after 30 minutes, becomes an error tool result, and leaves that agent free to recover. Artifacts are saved under ~/.pi/agent/workflows/<runId>/ for inspection.",
  "",
  "DEFAULT TO pipeline(). Only reach for a barrier (parallel between stages) when you genuinely need ALL prior-stage results together.",
  "",
  "A barrier is correct ONLY when stage N needs cross-item context from all of stage N-1:",
  "- Dedup/merge across the full result set before expensive downstream work",
  '- Early-exit if the total count is zero ("0 bugs found → skip verification entirely")',
  '- Stage N\'s prompt references "the other findings" for comparison',
  "",
  "A barrier is NOT justified by:",
  '- "I need to flatten/map/filter first" — do it inside a pipeline stage: pipeline(items, stageA, (r) => transform([r]).flat(), stageB)',
  '- "The stages are conceptually separate" — that\'s what pipeline() models. Separate stages ≠ synchronized stages.',
  "- \"It's cleaner code\" — barrier latency is real. If 5 finders run and the slowest takes 3× the fastest, a barrier wastes 2/3 of the fast finders' idle time.",
  "",
  "Smell test: if you wrote",
  "  const a = await parallel(...)",
  "  const b = a.filter((r) => r.ok).map(...)   // no cross-item dependency",
  "  const c = await parallel(b.map(...))",
  "that middle transform doesn't need the barrier. Rewrite as a pipeline with the transform inside a stage. When in doubt: pipeline.",
  "",
  "The canonical multi-stage pattern — pipeline by default, each dimension verifies as soon as its review completes:",
  "  export const meta = {",
  "    name: 'review-changes',",
  "    description: 'Review changed files across dimensions, verify each finding',",
  "    phases: [{ title: 'Review' }, { title: 'Verify' }],",
  "  }",
  "  const DIMENSIONS = [{key: 'bugs', prompt: '...'}, {key: 'perf', prompt: '...'}]",
  "  const results = await pipeline(",
  "    DIMENSIONS,",
  "    d => agent(d.prompt, {label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA}),",
  "    review => parallel(review.findings.map(f => () =>",
  "      agent(`Adversarially verify: ${f.title}`, {label: `verify:${f.file}`, phase: 'Verify', schema: VERDICT_SCHEMA})",
  "        .then(v => ({...f, verdict: v}))",
  "    ))",
  "  )",
  "  const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.isReal)",
  "  return { confirmed }",
  "  // Dimension 'bugs' findings verify while dimension 'perf' is still reviewing. No wasted wall-clock.",
  "",
  "When a barrier IS correct — dedup across all findings before expensive verification:",
  "  const all = await parallel(DIMENSIONS.map(d => () => agent(d.prompt, {schema: FINDINGS_SCHEMA})))",
  "  const deduped = dedupeByFileAndLine(all.filter(Boolean).flatMap(r => r.findings))  // <-- genuinely needs ALL at once",
  "  const verified = await parallel(deduped.map(f => () => agent(verifyPrompt(f), {schema: VERDICT_SCHEMA})))",
  "",
  "Loop-until-count pattern — accumulate to a target:",
  "  const bugs = []",
  "  while (bugs.length < 10) {",
  '    const result = await agent("Find bugs in this codebase.", {schema: BUGS_SCHEMA})',
  "    bugs.push(...(result?.bugs ?? []))",
  "    log(`${bugs.length}/10 found`)",
  "  }",
  "",
  "Loop-until-budget pattern — scale depth to the user's token target. Guard on budget.total: with no target set, remaining() is Infinity and the loop would run straight to the 1000-agent cap.",
  "  const bugs = []",
  "  while (budget.total && budget.remaining() > 50_000) {",
  '    const result = await agent("Find bugs in this codebase.", {schema: BUGS_SCHEMA})',
  "    bugs.push(...(result?.bugs ?? []))",
  "    log(`${bugs.length} found, ${Math.round(budget.remaining()/1000)}k remaining`)",
  "  }",
  "",
  "Composing patterns — exhaustive review (find → dedup vs seen → diverse-lens panel → loop-until-dry):",
  "  const seen = new Set(), confirmed = []",
  "  let dry = 0",
  "  while (dry < 2) {                                              // loop-until-dry",
  "    const found = (await parallel(FINDERS.map(f => () =>          // barrier: collect all finders this round",
  "      agent(f.prompt, {phase: 'Find', schema: BUGS})))).filter(Boolean).flatMap(r => r.bugs)",
  "    const fresh = found.filter(b => !seen.has(key(b)))           // dedup vs ALL seen — plain code, not an agent",
  "    if (!fresh.length) { dry++; continue }",
  "    dry = 0; fresh.forEach(b => seen.add(key(b)))",
  "    const judged = await parallel(fresh.map(b => () =>           // every fresh bug judged concurrently...",
  "      parallel(['correctness','security','repro'].map(lens => () =>   // ...each by 3 distinct lenses",
  "        agent(`Judge \"${b.desc}\" via the ${lens} lens — real?`, {phase: 'Verify', schema: VERDICT})))",
  "        .then(vs => ({ b, real: vs.filter(Boolean).filter(v => v.real).length >= 2 }))))",
  "    confirmed.push(...judged.filter(v => v.real).map(v => v.b))",
  "  }",
  "  return confirmed",
  "  // dedup vs `seen`, NOT `confirmed` — else judge-rejected findings reappear every round and it never converges.",
  "",
  "Quality patterns — common shapes; pick by task and compose freely:",
  "- Adversarial verify: spawn N independent skeptics per finding, each prompted to REFUTE. Kill it if a majority refute. Prevents plausible-but-wrong findings from surviving.",
  "- Perspective-diverse verify: when a finding can fail in more than one way, give each verifier a distinct lens (correctness, security, perf, does-it-reproduce) instead of N identical refuters — diversity catches failure modes redundancy can't.",
  "- Judge panel: generate N independent attempts from different angles (MVP-first, risk-first, user-first), score with parallel judges, synthesize from the winner while grafting the best ideas from runners-up. Beats one-attempt-iterated when the solution space is wide.",
  "- Multi-modal sweep: parallel agents each searching a different way (by-file, by-symbol, by-entity, by-history). Each is blind to what the others surface; useful when one search angle won't find everything.",
  '- Completeness critic: a final agent that asks "what\'s missing — angle not tried, claim unverified, source unread?" What it finds becomes the next round of work.',
  '- No silent caps: if a workflow bounds coverage (top-N, no-retry, sampling) or loses agents to `ok: false`, `log()` what was dropped and put it in the returned aggregate — silent truncation reads as "covered everything" when it didn\'t.',
  "",
  'Scale to what the user asked for. "find any bugs" → a few finders, single-vote verify. "thoroughly audit this" or "be comprehensive" → larger finder pool, 3–5 vote adversarial pass, synthesis stage. When unsure, lean toward thoroughness for research/review/audit requests and toward brevity for quick checks.',
  "",
  "These patterns aren't exhaustive — compose novel harnesses when the task calls for it (tournament brackets, self-repair loops, staged escalation, whatever fits).",
  "",
  "Use this tool for multi-step orchestration where control flow should be deterministic (loops, conditionals, fan-out) rather than model-driven. Use map/filter/if/await/template strings to orchestrate, and `return` a JSON-serializable aggregate.",
  "",
  "## Resume",
  "",
  "The tool result includes a runId. To resume after an abort, a failure, or a script edit, relaunch with the corrected script and `resumeFromRunId` set to that id — the longest unchanged prefix of agent() calls returns cached results instantly; the first edited or new call, and everything after it, runs live. Same script + same args → 100% cache hit. A call matches only if both its prompt and its options are byte-identical, so vary nothing you do not intend to re-run. Before diagnosing why a completed workflow returned an empty or unexpected result, read ~/.pi/agent/workflows/<runId>/journal.jsonl — it records each agent's actual return value; do not assume cached results are non-empty. Prompts built from Date.now()/Math.random() differ on every replay and will always miss the cache; pass such values in through `args` instead.",
].join("\n");

/** Adds workflow orchestration primitives and background execution to the model's tool prompt. */
export const WORKFLOW_PROMPT_SNIPPET =
  "Orchestrate isolated subagents from an inline JS script: phase()/agent()/pipeline()/parallel()/log() with structured outputs and optional background execution";

/** Guides the model on appropriate workflow fan-out and mandatory agent result checks. */
export const WORKFLOW_PROMPT_GUIDELINES = [
  "Do not use the workflow tool unless the user requested it — keep single small delegations in the main session",
  "In workflow scripts, agent() never throws — always check `.ok` on its result before using `.output`/`.structured`",
];

/** Marks and forwards a workflow script's agent() task as an isolated child-model prompt. */
export function buildWorkflowAgentPrompt(prompt: string) {
  return prompt;
}

/** Frames a plain workflow child's final text as the script's return value, not a human-facing reply. */
export const WORKFLOW_AGENT_SYSTEM_INSTRUCTION = [
  "You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.",
  "",
  "Your final text response is returned verbatim as a string to the calling script — it is your return value, not a message to a human.",
  '- Output the literal result (data, JSON, text). Do NOT output confirmations like "Done." or "Here you go."',
  "- If asked for JSON, return ONLY the raw JSON — no code fences, no prose, no markdown.",
  "- Be concise. The script will parse your output.",
].join("\n");

/** Instructs structured workflow children to terminate with exactly one structured_output call. */
export const STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION = [
  "You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.",
  "",
  "You MUST call the `structured_output` tool exactly once to return your final answer. The tool's input schema defines the required shape.",
  "- Do your work (read files, run commands, etc.), then call `structured_output` with your answer.",
  "- Do NOT put your answer in a text response. The script reads ONLY the `structured_output` tool call.",
  "- If schema validation fails, read the error and call `structured_output` again with a corrected shape.",
  "- After calling `structured_output` successfully, end your turn. No acknowledgment needed.",
].join("\n");

/** Describes the terminating structured_output tool and its final-action contract. */
export const STRUCTURED_OUTPUT_TOOL_DESCRIPTION =
  "Return your final result as structured data matching the required schema. Call this exactly once, as your last action; do not write any other text after it.";

/** Builds the workflow completion report returned to the parent model. */
export function buildWorkflowResultMessage(
  details: WorkflowDetails,
  runDir: string,
) {
  const { done, failed } = countStates(details);
  const elapsed = formatElapsed(details.startedAt, details.finishedAt);
  const lines = [
    `Workflow ${details.name ? `"${details.name}"` : details.runId} ${details.status} — ` +
      `${done}/${details.agents.length} agents ok${failed ? `, ${failed} failed` : ""} ` +
      `across ${details.phases.length} phase(s) in ${elapsed}.`,
    `Run dir: ${shortenHome(runDir)}`,
  ];
  const cached = details.agents.filter((agent) => agent.cached).length;
  if (cached > 0)
    lines.push(`Replayed ${cached} cached agent(s) from journal.`);
  if (details.status !== "completed") {
    lines.push(
      `To resume after fixing the script: workflow({ script, resumeFromRunId: "${details.runId}" }) — unchanged agent() calls return cached.`,
    );
  }
  if (details.error) lines.push(`Error: ${details.error}`);
  if (details.agents.length > 0) {
    lines.push("", "Agents:");
    for (const agent of details.agents) {
      const status =
        agent.state === "done"
          ? "ok"
          : agent.state === "error"
            ? "FAILED"
            : "running";
      lines.push(
        `- [${agent.label}]${agent.phase ? ` (${agent.phase})` : ""} ${status}` +
          (agent.error ? ` — ${agent.error}` : ""),
      );
    }
  }
  if (details.logs?.length) {
    lines.push("", "Log:");
    for (const message of details.logs) lines.push(`- ${message}`);
  }
  if (details.result !== undefined)
    lines.push("", "Result:", resultJson(details.result));
  return lines.join("\n");
}

/** Builds the follow-up user message that delivers a settled background workflow to the parent model. */
export function buildBackgroundWorkflowFollowUp(options: {
  runId: string;
  status: WorkflowDetails["status"];
  result: string;
}) {
  return `[Background workflow ${options.runId} ${options.status}]\n\n${options.result}`;
}

/** Builds the background-launch result and tells the parent model where progress and artifacts appear. */
export function buildBackgroundWorkflowLaunchResult(options: {
  runId: string;
  name?: string;
  runDir: string;
}) {
  return [
    `Workflow ${options.name ? `"${options.name}"` : options.runId} launched in background (run ${options.runId}).`,
    `Artifacts: ${shortenHome(options.runDir)}`,
    "You'll receive a follow-up message when it finishes; /workflows shows progress.",
  ].join("\n");
}
