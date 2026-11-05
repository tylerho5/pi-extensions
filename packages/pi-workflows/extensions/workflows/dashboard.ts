/**
 * /workflows dashboard: a full-screen overlay with a run list and a per-run
 * detail view (phases sidebar + agents panel), modeled after:
 *
 *   name                                             5/5 agents · 31m18s · done
 *   description
 *   ╭ Phases ────────────╮ ╭ Gather · 3 agents ──────────────────────────────╮
 *   │ ❯ ■ Gather     3/3 │ │ ■ CodeRabbit feedback   gpt-5 · 7%/372k  5m37s│
 *   │   ■ Verify     1/1 │ │ ■ Other bot feedback    gpt-5 · 9%/372k  4m43s│
 *   ╰────────────────────╯ ╰─────────────────────────────────────────────────╯
 *   up/down select · esc back · s save report
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  getAgentDir,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type TUI,
} from "@earendil-works/pi-tui";
import { hydrateWorkflowResult, isRunLiveFromDisk } from "./artifacts.ts";
import { writeFileAtomic } from "./serialization.ts";
import {
  agentContext,
  agentModelLabel,
  agentStateWord,
  countStates,
  formatElapsed,
  formatUsage,
  aggregateUsage,
  normalizeTranscript,
  phaseGroups,
  resultJson,
  shortenHome,
  stateSquare,
  statusColor,
  statusWord,
  SQUARE,
  type Theme,
  type AgentRecord,
  type PhaseGroup,
  type TranscriptEntry,
  type WorkflowDetails,
} from "./model.ts";

const NOTICE_TTL_MS = 4000;
const MIN_HEIGHT = 10;
const TRANSCRIPT_SCROLL_STEP = 20;

function wrapSelection(index: number, delta: number, length: number): number {
  if (length === 0) return 0;
  return (index + delta + length) % length;
}

export interface RunEntry {
  runId: string;
  details: WorkflowDetails;
  live: boolean;
  resumable: boolean;
  resumeActive: boolean;
}

export interface WorkflowDashboardControls {
  stop(runId: string): void;
  pause(runId: string): void;
  skipAgent(runId: string, index: number): boolean;
  retryAgent(runId: string, index: number): boolean;
  resume(runId: string): Promise<void>;
}

export type WorkflowControlAction =
  | { action: "stop"; runId: string }
  | { action: "pause"; runId: string }
  | { action: "skipAgent"; runId: string; index: number }
  | { action: "retryAgent"; runId: string; index: number }
  | { action: "resume"; runId: string };

export function resolveWorkflowControlAction(selection: {
  key: string;
  run?: RunEntry;
  agent?: AgentRecord;
  focus?: "run" | "agent";
}): WorkflowControlAction | undefined {
  const { key, run, agent, focus = "run" } = selection;
  if (!run) return undefined;
  const { runId, details, live } = run;
  if (key === "x") {
    if (focus === "agent") {
      return live && details.status === "running" && agent?.state === "running"
        ? { action: "skipAgent", runId, index: agent.index }
        : undefined;
    }
    return live &&
      (details.status === "running" || details.status === "stopping")
      ? { action: "stop", runId }
      : undefined;
  }
  if (key === "p") {
    return focus === "run" && live && details.status === "running"
      ? { action: "pause", runId }
      : undefined;
  }
  if (key === "r") {
    if (focus === "agent") {
      return !live &&
        run.resumable &&
        !run.resumeActive &&
        agent &&
        (agent.state === "error" ||
          agent.state === "skipped" ||
          agent.state === "interrupted")
        ? { action: "retryAgent", runId, index: agent.index }
        : undefined;
    }
    return !live &&
      run.resumable &&
      !run.resumeActive &&
      (details.status === "paused" || details.status === "interrupted")
      ? { action: "resume", runId }
      : undefined;
  }
  return undefined;
}

/**
 * Why a run cannot be resumed: the journal was not written completely, or the
 * run has no saved script. Undefined when the run can be resumed, or when a
 * live replay of it is the only thing blocking a resume. A live run still gets
 * a reason: it is running now and will not be resumable once it settles.
 */
export function resumeUnavailableReason(run: RunEntry): string | undefined {
  if (run.resumeActive) return undefined;
  if (run.details.resumable === false)
    return run.details.resumeError ?? "journal is non-resumable";
  if (!run.resumable) return "no saved script to resume from";
  return undefined;
}

/** Explains a refused `r` press instead of letting the key fall through. */
export function resolveWorkflowControlNotice(selection: {
  key: string;
  run?: RunEntry;
  focus?: "run" | "agent";
}): string | undefined {
  const { key, run, focus = "run" } = selection;
  if (key !== "r" || focus !== "run" || !run) return undefined;
  if (run.live) return undefined;
  const reason = resumeUnavailableReason(run);
  return reason ? `cannot resume: ${reason}` : undefined;
}

function runsDir(): string {
  return path.join(getAgentDir(), "workflows");
}

