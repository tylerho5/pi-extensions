/**
 * Checkpoints: snapshot the files each session's edit tools touch, one checkpoint per
 * user prompt, restorable with the conversation through `/rewind`.
 *
 * A per-session bare git repository under `~/.pi/agent/checkpoints/` is driven with
 * `--git-dir` and `--work-tree`, so the project's own git state is untouched. Snapshot
 * scope is the set of files the session's `edit` and `write` calls named, which is what
 * bounds snapshot size. Checkpoint records are custom session entries, so they travel
 * with the conversation.
 *
 * Adapted from `extensions/git-checkpoint.ts` in `ilovepixelart/pi-code` at commit
 * `ff3eb5e` (2026-10-05), MIT licensed, copyright 2025 Mario Zechner and 2026
 * ilovepixelart.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_COMPACTION_SETTINGS,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { effectiveCwd } from "../shared/effective-cwd.ts";
import { findFocusedComponent, isDefaultEditorFocused } from "./src/focus.ts";
import { attachEscapeGesture } from "./src/gesture.ts";
import { applyRestore, planHasChanges, planRestore } from "./src/plan.ts";
import {
  handleBeforeCompact,
  runRewindCommand,
  type CompactionState,
  type MenuDeps,
} from "./src/menu.ts";
import { decideRun, decideTurnEnd } from "./src/run.ts";
import {
  addablePaths,
  ensureShadow,
  inheritRefs,
  mirrorLocalExcludes,
  markShadowRootUntracked,
  pruneShadowRepos,
  shadowDirFor,
  snapshotShadow,
  type ShadowDeps,
  type ShadowRepo,
} from "./src/shadow.ts";
import {
  loadCheckpointSettings,
  type CheckpointSettings,
} from "./src/settings.ts";
import {
  capCheckpoints,
  findLastUserMessage,
  recordsFromBranch,
  CUSTOM_TYPE,
  MAX_CHECKPOINTS_PER_SESSION,
  type Checkpoint,
} from "./src/store.ts";
import {
  captureBaseline,
  fileToolTarget,
  seedTouched,
  throughSymlinks,
  EDIT_TOOLS,
} from "./src/track.ts";

/**
 * The three things the wiring cannot work out for itself, so a test can hand it a
 * temporary shadow root and a fixed effective directory.
 */
export interface CheckpointRuntime {
  /** Where the per-session shadow repositories live, for the retention sweep. */
  shadowRoot: string;
  /** The shadow repository for a session bound to a work tree. */
  shadowFor: (sessionId: string, workTree: string) => ShadowRepo;
  /** The directory a session's file tools actually resolve against. */
  effectiveCwd: (sessionId: string, sessionCwd: string) => string;
  /** The settings and environment knobs in effect. */
  settings: () => CheckpointSettings;
}

function defaultRuntime(): CheckpointRuntime {
  const agentDir = getAgentDir();
  const shadowRoot = path.join(agentDir, "checkpoints");
  return {
    shadowRoot,
    shadowFor: (sessionId, workTree) =>
      shadowDirFor(shadowRoot, sessionId, workTree),
    effectiveCwd: (sessionId, sessionCwd) =>
      effectiveCwd(agentDir, sessionId, sessionCwd),
    settings: () =>
      loadCheckpointSettings(path.join(agentDir, "settings.json")),
  };
}

