# @tylerho/pi-copy-all

Copies the current thread's user and assistant messages to the clipboard as plain text.

## Install

`pi install npm:@tylerho/pi-copy-all`

---

# Copy-all

`/copy-all` — copies the current thread's user and assistant messages to the clipboard as plain text, so the conversation can be pasted anywhere (Notion, Slack, another AI tool, a bug report). Exists because there is no built-in pi command for exporting a thread: the built-in clipboard path (`copyToClipboard`) is exposed to extensions, but the session-snapshot logic is not.

## Key concepts

- **Plain-text serialization, not UI markdown.** Messages are read from `ctx.sessionManager.getBranch()` and flattened by `textFromContent`: a string `content` is used as-is; an array of content blocks keeps only `text` blocks (their `.text`), degrades `image` blocks to the literal `[image]`, and drops everything else (thinking, tool-call blocks, unknown shapes). Blocks join with `\n`.
- **Scope: user + assistant only.** Entries are filtered to `entry.type === "message"` with `message.role` of `user` or `assistant`. Tool calls, tool results, custom messages, and compaction entries never appear in the copy.
- **Snapshot after idle.** The handler starts with `await ctx.waitForIdle()` — the copy reflects the fully settled thread (including retries, auto-compaction, and queued continuations), and the snapshot can't race an in-flight agent turn.
- **Output format.** Each kept message becomes a block `USER:\n<content>` or `ASSISTANT:\n<content>` (role uppercased, content `.trim()`ed, empty-content messages dropped). Blocks join with `\n\n---\n\n`. Empty result (no user/assistant text) notifies instead of copying.
- **No state.** The extension is stateless — it derives everything from the session on each invocation. No config, no events, no session lifecycle.

## API

### Commands

| Command | Args | Purpose |
|---|---|---|
| `/copy-all` | none | Copy all previous user and assistant messages in the current thread's branch to the clipboard. |

Handler flow:

1. `await ctx.waitForIdle()` — block until the agent fully settles.
2. `ctx.sessionManager.getBranch()` → filter to `user`/`assistant` message entries → serialize via `textFromContent` → drop empty content.
3. No sections: `ctx.ui.notify("No user or assistant messages to copy", "info")` and return.
4. Otherwise `await copyToClipboard(sections.join("\n\n---\n\n"))` (from `@earendil-works/pi-coding-agent`) and notify `Copied <N> messages to clipboard` (info).

### Tools

None — the extension registers no tools.

### Events / shortcuts / config

None — no `pi.on(...)`, no `registerShortcut`, no settings or JSON config files.

## Examples

1. **Export a thread externally.** The user types `/copy-all`; the extension copies e.g.

   ```
   USER:
   Summarize the auth flow changes.

   ---

   ASSISTANT:
   The auth flow now uses refresh-token rotation...
   ```

   and the user pastes it into Notion, Slack, or an issue tracker.

2. **Hand context to another AI tool.** Before switching tools, the user types `/copy-all` and pastes the clipboard as the starting context of the other tool — a fast way to transfer the whole conversation without retyping.

3. **Mid-turn use.** The user types `/copy-all` while the agent is still generating: the command waits for the agent to finish (`waitForIdle`) before snapshotting, so the copy includes the completed reply.

4. **Empty-thread edge case.** On a fresh session with no user/assistant text (e.g. only tool results so far), `/copy-all` shows the info notification "No user or assistant messages to copy" and writes nothing.