/** Leniently normalize a workflow.json (including runs from older tooling). */
function normalizeDetails(
  runId: string,
  raw: unknown,
): WorkflowDetails | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const meta = (record.meta ?? {}) as Record<string, unknown>;

  const rawAgents = Array.isArray(record.agents) ? record.agents : [];
  const startedAt = typeof record.startedAt === "number" ? record.startedAt : 0;
  const agents: AgentRecord[] = [];
  for (const item of rawAgents) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    const state =
      a.state === "error" || a.state === "failed"
        ? "error"
        : a.state === "running"
          ? "running"
          : a.state === "skipped" || a.state === "interrupted"
            ? a.state
            : "done";
    agents.push({
      index: typeof a.index === "number" ? a.index : agents.length + 1,
      label:
        typeof a.label === "string" ? a.label : `agent-${agents.length + 1}`,
      phase: typeof a.phase === "string" ? a.phase : undefined,
      state,
      model: typeof a.model === "string" ? a.model : undefined,
      requestedModel:
        typeof a.requestedModel === "string" ? a.requestedModel : undefined,
      contextWindow:
        typeof a.contextWindow === "number" &&
        Number.isFinite(a.contextWindow) &&
        a.contextWindow > 0
          ? a.contextWindow
          : undefined,
      startedAt: typeof a.startedAt === "number" ? a.startedAt : startedAt,
      finishedAt: typeof a.finishedAt === "number" ? a.finishedAt : undefined,
      attempts:
        typeof a.attempts === "number" &&
        Number.isInteger(a.attempts) &&
        a.attempts > 0
          ? a.attempts
          : undefined,
      error:
        typeof a.error === "string" && a.error !== "[undefined]"
          ? a.error
          : undefined,
      preview: typeof a.preview === "string" ? a.preview : "",
      transcriptOmitted:
        typeof a.transcriptOmitted === "string"
          ? a.transcriptOmitted
          : undefined,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
        ...(a.usage && typeof a.usage === "object" ? (a.usage as object) : {}),
      },
      transcript: normalizeTranscript(a.transcript),
    });
  }

  const rawPhases = Array.isArray(record.phases)
    ? record.phases
    : Array.isArray(meta.phases)
      ? meta.phases
      : [];
  const phases: WorkflowDetails["phases"] = [];
  for (const item of rawPhases) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    if (typeof p.title !== "string") continue;
    phases.push({
      title: p.title,
      ...(typeof p.detail === "string" ? { detail: p.detail } : {}),
    });
  }

  const status =
    record.status === "running" ||
    record.status === "stopping" ||
    record.status === "paused" ||
    record.status === "interrupted" ||
    record.status === "failed" ||
    record.status === "aborted"
      ? record.status
      : "completed";

  return {
    runId,
    resumedFromRunId:
      typeof record.resumedFromRunId === "string"
        ? record.resumedFromRunId
        : undefined,
    sessionId:
      typeof record.sessionId === "string" ? record.sessionId : undefined,
    name:
      typeof record.name === "string"
        ? record.name
        : typeof meta.name === "string"
          ? meta.name
          : undefined,
    description:
      typeof record.description === "string"
        ? record.description
        : typeof meta.description === "string"
          ? meta.description
          : undefined,
    background: record.background === true,
    status,
    startedAt,
    finishedAt:
      typeof record.finishedAt === "number" ? record.finishedAt : undefined,
    phases,
    currentPhase:
      typeof record.currentPhase === "string" ? record.currentPhase : undefined,
    agents,
    result: record.result,
    resultArtifact:
      typeof record.resultArtifact === "string"
        ? record.resultArtifact
        : undefined,
    resultOmitted:
      typeof record.resultOmitted === "string"
        ? record.resultOmitted
        : undefined,
    transcriptArtifact:
      typeof record.transcriptArtifact === "string"
        ? record.transcriptArtifact
        : undefined,
    resumable: record.resumable === false ? false : undefined,
    resumeError:
      typeof record.resumeError === "string" ? record.resumeError : undefined,
    deliveryFailure:
      record.deliveryFailure &&
      typeof record.deliveryFailure === "object" &&
      typeof (record.deliveryFailure as Record<string, unknown>).error ===
        "string" &&
      typeof (record.deliveryFailure as Record<string, unknown>).reportPath ===
        "string"
        ? (record.deliveryFailure as WorkflowDetails["deliveryFailure"])
        : undefined,
    error: typeof record.error === "string" ? record.error : undefined,
  };
}

export function sessionWorkflowRunIds(ctx: ExtensionContext): Set<string> {
  const runIds = new Set<string>();
  for (const entry of ctx.sessionManager.getEntries()) {
    if (
      entry.type !== "message" ||
      entry.message.role !== "toolResult" ||
      entry.message.toolName !== "workflow"
    ) {
      continue;
    }
    const details = entry.message.details;
    if (!details || typeof details !== "object") continue;
    const runId = (details as Record<string, unknown>).runId;
    if (typeof runId === "string") runIds.add(runId);
  }
  return runIds;
}

