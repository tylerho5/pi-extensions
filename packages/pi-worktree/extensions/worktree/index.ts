import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { Type } from "typebox";
import { loadConfig } from "./config.ts";
import { enterWorktree, exitWorktree, WorktreeSessionError } from "./core.ts";
import { errorText } from "./git.ts";
import {
  ENTER_NAME_PARAM_DESCRIPTION,
  ENTER_PATH_PARAM_DESCRIPTION,
  ENTER_WORKTREE_PROMPT_GUIDELINES,
  ENTER_WORKTREE_PROMPT_SNIPPET,
  ENTER_WORKTREE_TOOL_DESCRIPTION,
  EXIT_ACTION_PARAM_DESCRIPTION,
  EXIT_DISCARD_PARAM_DESCRIPTION,
  EXIT_WORKTREE_PROMPT_GUIDELINES,
  EXIT_WORKTREE_PROMPT_SNIPPET,
  EXIT_WORKTREE_TOOL_DESCRIPTION,
} from "./prompt.ts";
import { type ActiveWorktree, WorktreeStateStore } from "./state.ts";

function errorResult(err: unknown): Error {
  if (err instanceof WorktreeSessionError) return err;
  return new WorktreeSessionError(`worktree tool failed: ${errorText(err)}`);
}

/**
 * pi bakes each built-in tool's cwd at creation, so "entering" a worktree is
 * implemented as cwd-aware proxies over the built-ins (the documented
 * override pattern). Each proxy delegates to a freshly-created built-in for
 * the effective cwd — the worktree while one is active, the session cwd
 * otherwise — and forwards render calls with that cwd so previews and path
 * display agree. Child sessions keep their own cwd: the active worktree only
 * applies when the caller's cwd matches the session that entered it.
 */
