/**
 * Model-facing text and schema caps for `ask_user_question`.
 *
 * The tool itself is upstream (@juicesharp/rpiv-ask-user-question, see
 * index.ts). This module owns what the model sees, because upstream ships
 * roughly 1,245 tokens of always-on tool definition: a 1,641-character
 * description, 1,214 characters of guidelines, and a schema whose every field
 * carries a paragraph. Everything here says the same load-bearing things in
 * about a third of the space.
 *
 * Two deliberate divergences from upstream:
 * - `header` is capped at 12 characters (Claude Code's cap) instead of 16.
 * - The cap is stated in the field description only; upstream still tolerates
 *   up to 16 at runtime, so an over-long header degrades to a wide chip rather
 *   than a rejected call.
 *
 * The free-form row is labelled "Type something." by upstream's own UI strings,
 * so the text below names it that way. Claude Code calls the same row "Other";
 * matching that label would mean forking upstream's locale files, since the
 * literal is not configuration.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

/** Tool description: the shape, the free-form escape, the reserved labels. */
export const ASK_USER_QUESTION_DESCRIPTION = [
  "Ask the user 1-4 structured questions when a decision is genuinely ambiguous.",
  'Each question takes 2-4 options; the user can also type a custom answer in the automatically appended "Type something." row, or press Esc to abandon the questionnaire.',
  'Never author "Other" or "Type something." labels yourself - reserved labels are rejected.',
].join(" ");

/** One line in the system prompt's available-tools list. */
export const ASK_USER_QUESTION_PROMPT_SNIPPET =
  "Ask the user 1-4 structured questions (2-4 options each) when requirements are ambiguous";

/** Guidelines appended to the system prompt's flat list. Each names the tool. */
export const ASK_USER_QUESTION_PROMPT_GUIDELINES = [
  "Use ask_user_question only for decisions that are genuinely ambiguous and expensive to get wrong - never for permissions, lookups you can do yourself, or confirming a plan you are confident in.",
  'One ask_user_question call takes 1-4 questions with 2-4 options each: 1-5 word labels, a one-line trade-off per option, headers of 12 characters or fewer, a recommended option first with "(Recommended)" appended to its label, and multiSelect only when several answers can hold at once.',
  "Add an ask_user_question option preview (markdown, single-select questions only) when the user must compare concrete artifacts. A dismissed question is not an approval.",
];

const FIELD_TEXT = {
  questions: "1-4 questions to ask the user.",
  question: "The complete question, ending with a question mark.",
  header:
    'MAX 12 CHARACTERS - short chip shown next to the question, e.g. "Auth method".',
  options:
    'The 2-4 choices for this question. The "Type something." row is appended automatically - do not author it.',
  preview:
    "Optional markdown shown beside the options while this option is focused. Single-select questions only.",
} as const;

/** The parts of a JSON Schema node this module reads or rewrites. */
export type SchemaNode = {
  description?: string;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  default?: unknown;
  required?: string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
};

export const HEADER_MAX_LENGTH = 12;

/**
 * Retune the tool object upstream hands to `registerTool`. Text and caps only;
 * `execute` and the renderers stay upstream's. Lookups are defensive so a
 * future upstream restructuring degrades to "text not applied" rather than a
 * crash, and prompt.test.ts fails if the shape moves.
 */
export function tuneRegisteredTool(tool: RegisteredTool): RegisteredTool {
  // Upstream's schema object is module-level and shared with its own
  // validation, so tune a copy rather than editing it in place.
  const schema = structuredClone(tool.parameters) as unknown as SchemaNode;
  const fields = schema.properties?.questions?.items?.properties;

  if (schema.properties?.questions) {
    schema.properties.questions.description = FIELD_TEXT.questions;
  }
  if (fields) {
    if (fields.question) fields.question.description = FIELD_TEXT.question;
    if (fields.header) {
      fields.header.maxLength = HEADER_MAX_LENGTH;
      fields.header.description = FIELD_TEXT.header;
    }
    if (fields.options) {
      fields.options.description = FIELD_TEXT.options;
      const option = fields.options.items?.properties;
      if (option?.preview) option.preview.description = FIELD_TEXT.preview;
      // Option label and description guidance lives in the guidelines instead:
      // field-level text is the most expensive real estate in the schema.
      if (option?.label) option.label.description = undefined;
      if (option?.description) option.description.description = undefined;
    }
    if (fields.multiSelect) fields.multiSelect.description = undefined;
  }

  return {
    ...tool,
    description: ASK_USER_QUESTION_DESCRIPTION,
    promptSnippet: ASK_USER_QUESTION_PROMPT_SNIPPET,
    promptGuidelines: [...ASK_USER_QUESTION_PROMPT_GUIDELINES],
    parameters: schema as RegisteredTool["parameters"],
    // Two overlapping dialogs would fight over pi's single editor slot and
    // orphan the first component, whose `done` then never fires.
    executionMode: "sequential",
  };
}
