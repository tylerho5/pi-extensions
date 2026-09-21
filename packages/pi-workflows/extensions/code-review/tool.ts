/**
 * The model-facing `code_review` tool. It normalizes typed parameters into a
 * review request and hands it to the shared launcher; the launcher owns the run
 * lifecycle and the completion/failure handoff. The bundled skill owns
 * system-prompt routing, so the description carries the explicit-request gate.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { EFFORT_LEVELS, resolveEffortInput } from "./command.ts";
import type { ReviewLaunchResult, ReviewLauncher } from "./launch.ts";
import { loadLastEffort, saveLastEffort } from "./state.ts";

export const CODE_REVIEW_PARAMS = Type.Object(
  {
    target: Type.Optional(Type.String()),
    level: Type.Optional(StringEnum([...EFFORT_LEVELS])),
    mode: Type.Optional(StringEnum(["inline", "fanout"] as const)),
    fix: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const CODE_REVIEW_DESCRIPTION = [
  "Launch the multi-agent code review workflow over a diff, branch, path, or",
  "pull request. Call it only when the user explicitly asks for a review; never",
  "as an automatic post-implementation check. It returns a run id to track with",
  "/workflows <id>; the review reports back when it finishes.",
].join(" ");

/** A component whose single line is truncated to the terminal width. */
function widthLine(text: string) {
  return {
    render: (width: number) => [truncateToWidth(text, width)],
    invalidate: () => {},
  };
}

export function registerCodeReviewTool(
  pi: ExtensionAPI,
  launch: ReviewLauncher,
): void {
  pi.registerTool({
    name: "code_review",
    label: "Code review",
    description: CODE_REVIEW_DESCRIPTION,
    parameters: CODE_REVIEW_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const resolved = resolveEffortInput(params.level, loadLastEffort());
      if (params.level) await saveLastEffort(params.level);

      const result = await launch(
        {
          target: params.target ?? "",
          level: resolved.level,
          mode: params.mode ?? "fanout",
          fix: params.fix ?? false,
          comment: false,
        },
        ctx,
      );

      return {
        content: [
          {
            type: "text",
            text:
              `Started a ${result.level} ${result.mode} review of ${result.scope}. ` +
              `Track it with /workflows ${result.runId}; findings arrive when it finishes.`,
          },
        ],
        details: result,
        terminate: true,
      };
    },

    renderCall(args, theme) {
      const parts = [
        theme.fg("toolTitle", theme.bold("code_review")),
        theme.fg("accent", args.target?.trim() || "working tree"),
      ];
      if (args.level) parts.push(theme.fg("muted", args.level));
      parts.push(theme.fg("muted", args.mode ?? "fanout"));
      if (args.fix) parts.push(theme.fg("warning", "fix"));
      return widthLine(parts.join(theme.fg("dim", " · ")));
    },

    renderResult(result, _options, theme) {
      const details = result.details as ReviewLaunchResult | undefined;
      if (!details) {
        const first = result.content[0];
        return widthLine(first?.type === "text" ? first.text : "(no output)");
      }
      // The row is intentionally not live: a settled tool row cannot update in
      // place, so the workflows rail owns liveness and this is the pointer.
      let text =
        theme.fg("accent", "⏵ ") +
        theme.fg("accent", details.runId) +
        theme.fg(
          "muted",
          ` · reviewing ${details.scope} at ${details.level} · /workflows to watch`,
        );
      if (details.fix) text += theme.fg("warning", " · fix requested");
      return widthLine(text);
    },
  });
}
