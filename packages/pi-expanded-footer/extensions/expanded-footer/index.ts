/**
 * Expanded Footer Extension
 *
 * Replaces pi's default footer with a layout mimicking Claude Code's statusline:
 *
 *   Line 1: model_name · effort | {tokens}tokens [{ctx%}] | ↑input ↓output Rcache CHhit% $cost
 *   Line 2: ~/path · branch
 *   Line 3: [extension statuses]
 *
 * Colors match Claude's scheme:
 *   - Model name: accent (#8abeb7 teal/cyan, vs Claude's \033[36m)
 *   - Effort: dim
 *   - Context tokens: success/warning/error (green/yellow/red) at 34%/67% thresholds
 *   - Path: customMessageLabel (#9575cd purple, matching Claude's \033[35m magenta)
 *   - Branch: warning (#ffff00 yellow, matching Claude's \033[33m)
 *   - Worktree: syntaxVariable (#9cdcfe light blue, matching Claude's \033[94m)
 *   - Token stats: dim
 */

import { execSync } from "node:child_process";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  cacheStatText,
  loadConfig,
  type TtlConfig,
} from "../lib/cache-timer.ts";

interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total: number };
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

// Track the current thinking level across sessions.
// Updated by thinking_level_select event; starts at a sensible default
// and gets overridden when the real level is known.
let currentThinkingLevel = "off";

// Cache countdown timer: shown inline in the stats line, left of the token stats.
let cacheTimerEnabled = true;
let cacheConfig: TtlConfig = {};
let cacheTicker: ReturnType<typeof setInterval> | undefined;

/**
 * Detect git worktree name from the current directory.
 * Returns the worktree name if in a linked worktree, null otherwise.
 */
