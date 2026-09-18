/**
 * reminders — Claude Code's system-reminder mechanism for pi.
 *
 * Before every LLM call (the `context` event), runs all registered reminder
 * generators (see extensions/shared/reminders.ts) and appends their output
 * as a single hidden `<system-reminder>` user message — the same shape CC
 * uses: user-role text wrapped in reminder tags, delivered after the cached
 * prompt prefix, never part of the system prompt. Generators announce only
 * deltas (announced-name tracking) and reset their state on session start.
 *
 * The extension itself registers nothing — it is the injector. Consumers
 * register generators through the shared registry; none does at present (see
 * docs/reminders.md → Consumers).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getReminderGenerators,
  resetReminderGenerators,
} from "../shared/reminders.ts";

const OPEN_TAG = "<system-reminder>";
const CLOSE_TAG = "</system-reminder>";

export type ReminderMessage = {
  role: "user";
  content: Array<{ type: "text"; text: string }>;
  timestamp: number;
};

/** Wrap reminder texts in the system-reminder tag pair (CC convention). */
export function buildReminderMessage(
  texts: readonly string[],
): ReminderMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `${OPEN_TAG}\n${texts.join("\n\n")}\n${CLOSE_TAG}`,
      },
    ],
    timestamp: Date.now(),
  };
}

export function installReminders(pi: Pick<ExtensionAPI, "on">): void {
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

  pi.on("context", (event) => {
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
    event.messages.push(buildReminderMessage(texts));
  });
}

export default function reminders(pi: ExtensionAPI): void {
  installReminders(pi);
}