export function loadRunEntries(
  active: Map<string, WorkflowDetails>,
  sessionId: string,
  referencedRunIds: ReadonlySet<string>,
  options: { now?: () => number } = {},
): RunEntry[] {
  const now = options.now ?? Date.now;
  let names: string[] = [];
  try {
    names = fs.readdirSync(runsDir()).filter((name) => name.startsWith("wf_"));
  } catch {
    // No runs yet.
  }
  const entries: RunEntry[] = [];
  for (const runId of names) {
    const live = active.get(runId);
    if (live) {
      entries.push({
        runId,
        details: live,
        live: true,
        resumable: fs.existsSync(path.join(runsDir(), runId, "script.js")),
        resumeActive: false,
      });
      continue;
    }
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(runsDir(), runId, "workflow.json"), "utf8"),
      );
      const normalized = normalizeDetails(runId, raw);
      if (
        normalized &&
        (normalized.sessionId === sessionId || referencedRunIds.has(runId))
      ) {
        const runDir = path.join(runsDir(), runId);
        const details = hydrateWorkflowResult(runDir, normalized);
        if (details.status === "running" || details.status === "stopping") {
          // Liveness has an authority outside this process: the run's own
          // heartbeat. Only a run that is not live from disk is recovered.
          const liveFromDisk = isRunLiveFromDisk(runDir, now);
          if (!liveFromDisk) {
            details.status = "interrupted";
            details.finishedAt = details.finishedAt ?? now();
            details.error =
              details.error ?? "Recovered stale run that was not active";
            for (const agent of details.agents) {
              if (agent.state !== "running") continue;
              agent.state = "interrupted";
              agent.error =
                agent.error ?? "Run ended before this agent settled";
              agent.finishedAt = details.finishedAt;
            }
            const persisted = raw as Record<string, unknown>;
            persisted.status = details.status;
            persisted.finishedAt = details.finishedAt;
            persisted.error = details.error;
            if (Array.isArray(persisted.agents)) {
              for (const item of persisted.agents) {
                if (!item || typeof item !== "object") continue;
                const agent = item as Record<string, unknown>;
                if (agent.state !== "running") continue;
                agent.state = "interrupted";
                agent.error =
                  agent.error ?? "Run ended before this agent settled";
                agent.finishedAt = details.finishedAt;
              }
            }
            try {
              writeFileAtomic(
                path.join(runDir, "workflow.json"),
                JSON.stringify(persisted),
              );
            } catch {
              // Keep the recovered state visible even if the artifact is read-only.
            }
          }
          entries.push({
            runId,
            details,
            live: liveFromDisk,
            resumable:
              details.resumable !== false &&
              fs.existsSync(path.join(runDir, "script.js")),
            resumeActive: false,
          });
          continue;
        }
        entries.push({
          runId,
          details,
          live: false,
          resumable:
            details.resumable !== false &&
            fs.existsSync(path.join(runDir, "script.js")),
          resumeActive: false,
        });
      }
    } catch {
      // Skip unreadable runs.
    }
  }
  const resumedFrom = new Set(
    entries
      .filter((entry) => entry.live && entry.details.resumedFromRunId)
      .map((entry) => entry.details.resumedFromRunId!),
  );
  for (const entry of entries)
    entry.resumeActive = resumedFrom.has(entry.runId);
  return entries.sort((a, b) => b.details.startedAt - a.details.startedAt);
}

function buildReport(entry: RunEntry): string {
  const details = entry.details;
  const { done, failed, skipped, interrupted } = countStates(details);
  const lines: string[] = [
    `# Workflow ${details.name ?? details.runId}`,
    "",
    `- Run: ${details.runId}`,
    `- Status: ${statusWord(details.status)}`,
    `- Agents: ${done}/${details.agents.length} ok${failed ? `, ${failed} failed` : ""}${skipped ? `, ${skipped} skipped` : ""}${interrupted ? `, ${interrupted} interrupted` : ""}`,
    `- Elapsed: ${formatElapsed(details.startedAt, details.finishedAt)}`,
  ];
  const totals = formatUsage(aggregateUsage(details.agents));
  if (totals) lines.push(`- Usage: ${totals}`);
  if (details.description) lines.push("", details.description);
  if (details.error) lines.push("", `**Error:** ${details.error}`);
  if (details.resultOmitted)
    lines.push("", `**Result omitted:** ${details.resultOmitted}`);
  if (details.deliveryFailure)
    lines.push(
      "",
      `**Follow-up delivery failed:** ${details.deliveryFailure.error}`,
      `Report: ${details.deliveryFailure.reportPath}`,
    );
  const resumeReason = resumeUnavailableReason(entry);
  if (resumeReason) lines.push("", `**Resume unavailable:** ${resumeReason}`);

  for (const group of phaseGroups(details, true)) {
    lines.push("", `## ${group.title}`, "");
    if (group.agents.length === 0) {
      lines.push("_no agents_");
      continue;
    }
    for (const agent of group.agents) {
      const status = agentStateWord(agent.state);
      const stats = [
        agentModelLabel(agent),
        agentContext(agent),
        formatElapsed(agent.startedAt, agent.finishedAt),
      ]
        .filter(Boolean)
        .join(" · ");
      lines.push(
        `- **${agent.label}** — ${status}${stats ? ` (${stats})` : ""}`,
      );
      if (agent.error) lines.push(`  - error: ${agent.error}`);
    }
  }

  if (details.result !== undefined) {
    lines.push(
      "",
      "## Result",
      "",
      "```json",
      resultJson(details.result),
      "```",
    );
  }
  lines.push("");
  return lines.join("\n");
}

