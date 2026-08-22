/**
 * Confined write / edit / bash for the dream. pi's built-ins are `read`, `bash`,
 * `edit`, `write` — no `grep`/`glob`, so the shell does the searching and this
 * allowlist carries more weight than in Claude Code.
 *
 * Tool wiring (verified against SDK source): `noTools: "all"` empties the
 * allowlist and drops customTools with it, so a dream configured that way would
 * have zero tools. Instead the runner passes an explicit `tools: ["read",
 * "bash", "write", "edit"]` allowlist plus these custom definitions. Custom
 * tools are `Map.set()` after the built-ins in the tool registry, so custom
 * `bash`/`write`/`edit` shadow the built-ins under their own names — no prefix
 * needed. Built-in `read` stays enabled as-is.
 *
 * The dream's bash runs with cwd = the memory directory, so even an accidental
 * relative write lands in-domain rather than in the project tree.
 */

import { isAbsolute, resolve, sep } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  CHILD_TOOL_CALL_TIMEOUT_MS,
  runWithToolCallTimeout,
} from "../../../shared/tool-call-timeout.ts";

/**
 * Genuinely read-only shell commands. `find`/`sed`/`awk`/`xargs`/`tee` are
 * excluded because each has a well-known write escape hatch (`-exec`/`-delete`,
 * `-i`, redirects, `xargs rm`). `sort`'s `-o` can write, but only inside the
 * bash cwd (the memory dir), so it stays in-domain.
 */
export const READ_ONLY_COMMANDS: readonly string[] = [
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "diff",
  "stat",
  "pwd",
  "echo",
  "nl",
  "cut",
  "tr",
  "comm",
  "sort",
  "uniq",
];

const PROTECTED_SUBDIRS = new Set([".git", "agents", "node_modules"]);

const stripQuotes = (token: string) => token.replace(/^['"]|['"]$/g, "");

const commandHead = (segment: string) => segment.trim().split(/\s+/)[0] ?? "";

/**
 * True when `candidate` resolves to a file strictly inside `memoryDir`. Relative
 * paths resolve against the memory directory (the dream's bash cwd). The prefix
 * check ends at a separator, so `…/memory-other/x.md` is not accepted for
 * `…/memory`.
 */
export function isInsideMemoryDir(
  candidate: string,
  memoryDir: string,
): boolean {
  const base = resolve(memoryDir);
  const target = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(base, candidate);
  if (target === base) return false;
  const prefix = base.endsWith(sep) ? base : base + sep;
  return target.startsWith(prefix);
}

function isUnderProtectedSubdir(candidate: string, memoryDir: string): boolean {
  const base = resolve(memoryDir);
  const target = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(base, candidate);
  const parts = target.slice(base.length).split(sep).filter(Boolean);
  return parts.some((part) => PROTECTED_SUBDIRS.has(part));
}

/** `rm` with no flags but `-f`, only `.md` operands, all inside the memory dir. */
function isAllowedRm(segment: string, memoryDir: string): boolean {
  const tokens = segment.trim().split(/\s+/).slice(1);
  const operands: string[] = [];
  for (const token of tokens) {
    if (token.startsWith("-")) {
      if (token !== "-f") return false;
    } else {
      operands.push(stripQuotes(token));
    }
  }
  if (operands.length === 0) return false;
  return operands.every(
    (operand) =>
      operand.endsWith(".md") &&
      isInsideMemoryDir(operand, memoryDir) &&
      !isUnderProtectedSubdir(operand, memoryDir),
  );
}

/**
 * A command is allowed when its head is read-only, or it is a confined `rm`.
 * Shell features that could chain, redirect, background, or substitute are
 * rejected outright so a denied command cannot ride in on an allowed one. A
 * single `|` pipe is permitted only when every stage is itself read-only.
 */
export function isAllowedDreamCommand(
  command: string,
  memoryDir: string,
): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (
    /[`;<>&]/.test(trimmed) ||
    trimmed.includes("$(") ||
    trimmed.includes("||")
  ) {
    return false;
  }

  const segments = trimmed
    .split("|")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) return false;

  if (segments.length > 1) {
    return segments.every((segment) =>
      READ_ONLY_COMMANDS.includes(commandHead(segment)),
    );
  }

  const head = commandHead(trimmed);
  if (READ_ONLY_COMMANDS.includes(head)) return true;
  if (head === "rm") return isAllowedRm(trimmed, memoryDir);
  return false;
}

/**
 * Wrap a tool definition's execute with a per-call timeout and a synchronous
 * guard that throws to deny. Mutates and returns the same definition. Exported
 * so the timeout wrapping is testable without a live session.
 */
export function confineToolDefinition<D extends ToolDefinition<any, any, any>>(
  def: D,
  guard: (params: any) => void,
  timeoutMs: number = CHILD_TOOL_CALL_TIMEOUT_MS,
): D {
  const original = def.execute;
  def.execute = (toolCallId, params, signal, onUpdate, ctx) =>
    runWithToolCallTimeout(def.name, timeoutMs, signal, (innerSignal) => {
      guard(params);
      return original.call(def, toolCallId, params, innerSignal, onUpdate, ctx);
    });
  return def;
}

export function buildDreamTools(memoryDir: string): ToolDefinition[] {
  const bash = confineToolDefinition(
    createBashToolDefinition(memoryDir),
    (params: { command: string }) => {
      if (!isAllowedDreamCommand(params.command, memoryDir)) {
        throw new Error(
          `The dream may only run read-only shell commands or "rm -f <file>.md" inside the memory directory. Refused: ${params.command}`,
        );
      }
    },
  );

  const write = confineToolDefinition(
    createWriteToolDefinition(memoryDir),
    (params: { path: string }) => {
      if (!isInsideMemoryDir(params.path, memoryDir)) {
        throw new Error(
          `The dream may only write inside the memory directory. Refused: ${params.path}`,
        );
      }
    },
  );

  const edit = confineToolDefinition(
    createEditToolDefinition(memoryDir),
    (params: { path: string }) => {
      if (!isInsideMemoryDir(params.path, memoryDir)) {
        throw new Error(
          `The dream may only edit inside the memory directory. Refused: ${params.path}`,
        );
      }
    },
  );

  return [
    bash as ToolDefinition,
    write as ToolDefinition,
    edit as ToolDefinition,
  ];
}
