# @tylerho/pi-reminders

Injects dynamic system-reminder messages before each LLM call from a shared generator registry.

## Install

`pi install npm:@tylerho/pi-reminders`

---

# Reminders (system-reminder injector)

Claude Code's system-reminder mechanism for pi: before every LLM call (the `context` event), runs every registered reminder generator from the shared registry (`shared/reminders.ts`) and appends their output as a single hidden `<system-reminder>` user message. The extension itself registers no tools, commands, or shortcuts — it is purely the **injector**; consumers (e.g. the MCP adapter) register generators through the registry. Exists so dynamic per-request facts (tool-pool changes, connect/disconnect, standing nudges) reach the model without rebuilding the cached system prompt.

## Key concepts

- **Per-LLM-call injection.** `pi.on("context")` fires before each LLM call with a deep-copy `event.messages` array. The handler appends one reminder message to the end of it — never part of the system prompt — so the cached prompt prefix is untouched and cache-preserving (same shape as CC: user-role text wrapped in reminder tags).
- **Single message, batched.** All generators that speak on a given call contribute paragraphs; they are joined with `\n\n` and wrapped once as `<system-reminder>\n…\n</system-reminder>` in one `user` message. Generator order = `Map` insertion order (registration order).
- **Interval clock.** One install-wide `callCount` increments per `context` event. Per generator, `lastInjectedAt` records the call count of its **last actual emission** (not last compute). A generator with `interval: N` is forced (`compute(true)`) when `callCount - lastInjected >= N`. Because the clock only advances on emission, a generator that returns `null` even when forced is re-forced on every subsequent call until it speaks — `interval` means "keep offering the floor every N calls until you emit", matching its docstring "Re-run compute(force=true) every N LLM calls, even when it returned null".
- **Delta-based.** `createAnnouncedDelta` tracks an announced-name set. `getBaseline()` names are seeded silently (the standing prompt — e.g. a tool description — already lists them); only post-baseline adds/removes produce reminders; silence otherwise. `compute(force)` returns `null` when forced — standing intervals are meaningless for deltas. `reset()` re-reads `getBaseline()` fresh (not frozen), so a new session re-announces the current pool.
- **Session-scoped.** `pi.on("session_start")` calls `resetReminderGenerators()` (each generator's `reset?.()`, re-seeding announced sets), clears `lastInjectedAt`, and zeroes `callCount`. A new session re-announces state that is already in the conversation.
- **Inert without consumers.** `getReminderGenerators()` empty → the `context` handler returns immediately; registration is always safe even if this extension is absent (consumers like the MCP adapter use a guarded dynamic import). Blank output (`text.trim().length === 0`) is skipped.
- **Literal text transport.** The tag travels as plain text in a `user`-role message — pi maps custom messages to user-role text, and reasoning-capable models treat the tags as instructions regardless of provider. Don't conflate with the **memory** extension's recall injection: that is a separate mechanism (its own `<system-reminder>` wrapping injected at `before_agent_start`), not this registry.

## API

No tools, commands, shortcuts, or config files. The public surface of `extensions/reminders/index.ts`:

- **default export `reminders(pi: ExtensionAPI): void`** — the extension entry point (auto-loaded from `extensions/reminders/index.ts`); just calls `installReminders(pi)`.
- **`installReminders(pi: Pick<ExtensionAPI, "on">): void`** — registers the two event handlers. Takes only `on`, which makes it trivially testable with a stub pi (the tests do exactly this).
- **`buildReminderMessage(texts: readonly string[]): ReminderMessage`** — wraps texts in the tag pair (`OPEN_TAG`/`CLOSE_TAG` = `<system-reminder>`/`</system-reminder>`, module-private), `\n\n`-joined, with `timestamp: Date.now()`.
- **`type ReminderMessage = { role: "user"; content: Array<{ type: "text"; text: string }>; timestamp: number }`** — the exact message shape pushed onto `event.messages`.

### Events

- **`context`** — the injector. If no generators are registered, returns. Otherwise increments `callCount`, runs each generator with the interval-force rule above, collects non-blank trimmed texts, and if any exist pushes `buildReminderMessage(texts)` onto `event.messages` (mutation of the deep copy; no return value).
- **`session_start`** — state reset: `resetReminderGenerators()`, `lastInjectedAt.clear()`, `callCount = 0`. Why it matters: per-conversation announced state and the interval clock must not leak across sessions, or deltas would never re-announce in a fresh conversation.

### Registry (`shared/reminders.ts`) — the consumer-facing API

Extensions and packages use this module, never the injector. Full reference in `shared.md`; the surface:

- `registerReminderGenerator(generator: ReminderGenerator): void` — `ReminderGenerator = { id: string; compute(force: boolean): string | null; interval?: number; reset?(): void }`. `null` = silent this call; re-registering an id replaces the previous generator.
- `unregisterReminderGenerator(id: string): boolean` — true if it was registered.
- `getReminderGenerators(): readonly ReminderGenerator[]` — snapshot in registration order (used by the injector).
- `resetReminderGenerators(): void` — calls `reset?.()` on every generator (used by the injector on `session_start`).
- `createAnnouncedDelta({ id, getCurrent, getBaseline?, renderAdded, renderRemoved }): ReminderGenerator` — announced-name tracking: `getCurrent: () => readonly string[]` is the tracked pool; `getBaseline?: () => readonly string[]` seeds the announced set silently (re-evaluated on reset); `renderAdded`/`renderRemoved: (names) => string` format the delta text. Returns `null` when nothing changed or when forced.

The generator registry (`registerReminderGenerator`/`unregisterReminderGenerator`/`getReminderGenerators`/`resetReminderGenerators`) is backed by a `globalThis` slot (`Symbol.for("pi.shared.reminders.generators")`), so the injector and a separately-installed package (e.g. `pi-mcp-adapter`) resolve the same registry even across duplicated module instances.

## Examples

Register a standing nudge — the model is offered the reminder every 3rd LLM call until it emits (a delta or policy reminder that should re-surface periodically):

```ts
registerReminderGenerator({
  id: "policy-nudge",
  interval: 3,
  compute: (force) =>
    force ? "Reminder: never run `git push` without asking first." : null,
});
```

Announce pool changes with baseline seeding (the MCP-adapter pattern) — names already in the standing prompt are seeded silently; only post-baseline changes remind:

```ts
registerReminderGenerator(
  createAnnouncedDelta({
    id: "mcp-deferred-tools",
    getCurrent: () => [...deferredTools.keys()],
    getBaseline: () => [...deferredTools.keys()],
    renderAdded: (names) =>
      `New MCP tools are now available: ${names.join(", ")}. Their schemas are NOT loaded — select them with mcp({ select: "name" }) (batch multiple names into one call) to make them callable directly by name.`,
    renderRemoved: (names) =>
      `The following MCP tools are no longer available: ${names.join(", ")}. Do not search for them — mcp({ search }) will return no match.`,
  }),
);
```

What the model actually receives (two generators speaking on one call → one batched message):

```text
<system-reminder>
New MCP tools are now available: notion_notion-create-attachment, slack_slack_create_canvas.

Reminder: never run `git push` without asking first.
</system-reminder>
```

Guarded registration from an npm package (safe without the reminders extension installed):

```ts
const { registerReminderGenerator } = await import(
  "../../../extensions/shared/reminders.ts"
);
registerReminderGenerator(/* ... */);
```

## When to use a reminder vs. alternatives

| Need | Mechanism |
|---|---|
| Dynamic per-request fact (pool/tool changes, connect/disconnect, standing nudge) | register a generator → `<system-reminder>` |
| Static fact | tool description / `promptSnippet` |
| Durable user-visible state | `pi.appendEntry` |
| One-shot steering | `pi.sendMessage(..., { deliverAs: "steer" })` |
