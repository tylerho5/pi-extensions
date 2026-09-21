# pi-extensions

Extensions for the pi coding agent, published as individual npm packages under the `@tylerho` scope. Each package is installable on its own; the whole repo is installable via git.

## Packages

⚠️ = prototype (patches pi internals; may break across pi versions — pin your pi version).

| Package | Status | Description |
|---|---|---|
| [`@tylerho/pi-advisor`](packages/pi-advisor) | no record | A stronger reviewer model the main agent can consult mid-turn for strategic guidance, ported from Claude Code. |
| [`@tylerho/pi-ask-user-question`](packages/pi-ask-user-question) | no record | Claude Code-shaped batch questions: 1-4 per call, each with a header, 2-4 options, optional multi-select and per-option previews. |
| [`@tylerho/pi-background-terminals`](packages/pi-background-terminals) | no record | Runs long-lived background shell processes started by the model, inspectable and killable via /ps. |
| [`@tylerho/pi-clear`](packages/pi-clear) | wip (source only) | Registers `/clear` as an alias for pi's built-in `/new`, the command Claude Code users already type. |
| [`@tylerho/pi-collapsed-previews`](packages/pi-collapsed-previews) ⚠️ | wip (source only) | Collapses hidden thinking blocks and edit-tool diffs to one-line summaries via runtime prototype patches on pi's TUI. |
| [`@tylerho/pi-copy-all`](packages/pi-copy-all) | no record | Copies the current thread's user and assistant messages to the clipboard as plain text. |
| [`@tylerho/pi-expanded-footer`](packages/pi-expanded-footer) | no record | Replaces the default footer with a Claude Code-style layout: model, context usage, cost, branch, worktree. |
| [`@tylerho/pi-file-search`](packages/pi-file-search) | no record | Adds native fd and rg tools for fast, gitignore-aware file search with automatic binary resolution. |
| [`@tylerho/pi-git-info`](packages/pi-git-info) | no record | On-demand /lg diff browser and /pr lookup for the current branch's local changes and open pull request. |
| [`@tylerho/pi-guard`](packages/pi-guard) | no record | Prompts for human confirmation before risky git writes, PR publishing, and recursive rm in the bash tool. |
| [`@tylerho/pi-long-cache`](packages/pi-long-cache) | no record | Forces long prompt-cache retention in-process so providers without an explicit opt-in still get caching. |
| [`@tylerho/pi-memory`](packages/pi-memory) | no record | Claude Code-style persistent file-based memory, with per-turn recall and idle-triggered consolidation dreams. |
| [`@tylerho/pi-prompt-stash`](packages/pi-prompt-stash) | no record | Saves and restores the editor's draft text in a single slot via ctrl+s, Claude Code style. |
| [`@tylerho/pi-reminders`](packages/pi-reminders) | no record | Injects dynamic system-reminder messages before each LLM call from a shared generator registry. |
| [`@tylerho/pi-skill-stack`](packages/pi-skill-stack) | wip (source only) | Expands every skill named in a prompt, so several skills stack in one message before the model reads it. |
| [`@tylerho/pi-skills-banner-split`](packages/pi-skills-banner-split) ⚠️ | wip (source only) | Splits the startup banner's Skills section into model-invokable and user-invoked groups. |
| [`@tylerho/pi-subagents`](packages/pi-subagents) | no record | Background subagents on a pi or Claude Code backend, with fire-and-forget spawn and deferred result delivery. |
| [`@tylerho/pi-summaries`](packages/pi-summaries) | no record | Generates a compact recap of each agent run and appends it to the session once the run settles. |
| [`@tylerho/pi-web-fetch`](packages/pi-web-fetch) | no record | Fetches a URL and converts it to markdown, with a Jina reader fallback and an optional cheap-model answer pass. |
| [`@tylerho/pi-workflows`](packages/pi-workflows) | no record | Sandboxed multi-agent workflow orchestration, plus a deterministic multi-angle code review built on it. |
| [`@tylerho/pi-worktree`](packages/pi-worktree) | no record | Lets the agent create, enter, and exit isolated git worktrees for parallel work in one repo. |

`no record` = no publish record for the package in this repository's release ledger; it may still be live on npm.

## Install

Per package (npm):

```
pi install npm:@tylerho/pi-<name>
```

Or the whole repo (git):

```
pi install git:github.com/tylerho5/pi-extensions
```

## License

MIT © Tyler Ho
