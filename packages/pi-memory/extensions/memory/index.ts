/**
 * memory - Claude Code's persistent file-based memory, ported to pi.
 *
 * One fact per markdown file in a per-project directory, indexed by a MEMORY.md
 * that is loaded into the system prompt each session. No new tools: the model
 * reads and writes memories with read/write/edit like any other file.
 *
 * - /memory        pick a memory file and edit it (Ctrl+G hands off to $EDITOR)
 * - /pause-memory  stop reading and writing memory for the rest of the session
 * - /dream-log     open the persistent dream run log in a pane
 *
 * Configure in settings.json: "memory": { "enabled": true, "promptVariant": "auto" }
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  ExtensionEditorComponent,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  maybeDream,
  runDreamNow,
  type DreamOutcome,
} from "./src/dream/index.ts";
import { appendDreamLog, buildDreamLogEntry } from "./src/dream/log.ts";
import { showDreamLogPane } from "./src/dream/log-pane.ts";
import {
  buildDreamOutcomeData,
  DREAM_OUTCOME_ENTRY,
  renderDreamOutcome,
  type DreamOutcomeEntryData,
} from "./src/dream/outcome.ts";
import {
  persistDreamAutoEnabled,
  projectOverridesDreamEnabled,
} from "./src/dream/settings.ts";
import { formatIndexSection, readIndex } from "./src/index-file.ts";
import { memoryDir, memoryIndexPath } from "./src/paths.ts";
import {
  buildFullMemoryPrompt,
  buildTerseMemoryPrompt,
  MEMORY_INDEX_FILENAME,
} from "./src/prompt.ts";
import { RecallLedger, RECALL_MESSAGE_TYPE } from "./src/recall-ledger.ts";
import { createSelectorComplete } from "./src/recall-model.ts";
import { runRecall } from "./src/recall.ts";
import { loadMemorySettings } from "./src/settings.ts";
import { resolveVariant } from "./src/variant.ts";

/** Footer status key for the "recalled N memories" indicator. */
const RECALL_STATUS_KEY = "memory";

/** Transcript entry for a write/edit that landed in the memory directory. */
const MEMORY_WRITE_ENTRY = "memory-write";

/** Persistent status line while a dream is in flight — the "don't close yet" signal. */
const DREAM_STATUS_KEY = "dream";
const DREAM_SHUTDOWN_WAIT_MS = 2_000;

