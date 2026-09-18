---
name: code-review
description: "Run the installed multi-agent code-review workflow when the user explicitly asks to review a diff, branch, path, or pull request, or asks to review and fix findings. Do not use it as an automatic completion check."
disable-model-invocation: false
---

# Code review

Use this skill only when the user explicitly asks for a code review. Do not run it as an automatic completion check after implementing or changing code.

## Launch the review

Map the request to the `code_review` tool parameters:

- `target`: a PR number, branch, git range, or path. Omit it to use the current branch and working tree.
- `level`: `low | medium | high | xhigh | max`. Omit it unless the user names a level.
- `mode`: `inline | fanout`. Omit it unless the user asks for one.
- `fix`: set it only when the user asks to fix the findings.

Omit any option the user did not specify. Call `code_review` exactly once. Do not run a duplicate review with `workflow`, subagents, or your own inline analysis.

If the user asks for comment commands, point them at `/code-review --comment` instead of adding comment behavior to the tool call.

## Wait for the handoff

After the launch call, wait for the completion handoff. Follow its instructions: call `report_findings` as directed, and apply fixes only when the handoff asks for them.
