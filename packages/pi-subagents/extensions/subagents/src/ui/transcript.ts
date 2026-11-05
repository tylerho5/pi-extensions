/**
 * Transcript rendering for the takeover view: turns a SubagentSnapshot's
 * normalized transcript + live state into plain wrapped lines. Ported from
 * v1, with the session-poking replaced by snapshot reads.
 */

import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type {
  LiveToolState,
  SubagentSnapshot,
  TranscriptItem,
  TranscriptPart,
} from "../domain.ts";
import { spinnerGlyph } from "./activity-row.ts";

const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/**
 * Strip raw ANSI codes, expand tabs, and drop control chars. Terminal-expanded
 * tabs (and stray escapes) make lines wider than the width we declare to the
 * TUI, which desyncs the renderer and smears the overlay.
 */
export function sanitizeText(text: string): string {
  return text
    .replace(ANSI_PATTERN, "")
    .replaceAll("\t", "  ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

function backgroundLine(
  theme: Theme,
  color: "userMessageBg" | "toolPendingBg" | "toolSuccessBg" | "toolErrorBg",
  text: string,
  width: number,
) {
  const safe = truncateToWidth(text, width);
  const padded = safe + " ".repeat(Math.max(0, width - visibleWidth(safe)));
  return typeof theme.bg === "function" ? theme.bg(color, padded) : safe;
}

function renderUserText(
  theme: Theme,
  text: string,
  width: number,
  out: string[],
) {
  const clean = sanitizeText(text).trim();
  if (!clean) return;
  const wrapped = wrapTextWithAnsi(clean, Math.max(1, width - 2));
  for (const line of wrapped) {
    out.push(
      backgroundLine(
        theme,
        "userMessageBg",
        `${theme.fg("accent", "> ")}${theme.fg("userMessageText", line)}`,
        width,
      ),
    );
  }
}

function renderMarkdown(text: string, width: number, out: string[]) {
  const clean = sanitizeText(text).trim();
  if (!clean) return;
  out.push(
    ...new Markdown(clean, 0, 0, getMarkdownTheme())
      .render(width)
      .map((line) => truncateToWidth(line, width)),
  );
}

/** Matches the main session's collapsed thinking label (collapsed-previews). */
const THINKING_SNIPPET_MAX = 160;

function renderThinking(
  theme: Theme,
  text: string,
  width: number,
  out: string[],
  visible: boolean,
) {
  const reasoning = sanitizeText(text).trim();
  if (!visible) {
    const flat = reasoning.replace(/\s+/g, " ");
    const snippet =
      flat.length > THINKING_SNIPPET_MAX
        ? `${flat.slice(0, THINKING_SNIPPET_MAX - 1)}…`
        : flat;
    const label = snippet ? `💭 thinking · ${snippet} (ctrl+t)` : "💭 thinking";
    // Wrap like the main session's label — truncating to one line would cut
    // off the … and the (ctrl+t) tail.
    out.push(
      ...wrapTextWithAnsi(theme.fg("thinkingText", theme.italic(label)), width),
    );
    return;
  }
  if (!reasoning) return;
  const prefix = theme.fg("dim", "~ ");
  const wrapped = wrapTextWithAnsi(reasoning, Math.max(10, width - 2));
  for (let i = 0; i < wrapped.length; i++) {
    out.push(
      truncateToWidth(
        (i === 0 ? prefix : "  ") + theme.fg("muted", theme.italic(wrapped[i])),
        width,
      ),
    );
  }
}

function renderAssistantItem(
  theme: Theme,
  item: Extract<TranscriptItem, { kind: "assistant" }>,
  width: number,
  out: string[],
  showThinking: boolean,
  showTools: boolean,
) {
  for (const part of item.parts) {
    if (part.type === "text") {
      const text = sanitizeText(part.text).trim();
      if (!text) continue;
      renderMarkdown(text, width, out);
    } else if (part.type === "thinking") {
      renderThinking(
        theme,
        part.redacted ? "[redacted reasoning]" : part.text,
        width,
        out,
        showThinking,
      );
    } else if (part.type === "toolCall") {
      if (!showTools) {
        out.push(theme.fg("dim", "→ tool call hidden · ctrl+o"));
        continue;
      }
      const preview = part.argsPreview ? sanitizeText(part.argsPreview) : "";
      const line =
        theme.fg("muted", "→ ") +
        theme.fg("toolTitle", part.name) +
        (preview && preview !== "{}" ? theme.fg("dim", ` ${preview}`) : "");
      out.push(truncateToWidth(line, width));
    }
  }
}

function renderToolCall(
  theme: Theme,
  item: Extract<TranscriptPart, { type: "toolCall" }>,
  width: number,
  out: string[],
  result?: Extract<TranscriptItem, { kind: "toolResult" }>,
  expanded = false,
  live?: LiveToolState,
  frame = 0,
) {
  const preview = item.argsPreview ? sanitizeText(item.argsPreview) : "";
  const fullArgs = expanded && item.args ? sanitizeText(item.args) : "";
  const argsLines = fullArgs
    ? wrapTextWithAnsi(fullArgs, Math.max(1, width - 2))
    : [];
  const firstArgsLine =
    argsLines.length > 0
      ? argsLines[0]
      : preview && preview !== "{}"
        ? preview
        : "";
  const background = result?.isError
    ? "toolErrorBg"
    : result
      ? "toolSuccessBg"
      : "toolPendingBg";
  out.push(
    backgroundLine(
      theme,
      background,
      truncateToWidth(
        `${theme.fg("muted", "→ ")}${theme.fg("toolTitle", item.name)}${firstArgsLine ? theme.fg("dim", ` ${firstArgsLine}`) : ""}`,
        width,
      ),
      width,
    ),
  );
  for (const line of argsLines.slice(1)) {
    out.push(
      backgroundLine(
        theme,
        background,
        truncateToWidth(`  ${theme.fg("dim", line)}`, width),
        width,
      ),
    );
  }
  if (!result) {
    const liveOutput = live?.outputPreview && sanitizeText(live.outputPreview);
    const pending = !live?.done;
    const failed = live?.isError ?? false;
    const state = pending
      ? `${theme.fg("warning", spinnerGlyph(frame))} ${theme.fg("warning", "running")}`
      : `${theme.fg(failed ? "error" : "success", failed ? "error: " : "done")}${liveOutput ? theme.fg("dim", liveOutput) : ""}`;
    const color = pending
      ? "toolPendingBg"
      : failed
        ? "toolErrorBg"
        : "toolSuccessBg";
    out.push(
      backgroundLine(theme, color, truncateToWidth(state, width), width),
    );
    return;
  }
  const output = sanitizeText(
    expanded
      ? (result.output ?? result.outputPreview ?? "")
      : (result.outputPreview ?? result.output ?? ""),
  );
  const firstLine =
    output.split("\n").find((line) => line.trim()) ?? "(no output)";
  const status = result.isError
    ? theme.fg("error", "error: ")
    : theme.fg("dim", "output: ");
  out.push(
    backgroundLine(
      theme,
      result.isError ? "toolErrorBg" : "toolSuccessBg",
      truncateToWidth(status + theme.fg("dim", firstLine), width),
      width,
    ),
  );
  if (expanded) {
    const continuationColor = result.isError ? "toolErrorBg" : "toolSuccessBg";
    for (const line of output.split("\n").slice(1)) {
      for (const wrapped of wrapTextWithAnsi(
        sanitizeText(line),
        Math.max(1, width - 2),
      )) {
        out.push(
          backgroundLine(
            theme,
            continuationColor,
            `  ${theme.fg("dim", wrapped)}`,
            width,
          ),
        );
      }
    }
  }
}

// --- Persisted/live merge -----------------------------------------------------

/**
 * Bounded signature used to locate where the live transcript starts inside
 * the persisted one. Not a deep equality — enough to anchor the overlap.
 */
function itemSignature(item: TranscriptItem): string {
  switch (item.kind) {
    case "user":
      return `u:${item.text.slice(0, 80)}`;
    case "assistant": {
      const first = item.parts[0];
      const head =
        first === undefined
          ? ""
          : first.type === "text"
            ? `t:${first.text.slice(0, 80)}`
            : first.type === "thinking"
              ? `k:${first.text.slice(0, 80)}`
              : `c:${first.name}:${first.toolId}`;
      return `a:${item.parts.length}:${head}`;
    }
    case "toolResult":
      return `r:${item.toolId}:${item.name}`;
  }
}

/**
 * Merge the bounded live transcript with the full persisted one for display.
 *
 * Both are the same event stream, so the live items are a suffix of the
 * persisted items (modulo the 512-item in-memory bound). The live transcript
 * always wins: it is continuously updated, while the persisted snapshot is
 * frozen at load time — rendering the persisted list alone would make every
 * message that finalizes after the load vanish from the view. Items that
 * precede the live window were pruned from memory and are recovered from
 * disk, and toolResult items get their full multi-line output back (the live
 * pipeline keeps only a one-line preview).
 */
export function mergeTranscripts(
  persisted: ReadonlyArray<TranscriptItem> | undefined,
  live: ReadonlyArray<TranscriptItem>,
): ReadonlyArray<TranscriptItem> {
  if (!persisted || persisted.length === 0) return live;

  const fullOutputs = new Map<string, string>();
  const fullArgs = new Map<string, string>();
  for (const item of persisted) {
    if (item.kind === "toolResult" && item.output) {
      fullOutputs.set(item.toolId, item.output);
    } else if (item.kind === "assistant") {
      for (const part of item.parts) {
        if (part.type === "toolCall" && part.args) {
          fullArgs.set(part.toolId, part.args);
        }
      }
    }
  }

  const first = live[0];
  let prunedStart = -1;
  if (first) {
    const signature = itemSignature(first);
    for (let i = persisted.length - 1; i >= 0; i--) {
      if (itemSignature(persisted[i]) === signature) {
        prunedStart = i;
        break;
      }
    }
  }
  const merged =
    prunedStart > 0 ? [...persisted.slice(0, prunedStart), ...live] : live;
  return merged.map((item) => {
    if (item.kind === "toolResult" && item.output === undefined) {
      return { ...item, output: fullOutputs.get(item.toolId) };
    }
    if (item.kind === "assistant") {
      let changed = false;
      const parts = item.parts.map((part) => {
        if (part.type !== "toolCall" || part.args !== undefined) return part;
        const args = fullArgs.get(part.toolId);
        if (args === undefined) return part;
        changed = true;
        return { ...part, args };
      });
      return changed ? { ...item, parts } : item;
    }
    return item;
  });
}

/**
 * Render a btw aside's answer — assistant content only. The question already
 * heads the /btw panel, and btw children run without tools, so user and
 * toolResult items are skipped.
 */
export function buildBtwAnswerLines(
  snap: SubagentSnapshot,
  width: number,
  theme: Theme,
  options: { showThinking: boolean },
): string[] {
  const out: string[] = [];

  for (const item of snap.transcript) {
    if (item.kind !== "assistant") continue;
    const before = out.length;
    renderAssistantItem(theme, item, width, out, options.showThinking, true);
    if (out.length > before) out.push("");
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();

  if (snap.liveAssistant) {
    const { thinking, text } = snap.liveAssistant;
    const before = out.length;
    if (out.length > 0) out.push("");
    if (thinking.trim())
      renderThinking(theme, thinking, width, out, options.showThinking);
    if (text.trim())
      out.push(...wrapTextWithAnsi(sanitizeText(text).trim(), width));
    if (out.length === before + 1) out.pop();
  }

  return out;
}

/** Render a subagent's conversation as plain lines, wrapped to `width`. */
export function buildTranscriptLines(
  snap: SubagentSnapshot,
  width: number,
  theme: Theme,
  options:
    | {
        showThinking: boolean;
        toolsExpanded: boolean;
        showTools?: never;
        frame?: number;
      }
    | {
        showThinking: boolean;
        showTools: boolean;
        toolsExpanded?: never;
        frame?: number;
      },
): string[] {
  const out: string[] = [];
  const toolsExpanded = options.toolsExpanded ?? options.showTools ?? false;
  const frame = options.frame ?? 0;
  const results = new Map<
    string,
    Extract<TranscriptItem, { kind: "toolResult" }>
  >();
  const callIds = new Set<string>();
  for (const item of snap.transcript) {
    if (item.kind === "assistant") {
      for (const part of item.parts)
        if (part.type === "toolCall") callIds.add(part.toolId);
    } else if (item.kind === "toolResult") {
      results.set(item.toolId, item);
    }
  }
  const liveTools = new Map(snap.liveTools.map((tool) => [tool.toolId, tool]));
  for (const item of snap.transcript) {
    if (item.kind === "user") {
      renderUserText(theme, item.text, width, out);
    } else if (item.kind === "assistant") {
      for (const part of item.parts) {
        if (part.type === "toolCall") {
          renderToolCall(
            theme,
            part,
            width,
            out,
            results.get(part.toolId),
            toolsExpanded,
            liveTools.get(part.toolId),
            frame,
          );
        } else if (part.type === "text") {
          renderMarkdown(part.text, width, out);
        } else {
          renderThinking(
            theme,
            part.redacted ? "[redacted reasoning]" : part.text,
            width,
            out,
            options.showThinking,
          );
        }
      }
    } else if (!callIds.has(item.toolId)) {
      const output = sanitizeText(
        toolsExpanded
          ? (item.output ?? item.outputPreview ?? "")
          : (item.outputPreview ?? item.output ?? ""),
      );
      const firstLine =
        output.split("\n").find((line) => line.trim()) ?? "(no output)";
      const color = item.isError ? "toolErrorBg" : "toolSuccessBg";
      const label = item.isError
        ? theme.fg("error", "error: ")
        : theme.fg("dim", "output: ");
      out.push(
        backgroundLine(
          theme,
          color,
          truncateToWidth(label + theme.fg("dim", firstLine), width),
          width,
        ),
      );
      if (toolsExpanded) {
        for (const line of output.split("\n").slice(1)) {
          for (const wrapped of wrapTextWithAnsi(line, Math.max(1, width - 2)))
            out.push(
              backgroundLine(
                theme,
                color,
                `  ${theme.fg("dim", wrapped)}`,
                width,
              ),
            );
        }
      }
    }
  }

  if (snap.liveAssistant) {
    const { thinking, text } = snap.liveAssistant;
    if (thinking.trim())
      renderThinking(theme, thinking, width, out, options.showThinking);
    if (text.trim()) renderMarkdown(text, width, out);
  }

  for (const tool of snap.liveTools) {
    if (callIds.has(tool.toolId)) continue;
    const color = tool.isError
      ? "toolErrorBg"
      : tool.done
        ? "toolSuccessBg"
        : "toolPendingBg";
    const marker = tool.done
      ? theme.fg(
          tool.isError ? "error" : "success",
          tool.isError ? "error" : "done",
        )
      : `${theme.fg("warning", spinnerGlyph(frame))} ${theme.fg("warning", "running")}`;
    let line = `${theme.fg("toolTitle", tool.name)} · ${marker}`;
    const preview = tool.outputPreview && sanitizeText(tool.outputPreview);
    if (preview) line += theme.fg("dim", ` · ${preview}`);
    out.push(backgroundLine(theme, color, truncateToWidth(line, width), width));
  }

  for (const message of snap.queued) {
    const prefix = theme.fg("warning", `> [queued ${message.kind}] `);
    const wrapped = wrapTextWithAnsi(
      sanitizeText(message.text),
      Math.max(1, width - visibleWidth(prefix)),
    );
    for (let i = 0; i < wrapped.length; i++) {
      out.push(
        truncateToWidth(
          (i === 0 ? prefix : " ".repeat(visibleWidth(prefix))) +
            theme.fg("muted", wrapped[i]),
          width,
        ),
      );
    }
  }
  return out;
}
