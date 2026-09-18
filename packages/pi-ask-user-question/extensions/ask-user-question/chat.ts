/**
 * "Chat about this" — Claude Code's escape hatch, without Claude Code's row.
 *
 * In Claude Code the dialog appends a `Chat about this` row to every
 * single-select question; picking it abandons the questionnaire and hands the
 * model a deny whose feedback restates each question with the answer given so
 * far (or `(No answer provided)`) under "The user wants to clarify these
 * questions." Upstream (rpiv-ask-user-question) has no row kind for it and no
 * seam to add one, so here the same outcome is reached through a raw input
 * listener: the chat key is rewritten to Escape, which is upstream's cancel
 * action, and the cancelled result (partial answers intact) is reshaped into
 * CC's feedback text before it reaches the model.
 *
 * What this buys and what it costs:
 * - The model-facing result is CC's, byte for byte in substance.
 * - The caller's transcript record still sees `answers` and `cancelled`, plus a
 *   `chat` marker so the row does not read as a plain dismissal.
 * - The affordance is a key plus one appended hint line, not a selectable row.
 *
 * The listener guards on the overlay handle (routed through `ctx.ui.custom`'s
 * `onHandle`) so a different overlay stacked on top keeps its keystrokes, and
 * swallows kitty-protocol key repeats and releases so one tap does not fire
 * Escape twice.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  type Component,
  type OverlayHandle,
} from "@earendil-works/pi-tui";

/** The key that abandons the questionnaire in favour of a conversation. */
export const CHAT_RESPOND_KEY = "ctrl+r";

/** Row label, in Claude Code's words. */
export const CHAT_HINT_LABEL = "Chat about this";

/** Escape: upstream's cancel action, which preserves the answers given so far. */
const CANCEL_KEYSTROKE = "\x1b";

/** Claude Code's feedback preamble, verbatim apart from the source indentation. */
export const CLARIFY_PREAMBLE = [
  "The user wants to clarify these questions.",
  "This means they may have additional information, context or questions for you.",
  "Take their response into account and then reformulate the questions if appropriate.",
  "Start by asking them what they would like to clarify.",
].join("\n");

const NO_ANSWER_LINE = "  (No answer provided)";

/** Shapes read structurally, so this module needs no upstream types. */
interface QuestionLike {
  question?: unknown;
}

interface AnswerLike {
  questionIndex?: unknown;
  question?: unknown;
  kind?: unknown;
  answer?: unknown;
  selected?: unknown;
  notes?: unknown;
}

interface ResultLike {
  answers?: unknown;
  globalNote?: unknown;
}

interface ChatContextLike {
  ui?: {
    onTerminalInput?: unknown;
    custom?: unknown;
  };
}

/** The scalar the user chose or typed, mirroring upstream's envelope formatting. */
function answerScalar(answer: AnswerLike): string | undefined {
  const selected = Array.isArray(answer.selected)
    ? answer.selected.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  if (selected.length > 0) return selected.join(", ");
  if (typeof answer.answer === "string" && answer.answer.length > 0)
    return answer.answer;
  // `kind: "custom"` commits an empty draft as a null answer; upstream shows "(no input)".
  return answer.kind === "custom" ? "(no input)" : undefined;
}

function answerFor(
  answers: AnswerLike[],
  question: QuestionLike,
  index: number,
): AnswerLike | undefined {
  return (
    answers.find((answer) => answer.questionIndex === index) ??
    answers.find((answer) => answer.question === question.question)
  );
}

/**
 * Claude Code's clarify feedback: the preamble, then every question that was
 * asked with the answer given so far. Pure — the tool-result wrapper below and
 * the tests both go through it.
 */
export function buildClarifyText(params: unknown, details: unknown): string {
  const asked = (params as { questions?: unknown } | undefined)?.questions;
  const questions: QuestionLike[] = Array.isArray(asked) ? asked : [];
  const result = (details as ResultLike | undefined) ?? {};
  const answers: AnswerLike[] = Array.isArray(result.answers)
    ? result.answers
    : [];

  const blocks = questions.map((question, index) => {
    const match = answerFor(answers, question, index);
    const text =
      typeof question?.question === "string"
        ? question.question
        : "(question text unavailable)";
    const lines = [`- "${text}"`];
    const scalar = match ? answerScalar(match) : undefined;
    lines.push(scalar === undefined ? NO_ANSWER_LINE : `  Answer: ${scalar}`);
    const notes =
      match && typeof match.notes === "string" && match.notes.length > 0
        ? match.notes
        : undefined;
    if (notes) lines.push(`  User notes: ${notes}`);
    return lines.join("\n");
  });

  const parts = [CLARIFY_PREAMBLE, "", "Questions asked:", ...blocks];
  const globalNote = result.globalNote;
  if (typeof globalNote === "string" && globalNote.length > 0) {
    parts.push("", `Global note: ${globalNote}`);
  }
  return parts.join("\n");
}

/**
 * Reshape upstream's cancelled result into CC's clarify result: the text
 * becomes the feedback, and `chat: true` rides upstream's own details (with its
 * `answers` and `cancelled` untouched) so the transcript record can tell this
 * apart from a dismissal.
 */
