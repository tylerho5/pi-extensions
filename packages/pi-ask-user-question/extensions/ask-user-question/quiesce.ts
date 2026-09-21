/**
 * A quiet questionnaire, so the terminal can scroll while it waits.
 *
 * pi's inline TUI keeps the transcript in the terminal's own scrollback and
 * the live region at the bottom of the buffer. While ask_user_question runs,
 * the working spinner animates for the whole turn: a Loader frame every 80ms,
 * each one terminal output, and scroll-following terminals (kitty, Terminal.app,
 * iTerm2 by default) snap the viewport to the bottom on output. The user
 * cannot stay scrolled up while a questionnaire is open. Claude Code's panel
 * is static while idle, so nothing is written until a key lands: scrolling
 * works, the panel moves down out of view, and the next keypress brings the
 * view back.
 *
 * `ctx.ui.setWorkingIndicator` swaps the live spinner for a single-frame
 * indicator, and a one-frame Loader clears its animation interval, so pi
 * writes nothing while the dialog waits for input. The default animated
 * indicator is restored in `finally`, re-applied to the live indicator,
 * however the questionnaire ends: answered, dismissed, chat, failure.
 *
 * The working row stays put holding one static glyph rather than hiding via
 * `setWorkingVisible(false)`: hiding reflows the live region twice for no
 * gain, and the row is one line either way. Nothing else in this setup calls
 * `setWorkingIndicator`, so restoring the default overwrites no configuration.
 */

/** The single frame the working indicator holds while a questionnaire is open. */
export const QUIET_WORKING_FRAME = "◐";

/** Structural shape, so this module needs no upstream types. */
interface QuietUiLike {
  setWorkingIndicator(options?: {
    frames?: string[];
    intervalMs?: number;
  }): void;
}

/**
 * Freeze the working spinner for the duration of a questionnaire so the
 * terminal can scroll. Hosts without `setWorkingIndicator` (RPC, print) run
 * the tool exactly as before.
 */
export function withQuietQuestionnaire<T extends object>(tool: T): T {
  const execute = (tool as { execute?: unknown }).execute;
  if (typeof execute !== "function") return tool;
  const run = execute as (...args: unknown[]) => Promise<unknown>;

  return {
    ...tool,
    async execute(...args: unknown[]) {
      const ui = (args[4] as { ui?: QuietUiLike } | undefined)?.ui;
      if (!ui || typeof ui.setWorkingIndicator !== "function") {
        return run(...args);
      }
      ui.setWorkingIndicator({ frames: [QUIET_WORKING_FRAME] });
      try {
        return await run(...args);
      } finally {
        ui.setWorkingIndicator();
      }
    },
  };
}