function detectWorktree(cwd: string): string | null {
  try {
    const gitDir = execSync("git rev-parse --git-dir", {
      cwd,
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // Worktree git dirs look like: .git/worktrees/<name>
    const match = gitDir.match(/worktrees\/([^/]+)$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  // Listen for thinking level changes so the footer stays in sync
  pi.on("thinking_level_select", async (event) => {
    currentThinkingLevel = event.level;
  });

  pi.on("session_start", async (_event, ctx) => {
    // Capture ctx once per session; setFooter closure holds it.
    const capturedCtx = ctx;
    const worktreeName = detectWorktree(ctx.cwd);
    cacheConfig = loadConfig();

    capturedCtx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      // Re-render every second so the cache countdown ticks
      if (cacheTicker) clearInterval(cacheTicker);
      cacheTicker = setInterval(() => tui.requestRender(), 1000);

      return {
        dispose: () => {
          unsub();
          if (cacheTicker) {
            clearInterval(cacheTicker);
            cacheTicker = undefined;
          }
        },
        invalidate() {},

        render(width: number): string[] {
          // ── Gather cumulative usage across all entries ──
          let input = 0,
            output = 0,
            cacheRead = 0,
            cacheWrite = 0,
            cost = 0;
          let latestCacheHitRate: number | undefined;

          for (const e of capturedCtx.sessionManager.getEntries()) {
            if (
              e.type === "message" &&
              (e.message as AssistantMessage).role === "assistant"
            ) {
              const usage = (e.message as AssistantMessage).usage as Usage;
              input += usage.input || 0;
              output += usage.output || 0;
              cacheRead += usage.cacheRead || 0;
              cacheWrite += usage.cacheWrite || 0;
              cost += usage.cost?.total || 0;

              const promptTokens =
                (usage.input || 0) +
                (usage.cacheRead || 0) +
                (usage.cacheWrite || 0);
              latestCacheHitRate =
                promptTokens > 0
                  ? ((usage.cacheRead || 0) / promptTokens) * 100
                  : undefined;
            } else if (
              e.type === "message" &&
              (e.message as { role: string }).role === "toolResult" &&
              (e.message as { usage?: Usage }).usage
            ) {
              const usage = (e.message as { usage?: Usage }).usage;
              cost += usage?.cost?.total || 0;
            } else if (
              (e.type === "branch_summary" || e.type === "compaction") &&
              (e as { usage?: Usage }).usage
            ) {
              const u = (e as { usage: Usage }).usage;
              input += u.input || 0;
              output += u.output || 0;
              cacheRead += u.cacheRead || 0;
              cacheWrite += u.cacheWrite || 0;
              cost += u.cost?.total || 0;
            }
          }

          const contextUsage = capturedCtx.getContextUsage();
          const contextWindow =
            contextUsage?.contextWindow ??
            capturedCtx.model?.contextWindow ??
            200_000;
          const contextPercentValue = contextUsage?.percent ?? 0;
          const contextPercent =
            contextUsage?.percent !== null
              ? contextPercentValue.toFixed(1)
              : "?";

          const model = capturedCtx.model;
          const modelName = model?.id || "no-model";
          const thinkingLevel = model?.reasoning
            ? currentThinkingLevel
            : undefined;

          // ── Path with home shortening + branch ──
          const branch = footerData.getGitBranch();
          const home = process.env.HOME || process.env.USERPROFILE || "";
          let pwd = capturedCtx.cwd;
          if (home && pwd.startsWith(home)) {
            pwd = "~" + pwd.slice(home.length);
          }

          // Build Claude-style context display:
          //   Standard: "{tokens}tokens [{percent}%]"
          //   Large ctx (>200k): "{tokens}tokens [{percent}% {window} | {pct_200k}% 200k]"
          const pctNum = parseFloat(contextPercent);
          let ctxDisplay: string;
          if (isNaN(pctNum)) {
            ctxDisplay = theme.fg("dim", "? tokens [?]");
          } else {
            const tokensInCtx = Math.round((pctNum / 100) * contextWindow);
            const tokFmt = formatTokens(tokensInCtx);

            let ctxStr: string;
            if (contextWindow > 200_000) {
              const pct200k = Math.round((pctNum * contextWindow) / 200000);
              const winFmt = formatTokens(contextWindow);
              ctxStr = `${tokFmt} tokens [${contextPercent}% ${winFmt} | ${pct200k}% 200k]`;
            } else {
              ctxStr = `${tokFmt} tokens [${contextPercent}%]`;
            }

            // Color by threshold: green <34%, yellow 34-66%, red >=67%
            if (pctNum >= 67) ctxDisplay = theme.fg("error", ctxStr);
            else if (pctNum >= 34) ctxDisplay = theme.fg("warning", ctxStr);
            else ctxDisplay = theme.fg("success", ctxStr);
          }

          // ── Line 1: model [· effort] | context | cost ──
          const line1Parts: string[] = [];

          // Model name in accent (cyan)
          let modelDisplay = theme.fg("accent", modelName);
          // Effort level in dim (like Claude's `<dim>effort</dim>`)
          if (thinkingLevel && thinkingLevel !== "off") {
            modelDisplay += ` ${theme.fg("dim", `· ${thinkingLevel}`)}`;
          }
          line1Parts.push(modelDisplay);

          // Separator, then context display (Claude-style, colored)
          line1Parts.push(theme.fg("dim", "|"));
          line1Parts.push(ctxDisplay);

          // Cost stays on line 1 after context
          if (cost) {
            line1Parts.push(theme.fg("dim", "|"));
            line1Parts.push(theme.fg("dim", `$${cost.toFixed(3)}`));
          }

          let line1 = line1Parts.join(" ");
          if (visibleWidth(line1) > width) {
            line1 = truncateToWidth(line1, width, theme.fg("dim", "..."));
          }

          // ── Line 2: Path (magenta) + branch (yellow) + worktree (light blue) | token stats (dim) ──
          // The branch/worktree are the high-value parts of this line: they are
          // middle-truncated last. Tail truncation would cut them off first on
          // narrow terminals.
          const stylePwd = (text: string) =>
            theme.fg("customMessageLabel", text);
          const suffixParts: string[] = [];
          if (branch) suffixParts.push(theme.fg("warning", `· ${branch}`));
          if (worktreeName) {
            suffixParts.push(
              theme.fg("syntaxVariable", `· wt:${worktreeName}`),
            );
          }
          const suffixStr = suffixParts.length
            ? ` ${suffixParts.join(" ")}`
            : "";
          const suffixWidth = visibleWidth(suffixStr);
          const branchSuffix = branch
            ? ` ${theme.fg("warning", `· ${branch}`)}`
            : "";
          const middleTruncate = (text: string, max: number): string => {
            if (visibleWidth(text) <= max) return text;
            const headW = Math.floor((max - 1) / 2);
            const tailW = max - 1 - headW;
            const head = truncateToWidth(text, headW, "");
            const tail = sliceByColumn(
              text,
              visibleWidth(text) - tailW,
              tailW,
              true,
            );
            return `${head}…${tail}`;
          };
          // Fit the path segment into a column budget, sacrificing parts in
          // order: path middle, worktree suffix, then branch length.
          const fitPath = (budget: number): string => {
            if (visibleWidth(pwd) + suffixWidth <= budget) {
              return stylePwd(pwd) + suffixStr;
            }
            const pwdBudget = budget - suffixWidth;
            if (pwdBudget >= 8) {
              return stylePwd(middleTruncate(pwd, pwdBudget)) + suffixStr;
            }
            const pwdBudgetNoWt = budget - visibleWidth(branchSuffix);
            if (worktreeName && pwdBudgetNoWt >= 8) {
              return (
                stylePwd(middleTruncate(pwd, pwdBudgetNoWt)) + branchSuffix
              );
            }
            const branchBudget = budget - 8 - 2;
            if (branch && branchBudget >= 8) {
              const stub = truncateToWidth(
                stylePwd(pwd),
                8,
                theme.fg("dim", "…"),
              );
              return `${stub} ${theme.fg("warning", `· ${middleTruncate(branch, branchBudget)}`)}`;
            }
            return truncateToWidth(
              stylePwd(pwd),
              Math.max(1, budget),
              theme.fg("dim", "..."),
            );
          };
          let pathStr = stylePwd(pwd) + suffixStr;

          // Build right-side token stats (all dim)
          const rightParts: string[] = [];

          // Cache countdown first, left of the token stats, same dim grey
          if (cacheTimerEnabled) {
            const cacheStat = cacheStatText(
              capturedCtx.sessionManager.getBranch(),
              Date.now(),
              cacheConfig,
              capturedCtx.model,
            );
            if (cacheStat) rightParts.push(cacheStat);
          }

          if (input) rightParts.push(`↑${formatTokens(input)}`);
          if (output) rightParts.push(`↓${formatTokens(output)}`);
          if (cacheRead) rightParts.push(`R${formatTokens(cacheRead)}`);
          if (cacheWrite) rightParts.push(`W${formatTokens(cacheWrite)}`);
          if (
            (cacheRead > 0 || cacheWrite > 0) &&
            latestCacheHitRate !== undefined
          ) {
            rightParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
          }

          let line2: string;
          if (rightParts.length > 0) {
            const rightStr = theme.fg("dim", rightParts.join(" "));
            const pathWidth = visibleWidth(pathStr);
            const rightWidth = visibleWidth(rightStr);
            const minGap = 2;

            if (pathWidth + minGap + rightWidth <= width) {
              const gap = width - pathWidth - rightWidth;
              line2 = pathStr + " ".repeat(gap) + rightStr;
            } else {
              // Fit the path, keeping the branch/worktree when possible
              const availForPath = width - rightWidth - minGap;
              if (availForPath > 10) {
                const fittedPath = fitPath(availForPath);
                const tPathWidth = visibleWidth(fittedPath);
                const gap = Math.max(0, width - tPathWidth - rightWidth);
                line2 = fittedPath + " ".repeat(gap) + rightStr;
              } else {
                line2 = truncateToWidth(
                  pathStr + " " + rightStr,
                  width,
                  theme.fg("dim", "..."),
                );
              }
            }
          } else {
            line2 = pathStr;
            if (visibleWidth(line2) > width) {
              line2 = fitPath(width);
            }
          }

          // ── Build output lines ──
          // Extension statuses are split: the subagent rail status sits
          // directly under the model context (line 2) so the running/done
          // counts are visible at a glance; everything else trails at the
          // bottom.
          const extStatuses = footerData.getExtensionStatuses();
          const subagentsStatus = extStatuses.get("subagents");
          const otherStatuses = Array.from(extStatuses.entries())
            .filter(([key]) => key !== "subagents")
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) => sanitizeStatusText(text));

          const lines = [line1];
          if (subagentsStatus) {
            lines.push(
              truncateToWidth(subagentsStatus, width, theme.fg("dim", "...")),
            );
          }
          lines.push(line2);
          if (otherStatuses.length > 0) {
            lines.push(
              truncateToWidth(
                otherStatuses.join(" "),
                width,
                theme.fg("dim", "..."),
              ),
            );
          }

          return lines;
        },
      };
    });
  });

  pi.registerCommand("cache-timer", {
    description: "Toggle the cache countdown timer in the footer",
    handler: async (_args, ctx) => {
      cacheTimerEnabled = !cacheTimerEnabled;
      ctx.ui.notify(
        cacheTimerEnabled ? "Cache timer enabled" : "Cache timer disabled",
        "info",
      );
    },
  });
}