export default function (pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const store = new WorktreeStateStore(agentDir);
  const config = loadConfig(agentDir);
  let active: ActiveWorktree | null = null;
  let sessionCwd = process.cwd();

  function effectiveCwd(ctxCwd: string): string {
    if (active && path.resolve(active.sessionCwd) === path.resolve(ctxCwd)) {
      return active.worktreePath;
    }
    return ctxCwd;
  }

  function refreshStatus(ctx: {
    hasUI: boolean;
    ui: ExtensionContext["ui"];
  }): void {
    if (!ctx.hasUI) return;
    if (active) {
      ctx.ui.setStatus("worktree", `🌳 ${path.basename(active.worktreePath)}`);
    } else {
      ctx.ui.setStatus("worktree", undefined);
    }
  }

  pi.on("session_start", (_event, ctx) => {
    sessionCwd = ctx.cwd;
    registerProxies(pi);
    const stored = store.load();
    if (
      !active &&
      stored &&
      path.resolve(stored.sessionCwd) === path.resolve(ctx.cwd)
    ) {
      active = stored;
      store.writeLock({
        pid: process.pid,
        sessionId: stored.sessionId,
        createdAt: Date.now(),
        worktreePath: stored.worktreePath,
      });
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Resumed worktree session at ${stored.worktreePath} — use exit_worktree to leave, /worktree for status.`,
          "info",
        );
      }
    }
    refreshStatus(ctx);
  });

  /**
   * Wraps a built-in tool definition so every execution and render uses the
   * effective cwd (worktree while active). Keeps the definition's schema,
   * prompt copy, and renderers intact; delegates to per-cwd definition
   * instances so relative paths, session env, and previews all agree.
   */
  function cwdAware<TDef extends ToolDefinition<any, any, any>>(
    def: TDef,
    getCwd: (ctxCwd: string) => string,
    cache: Map<string, TDef>,
    factory: (cwd: string) => TDef,
  ): TDef {
    return {
      ...def,
      renderCall: def.renderCall
        ? (args, theme, context) =>
            def.renderCall!(args, theme, {
              ...context,
              cwd: getCwd(context.cwd),
            })
        : undefined,
      renderResult: def.renderResult
        ? (result, options, theme, context) =>
            def.renderResult!(result, options, theme, {
              ...context,
              cwd: getCwd(context.cwd),
            })
        : undefined,
      execute: (toolCallId, params, signal, onUpdate, ctx) => {
        const cwd = getCwd(ctx.cwd);
        let tool = cache.get(cwd);
        if (!tool) {
          tool = factory(cwd);
          cache.set(cwd, tool);
        }
        return tool.execute(toolCallId, params, signal, onUpdate, ctx);
      },
    } as TDef;
  }

  function registerProxies(pi: ExtensionAPI): void {
    pi.registerTool(
      cwdAware(
        createBashToolDefinition(sessionCwd),
        effectiveCwd,
        new Map(),
        createBashToolDefinition,
      ),
    );
    pi.registerTool(
      cwdAware(
        createReadToolDefinition(sessionCwd),
        effectiveCwd,
        new Map(),
        createReadToolDefinition,
      ),
    );
    pi.registerTool(
      cwdAware(
        createWriteToolDefinition(sessionCwd),
        effectiveCwd,
        new Map(),
        createWriteToolDefinition,
      ),
    );
    pi.registerTool(
      cwdAware(
        createEditToolDefinition(sessionCwd),
        effectiveCwd,
        new Map(),
        createEditToolDefinition,
      ),
    );
    pi.registerTool(
      cwdAware(
        createGrepToolDefinition(sessionCwd),
        effectiveCwd,
        new Map(),
        createGrepToolDefinition,
      ),
    );
    pi.registerTool(
      cwdAware(
        createFindToolDefinition(sessionCwd),
        effectiveCwd,
        new Map(),
        createFindToolDefinition,
      ),
    );
    pi.registerTool(
      cwdAware(
        createLsToolDefinition(sessionCwd),
        effectiveCwd,
        new Map(),
        createLsToolDefinition,
      ),
    );
  }

  pi.registerTool({
    name: "enter_worktree",
    label: "Enter Worktree",
    description: ENTER_WORKTREE_TOOL_DESCRIPTION,
    promptSnippet: ENTER_WORKTREE_PROMPT_SNIPPET,
    promptGuidelines: ENTER_WORKTREE_PROMPT_GUIDELINES,
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({ description: ENTER_NAME_PARAM_DESCRIPTION }),
      ),
      path: Type.Optional(
        Type.String({ description: ENTER_PATH_PARAM_DESCRIPTION }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await enterWorktree(
          {
            sessionCwd: ctx.cwd,
            sessionId: ctx.sessionManager.getSessionId(),
            stateDir: agentDir,
            config,
            confirmEnterPath: ctx.hasUI
              ? (target) =>
                  ctx.ui.confirm(
                    "Enter worktree?",
                    `Enter the worktree at ${target}? This moves the session's file tools and write access there.`,
                  )
              : undefined,
          },
          { name: params.name, path: params.path },
        );
        active = result.state;
        refreshStatus(ctx);
        return {
          content: [{ type: "text", text: result.message }],
          details: {
            worktreePath: result.state.worktreePath,
            worktreeBranch: result.state.branch,
          },
        };
      } catch (err) {
        throw errorResult(err);
      }
    },
  });

  pi.registerTool({
    name: "exit_worktree",
    label: "Exit Worktree",
    description: EXIT_WORKTREE_TOOL_DESCRIPTION,
    promptSnippet: EXIT_WORKTREE_PROMPT_SNIPPET,
    promptGuidelines: EXIT_WORKTREE_PROMPT_GUIDELINES,
    parameters: Type.Object({
      action: StringEnum(["keep", "remove"] as const, {
        description: EXIT_ACTION_PARAM_DESCRIPTION,
      }),
      discard_changes: Type.Optional(
        Type.Boolean({ description: EXIT_DISCARD_PARAM_DESCRIPTION }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await exitWorktree(
          {
            sessionCwd: ctx.cwd,
            sessionId: ctx.sessionManager.getSessionId(),
            stateDir: agentDir,
            config,
          },
          { action: params.action, discard_changes: params.discard_changes },
        );
        active = null;
        refreshStatus(ctx);
        return {
          content: [{ type: "text", text: result.message }],
          details: {
            action: result.action,
            worktreePath: result.worktreePath,
            worktreeBranch: result.worktreeBranch,
          },
        };
      } catch (err) {
        throw errorResult(err);
      }
    },
  });

  pi.registerCommand("worktree", {
    description: "Show or reset the active worktree session",
    handler: async (args, ctx) => {
      if (args === "reset") {
        const stored = store.load();
        if (!stored && !active) {
          if (ctx.hasUI) ctx.ui.notify("No worktree state to reset.", "info");
          return;
        }
        if (ctx.hasUI) {
          const ok = await ctx.ui.confirm(
            "Reset worktree state?",
            "Clear the active worktree state without touching the worktree itself? The worktree and its branch stay on disk.",
          );
          if (!ok) return;
        }
        if (stored) store.releaseLock(stored.worktreePath);
        store.clear();
        active = null;
        refreshStatus(ctx);
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Worktree state cleared. The worktree and branch were left on disk.",
            "info",
          );
        }
        return;
      }
      const current = active ?? store.load();
      if (!current) {
        if (ctx.hasUI) ctx.ui.notify("Not in a worktree session.", "info");
        return;
      }
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Worktree: ${current.worktreePath}${
            current.branch ? ` (branch ${current.branch})` : ""
          } · original: ${current.originalCwd}`,
          "info",
        );
      }
    },
  });
}
