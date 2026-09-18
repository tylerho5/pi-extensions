/**
 * ask_user_question - Claude Code-shaped question tool.
 *
 * The implementation is upstream (@juicesharp/rpiv-ask-user-question): a batch
 * of 1-4 questions, each with a short header and 2-4 options, multi-select,
 * per-option markdown previews, per-answer notes, and a tabbed dialog. This
 * extension registers it through a proxy so the model-facing text and the
 * `header` cap come from prompt.ts instead of upstream's own defaults, and so
 * every finished questionnaire leaves a transcript record (transcript.ts).
 *
 * Upstream is a plain dependency, not an installed pi package: installing it
 * as a package would register the tool a second time under the same name, and
 * pi resolves that collision by directory read order.
 *
 * Upstream's own `~/.config/rpiv-ask-user-question/config.json` can replace its
 * description, snippet and guidelines. Those values are overwritten here, so
 * that file is not the place to tune wording; its `collapseKey` still applies.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import askUserQuestion from "@juicesharp/rpiv-ask-user-question";
import { tuneRegisteredTool } from "./prompt.ts";
import {
  ASK_USER_ANSWERS_ENTRY,
  type AnswerEntryData,
  recordQuestionnaire,
  renderAnswerEntry,
} from "./transcript.ts";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

export default function askUser(pi: ExtensionAPI) {
  pi.registerEntryRenderer<AnswerEntryData>(
    ASK_USER_ANSWERS_ENTRY,
    (entry, { expanded }, theme) =>
      renderAnswerEntry(entry.data, expanded, theme),
  );

  const tuned = new Proxy(pi, {
    get(target, property) {
      if (property === "registerTool") {
        return (tool: RegisteredTool) =>
          target.registerTool(
            recordQuestionnaire(target, tuneRegisteredTool(tool)),
          );
      }
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });

  askUserQuestion(tuned);
}