/** Race a task against a deadline without letting a rejection escape. */
async function waitBounded(task: Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      task.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Claude Code's own wording for the /pause-memory toggle. */
const PAUSED_NOTICE =
  "Memory paused for this session · this conversation will not write or read new memories, and previously-loaded memory content should not be referenced.";
const RESUMED_NOTICE =
  "Memory resumed · memory content may be referenced and new memories can be saved.";

export default function memory(pi: ExtensionAPI) {
  /**
   * The index is snapshotted per session rather than re-read each turn, both to
   * match Claude Code (which reloads on session start and after compaction) and
   * to keep the system prompt prefix stable for the cache. A manual /memory
   * edit or a completed dream deliberately does NOT refresh it mid-session —
   * that would change the system prompt and invalidate the cached prefix on
   * expensive models. Fresh content reaches the model via per-turn recall and
   * the read tool instead.
   */
  let indexSection: string | undefined;
  let paused = false;

  /**
   * Recall dedupe state, per session. Memories surfaced once are not surfaced
   * again, and a running byte total caps how much a long session can inject.
   * Rebuilt from the session transcript at every session start — pi fires
   * `session_start` on resume/reload/fork too, where the conversation is NOT
   * rebuilt, so the same memories must not be re-injected. Reset only where
   * Claude Code rebuilds the conversation: compaction.
   */
  const recallLedger = new RecallLedger();

  /**
   * Dream state. `lastDreamScanAt` is the per-process scan throttle (gate 6);
   * it survives across sessions in one process. An in-flight dream is NOT
   * aborted by user activity — only by shutdown or a cap — so a half-written
   * merge is never left without its replacement.
   */
  let lastDreamScanAt = 0;
  let dreamTimer: ReturnType<typeof setTimeout> | undefined;
  let activeDream:
    { controller: AbortController; done: Promise<void> } | undefined;
  let dreamStatusCtx: ExtensionContext | undefined;

  const cancelDreamTimer = () => {
    if (!dreamTimer) return;
    clearTimeout(dreamTimer);
    dreamTimer = undefined;
  };

  const setDreamStatus = (text: string | undefined) => {
    dreamStatusCtx?.ui.setStatus(DREAM_STATUS_KEY, text);
  };

  const reportDreamOutcome = async (
    ctx: ExtensionContext,
    outcome: DreamOutcome,
    onDemand: boolean,
  ) => {
    if (!ctx.hasUI) return;
    if (!outcome.fired) {
      // Idle dreams stay quiet; /dream tells the user why nothing happened.
      if (onDemand)
        ctx.ui.notify(`No dream: ${outcome.reason ?? "gated"}.`, "info");
      return;
    }
    const result = outcome.result;
    if (!result || result.status === "failed") {
      ctx.ui.notify(
        `The dream failed: ${result?.summary ?? "unknown error"}.`,
        "warning",
      );
      return;
    }

    // The summary used to ride along in a notification verbatim; the entry
    // keeps the headline visible and hides the summary behind ctrl+o.
    pi.appendEntry(DREAM_OUTCOME_ENTRY, buildDreamOutcomeData(result));
  };

  const runDreamSession = async (ctx: ExtensionContext, onDemand: boolean) => {
    if (ctx.mode !== "tui" || activeDream) return;
    dreamStatusCtx = ctx;
    const controller = new AbortController();
    const done = (async () => {
      let outcome: DreamOutcome;
      const startedAt = Date.now();
      try {
        outcome = await (onDemand ? runDreamNow : maybeDream)(ctx, {
          paused,
          lastScanAt: lastDreamScanAt,
          signal: controller.signal,
          onProgress: ({ turn, maxTurns }) =>
            setDreamStatus(
              ctx.ui.theme.fg(
                "muted",
                `✦ dreaming… (turn ${turn}/${maxTurns})`,
              ),
            ),
        });
      } catch (error) {
        // A gate-level failure (e.g. an unreadable lock file) still belongs in
        // the log, so it becomes a failed outcome like any other.
        outcome = {
          fired: true,
          result: {
            status: "failed",
            filesTouched: [],
            turns: 0,
            summary: error instanceof Error ? error.message : String(error),
          },
        };
      } finally {
        lastDreamScanAt = Date.now();
      }
      const durationMs = Date.now() - startedAt;
      await logDreamOutcome(ctx, outcome, onDemand, durationMs);
      await reportDreamOutcome(ctx, outcome, onDemand);
    })()
      .catch((error) => {
        if (onDemand && ctx.hasUI) {
          ctx.ui.notify(
            `The dream failed: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
      })
      .finally(() => {
        activeDream = undefined;
        setDreamStatus(undefined);
      });
    activeDream = { controller, done };
    await done;
  };

  /**
   * Every dream attempt — fired or gated — is appended to the persistent JSONL
   * log in the memory directory, so the history survives restarts and the
   * `/dream-log` pane can render it. A log write must never break the dream
   * flow or the session, so failures are swallowed.
   */
  const logDreamOutcome = async (
    ctx: ExtensionContext,
    outcome: DreamOutcome,
    onDemand: boolean,
    durationMs: number,
  ) => {
    try {
      const settings = loadMemorySettings(ctx.cwd);
      await appendDreamLog(
        memoryDir(ctx.cwd),
        buildDreamLogEntry(outcome, {
          trigger: onDemand ? "manual" : "idle",
          model: settings.dream.model,
          durationMs,
        }),
      );
    } catch {
      // Logging is best-effort; the dream result and the session come first.
    }
  };

  const loadIndexSection = async (cwd: string) => {
    const dir = memoryDir(cwd);
    // Claude Code guarantees the directory exists before telling the model so,
    // so the prompt can say "write to it directly" without a mkdir round-trip.
    await mkdir(dir, { recursive: true }).catch(() => undefined);
    const path = memoryIndexPath(cwd);
    return formatIndexSection(path, await readIndex(path));
  };

  pi.on("session_start", async (_event, ctx) => {
    paused = false;
    pendingMemoryWrites.clear();
    cancelDreamTimer();
    dreamStatusCtx = ctx;
    // Rebuild the ledger from the transcript. A fresh session file contains
    // no memory-recall entries yet, so rebuilding yields an empty ledger;
    // a resumed one marks everything already surfaced, so the first message
    // after a restart does not re-inject the same memories.
    try {
      recallLedger.rebuildFromEntries(ctx.sessionManager.getEntries());
    } catch {
      // In-memory or unreadable session: start with an empty ledger.
    }
    if (!loadMemorySettings(ctx.cwd).enabled) return;
    indexSection = await loadIndexSection(ctx.cwd);
  });

  // Compaction rebuilds the conversation, which is where Claude Code also
  // refreshes its memory files. Anything saved this session lands here.
  pi.on("session_compact", async (_event, ctx) => {
    recallLedger.reset();
    if (!loadMemorySettings(ctx.cwd).enabled) return;
    indexSection = await loadIndexSection(ctx.cwd);
  });

  /**
   * The per-turn relevance prefetch. Blocks the turn on a cheap selector call so
   * the surfaced memories are present for the same turn that triggered them, the
   * way Claude Code's prefetch collects before the main request. Fail-open: any
   * problem (no model, no key, timeout, bad reply) surfaces nothing and the turn
   * proceeds untouched.
   */
  const recall = async (
    dir: string,
    query: string,
    settings: ReturnType<typeof loadMemorySettings>,
    ctx: ExtensionContext,
  ) => {
    if (ctx.hasUI) ctx.ui.setStatus(RECALL_STATUS_KEY, undefined);
    try {
      const complete = await createSelectorComplete(
        ctx.modelRegistry,
        settings.recall,
      );
      if (!complete) return undefined;

      const result = await runRecall({
        query,
        dir,
        complete,
        alreadyInjected: recallLedger.alreadyInjected,
        sessionBytes: recallLedger.sessionBytes,
        now: Date.now(),
        signal: ctx.signal,
      });
      if (!result) return undefined;

      recallLedger.markInjected(result.injectedPaths, result.bytes);
      if (ctx.hasUI) {
        const n = result.injectedPaths.length;
        ctx.ui.setStatus(
          RECALL_STATUS_KEY,
          ctx.ui.theme.fg(
            "muted",
            `✦ recalled ${n} ${n === 1 ? "memory" : "memories"}`,
          ),
        );
      }

      return {
        customType: RECALL_MESSAGE_TYPE,
        content: result.content,
        display: true,
        details: { paths: result.injectedPaths },
      };
    } catch {
      return undefined;
    }
  };

  /**
   * Memory writes surface as their own transcript row. The generic tool row
   * still renders above; this entry is the persistent "a memory changed"
   * marker, the counterpart to the recall row. `tool_result` sees the input
   * path but fires before the toolResult message exists, so the path is
   * stashed by toolCallId and the entry is appended on `message_end`, which
   * lands it directly under the tool row it belongs to.
   */
  const pendingMemoryWrites = new Map<string, { path: string; tool: string }>();

  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const input = event.input as { path?: unknown };
    const raw = typeof input.path === "string" ? input.path : undefined;
    if (!raw) return;
    const absolute = resolve(ctx.cwd, raw);
    if (!absolute.startsWith(memoryDir(ctx.cwd))) return;
    pendingMemoryWrites.set(event.toolCallId, {
      path: absolute,
      tool: event.toolName,
    });
  });

  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "toolResult") return;
    const pending = pendingMemoryWrites.get(message.toolCallId);
    if (!pending) return;
    pendingMemoryWrites.delete(message.toolCallId);
    if (message.isError) return;
    const name = pending.path.split("/").pop();
    pi.appendEntry(MEMORY_WRITE_ENTRY, {
      path: pending.path,
      action:
        name === MEMORY_INDEX_FILENAME
          ? "index updated"
          : pending.tool === "write"
            ? "saved"
            : "updated",
    });
  });

  pi.registerEntryRenderer(DREAM_OUTCOME_ENTRY, (entry, { expanded }, theme) =>
    renderDreamOutcome(
      (entry.data ?? {}) as DreamOutcomeEntryData,
      expanded,
      theme,
    ),
  );

  pi.registerEntryRenderer(MEMORY_WRITE_ENTRY, (entry, { expanded }, theme) => {
    const data = (entry.data ?? {}) as { path?: string; action?: string };
    const name = data.path?.split("/").pop() ?? "?";
    const action = data.action ?? "saved";
    let text =
      theme.fg("accent", "✦ ") +
      theme.fg(
        "muted",
        action === "index updated"
          ? "memory index updated"
          : `memory ${action}: ${name}`,
      );
    if (expanded && data.path) text += `\n${theme.fg("dim", data.path)}`;
    return new Text(text, 0, 0);
  });

  /**
   * The recall row in the transcript. Collapsed it is one muted line naming
   * the files; expanded it shows the exact system-reminder text the model
   * received, so what the user sees and what the model saw never diverge.
   */
  pi.registerMessageRenderer(
    RECALL_MESSAGE_TYPE,
    (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as { paths?: string[] };
      const names = (details.paths ?? []).map(
        (path) => path.split("/").pop() ?? path,
      );
      const n = names.length;
      let text =
        theme.fg("accent", "✦ ") +
        theme.fg(
          "muted",
          `recalled ${n} ${n === 1 ? "memory" : "memories"}` +
            (n > 0 ? `: ${names.join(", ")}` : ""),
        );
      if (expanded) {
        const content =
          typeof message.content === "string" ? message.content : "";
        text += `\n${theme.fg("dim", content)}`;
      }
      return new Text(text, 0, 0);
    },
  );

  pi.on("before_agent_start", async (event, ctx) => {
    // A new run means the user is active — drop any pending idle dream.
    cancelDreamTimer();
    if (paused) return;
    const settings = loadMemorySettings(ctx.cwd);
    if (!settings.enabled) return;

    const variant = resolveVariant(ctx.model?.id, settings.promptVariant);
    const dir = memoryDir(ctx.cwd);
    const section =
      variant === "terse"
        ? buildTerseMemoryPrompt(dir)
        : buildFullMemoryPrompt(dir);

    const systemPrompt = [event.systemPrompt, section, indexSection]
      .filter(Boolean)
      .join("\n\n");

    const recallMessage = settings.recall.enabled
      ? await recall(dir, event.prompt, settings, ctx)
      : undefined;

    return {
      systemPrompt,
      ...(recallMessage && { message: recallMessage }),
    };
  });

  // Idle trigger: arm a timer once the session goes quiet, so a dream only runs
  // when the user has actually stopped and never contends for the model. The
  // gates re-check everything when it fires.
  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    dreamStatusCtx = ctx;
    cancelDreamTimer();
    if (paused) return;
    const settings = loadMemorySettings(ctx.cwd);
    if (!settings.enabled || !settings.dream.enabled) return;
    dreamTimer = setTimeout(() => {
      dreamTimer = undefined;
      void runDreamSession(ctx, false);
    }, settings.dream.idleDelayMs);
    dreamTimer.unref();
  });

  // User activity cancels the pending timer, but never aborts an in-flight
  // dream — a recap is disposable, a half-done consolidation is not.
  pi.on("input", (event) => {
    if (event.source === "interactive") cancelDreamTimer();
  });
  pi.on("user_bash", () => cancelDreamTimer());

  pi.on("session_shutdown", async () => {
    cancelDreamTimer();
    if (activeDream) {
      activeDream.controller.abort();
      await waitBounded(activeDream.done, DREAM_SHUTDOWN_WAIT_MS);
    }
    setDreamStatus(undefined);
    dreamStatusCtx = undefined;
  });

  pi.registerCommand("dream", {
    description: "Consolidate memories now (an on-demand dream)",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) {
          ctx.ui.notify("The dream is only available in the TUI.", "error");
        }
        return;
      }
      if (activeDream) {
        ctx.ui.notify("A dream is already running.", "info");
        return;
      }
      cancelDreamTimer();
      await runDreamSession(ctx, true);
    },
  });

  pi.registerCommand("dream-log", {
    description: "Open the persistent dream run log",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "The dream log pane is only available in the TUI.",
            "error",
          );
        }
        return;
      }
      await showDreamLogPane(ctx, memoryDir(ctx.cwd));
    },
  });

  pi.registerCommand("dream-auto", {
    description: "Toggle automatic (idle-triggered) dreaming on or off",
    handler: async (_args, ctx) => {
      const next = !loadMemorySettings(ctx.cwd).dream.enabled;
      try {
        await persistDreamAutoEnabled(getAgentDir(), next);
      } catch (error) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Could not save the dream setting: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
        return;
      }
      if (!ctx.hasUI) return;
      const overridden = projectOverridesDreamEnabled(ctx.cwd, getAgentDir());
      const override = overridden
        ? " A project-level memory.dream.enabled setting overrides this — edit the project's settings to change it."
        : "";
      ctx.ui.notify(
        `Automatic dreaming ${next ? "enabled" : "disabled"}.${override} /dream still works manually regardless of this setting.`,
        "info",
      );
    },
  });

  pi.registerCommand("pause-memory", {
    description: "Stop reading and writing memory for the rest of this session",
    handler: async (_args, ctx) => {
      paused = !paused;
      ctx.ui.notify(
        paused
          ? `${PAUSED_NOTICE}\n\nRun /pause-memory again to resume.`
          : RESUMED_NOTICE,
        paused ? "warning" : "info",
      );
    },
  });

  pi.registerCommand("memory", {
    description: "Open a memory file in your editor",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Editing memories is only available in the TUI",
            "error",
          );
        }
        return;
      }

      const dir = memoryDir(ctx.cwd);
      await mkdir(dir, { recursive: true }).catch(() => undefined);

      const files = await listMemoryFiles(dir);
      if (files.length === 0) {
        ctx.ui.notify(
          `No memories yet. The agent writes them to ${dir} as it learns.`,
          "info",
        );
        return;
      }

      const chosen = await ctx.ui.select(`Memory · ${dir}`, files);
      if (!chosen) return;

      const path = dir + chosen;
      const before = await readFile(path, "utf8").catch(() => "");
      const edited = await editInTui(ctx, chosen, before);
      if (edited === undefined || edited === before) return;

      await writeFile(
        path,
        edited.endsWith("\n") ? edited : `${edited}\n`,
        "utf8",
      );
      ctx.ui.notify(`Saved ${chosen}`, "info");
    },
  });
}

/** The index first, then memories alphabetically — the order they are read in. */
async function listMemoryFiles(dir: string) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
  return [
    ...files.filter((name) => name === MEMORY_INDEX_FILENAME),
    ...files.filter((name) => name !== MEMORY_INDEX_FILENAME),
  ];
}

/**
 * Undefined when the user cancels. Ctrl+G inside the editor follows pi's own
 * chain: `externalEditor` setting, then `$VISUAL`, then `$EDITOR`, then nano.
 */
function editInTui(
  ctx: ExtensionCommandContext,
  title: string,
  content: string,
) {
  const externalEditorCommand = SettingsManager.create(
    ctx.cwd,
    getAgentDir(),
  ).getExternalEditorCommand();
  return ctx.ui.custom<string | undefined>(
    (tui, _theme, keybindings, done) =>
      new ExtensionEditorComponent(
        tui,
        keybindings,
        title,
        content,
        (value) => done(value),
        () => done(undefined),
        undefined,
        externalEditorCommand,
      ),
  );
}
