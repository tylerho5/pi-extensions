import {
  AssistantMessageComponent,
  ToolExecutionComponent,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

/**
 * Collapsed previews for pi's TUI.
 *
 * - Hidden thinking blocks (hideThinkingBlock: true) show a snippet of the
 *   reasoning instead of just a static label. Ctrl+T still toggles full view.
 * - Edit tool diffs are collapsed by default to their header plus a
 *   "+added -removed" summary. Ctrl+O expands them, like other tool output.
 *
 * Both are runtime prototype patches on pi's own component classes (the
 * package re-exports them and extensions share pi's module instance, so the
 * patches affect pi's UI directly). No dist files are modified. The PATCHED
 * marker survives /reload so handlers are never stacked.
 */

const THINKING_LABEL = "💭 thinking";
const SNIPPET_MAX = 160;
const PATCHED = Symbol.for("pi-collapsed-previews.patched");

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string) {
  return text.replace(ANSI_RE, "");
}

interface TextLike {
  text: string;
  setText(text: string): void;
}

function isTextLike(value: unknown): value is TextLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as TextLike).text === "string" &&
    typeof (value as TextLike).setText === "function"
  );
}

interface ContainerLike {
  children: unknown[];
  removeChild(child: unknown): void;
}

type PrototypeRecord = Record<PropertyKey, unknown>;

// ---------------------------------------------------------------------------
// Thinking snippets
// ---------------------------------------------------------------------------

type UpdateContent = AssistantMessageComponent["updateContent"];
type MessageContent = Parameters<UpdateContent>[0]["content"];

interface AssistantInternals {
  hideThinkingBlock: boolean;
  hiddenThinkingLabel: string;
  contentContainer: ContainerLike;
}

/** Group consecutive thinking blocks into runs, mirroring updateContent(). */
function thinkingRuns(content: MessageContent) {
  const runs: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const run = current.join(" ").replace(/\s+/g, " ").trim();
    if (run) runs.push(run);
    current = [];
  };
  for (const block of content) {
    if (block.type === "thinking") {
      const text = block.thinking.trim();
      if (text) current.push(text);
    } else {
      flush();
    }
  }
  flush();
  return runs;
}

function snippet(run: string) {
  const cut = run.slice(0, SNIPPET_MAX);
  return cut.length < run.length ? `${cut}…` : cut;
}

function patchAssistantMessage() {
  const proto =
    AssistantMessageComponent.prototype as unknown as PrototypeRecord;
  if (proto[PATCHED]) return;

  const original = proto.updateContent as UpdateContent;
  proto.updateContent = function (
    this: AssistantMessageComponent,
    ...args: Parameters<UpdateContent>
  ) {
    original.apply(this, args);
    const self = this as unknown as AssistantInternals;
    if (!self.hideThinkingBlock) return;
    const runs = thinkingRuns(args[0].content);
    if (runs.length === 0) return;

    let runIndex = 0;
    for (const child of self.contentContainer.children) {
      if (runIndex >= runs.length) break;
      if (!isTextLike(child)) continue;
      // The hidden-state label is the only Text child whose entire content
      // is exactly the label (Markdown blocks hold longer prose).
      if (stripAnsi(child.text).trim() !== self.hiddenThinkingLabel) continue;
      child.setText(
        child.text.replace(
          self.hiddenThinkingLabel,
          `${self.hiddenThinkingLabel} · ${snippet(runs[runIndex])} (ctrl+t)`,
        ),
      );
      runIndex++;
    }
  };
  proto[PATCHED] = true;
}

// ---------------------------------------------------------------------------
// Collapsible edit diffs
// ---------------------------------------------------------------------------

interface EditCallComponent extends ContainerLike {
  preview?: { error?: string } | { diff?: string };
}

interface ToolExecInternals {
  toolName: string;
  expanded: boolean;
  callRendererComponent?: EditCallComponent;
}

/** Count +/- lines in renderDiff() output ("+<lineNum> …" / "-<lineNum> …"). */
function diffStats(diffText: string) {
  let added = 0;
  let removed = 0;
  for (const line of stripAnsi(diffText).split("\n")) {
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function patchToolExecution() {
  const proto = ToolExecutionComponent.prototype as unknown as PrototypeRecord;
  if (proto[PATCHED]) return;

  const original = proto.updateDisplay as (
    this: ToolExecutionComponent,
  ) => void;
  proto.updateDisplay = function (this: ToolExecutionComponent) {
    original.call(this);
    const self = this as unknown as ToolExecInternals;
    if (self.toolName !== "edit" || self.expanded) return;
    const call = self.callRendererComponent;
    if (!call || !Array.isArray(call.children) || call.children.length <= 1)
      return;
    if (call.preview && "error" in call.preview) return; // keep errors visible

    const [header, ...rest] = call.children;
    const body = rest
      .filter(isTextLike)
      .map((c) => c.text)
      .join("\n");
    const { added, removed } = diffStats(body);
    const stats = added + removed > 0 ? ` +${added} -${removed}` : "";
    for (const child of rest) call.removeChild(child);
    if (isTextLike(header)) {
      header.setText(`${header.text}  ·${stats} diff (ctrl+o)`);
    }
  };
  proto[PATCHED] = true;
}

// ---------------------------------------------------------------------------

patchAssistantMessage();
patchToolExecution();

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setHiddenThinkingLabel(THINKING_LABEL);
  });
}
