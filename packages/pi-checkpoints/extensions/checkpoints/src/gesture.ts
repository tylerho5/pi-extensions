/**
 * Double Escape opens `/rewind`, matching Claude Code.
 *
 * pi's built-in editor owns Escape behind a fixed `tree | fork | none` setting and has
 * no hook for a new action, so the gesture is picked up from raw terminal input instead.
 * That listener runs before the focused component and can consume, which lets the second
 * press open rewind and never reach the built-in at all.
 *
 * Because neither the focused component nor the session state is visible from the raw
 * input handler, every guard the built-in applies has to be repeated here: an empty
 * editor, an idle agent, and focus on the chat editor rather than a modal, where Escape
 * means cancel. An ineligible press clears the pending one, so a pair can never span a
 * modal or a draft.
 */

import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";

/** The window pi's built-in double-Escape uses. Matching it keeps the two in step. */
export const DOUBLE_ESCAPE_WINDOW_MS = 500;

export interface DoubleEscapeGesture {
  /** Record an Escape press. True when this press completes a double press. */
  press(now: number): boolean;
  /** Forget a pending press. */
  reset(): void;
}

export function createDoubleEscapeGesture(
  windowMs: number = DOUBLE_ESCAPE_WINDOW_MS,
): DoubleEscapeGesture {
  // 0 is the "no pending press" sentinel, as in pi's own handler: a timestamp of 0
  // cannot be produced by Date.now() inside a session.
  let last = 0;
  return {
    press(now) {
      if (last !== 0 && now - last < windowMs) {
        last = 0;
        return true;
      }
      last = now;
      return false;
    },
    reset() {
      last = 0;
    },
  };
}

export interface EscapeGestureDeps {
  /** The chat editor holds focus, rather than a modal or an overlay. */
  editorFocused: () => boolean;
  /** The text in the core input editor. */
  editorText: () => string;
  /** No run is streaming. Escape aborts while one is. */
  idle: () => boolean;
  /** Open the rewind menu. */
  open: () => void | Promise<void>;
  /** Injected so the tests drive the window instead of the clock. */
  now?: () => number;
}

export type RawInputHandler = (
  data: string,
) => { consume?: boolean } | undefined;

/** Subscribe to raw terminal input for the gesture, and return the unsubscribe. */
export function attachEscapeGesture(
  onTerminalInput: (handler: RawInputHandler) => () => void,
  deps: EscapeGestureDeps,
): () => void {
  const gesture = createDoubleEscapeGesture();
  const now = deps.now ?? Date.now;
  return onTerminalInput((data) => {
    if (!matchesKey(data, "escape")) return undefined;
    // Kitty protocol emits a release after the press, and repeats while the key is
    // held. Neither is a press, and neither may pair with one.
    if (isKeyRelease(data) || isKeyRepeat(data)) return undefined;
    if (
      !deps.editorFocused() ||
      !deps.idle() ||
      deps.editorText().trim() !== ""
    ) {
      gesture.reset();
      return undefined;
    }
    if (!gesture.press(now())) return undefined;
    void deps.open();
    return { consume: true };
  });
}