type View = "list" | "detail" | "transcript";
type DetailFocus = "phases" | "agents";

export class WorkflowDashboard {
  private view: View = "list";
  private entries: RunEntry[] = [];
  private listIndex = 0;
  private phaseIndex = 0;
  private agentIndex = 0;
  private detailFocus: DetailFocus = "phases";
  private transcriptScroll = 0;
  private transcriptRowCount = 0;
  private transcriptViewportSize = 1;
  private current?: RunEntry;
  private notice?: string;
  private noticeAt = 0;
  private disposed = false;
  private timer: ReturnType<typeof setInterval>;
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private getActive: () => Map<string, WorkflowDetails>;
  private sessionId: string;
  private referencedRunIds: ReadonlySet<string>;
  private close: () => void;
  private controls?: WorkflowDashboardControls;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    getActive: () => Map<string, WorkflowDetails>,
    sessionId: string,
    referencedRunIds: ReadonlySet<string>,
    close: () => void,
    initialRunId?: string,
    controls?: WorkflowDashboardControls,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.getActive = getActive;
    this.sessionId = sessionId;
    this.referencedRunIds = referencedRunIds;
    this.close = close;
    this.controls = controls;
    this.refresh();
    if (initialRunId) {
      const entry = this.entries.find(
        (e) => e.runId === initialRunId || e.runId.endsWith(initialRunId),
      );
      if (entry) {
        this.current = entry;
        this.listIndex = this.entries.indexOf(entry);
        this.view = "detail";
      }
    }
    this.timer = setInterval(() => {
      if (
        this.entries.some((e) => e.live) ||
        this.current?.live ||
        this.notice
      ) {
        this.refresh();
        this.tui.requestRender();
      }
    }, 500);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
  }

  invalidate() {}

  private refresh() {
    const selected = this.entries[this.listIndex]?.runId;
    this.entries = loadRunEntries(
      this.getActive(),
      this.sessionId,
      this.referencedRunIds,
    );
    if (selected) {
      const index = this.entries.findIndex((e) => e.runId === selected);
      if (index >= 0) this.listIndex = index;
    }
    this.listIndex = Math.min(
      this.listIndex,
      Math.max(0, this.entries.length - 1),
    );
    if (this.current) {
      const refreshed = this.entries.find(
        (e) => e.runId === this.current?.runId,
      );
      if (refreshed) this.current = refreshed;
    }
    if (this.notice && Date.now() - this.noticeAt > NOTICE_TTL_MS)
      this.notice = undefined;
  }

  private groups(): PhaseGroup[] {
    if (!this.current) return [];
    return phaseGroups(this.current.details, true);
  }

  private selectedGroup(): PhaseGroup | undefined {
    return this.groups()[this.phaseIndex];
  }

  private selectedAgent(): AgentRecord | undefined {
    return this.selectedGroup()?.agents[this.agentIndex];
  }

  private clampAgentIndex() {
    const agents = this.selectedGroup()?.agents ?? [];
    this.agentIndex = Math.min(this.agentIndex, Math.max(0, agents.length - 1));
  }

  private saveReport() {
    const entry = this.current;
    if (!entry) return;
    const target = path.join(runsDir(), entry.runId, "report.md");
    try {
      fs.writeFileSync(target, buildReport(entry), "utf8");
      this.notice = `saved ${shortenHome(target)}`;
    } catch (error) {
      this.notice = `save failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.noticeAt = Date.now();
  }

  private applyControlAction(action: WorkflowControlAction) {
    const controls = this.controls;
    if (!controls) return;
    try {
      switch (action.action) {
        case "stop":
          controls.stop(action.runId);
          break;
        case "pause":
          controls.pause(action.runId);
          break;
        case "skipAgent":
          if (!controls.skipAgent(action.runId, action.index))
            this.notice = "agent is no longer running";
          break;
        case "retryAgent":
          if (!controls.retryAgent(action.runId, action.index))
            this.notice = "agent cannot be retried";
          break;
        case "resume":
          void controls.resume(action.runId).catch((error) => {
            this.notice =
              error instanceof Error ? error.message : String(error);
            this.noticeAt = Date.now();
            this.tui.requestRender();
          });
          break;
      }
    } catch (error) {
      this.notice = error instanceof Error ? error.message : String(error);
    }
    this.noticeAt = Date.now();
  }

  handleInput(data: string) {
    const up = this.keybindings.matches(data, "tui.select.up") || data === "k";
    const down =
      this.keybindings.matches(data, "tui.select.down") || data === "j";
    const left =
      this.keybindings.matches(data, "tui.editor.cursorLeft") || data === "h";
    const right =
      this.keybindings.matches(data, "tui.editor.cursorRight") || data === "l";
    const confirm = this.keybindings.matches(data, "tui.select.confirm");
    const cancel = this.keybindings.matches(data, "tui.select.cancel");
    const selectedRun =
      this.view === "list" ? this.entries[this.listIndex] : this.current;
    const focus =
      this.view !== "list" && this.detailFocus === "agents" ? "agent" : "run";
    const controlAction = resolveWorkflowControlAction({
      key: data,
      run: selectedRun,
      agent: focus === "agent" ? this.selectedAgent() : undefined,
      focus,
    });
    if (controlAction) {
      this.applyControlAction(controlAction);
      this.refresh();
      this.tui.requestRender();
      return;
    }
    const controlNotice = resolveWorkflowControlNotice({
      key: data,
      run: selectedRun,
      focus,
    });
    if (controlNotice) {
      this.notice = controlNotice;
      this.noticeAt = Date.now();
      this.tui.requestRender();
      return;
    }

    if (this.view === "list") {
      if (up) {
        this.listIndex = wrapSelection(this.listIndex, -1, this.entries.length);
      } else if (down) {
        this.listIndex = wrapSelection(this.listIndex, 1, this.entries.length);
      } else if (data === "g") {
        this.listIndex = 0;
      } else if (data === "G") {
        this.listIndex = Math.max(0, this.entries.length - 1);
      } else if (confirm) {
        const entry = this.entries[this.listIndex];
        if (entry) {
          this.current = entry;
          this.phaseIndex = 0;
          this.agentIndex = 0;
          this.detailFocus = "phases";
          this.view = "detail";
        }
      } else if (cancel) {
        this.close();
        return;
      }
    } else if (this.view === "detail") {
      if (this.detailFocus === "phases") {
        if (up) {
          this.phaseIndex = wrapSelection(
            this.phaseIndex,
            -1,
            this.groups().length,
          );
          this.agentIndex = 0;
        } else if (down) {
          this.phaseIndex = wrapSelection(
            this.phaseIndex,
            1,
            this.groups().length,
          );
          this.agentIndex = 0;
        } else if (data === "g") {
          this.phaseIndex = 0;
          this.agentIndex = 0;
        } else if (data === "G") {
          this.phaseIndex = Math.max(0, this.groups().length - 1);
          this.agentIndex = 0;
        } else if (
          right ||
          (confirm && (this.selectedGroup()?.agents.length ?? 0) > 0)
        ) {
          if ((this.selectedGroup()?.agents.length ?? 0) > 0) {
            this.detailFocus = "agents";
            this.clampAgentIndex();
          }
        } else if (cancel) {
          this.view = "list";
          this.refresh();
        }
      } else {
        const agents = this.selectedGroup()?.agents ?? [];
        if (up) {
          this.agentIndex = wrapSelection(this.agentIndex, -1, agents.length);
        } else if (down) {
          this.agentIndex = wrapSelection(this.agentIndex, 1, agents.length);
        } else if (data === "g") {
          this.agentIndex = 0;
        } else if (data === "G") {
          this.agentIndex = Math.max(0, agents.length - 1);
        } else if (left || cancel) {
          this.detailFocus = "phases";
        } else if (confirm && this.selectedAgent()) {
          this.transcriptScroll = 0;
          this.view = "transcript";
        }
      }
      if (data === "s") this.saveReport();
    } else {
      const maxScroll = Math.max(
        0,
        this.transcriptRowCount - this.transcriptViewportSize,
      );
      const scrollStep =
        data === "j" || data === "k" ? TRANSCRIPT_SCROLL_STEP : 1;
      const pageStep = Math.max(1, this.transcriptViewportSize - 2);
      if (up) {
        this.transcriptScroll = Math.max(0, this.transcriptScroll - scrollStep);
      } else if (down) {
        this.transcriptScroll = Math.min(
          maxScroll,
          this.transcriptScroll + scrollStep,
        );
      } else if (matchesKey(data, Key.ctrl("u"))) {
        this.transcriptScroll = Math.max(0, this.transcriptScroll - pageStep);
      } else if (matchesKey(data, Key.ctrl("d"))) {
        this.transcriptScroll = Math.min(
          maxScroll,
          this.transcriptScroll + pageStep,
        );
      } else if (data === "g") {
        this.transcriptScroll = 0;
      } else if (data === "G") {
        this.transcriptScroll = maxScroll;
      } else if (cancel || left) {
        this.view = "detail";
        this.detailFocus = "agents";
      }
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const height = Math.max(MIN_HEIGHT, this.tui.terminal.rows - 1);
    let lines: string[];
    if (this.view === "transcript" && this.current && this.selectedAgent()) {
      lines = this.renderTranscript(
        this.current.details,
        this.selectedAgent()!,
        width,
        height,
      );
    } else if (this.view === "detail" && this.current) {
      lines = this.renderDetail(this.current, width, height);
    } else {
      lines = this.renderList(width, height);
    }
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  /** Compose `left ... right` within `width`, truncating left when needed. */
  private split(left: string, right: string, width: number): string {
    const rightWidth = visibleWidth(right);
    let text = left;
    if (visibleWidth(text) + rightWidth + 1 > width) {
      text = truncateToWidth(text, Math.max(0, width - rightWidth - 2), "…");
    }
    const pad = Math.max(1, width - visibleWidth(text) - rightWidth);
    return text + " ".repeat(pad) + right;
  }

  /** Bordered panel with a title in the top border, padded to exact height. */
  private panel(
    title: string,
    rows: string[],
    width: number,
    height: number,
  ): string[] {
    const theme = this.theme;
    const inner = Math.max(0, width - 2);
    const border = (s: string) => theme.fg("borderMuted", s);
    const titleText = truncateToWidth(` ${title} `, Math.max(0, inner - 2));
    const dashes = Math.max(0, inner - visibleWidth(titleText) - 1);
    const lines: string[] = [
      border("╭─") + titleText + border("─".repeat(dashes) + "╮"),
    ];
    const bodyHeight = Math.max(0, height - 2);
    for (let i = 0; i < bodyHeight; i++) {
      const row = rows[i] ?? "";
      const clipped = truncateToWidth(row, inner, "…");
      const pad = Math.max(0, inner - visibleWidth(clipped));
      lines.push(border("│") + clipped + " ".repeat(pad) + border("│"));
    }
    lines.push(border("╰" + "─".repeat(inner) + "╯"));
    return lines;
  }

  /** Scroll window keeping `selected` visible. */
  private windowed<T>(
    items: T[],
    selected: number,
    size: number,
  ): { items: T[]; offset: number } {
    if (items.length <= size) return { items, offset: 0 };
    const offset = Math.max(
      0,
      Math.min(selected - Math.floor(size / 2), items.length - size),
    );
    return { items: items.slice(offset, offset + size), offset };
  }

  private keys(binding: Parameters<KeybindingsManager["getKeys"]>[0]) {
    return this.keybindings.getKeys(binding).join("/") || "unbound";
  }

  private hintLine(hint: string, width: number): string {
    const theme = this.theme;
    if (this.notice)
      return truncateToWidth(theme.fg("accent", ` ${this.notice}`), width);
    return truncateToWidth(theme.fg("dim", ` ${hint}`), width);
  }

  private renderList(width: number, height: number): string[] {
    const theme = this.theme;
    const lines: string[] = [];
    const header = this.split(
      " " + theme.bold(theme.fg("accent", "Workflows")),
      theme.fg(
        "dim",
        `${this.entries.length} run${this.entries.length === 1 ? "" : "s"} `,
      ),
      width,
    );
    lines.push(header);

    const panelHeight = height - 2;
    const bodyHeight = Math.max(0, panelHeight - 2);

    if (this.entries.length === 0) {
      lines.push(
        ...this.panel(
          "Runs",
          [theme.fg("dim", " no workflow runs yet")],
          width,
          panelHeight,
        ),
      );
      lines.push(
        this.hintLine(`${this.keys("tui.select.cancel")} close`, width),
      );
      return lines;
    }

    const { items, offset } = this.windowed(
      this.entries,
      this.listIndex,
      bodyHeight,
    );
    const rows = items.map((entry, i) => {
      const index = offset + i;
      const selected = index === this.listIndex;
      const d = entry.details;
      const marker = selected ? theme.fg("accent", "❯") : " ";
      const name = d.name ?? d.runId;
      const label = selected
        ? theme.fg("accent", name)
        : theme.fg("text", name);
      const { done, failed, skipped, interrupted } = countStates(d);
      const settled = done + failed + skipped + interrupted;
      const right =
        theme.fg(
          "dim",
          `${settled}/${d.agents.length} agents · ${formatElapsed(d.startedAt, d.finishedAt)} · `,
        ) +
        theme.fg(statusColor(d.status), statusWord(d.status)) +
        " ";
      const left = ` ${marker} ${statusSquareFor(d, theme)} ${label} ${theme.fg("dim", d.runId)}`;
      return this.split(left, right, width - 2);
    });
    lines.push(...this.panel("Runs", rows, width, panelHeight));
    lines.push(
      this.hintLine(
        `${this.keys("tui.select.up")}/${this.keys("tui.select.down")} select · ${this.keys("tui.select.confirm")} open · x stop · p pause · r resume · ${this.keys("tui.select.cancel")} close`,
        width,
      ),
    );
    return lines;
  }

  private renderDetail(
    entry: RunEntry,
    width: number,
    height: number,
  ): string[] {
    const d = entry.details;
    const theme = this.theme;
    const lines: string[] = [];

    const { done, failed, skipped, interrupted } = countStates(d);
    const settled = done + failed + skipped + interrupted;
    const right =
      theme.fg(
        "dim",
        `${settled}/${d.agents.length} agents · ${formatElapsed(d.startedAt, d.finishedAt)} · `,
      ) +
      theme.fg(statusColor(d.status), statusWord(d.status)) +
      " ";
    lines.push(
      this.split(
        " " + theme.bold(theme.fg("accent", d.name ?? d.runId)),
        right,
        width,
      ),
    );
    const totals = formatUsage(aggregateUsage(d.agents));
    const subLeft = " " + theme.fg("muted", d.description ?? d.runId);
    lines.push(
      this.split(subLeft, totals ? theme.fg("dim", `${totals} `) : " ", width),
    );

    const groups = this.groups();
    this.phaseIndex = Math.min(this.phaseIndex, Math.max(0, groups.length - 1));
    const selectedGroup = groups[this.phaseIndex];
    this.clampAgentIndex();

    const panelHeight = height - 3;
    const bodyHeight = Math.max(0, panelHeight - 2);

    // Left: phases sidebar.
    const maxTitle = Math.max(8, ...groups.map((g) => g.title.length));
    const sidebarWidth = Math.min(
      Math.max(maxTitle + 12, 20),
      Math.floor(width / 3),
    );
    const sidebarInner = sidebarWidth - 2;
    const phaseWindow = this.windowed(groups, this.phaseIndex, bodyHeight);
    const phaseRows = phaseWindow.items.map((group, i) => {
      const index = phaseWindow.offset + i;
      const selected = index === this.phaseIndex;
      const marker = selected
        ? theme.fg(this.detailFocus === "phases" ? "accent" : "muted", "❯")
        : " ";
      const groupDone = group.agents.filter(
        (a) => a.state !== "running",
      ).length;
      const square = groupSquare(group, theme);
      const title =
        selected && this.detailFocus === "phases"
          ? theme.fg("accent", group.title)
          : theme.fg("text", group.title);
      const counts =
        group.agents.length > 0
          ? theme.fg("dim", `${groupDone}/${group.agents.length} `)
          : theme.fg("dim", "- ");
      return this.split(` ${marker} ${square} ${title}`, counts, sidebarInner);
    });

    // Right: agents in the selected phase.
    const agentsWidth = width - sidebarWidth - 1;
    const agentsInner = agentsWidth - 2;
    const agentRows: string[] = [];
    if (selectedGroup) {
      const maxLabel = Math.max(
        0,
        ...selectedGroup.agents.map((a) => a.label.length),
      );
      const agentWindow = this.windowed(
        selectedGroup.agents,
        this.agentIndex,
        bodyHeight,
      );
      for (const [visibleIndex, agent] of agentWindow.items.entries()) {
        const index = agentWindow.offset + visibleIndex;
        const selected = index === this.agentIndex;
        const marker =
          selected && this.detailFocus === "agents"
            ? theme.fg("accent", "❯")
            : " ";
        const stats = [
          agentStateWord(agent.state),
          agentModelLabel(agent),
          agentContext(agent),
          agent.attempts !== undefined
            ? `${agent.attempts} attempt${agent.attempts === 1 ? "" : "s"}`
            : undefined,
        ]
          .filter(Boolean)
          .join(" · ");
        const label =
          selected && this.detailFocus === "agents"
            ? theme.fg("accent", agent.label.padEnd(Math.min(maxLabel, 40)))
            : theme.fg("text", agent.label.padEnd(Math.min(maxLabel, 40)));
        const left = ` ${marker} ${stateSquare(agent.state, theme)} ${label}  ${theme.fg("dim", stats)}`;
        const right = theme.fg(
          "dim",
          `${formatElapsed(agent.startedAt, agent.finishedAt)} `,
        );
        agentRows.push(this.split(left, right, agentsInner));
        if (agent.error) {
          agentRows.push(
            truncateToWidth(
              `       ${theme.fg("error", agent.error)}`,
              agentsInner,
              "…",
            ),
          );
        }
      }
      if (selectedGroup.agents.length === 0) {
        agentRows.push(theme.fg("dim", " no agents in this phase yet"));
      }
    }
    if (d.error) {
      agentRows.push("");
      agentRows.push(
        truncateToWidth(
          ` ${theme.fg("error", `workflow error: ${d.error}`)}`,
          agentsInner,
          "…",
        ),
      );
    }
    if (d.resultOmitted) {
      agentRows.push("");
      agentRows.push(
        truncateToWidth(
          ` ${theme.fg("warning", `result omitted: ${d.resultOmitted}`)}`,
          agentsInner,
          "…",
        ),
      );
    }
    if (d.deliveryFailure) {
      agentRows.push("");
      agentRows.push(
        truncateToWidth(
          ` ${theme.fg("warning", `follow-up delivery failed: ${d.deliveryFailure.error}`)}`,
          agentsInner,
          "…",
        ),
      );
      agentRows.push(
        truncateToWidth(
          ` ${theme.fg("dim", `report: ${shortenHome(d.deliveryFailure.reportPath)}`)}`,
          agentsInner,
          "…",
        ),
      );
    }
    const resumeReason = resumeUnavailableReason(entry);
    if (resumeReason) {
      agentRows.push("");
      agentRows.push(
        truncateToWidth(
          ` ${theme.fg("warning", `resume unavailable: ${resumeReason}`)}`,
          agentsInner,
          "…",
        ),
      );
    }

    const agentCount = selectedGroup?.agents.length ?? 0;
    const agentsTitle = selectedGroup
      ? `${selectedGroup.title} · ${agentCount} agent${agentCount === 1 ? "" : "s"}`
      : "Agents";
    const leftPanel = this.panel(
      "Phases",
      phaseRows,
      sidebarWidth,
      panelHeight,
    );
    const rightPanel = this.panel(
      agentsTitle,
      agentRows,
      agentsWidth,
      panelHeight,
    );
    for (let i = 0; i < panelHeight; i++) {
      lines.push(`${leftPanel[i] ?? ""} ${rightPanel[i] ?? ""}`);
    }

    const hint =
      this.detailFocus === "phases"
        ? `j/k select phase · l/${this.keys("tui.editor.cursorRight")}/${this.keys("tui.select.confirm")} agents · x stop · p pause · r resume · ${this.keys("tui.select.cancel")} back · s save report`
        : `j/k select agent · x skip · r retry · h/${this.keys("tui.editor.cursorLeft")}/${this.keys("tui.select.cancel")} phases · ${this.keys("tui.select.confirm")} transcript · s save report`;
    lines.push(this.hintLine(hint, width));
    return lines;
  }

  private transcriptRows(agent: AgentRecord, width: number): string[] {
    const theme = this.theme;
    const rows: string[] = [];
    if (agent.transcript.length === 0) {
      return [
        theme.fg(
          "dim",
          agent.transcriptOmitted
            ? ` transcript omitted: ${agent.transcriptOmitted}`
            : " transcript unavailable (this run predates transcript capture)",
        ),
      ];
    }

    for (const entry of agent.transcript) {
      const label = transcriptLabel(entry);
      const color = transcriptColor(entry);
      rows.push(
        ` ${theme.fg(color, SQUARE)} ${theme.bold(theme.fg(color, label))}`,
      );
      const contentWidth = Math.max(8, width - 4);
      const styled = theme.fg(
        entry.role === "thinking" ? "dim" : entry.isError ? "error" : "text",
        entry.text,
      );
      for (const line of wrapTextWithAnsi(styled, contentWidth)) {
        rows.push(`   ${line}`);
      }
      rows.push("");
    }
    return rows;
  }

  private renderTranscript(
    details: WorkflowDetails,
    agent: AgentRecord,
    width: number,
    height: number,
  ): string[] {
    const theme = this.theme;
    const lines: string[] = [];
    const right = theme.fg(
      "dim",
      [
        agentStateWord(agent.state),
        agentModelLabel(agent),
        agentContext(agent),
        formatElapsed(agent.startedAt, agent.finishedAt),
      ]
        .filter(Boolean)
        .join(" · ") + " ",
    );
    lines.push(
      this.split(
        ` ${stateSquare(agent.state, theme)} ${theme.bold(theme.fg("accent", agent.label))}`,
        right,
        width,
      ),
    );
    lines.push(
      this.split(
        ` ${theme.fg("muted", `${details.name ?? details.runId} · ${agent.phase ?? "unphased"}`)}`,
        theme.fg("dim", `${agent.transcript.length} entries `),
        width,
      ),
    );

    const panelHeight = height - 3;
    const bodyHeight = Math.max(1, panelHeight - 2);
    const rows = this.transcriptRows(agent, width - 2);
    this.transcriptRowCount = rows.length;
    this.transcriptViewportSize = bodyHeight;
    const maxScroll = Math.max(0, rows.length - bodyHeight);
    this.transcriptScroll = Math.min(this.transcriptScroll, maxScroll);
    const visible = rows.slice(
      this.transcriptScroll,
      this.transcriptScroll + bodyHeight,
    );
    const position =
      rows.length > bodyHeight
        ? `Transcript · ${this.transcriptScroll + 1}-${Math.min(rows.length, this.transcriptScroll + bodyHeight)}/${rows.length}`
        : "Transcript";
    lines.push(...this.panel(position, visible, width, panelHeight));
    lines.push(
      this.hintLine(
        "j/k scroll · ctrl-u/d page · g/G top/bottom · x skip · r retry · h/left/esc back",
        width,
      ),
    );
    return lines;
  }
}

function transcriptLabel(entry: TranscriptEntry): string {
  if (entry.role === "user") return "USER";
  if (entry.role === "assistant") return "ASSISTANT";
  if (entry.role === "thinking") return "THINKING";
  if (entry.role === "tool") return `TOOL ${entry.name ?? "unknown"}`;
  return `RESULT ${entry.name ?? "unknown"}`;
}

function transcriptColor(
  entry: TranscriptEntry,
): "accent" | "success" | "dim" | "warning" | "error" | "muted" {
  if (entry.isError) return "error";
  if (entry.role === "user") return "accent";
  if (entry.role === "assistant") return "success";
  if (entry.role === "thinking") return "dim";
  if (entry.role === "tool") return "warning";
  return "muted";
}

function statusSquareFor(details: WorkflowDetails, theme: Theme): string {
  return theme.fg(statusColor(details.status), SQUARE);
}

function groupSquare(group: PhaseGroup, theme: Theme): string {
  if (group.agents.length === 0) return theme.fg("dim", SQUARE);
  if (group.agents.some((a) => a.state === "running"))
    return theme.fg("warning", SQUARE);
  if (group.agents.some((a) => a.state === "error"))
    return theme.fg("error", SQUARE);
  return theme.fg("success", SQUARE);
}

/** Open the dashboard as a full-screen overlay. */
export async function showWorkflowDashboard(
  ctx: ExtensionContext,
  getActive: () => Map<string, WorkflowDetails>,
  initialRunId?: string,
  controls?: WorkflowDashboardControls,
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, keybindings, done) => {
      const dashboard: WorkflowDashboard = new WorkflowDashboard(
        tui,
        theme,
        keybindings,
        getActive,
        ctx.sessionManager.getSessionId(),
        sessionWorkflowRunIds(ctx),
        () => {
          dashboard.dispose();
          done(undefined);
        },
        initialRunId,
        controls,
      );
      return dashboard;
    },
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    },
  );
}
