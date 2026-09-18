export const ENTER_WORKTREE_TOOL_DESCRIPTION = `Creates an isolated git worktree and switches the session into it.
Pass \`name\` to create a new worktree, or \`path\` to switch into an existing registered worktree of the current repository. After entering, the session's file tools (read, write, edit, grep, find, ls) and bash operate inside the worktree; the original directory is left untouched. Use exit_worktree to leave. Worktrees isolate concurrent work in one repository: create a worktree per feature, then spawn a subagent per worktree (subagent_spawn with working_dir set to the worktree path) so multiple agents build in the same repo without colliding.`;

export const ENTER_WORKTREE_PROMPT_SNIPPET =
  "Create or switch into an isolated git worktree";

export const ENTER_WORKTREE_PROMPT_GUIDELINES = [
  "enter_worktree only works inside a git repository. Never branch a new worktree from one that has uncommitted work you do not intend to carry.",
  "For parallel features: create one worktree per feature, then delegate each to a subagent (subagent_spawn with working_dir set to the worktree path).",
  "Leave a worktree with exit_worktree when the work is done. Before removing a worktree that has uncommitted files or unpushed commits, confirm with the user and pass discard_changes: true.",
];

export const EXIT_WORKTREE_TOOL_DESCRIPTION = `Exits a worktree session created by enter_worktree and restores the original working directory. action "keep" leaves the worktree and its branch on disk; "remove" deletes both. Set discard_changes: true when removing a worktree with uncommitted files or unmerged commits, and only after confirming with the user.

On session exit, if the session is still in a worktree you created, the worktree is removed automatically when it is clean (no uncommitted files, no commits ahead of what it was branched from); otherwise you are prompted to keep or remove it.`;

export const EXIT_WORKTREE_PROMPT_SNIPPET = "Leave the active worktree session";

export const EXIT_WORKTREE_PROMPT_GUIDELINES = [
  'Prefer action "keep" unless the user asked to clean up. Removing a worktree discards its branch permanently.',
];

export const ENTER_NAME_PARAM_DESCRIPTION = `Optional name for a new worktree. Each "/"-separated segment may contain only letters, digits, dots, underscores, and dashes; max 64 chars total. A random name is generated if not provided. Mutually exclusive with \`path\`.`;

export const ENTER_PATH_PARAM_DESCRIPTION = `Path to an existing worktree of the current repository to switch into instead of creating a new one. Must appear in \`git worktree list\` for the repo. Mutually exclusive with \`name\`.`;

export const EXIT_ACTION_PARAM_DESCRIPTION = `"keep" leaves the worktree and its branch on disk; "remove" deletes both.`;

export const EXIT_DISCARD_PARAM_DESCRIPTION = `Required true when action is "remove" and the worktree has uncommitted files or unmerged commits. The tool will refuse and list them otherwise.`;
