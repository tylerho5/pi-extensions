import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// Module-level on purpose: the stash survives session rebinds (/new, /resume,
// /fork) within the process, matching Claude Code's app-level React state.
// A full /reload re-imports the module and resets it, also like CC losing the
// stash on process restart.
let stashed: string | undefined;

// A held ctrl+shift+s autorepeats (kitty CSI-u event type 2, or legacy raw
// bytes) and
// pi's TUI filters key releases but not repeats, so the shortcut would cycle
// stash -> restore while the key is held. Suppress toggles inside this window;
// events keep updating lastToggleAt so a long hold stays suppressed.
const REPEAT_WINDOW_MS = 300;
let lastToggleAt = 0;

export function shouldToggle(now: number, lastToggleAtMs: number) {
  return now - lastToggleAtMs >= REPEAT_WINDOW_MS;
}

/**
 * Claude Code's chat:stash semantics (CC binds ctrl+s; here ctrl+shift+s):
 * - editor has text -> save it (raw, untrimmed), clear the editor. A second
 *   stash overwrites the first: single slot, no stack.
 * - editor empty (or whitespace-only) + stash exists -> restore it, clear the slot.
 * - editor empty + no stash -> no-op.
 */
export function decideStashAction(
  editorText: string,
  stashedText: string | undefined,
) {
  if (editorText.trim() !== "")
    return { action: "stash", text: editorText } as const;
  if (stashedText !== undefined)
    return { action: "restore", text: stashedText } as const;
  return { action: "noop" } as const;
}

export function stashPreview(text: string, max = 40) {
  const squashed = text.replace(/\s+/g, " ").trim();
  return squashed.length > max ? `${squashed.slice(0, max - 1)}…` : squashed;
}

async function toggleStash(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;

  const now = Date.now();
  if (!shouldToggle(now, lastToggleAt)) {
    lastToggleAt = now;
    return;
  }
  lastToggleAt = now;

  const decision = decideStashAction(ctx.ui.getEditorText(), stashed);

  if (decision.action === "stash") {
    stashed = decision.text;
    ctx.ui.setEditorText("");
    ctx.ui.setStatus("prompt-stash", `stashed: ${stashPreview(decision.text)}`);
    return;
  }

  if (decision.action === "restore") {
    stashed = undefined;
    ctx.ui.setStatus("prompt-stash", undefined);
    ctx.ui.setEditorText(decision.text);
    ctx.ui.notify("Draft restored", "info");
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerShortcut("ctrl+shift+s", {
    description: "Stash the current prompt draft, or restore the stashed draft",
    handler: toggleStash,
  });

  pi.registerCommand("stash", {
    description:
      "Stash the current prompt draft, or restore the stashed draft (same as ctrl+shift+s)",
    handler: async (_args, ctx) => toggleStash(ctx),
  });
}
