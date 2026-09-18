# pi-extensions

Extensions for the pi coding agent, published as individual npm packages under the `@tylerho` scope. Each package is installable on its own; the whole repo is installable via git.

## Packages

⚠️ = prototype (patches pi internals; may break across pi versions — pin your pi version).

| Package | Description |
|---|---|
| [`@tylerho/pi-advisor`](packages/pi-advisor) | A stronger reviewer model the main agent can consult mid-turn for strategic guidance, ported from Claude Code. |
| [`@tylerho/pi-ask-user-question`](packages/pi-ask-user-question) | Claude Code-shaped batch questions: 1-4 per call, each with a header, 2-4 options, optional multi-select and per-option previews. |
| [`@tylerho/pi-background-terminals`](packages/pi-background-terminals) | Runs long-lived background shell processes started by the model, inspectable and killable via /ps. |
| [`@tylerho/pi-collapsed-previews`](packages/pi-collapsed-previews) ⚠️ | Collapses hidden thinking blocks and edit-tool diffs to one-line summaries via runtime prototype patches on pi's TUI. |
| [`@tylerho/pi-copy-all`](packages/pi-copy-all) | Copies the current thread's user and assistant messages to the clipboard as plain text. |
| [`@tylerho/pi-expanded-footer`](packages/pi-expanded-footer) | Replaces the default footer with a Claude Code-style layout: model, context usage, cost, branch, worktree. |
| [`@tylerho/pi-file-search`](packages/pi-file-search) | Adds native fd and rg tools for fast, gitignore-aware file search with automatic binary resolution. |
| [`@tylerho/pi-git-info`](packages/pi-git-info) | On-demand /lg diff browser and /pr lookup for the current branch's local changes and open pull request. |
| [`@tylerho/pi-guard`](packages/pi-guard) | Prompts for human confirmation before risky git writes, PR publishing, and recursive rm in the bash tool. |
| [`@tylerho/pi-long-cache`](packages/pi-long-cache) | Forces long prompt-cache retention in-process so providers without an explicit opt-in still get caching. |
| [`@tylerho/pi-memory`](packages/pi-memory) | Claude Code-style persistent file-based memory, with per-turn recall and idle-triggered consolidation dreams. |
| [`@tylerho/pi-prompt-stash`](packages/pi-prompt-stash) | Saves and restores the editor's draft text in a single slot via ctrl+s, Claude Code style. |
| [`@tylerho/pi-reminders`](packages/pi-reminders) | Injects dynamic system-reminder messages before each LLM call from a shared generator registry. |
| [`@tylerho/pi-skills-banner-split`](packages/pi-skills-banner-split) ⚠️ | Splits the startup banner's Skills section into model-invokable and user-invoked groups. |
| [`@tylerho/pi-subagents`](packages/pi-subagents) | Background subagents on a pi or Claude Code backend, with fire-and-forget spawn and deferred result delivery. |
| [`@tylerho/pi-summaries`](packages/pi-summaries) | Generates a compact recap of each agent run and appends it to the session once the run settles. |
| [`@tylerho/pi-web-fetch`](packages/pi-web-fetch) | Fetches a URL and converts it to markdown, with a Jina reader fallback and an optional cheap-model answer pass. |
| [`@tylerho/pi-workflows`](packages/pi-workflows) | Sandboxed multi-agent workflow orchestration, plus a deterministic multi-angle code review built on it. |
| [`@tylerho/pi-worktree`](packages/pi-worktree) | Lets the agent create, enter, and exit isolated git worktrees for parallel work in one repo. |

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
