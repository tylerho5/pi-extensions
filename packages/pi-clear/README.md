# @tylerho/pi-clear

Registers `/clear` as an alias for pi's built-in `/new`, the command Claude Code users already type.

## Install

`pi install npm:@tylerho/pi-clear`

---

# Clear

`/clear` starts a new session and is an alias for pi's built-in `/new`. The name comes from the command Claude Code users already type, and pi dispatches extension commands before the model sees input, so `/clear` never reaches the agent as a message.

## How it works

The extension registers the command `clear` with the description `Start a new session (alias for /new)`. The handler calls `ctx.newSession()` with a `withSession` callback. That callback runs in the new session's context and calls `newCtx.ui.notify("✓ New session started", "info")`, so the fresh session opens with a visible confirmation. Session behavior, including history and per-session state, comes from pi's `/new` path and the extension does not reimplement it.
