/**
 * reminders — Claude Code's system-reminder mechanism for pi.
 *
 * Before every prompt (the `before_agent_start` event), runs all registered
 * reminder generators (see extensions/shared/reminders.ts) and injects their
 * output as one hidden `<system-reminder>` user message — the same shape CC
 * uses: user-role text wrapped in reminder tags, never part of the system
 * prompt.
 *
 * CC keeps a reminder in the conversation. Each one becomes an attachment
 * entry holding a `rendered` copy of the text, and every later request re-emits
 * each attachment entry, so a reminder that fired once stays in context for the
 * rest of the session and survives resume. Reminders that must not replay are
 * lifted out of the wire path (`clearAt: "next_user_message"` on
 * `batching_reminder_sent` and `secondary_reminder_sent`), which makes replay
 * the default.
 *
 * `before_agent_start` is pi's equivalent: the returned message is stored as a
 * `custom_message` entry, so it participates in every later request. The
 * `context` event this used to inject through fires per LLM call, but its
 * mutations are a per-request clone, so the text reached the model once and was
 * then discarded.
 *
 * The extension itself registers nothing but the injector and its renderer.
 * Consumers register generators through the shared registry; none does at
 * present (see docs/reminders.md → Consumers).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  getReminderGenerators,
  resetReminderGenerators,
} from "../shared/reminders.ts";

const OPEN_TAG = "<system-reminder>";
const CLOSE_TAG = "</system-reminder>";

/** customType of an injected reminder message. */
export const REMINDER_MESSAGE_TYPE = "reminder";

/** Returned to `before_agent_start`; pi persists it as a `custom_message` entry. */
export type ReminderMessage = {
  customType: string;
  content: string;
  display: boolean;
  details: { texts: string[] };
};

/** Wrap reminder texts in the system-reminder tag pair (CC convention). */
export function buildReminderMessage(
  texts: readonly string[],
): ReminderMessage {
  return {
    customType: REMINDER_MESSAGE_TYPE,
    content: `${OPEN_TAG}\n${texts.join("\n\n")}\n${CLOSE_TAG}`,
    display: true,
    details: { texts: [...texts] },
  };
}

export function installReminders(
  pi: Pick<ExtensionAPI, "on" | "registerMessageRenderer">,
): void {
  /** generator id -> call count at last injection (for interval forcing). */
  const lastInjectedAt = new Map<string, number>();
  let callCount = 0;

  pi.on("session_start", () => {
    // Fresh conversation: per-conversation announced state resets so deltas
    // are re-announced in the new session.
    resetReminderGenerators();
    lastInjectedAt.clear();
    callCount = 0;
  });

  pi.on("before_agent_start", () => {
    const generators = getReminderGenerators();
    if (generators.length === 0) return;
    callCount += 1;

    const texts: string[] = [];
    for (const generator of generators) {
      const lastInjected = lastInjectedAt.get(generator.id) ?? 0;
      const force =
        generator.interval !== undefined &&
        callCount - lastInjected >= generator.interval;
      const text = generator.compute(force);
      if (text !== null && text.trim().length > 0) {
        texts.push(text.trim());
        lastInjectedAt.set(generator.id, callCount);
      }
    }

    if (texts.length === 0) return;
    return { message: buildReminderMessage(texts) };
  });

  /**
   * Collapsed by default, because the injected text is already in the model's
   * context. The line reports how many blocks a generator contributed; ctrl+o
   * shows the exact `<system-reminder>` body, so what the user sees and what
   * the model saw never diverge.
   */
  pi.registerMessageRenderer(
    REMINDER_MESSAGE_TYPE,
    (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as { texts?: string[] };
      const count = details.texts?.length ?? 0;
      let text =
        theme.fg("accent", "✦ ") +
        theme.fg("muted", `reminder: ${count} block${count === 1 ? "" : "s"}`);
      if (expanded) {
        const content =
          typeof message.content === "string" ? message.content : "";
        text += `\n${theme.fg("dim", content)}`;
      }
      return new Text(text, 0, 0);
    },
  );
}

export default function reminders(pi: ExtensionAPI): void {
  installReminders(pi);
}
