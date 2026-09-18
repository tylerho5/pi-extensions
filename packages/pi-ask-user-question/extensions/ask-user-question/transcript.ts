/**
 * The transcript record for a finished questionnaire.
 *
 * Upstream registers no `renderResult`, so without this a questionnaire leaves
 * the model-facing envelope text in the transcript and nothing else. The entry
 * appended here is a compact, re-expandable record of what was asked and
 * answered: `pi.appendEntry` content is written to the session and does not
 * participate in LLM context, so it survives restarts without costing tokens.
 *
 * Previews are deliberately not recorded. An answer can carry a preview of up
 * to a few thousand characters, and the model-facing envelope already echoes
 * it; a transcript row is the wrong place to store that twice.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const ASK_USER_ANSWERS_ENTRY = "ask-user-answers";

export interface AnswerEntryQuestion {
  header?: string;
  question: string;
  /** The chosen label(s) or the typed answer; absent when the user skipped it. */
  answer?: string;
  notes?: string;
}

export interface AnswerEntryData {
  questions: AnswerEntryQuestion[];
  /** Every question skipped without an answer, or the whole questionnaire dismissed. */
  dismissed: boolean;
  /** True when the user ended the dialog to talk about the questions instead. */
  chat?: boolean;
  globalNote?: string;
}

/** The upstream shapes this module reads, kept structural so nothing is imported. */
interface QuestionParamsLike {
  questions?: { header?: unknown; question?: unknown }[];
}

interface QuestionnaireResultLike {
  answers?: {
    questionIndex?: unknown;
    question?: unknown;
    kind?: unknown;
    answer?: unknown;
    selected?: unknown;
    notes?: unknown;
  }[];
  cancelled?: unknown;
  chat?: unknown;
  globalNote?: unknown;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

/**
 * Turn one tool call into the data for its transcript entry. Returns undefined
 * when there is nothing worth recording, so callers can append unconditionally.
 */
export function buildAnswerEntryData(
  params: unknown,
  details: unknown,
): AnswerEntryData | undefined {
  const asked = (params as QuestionParamsLike | undefined)?.questions;
  if (!Array.isArray(asked) || asked.length === 0) return undefined;

  const result = (details as QuestionnaireResultLike | undefined) ?? {};
  const answers = Array.isArray(result.answers) ? result.answers : [];

  const questions: AnswerEntryQuestion[] = asked.map((question, index) => {
    const match =
      answers.find((answer) => answer.questionIndex === index) ??
      answers.find((answer) => answer.question === question?.question);
    // Multi-select answers arrive as `selected`; every other kind as `answer`.
    const selected = Array.isArray(match?.selected)
      ? match.selected.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const entry: AnswerEntryQuestion = {
      question: text(question?.question) ?? "(question text unavailable)",
      answer:
        text(match?.answer) ??
        (selected.length > 0 ? selected.join(", ") : undefined),
    };
    const header = text(question?.header);
    if (header) entry.header = header;
    const notes = text(match?.notes);
    if (notes) entry.notes = notes;
    return entry;
  });

  const data: AnswerEntryData = {
    questions,
    dismissed: result.cancelled === true,
  };
  if (result.chat === true) data.chat = true;
  const globalNote = text(result.globalNote);
  if (globalNote) data.globalNote = globalNote;
  return data;
}

export interface QuestionnaireRecorder {
  appendEntry(customType: string, data: unknown): void;
}

/**
 * Wrap a question tool so every finished questionnaire is recorded. Structural
 * and generic so the wiring is testable without upstream's types, and so it
 * preserves whatever tool shape it is handed.
 */
export function recordQuestionnaire<T extends object>(
  recorder: QuestionnaireRecorder,
  tool: T,
): T {
  const execute = (tool as { execute?: unknown }).execute;
  if (typeof execute !== "function") return tool;
  const run = execute as (...args: unknown[]) => unknown;

  return {
    ...tool,
    async execute(...args: unknown[]) {
      const result = await run(...args);
      try {
        const data = buildAnswerEntryData(
          args[1],
          (result as { details?: unknown } | undefined)?.details,
        );
        if (data) recorder.appendEntry(ASK_USER_ANSWERS_ENTRY, data);
      } catch {
        // Bookkeeping must never fail a tool call the user already answered.
      }
      return result;
    },
  };
}

/** Collapsed: one muted line. Expanded: the questions, answers and notes. */
export function renderAnswerEntry(
  data: AnswerEntryData | undefined,
  expanded: boolean,
  theme: Theme,
) {
  if (!data)
    return new Text(theme.fg("dim", "ask_user_question · no record"), 0, 0);

  const answered = data.questions.filter(
    (question) => question.answer !== undefined,
  ).length;
  const asked = data.questions.length;
  const notes = data.questions.filter(
    (question) => question.notes !== undefined,
  ).length;

  const summary =
    data.dismissed && !data.chat
      ? `dismissed all ${asked}`
      : answered === 0
        ? `${asked} asked, none answered`
        : `${asked} asked, ${answered} answered`;
  const extras: string[] = [];
  if (data.chat) extras.push("ended in chat");
  if (notes > 0) extras.push(`${notes} note${notes === 1 ? "" : "s"}`);
  if (data.globalNote) extras.push("global note");

  let output =
    theme.fg("accent", "◆ ") +
    theme.fg("muted", `ask_user_question · ${summary}`) +
    (extras.length > 0 ? theme.fg("dim", ` · ${extras.join(" · ")}`) : "");

  if (!expanded) return new Text(output, 0, 0);

  const lines: string[] = [output];
  data.questions.forEach((question, index) => {
    const label = question.header ? `[${question.header}] ` : "";
    lines.push(
      theme.fg("dim", `  ${index + 1}. ${label}`) +
        theme.fg("muted", question.question),
    );
    lines.push(
      question.answer === undefined
        ? theme.fg("dim", "     → no answer")
        : theme.fg("text", `     → ${question.answer}`),
    );
    if (question.notes)
      lines.push(theme.fg("dim", `       note: ${question.notes}`));
  });
  if (data.globalNote)
    lines.push(theme.fg("dim", `  global note: ${data.globalNote}`));

  return new Text(lines.join("\n"), 0, 0);
}