export function createCheckpoints(
  pi: ExtensionAPI,
  runtime: CheckpointRuntime,
): void {
  /** Records by the user message they belong to, oldest first. */
  const records = new Map<string, Checkpoint>();
  const compactionState: CompactionState = { pendingBoundary: undefined };
  let shadow: ShadowRepo | undefined;
  let touched = new Set<string>();
  let pending: { ref: string; createdAt: string } | undefined;
  /** The ref holding the in-flight run's checkpoint, moved as later baselines arrive. */
  let runRef: string | undefined;
  /** A run is under way: the next turn_start takes its one snapshot. */
  let runArmed = false;
  /** The run about to start came from a prompt rather than a retry or a follow-up. */
  let promptedRun = false;
  /** The live session has no session file, so nothing can resume it. */
  let ephemeralShadow = false;
  /** One warning per session about records that name another shadow. */
  let warnedAboutForeignShadow = false;
  /** The TUI root, captured from an inert probe widget so the Escape gesture can tell
   * the chat editor from a modal. Nothing else in this extension renders a component. */
  let gestureTui: TUI | undefined;
  let escapeUnsubscribe: (() => void) | undefined;
  /** The context the notify callback reports through; set on every event. */
  let current: ExtensionContext | undefined;

  const deps: ShadowDeps = {
    exec: (command, args, options) => pi.exec(command, args, options),
    notify: (message, level) => {
      current?.ui.notify(message, level === "warning" ? "warning" : "info");
    },
  };

  /** The record a prompt's checkpoint, when it belongs to the shadow in play. A record
   * from another shadow must not be reused: its ref names a repository this session is
   * not bound to. */
  function recordFor(ctx: ExtensionContext): Checkpoint | undefined {
    const target = findLastUserMessage(ctx.sessionManager.getBranch());
    if (target === undefined) return undefined;
    const found = records.get(target.entryId);
    return found !== undefined && found.shadow === shadow?.dir
      ? found
      : undefined;
  }

  function warnAboutForeignShadow(): void {
    if (warnedAboutForeignShadow || shadow === undefined) return;
    const foreign = [...records.values()].find(
      (record) => record.shadow !== shadow?.dir,
    );
    if (foreign === undefined) return;
    warnedAboutForeignShadow = true;
    current?.ui.notify(
      `Checkpoints recorded in ${foreign.shadow} are not restorable from ${shadow.dir}`,
      "warning",
    );
  }

  /** Bind the shadow for a work tree, seed the tracked set, and mirror the repository's
   * local excludes into it. */
  async function bind(
    sessionId: string,
    workTree: string,
  ): Promise<ShadowRepo | undefined> {
    const bound = runtime.shadowFor(sessionId, workTree);
    // Defends the store against a `git add` in whatever checkout happens to contain it.
    markShadowRootUntracked(runtime.shadowRoot);
    if (!(await ensureShadow(deps, bound))) return undefined;
    await mirrorLocalExcludes(deps, bound, workTree);
    shadow = bound;
    touched = await seedTouched(deps, bound);
    return bound;
  }

  /** The shadow for the session's effective directory, rebound when that directory
   * changed. The effective directory can move mid-session, and it can move mid-turn: the
   * model can call `enter_worktree` and then edit in the same turn, so every path-taking
   * hook resolves through here rather than trusting the binding `turn_start` left. A new
   * tree gets its own shadow, because restoring one tree's commits into another would
   * overwrite unrelated same-named files. */
  async function boundShadow(
    ctx: ExtensionContext,
  ): Promise<ShadowRepo | undefined> {
    const sessionId = ctx.sessionManager.getSessionId();
    const workTree = runtime.effectiveCwd(sessionId, ctx.cwd);
    if (
      shadow !== undefined &&
      path.resolve(shadow.workTree) === path.resolve(workTree)
    ) {
      return shadow;
    }
    const previous = shadow?.dir;
    const rebound = await bind(sessionId, workTree);
    if (rebound === undefined) return undefined;
    if (previous !== undefined && previous !== rebound.dir) {
      ctx.ui.notify(
        `Checkpoints for this session were recorded in ${previous}; starting fresh checkpoints for ${workTree} (earlier ones are not restorable here)`,
        "warning",
      );
    }
    return rebound;
  }

  /** The widget key for the inert probe that carries the TUI reference. */
  const PROBE_WIDGET = "checkpoints-escape-probe";

  /** Run `/rewind` through pi's own dispatch, so the gesture gets the same menu and the
   * same context a typed command does, conversation actions included. pi treats the text
   * as a command when `expandPromptTemplates` is set, an option that landed after the
   * pinned 0.82 types. */
  function sendRewindCommand(): void {
    const host = pi as unknown as {
      sendUserMessage: (
        content: string,
        options?: { expandPromptTemplates?: boolean },
      ) => void;
    };
    host.sendUserMessage("/rewind", { expandPromptTemplates: true });
  }

  /** Bind Esc Esc to the rewind command. pi's built-in double Escape is set to `none`,
   * so this listener is the only thing the gesture reaches; every other Escape press
   * falls through to the built-in handlers untouched. */
  function attachEscapeGestureFor(ctx: ExtensionContext): void {
    escapeUnsubscribe?.();
    escapeUnsubscribe = undefined;
    gestureTui = undefined;
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    ctx.ui.setWidget(PROBE_WIDGET, (tui) => {
      gestureTui = tui;
      return { render: () => [], invalidate: () => undefined };
    });
    escapeUnsubscribe = attachEscapeGesture(
      (handler) => ctx.ui.onTerminalInput(handler),
      {
        editorFocused: () =>
          gestureTui !== undefined &&
          isDefaultEditorFocused(findFocusedComponent(gestureTui)),
        editorText: () => ctx.ui.getEditorText(),
        idle: () => ctx.isIdle(),
        open: sendRewindCommand,
      },
    );
  }

  const menuDeps: MenuDeps = {
    records: () => [...records.values()],
    shadowDir: () => shadow?.dir ?? "",
    plan: async (ref) => {
      const bound = shadow;
      return bound === undefined ? [] : planRestore(deps, bound, ref);
    },
    hasChanges: async (plan) => {
      const bound = shadow;
      return bound === undefined ? false : planHasChanges(deps, bound, plan);
    },
    apply: async (plan) => {
      const bound = shadow;
      return bound === undefined
        ? { applied: 0, skipped: 0 }
        : applyRestore(deps, bound, plan);
    },
    state: compactionState,
  };

  pi.on("session_start", async (event: SessionStartEvent, ctx) => {
    current = ctx;
    pending = undefined;
    runArmed = false;
    promptedRun = false;
    runRef = undefined;
    warnedAboutForeignShadow = false;
    compactionState.pendingBoundary = undefined;
    records.clear();
    // Bound before the shadow, and outside every early return below: the key belongs to
    // the gesture even when no checkpoint can be recorded, and `/rewind` reports that
    // state itself.
    attachEscapeGestureFor(ctx);

    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile();
    ephemeralShadow = sessionFile === undefined;
    const workTree = runtime.effectiveCwd(sessionId, ctx.cwd);
    const bound = await bind(sessionId, workTree);
    if (bound === undefined) return;
    if (bound === undefined) return;

    if (event.reason === "fork" && event.previousSessionFile !== undefined) {
      const parentSessionId = path.basename(event.previousSessionFile);
      await inheritRefs(
        deps,
        bound,
        runtime.shadowFor(parentSessionId, workTree).dir,
      );
    }
    // Housekeeping, after every repository this session might still need exists.
    pruneShadowRepos(
      runtime.shadowRoot,
      runtime.settings().cleanupPeriodDays,
      bound.dir,
    );

    for (const record of capCheckpoints(
      recordsFromBranch(ctx.sessionManager.getBranch()),
    )) {
      records.set(record.entryId, record);
    }
    warnAboutForeignShadow();
  });

  // A new agent loop starts a run. agent_start, not before_agent_start: a retry, an
  // overflow recovery, and a queued follow-up all re-enter through agent.continue, and
  // gating on before_agent_start would leave a queued follow-up's prompt with none.
  pi.on("agent_start", async () => {
    runArmed = true;
  });

  // Only a prompt fires before_agent_start. The runs that skip it have no new user
  // message, so they reuse the record their prompt already has.
  pi.on("before_agent_start", async () => {
    promptedRun = true;
  });

  pi.on("turn_start", async (_event, ctx) => {
    current = ctx;
    const settings = runtime.settings();
    if ((await boundShadow(ctx)) === undefined) return;

    const armed = runArmed;
    const decision = decideRun({
      armed,
      prompted: promptedRun,
      disabled: !settings.enabled,
      hasPendingMessages: ctx.hasPendingMessages(),
      recordedForLast: recordFor(ctx),
    });
    runArmed = false;
    promptedRun = false;
    if (decision.kind === "none") {
      // A fresh run that cannot snapshot must not leave the previous run's ref live: a
      // later tool_call would commit a baseline into a checkpoint that is already
      // recorded, and that checkpoint would then claim a file it never covered. A
      // continuation turn of the same run (not armed) keeps folding into its own ref.
      if (armed) runRef = undefined;
      return;
    }
    if (decision.kind === "reuse") {
      runRef = decision.ref;
      return;
    }
    const bound = shadow;
    if (bound === undefined) return;
    const paths = await addablePaths(deps, bound, touched);
    pending = await snapshotShadow(deps, bound, paths);
    runRef = pending?.ref;
  });

  pi.on("tool_call", async (event, ctx) => {
    current = ctx;
    if (!EDIT_TOOLS.has(event.toolName)) return;
    const target = fileToolTarget(event);
    if (target === undefined) return;
    // Re-resolved per call, not inherited from turn_start: a worktree entered earlier in
    // this same turn moves the directory the model's paths are relative to.
    const bound = await boundShadow(ctx);
    if (bound === undefined) return;
    const file = throughSymlinks(
      bound.workTree,
      path.resolve(bound.workTree, target),
    );
    if (touched.has(file)) return;
    touched.add(file);
    // Before the tool writes: once it has run, the pre-edit content is gone.
    await captureBaseline(deps, bound, runRef, file);
  });

  pi.on("turn_end", async (_event, ctx) => {
    current = ctx;
    const snapshot = pending;
    pending = undefined;
    const target = findLastUserMessage(ctx.sessionManager.getBranch());
    const recorded = recordFor(ctx);
    const decision = decideTurnEnd({
      pendingRef: snapshot?.ref,
      recordedForLast: recorded,
    });
    if (target === undefined || decision.kind !== "record") {
      // A re-run's snapshot is dropped, and later baselines keep folding into the
      // checkpoint that user message actually has.
      if (decision.kind === "discard") runRef = decision.ref;
      return;
    }
    if (snapshot === undefined) return;
    const checkpoint: Checkpoint = {
      entryId: target.entryId,
      ref: snapshot.ref,
      prompt: target.prompt,
      createdAt: snapshot.createdAt,
      shadow: shadow?.dir ?? "",
    };
    records.set(checkpoint.entryId, checkpoint);
    for (const stale of [...records.keys()].slice(
      0,
      Math.max(0, records.size - MAX_CHECKPOINTS_PER_SESSION),
    )) {
      records.delete(stale);
    }
    pi.appendEntry(CUSTOM_TYPE, checkpoint);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    current = ctx;
    return handleBeforeCompact(ctx, event, compactionState, {
      reserveTokens: () => DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    });
  });

  pi.on("session_before_fork", async (event, ctx) => {
    current = ctx;
    const bound = shadow;
    const found = records.get(event.entryId);
    if (bound === undefined || found === undefined || !ctx.hasUI) return;
    if (found.shadow !== bound.dir) {
      ctx.ui.notify(
        `Checkpoint recorded in ${found.shadow}; code left untouched`,
        "warning",
      );
      return;
    }
    const plan = await planRestore(deps, bound, found.ref);
    if (plan.length === 0) return;
    const choice = await ctx.ui.select("Restore code state?", [
      "Yes, restore code to that point",
      "No, keep current code",
    ]);
    if (choice?.startsWith("Yes") !== true) return;
    const result = await applyRestore(deps, bound, plan);
    const message =
      result.applied === 0
        ? "Restore failed; nothing was written"
        : result.skipped > 0
          ? `Code restored in part: ${result.skipped} of ${plan.length} files were not written`
          : "Code restored to checkpoint";
    ctx.ui.notify(
      message,
      result.applied === 0 || result.skipped > 0 ? "warning" : "info",
    );
  });

  pi.on("session_shutdown", async (event: SessionShutdownEvent) => {
    escapeUnsubscribe?.();
    escapeUnsubscribe = undefined;
    gestureTui = undefined;
    current?.ui.setWidget(PROBE_WIDGET, undefined);
    // A run with no session file can never be resumed, so its shadow is waste for the
    // whole retention window. Only a genuine quit removes it: 'new', 'resume', and
    // 'reload' keep the process alive, and 'fork' can still fetch refs from it.
    if (ephemeralShadow && shadow !== undefined && event.reason === "quit") {
      fs.rmSync(shadow.dir, { recursive: true, force: true });
    }
  });

  // Reserve budget for a manual boundary's summary. pi's own compaction settings own
  // this value for its automatic compactions; the extension only needs a sane default.
  pi.registerCommand("rewind", {
    description: "Rewind code and/or conversation to a previous checkpoint",
    handler: async (_args, ctx) => {
      current = ctx;
      await runRewindCommand(ctx, menuDeps);
    },
  });
}

export default function (pi: ExtensionAPI): void {
  createCheckpoints(pi, defaultRuntime());
}
