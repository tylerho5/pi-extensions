# @tylerho/pi-copy-all

Copies the current thread's user and assistant messages to the clipboard as plain text.

## Install

`pi install npm:@tylerho/pi-copy-all`

---

# Copy-all

`/copy-all` copies the user and assistant messages of the current thread to the clipboard as plain text. pi has no built-in way to export a thread, so the extension reads the session branch itself and calls `copyToClipboard`.

## How it works

The handler calls `await ctx.waitForIdle()` before it reads anything, so the copy covers a settled thread and cannot race an active turn. It then turns `ctx.sessionManager.getBranch()` into output:

- Entries keep only `entry.type === "message"` with a `user` or `assistant` role. Tool calls, tool results, custom messages and compaction entries never appear.
- A string content is used as is. In a block array, text blocks keep their `text`, each image block becomes `[image]`, and thinking and tool-call blocks are dropped.
- Each message becomes `USER:\n<content>` or `ASSISTANT:\n<content>`, with the content trimmed. Empty messages are dropped. Content blocks inside one message join with `\n`, and messages join with `\n\n---\n\n`.
- With nothing left to copy, the command shows the info notification `No user or assistant messages to copy` and writes nothing. Otherwise it copies and notifies `Copied <N> messages to clipboard`.
