import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/**
 * Splits the startup banner's [Skills] section into "Model-Invokable" and
 * "User-Invoked" (disable-model-invocation: true) groups.
 *
 * pi core renders the banner in interactive-mode's showLoadedResources() with
 * no extension hook, so this walks the live TUI component tree, finds the
 * Skills ExpandableText, and rewrites its collapsed/expanded text getters in
 * place (no dist files modified). The model-invokable set comes from the
 * <available_skills> block in ctx.getSystemPrompt(); banner names not listed
 * there are user-invoked. showLoadedResources() recreates the section on
 * session start and /reload, so the split is re-applied (deferred past that
 * render) on every session_start.
 */

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const CAPTURE_WIDGET_KEY = "skills-banner-split-tui-capture";
const MAX_ATTEMPTS = 20;

interface ExpandableTextLike {
  text: string;
  getCollapsedText: () => string;
  getExpandedText: () => string;
  setExpanded: (expanded: boolean) => void;
  children?: unknown[];
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function parseAvailableSkillNames(systemPrompt: string): Set<string> {
  const names = new Set<string>();
  const block = systemPrompt.match(
    /<available_skills>([\s\S]*?)<\/available_skills>/,
  );
  if (!block) return names;
  for (const m of block[1].matchAll(/<name>([^<]+)<\/name>/g)) {
    names.add(m[1].trim());
  }
  return names;
}

function findSkillsSection(root: unknown): ExpandableTextLike | null {
  const stack = [root];
  const seen = new Set<unknown>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node !== "object" || node === null || seen.has(node)) continue;
    seen.add(node);
    const candidate = node as Partial<ExpandableTextLike>;
    if (
      typeof candidate.getCollapsedText === "function" &&
      typeof candidate.setExpanded === "function"
    ) {
      let text = "";
      try {
        text = stripAnsi(candidate.getCollapsedText());
      } catch {
        continue;
      }
      if (text.startsWith("[Skills]")) return candidate as ExpandableTextLike;
    }
    if (Array.isArray(candidate.children)) stack.push(...candidate.children);
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  // Stable proxy to the live TUI, captured via a throwaway widget factory
  // (factories are invoked synchronously inside setWidget).
  let tui: { children?: unknown[]; requestRender?: () => void } | null = null;

  function captureTui(ctx: ExtensionContext) {
    if (tui) return;
    ctx.ui.setWidget(CAPTURE_WIDGET_KEY, (t) => {
      tui = t as typeof tui;
      return { render: () => [], invalidate: () => {} };
    });
    ctx.ui.setWidget(CAPTURE_WIDGET_KEY, undefined);
  }

  function applySplit(ctx: ExtensionContext): boolean {
    if (!tui) return false;
    const section = findSkillsSection(tui);
    if (!section) return false;

    const collapsed = section.getCollapsedText();
    if (collapsed.includes("Model-Invokable")) return true; // already split

    const names = stripAnsi(collapsed)
      .split("\n")
      .slice(1) // drop the "[Skills]" header line
      .join(" ")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (names.length === 0) return true;

    const modelNames = parseAvailableSkillNames(ctx.getSystemPrompt());
    const modelInvokable = names.filter((n) => modelNames.has(n));
    const userInvoked = names.filter((n) => !modelNames.has(n));
    if (modelInvokable.length === 0 || userInvoked.length === 0) return true;

    const theme = ctx.ui.theme;
    const header = (label: string) => theme.fg("mdHeading", `[${label}]`);
    const body = (items: string[]) => theme.fg("dim", `  ${items.join(", ")}`);

    // Re-bucket the expanded view's per-skill path lines by skill name.
    // Scope/package header lines match no skill name and are dropped.
    const expanded = section.getExpandedText();
    const modelLines: string[] = [];
    const userLines: string[] = [];
    for (const line of expanded.split("\n").slice(1)) {
      const plain = stripAnsi(line);
      if (userInvoked.some((n) => plain.includes(`/${n}/`)))
        userLines.push(line);
      else if (modelInvokable.some((n) => plain.includes(`/${n}/`)))
        modelLines.push(line);
    }

    const collapsedText =
      `${header("Skills: Model-Invokable")}\n${body(modelInvokable)}\n\n` +
      `${header("Skills: User-Invoked")}\n${body(userInvoked)}`;
    const expandedText =
      `${header("Skills: Model-Invokable")}\n${modelLines.join("\n")}\n\n` +
      `${header("Skills: User-Invoked")}\n${userLines.join("\n")}`;

    const wasExpanded = section.text === expanded;
    section.getCollapsedText = () => collapsedText;
    section.getExpandedText = () => expandedText;
    section.setExpanded(wasExpanded);
    tui.requestRender?.();
    return true;
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    captureTui(ctx);
    // session_start fires before showLoadedResources() populates the banner
    // (startup and /reload alike), so defer past it and retry until the
    // section exists (quiet startup skips the banner — retries give up).
    let attempts = 0;
    const tryApply = () => {
      if (applySplit(ctx)) return;
      if (++attempts < MAX_ATTEMPTS) setTimeout(tryApply, 100);
    };
    setTimeout(tryApply, 0);
  });
}
