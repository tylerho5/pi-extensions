# @tylerho/pi-skill-stack

Expands every skill named in a prompt, so several skills stack in one message before the model reads it.

## Install

`pi install npm:@tylerho/pi-skill-stack`

---

# skill-stack

Extends pi's single-skill expansion to stacked invocation. A prompt may name several skills at once, and every one of them is expanded into pi's skill blocks before the model reads the prompt. The model never has to decide to invoke a skill itself.

This matters for skill pairs that are designed to run together, such as a plan executor plus its implementation driver, where the second skill only makes sense with the first already loaded.

## Claude Code lineage

Ports stacked slash-skill invocations from Claude Code v2.1.199. The user-facing form, a ceiling of six skills per prompt, and the rule that skills marked `disable-model-invocation: true` can still be named explicitly all come from that feature.

Divergences:

- Claude Code consumes leading tokens only and stops at the first non-skill token, so `/<skill> <path> /<skill>` never stacks there. This extension matches anywhere in the prompt.
- Claude Code forwards the trailing text to every stacked skill as `$ARGUMENTS`. pi has no argument substitution in its skill route, so arguments stay where the author typed them.
- Claude Code attaches skill bodies as separate context. This extension reuses the inline `<skill>` block that `/skill:name` already produces, because that is the only injection route pi parses back into a skill card in the transcript.

## How it works

The hook is `input`, which pi emits inside `AgentSession.prompt()` after extension commands have been tried and before its own `_expandSkillCommand`. Extension commands therefore keep priority: `/clear` stays `/clear` even if a skill is named `clear`. The hook returns `{ action: "transform" }`, and because the rewritten text no longer starts with `/skill:`, pi's own expansion leaves it alone.

The skill list comes from `pi.getCommands()` filtered to `source === "skill"`. That list is built from the live resource loader, so it covers package skills, `~/.pi/agent/skills`, project-local skills, `~/.agents/skills`, settings gating, and skills hidden from the model index. Bodies are read from `sourceInfo.path`, frontmatter is stripped with the package's `stripFrontmatter`, and each result is cached by path and mtime.

A token expands when all of these hold:

- It is `/name` or `/skill:name`, where the name matches `[A-Za-z0-9][A-Za-z0-9_-]*`.
- It starts at the beginning of the prompt or after whitespace, an opening bracket, or a quote, and ends at the end of the prompt or before whitespace or closing punctuation.
- It is not inside a fenced code block or an inline code span, so a prompt that discusses `/skill-name` in backticks does not invoke it.
- The name resolves. Bare names defer to any extension command or prompt template that already owns them. The `/skill:name` form skips that check, since the prefix is unambiguous.

Text that looks like a path never matches, because the character after the name fails the boundary test: `/usr/local/bin` and `notes/<skill>/x.md` are left alone. A backslash before a slash escapes the token, and the backslash is dropped from the prompt (`\/name` reaches the model as `/name`). The escape is only processed for names that pi treats as commands or skills, so regex fragments such as `\/b\/c` keep their backslashes.

Blocks are joined to the surrounding text by a blank line. That layout is what core's anchored `parseSkillBlock` expects, and it is what makes the transcript render the first skill as a collapsible card with the author's remaining text underneath. The lines after a token stay where they were typed, so `/<skill-a> <path> /<skill-b>` gives skill A, then the path, then skill B.

Blocks other than the first cannot become cards, because core parses one block per message. A registered markdown transformer collapses each of them in the rendered user message to a single line, `[skill: subagent-driven-development — 214 lines injected]`. The transformation applies to user markdown only, and it changes the transcript, never the prompt.

Limits, all reported through `ctx.ui.notify` rather than applied silently:

- Six skills per prompt. Later tokens stay literal.
- A repeated skill is injected once, and the repeat is dropped along with one adjacent space.

A skill whose body cannot be read is left as a literal token, which is also what pi does when a `/skill:name` file read fails.

## API

Pure logic lives in `expand.ts` so it can be tested without a session.

```ts
MAX_STACKED_SKILLS: 6

type TokenResolver = (name: string, explicit: boolean) => boolean;

interface SkillToken { start: number; end: number; name: string; explicit: boolean }

codeRanges(text: string): Array<[number, number]>
findSkillTokens(text: string, resolve: TokenResolver): SkillToken[]
expandSkillTokens(text: string, options: {
  resolve: TokenResolver;
  render: (name: string) => string | undefined;
  max?: number;
}): { text: string; expanded: string[]; duplicates: string[]; overflow: string[] }
unescapeSkillTokens(text: string, wouldExpand: TokenResolver): string
tidySkillBlocks(markdown: string, context: { messageType: string }): string
```

`index.ts` wires those to `pi.on("input")` and `pi.registerMarkdownTransformer`. The transformer call is cast and optional because the API is absent from the pinned 0.82 types that `bun run check` uses, while the running pi (0.85) provides it. Under a build without the API the extension still injects skills and only loses the transcript tidy-up.

## Examples

```
/executing-plans .claude/plans/2026-09-19-feature.md /subagent-driven-development
```

Both skills load in one turn. The user message holds skill block A, then the plan path, then skill block B. In the transcript, skill A renders as a card, and skill B appears as `[skill: subagent-driven-development — 121 lines injected]` under the plan path.

```
/grilling /humanizer rewrite the README section
```

Two skills, shared trailing instruction, same layout.

```
/skill:executing-plans  # explicit form, used when a bare name collides
\/executing-plans        # literal text, no injection
```