export function clarifyResult(params: unknown, result: unknown): unknown {
  const toolResult = result as
    { content?: unknown; details?: unknown } | undefined;
  const details =
    toolResult &&
    typeof toolResult.details === "object" &&
    toolResult.details !== null
      ? toolResult.details
      : {};
  return {
    ...toolResult,
    content: [{ type: "text", text: buildClarifyText(params, details) }],
    details: { ...details, chat: true },
  };
}

/** The one dim row appended under the dialog. */
export function chatHintLine(
  theme: Theme,
  key: string = CHAT_RESPOND_KEY,
): string {
  return theme.fg("dim", ` ${key} · ${CHAT_HINT_LABEL}`);
}

export interface ChatTrigger {
  /** True once the user asked to chat instead of answering. */
  requested(): boolean;
  setOverlayHandle(handle: OverlayHandle): void;
  dispose(): void;
}

/**
 * Register the raw terminal listener that turns the chat key into a cancel.
 * Returns undefined on hosts with no raw input hook (RPC, print), where the
 * questionnaire renders through a native-dialog walker and the chat key has
 * nowhere to run; the dialog then behaves exactly as before.
 */
export function installChatTrigger(
  ctx: ChatContextLike | undefined,
): ChatTrigger | undefined {
  const onTerminalInput = ctx?.ui?.onTerminalInput;
  if (typeof onTerminalInput !== "function") return undefined;

  let requested = false;
  let overlayHandle: OverlayHandle | undefined;

  const handler = (
    onTerminalInput as (h: (data: string) => unknown) => () => void
  )((data: string) => {
    if (!matchesKey(data, CHAT_RESPOND_KEY)) return undefined;
    // Another overlay on top of the questionnaire (e.g. /btw) keeps its keys.
    if (
      overlayHandle &&
      !overlayHandle.isFocused() &&
      !overlayHandle.isHidden()
    )
      return undefined;
    if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };
    requested = true;
    return { data: CANCEL_KEYSTROKE };
  });

  return {
    requested: () => requested,
    setOverlayHandle: (handle) => {
      overlayHandle = handle;
    },
    dispose: () => handler(),
  };
}

/** Wrap the questionnaire component so the chat affordance is visible. */
export function withChatHint(
  component: Component & { handleInput?: (data: string) => void },
  theme: Theme,
  trigger: ChatTrigger,
  key: string = CHAT_RESPOND_KEY,
): Component & { handleInput?: (data: string) => void } {
  return {
    render(width: number) {
      const lines = component.render(width);
      // A collapsed questionnaire renders a single dim row; keep it collapsed.
      if (trigger.requested() || lines.length <= 1) return lines;
      return [...lines, chatHintLine(theme, key)];
    },
    invalidate: () => component.invalidate(),
    ...(component.handleInput
      ? { handleInput: (data: string) => component.handleInput?.(data) }
      : {}),
  };
}

type CustomFn = (
  factory: unknown,
  options?: Record<string, unknown>,
) => Promise<unknown>;

/** Re-route `ctx.ui.custom` through the hint wrapper and the overlay handle. */
function proxyUi(
  ui: Record<string, unknown>,
  trigger: ChatTrigger,
  key: string,
): Record<string, unknown> {
  return new Proxy(ui, {
    get(target, property) {
      if (property !== "custom") {
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      }
      return (factory: unknown, options?: Record<string, unknown>) => {
        const wrapped = async (
          tui: unknown,
          componentTheme: Theme,
          keybindings: unknown,
          done: unknown,
        ) => {
          const component = await (
            factory as (...args: unknown[]) => Promise<Component> | Component
          )(tui, componentTheme, keybindings, done);
          return withChatHint(component, componentTheme, trigger, key);
        };
        return (target.custom as CustomFn)(wrapped, {
          ...options,
          onHandle: (handle: OverlayHandle) => {
            trigger.setOverlayHandle(handle);
            const forward = options?.onHandle;
            if (typeof forward === "function")
              (forward as (h: OverlayHandle) => void)(handle);
          },
        });
      };
    },
  });
}

/**
 * Wrap a question tool so its questionnaire can end in a chat instead of an
 * answer. Structural and generic like `recordQuestionnaire`, so it preserves
 * whatever tool shape it is handed and stays testable without upstream.
 */
export function withChatAction<T extends object>(
  tool: T,
  key: string = CHAT_RESPOND_KEY,
): T {
  const execute = (tool as { execute?: unknown }).execute;
  if (typeof execute !== "function") return tool;
  const run = execute as (...args: unknown[]) => Promise<unknown>;

  return {
    ...tool,
    async execute(...args: unknown[]) {
      const ctx = args[4] as Record<string, unknown> | undefined;
      const ui = ctx?.ui as Record<string, unknown> | undefined;
      const trigger = installChatTrigger(ctx as ChatContextLike | undefined);
      if (!ctx || !ui || !trigger) return run(...args);

      const proxy = new Proxy(ctx, {
        get(target, property) {
          if (property === "ui") return proxyUi(ui, trigger, key);
          const member = Reflect.get(target, property, target);
          return typeof member === "function" ? member.bind(target) : member;
        },
      });

      try {
        const result = await run(args[0], args[1], args[2], args[3], proxy);
        if (!trigger.requested()) return result;
        return clarifyResult(args[1], result);
      } finally {
        trigger.dispose();
      }
    },
  };
}
