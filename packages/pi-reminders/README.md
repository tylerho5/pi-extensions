# @tylerho/pi-reminders

Injects dynamic system-reminder messages before each LLM call from a shared generator registry.

## Install

`pi install npm:@tylerho/pi-reminders`

---

# Reminders

The reminders extension is the system-reminder injector. Before each LLM call it runs every generator registered in `shared/reminders.ts` and appends the output to the conversation as one hidden `<system-reminder>` user message. It registers no tools, commands, or shortcuts.

## Claude Code lineage

The injector mirrors Claude Code's system-reminder mechanism: user-role text wrapped in `<system-reminder>` tags, appended after the cached prompt prefix. `createAnnouncedDelta` follows Claude Code's `deferred_tools_delta` semantics for announced-name tracking. The feature commit `61709db feat(reminders): system-reminder injector` (2026-08-12), the source, and the earlier docs record no Claude Code release, so the version the mechanism came from is not recorded.

## How it works

The `context` event fires before each LLM call with a deep copy of `event.messages`. When at least one generator is registered, the handler increments an install-wide `callCount`, runs each generator, and pushes one message onto the copy when a generator returns text. The message has `role: "user"` and holds one text block wrapped in `<system-reminder>` tags. It lands after the cached prompt prefix, so the prompt cache stays valid. All generators that speak on a call share that one message, in registry insertion order, with their trimmed texts joined by `\n\n`. Blank output is skipped, and an empty registry leaves the message list untouched. The tags are plain text in a `user` message, not a custom message type.

`lastInjectedAt` records the call count of each generator's last emission, not its last compute. A generator with `interval: N` is called with `force: true` when `callCount - lastInjected >= N`. A forced generator that returns `null` is offered the floor again on each later call until it emits. `session_start` then calls `resetReminderGenerators()`, clears `lastInjectedAt`, and sets `callCount` back to zero, so a new session re-announces state that is already in the conversation.

`createAnnouncedDelta` tracks a set of announced names. Names from `getBaseline` seed the set without a reminder, since the standing prompt already lists them. Only names that enter or leave the pool after that produce a reminder. `compute` returns `null` when `force` is true, because a standing interval has no meaning for a delta. `reset` re-reads `getBaseline`, so a new session re-announces the current pool.

## API

`extensions/reminders/index.ts` exports:

- `reminders(pi: ExtensionAPI): void` as the default export, which calls `installReminders(pi)`.
- `installReminders(pi: Pick<ExtensionAPI, "on">): void`, which registers the two event handlers. It takes only `on`, so a test can pass a stub.
- `buildReminderMessage(texts: readonly string[]): ReminderMessage`, which joins the texts with `\n\n`, wraps them in the module-private `OPEN_TAG` and `CLOSE_TAG` (`<system-reminder>` and `</system-reminder>`), and sets `timestamp: Date.now()`.
- `type ReminderMessage = { role: "user"; content: Array<{ type: "text"; text: string }>; timestamp: number }`, the shape pushed onto `event.messages`.

The injector listens on two events. `context` runs the registry, mutates the deep copy, and returns nothing. `session_start` calls `resetReminderGenerators()`, clears `lastInjectedAt`, and zeroes `callCount`.

The consumer-facing API is the registry in `shared/reminders.ts`, and consumers never import the injector. [shared.md](shared.md) holds the full reference. Static facts belong in a tool `description` or `promptSnippet`, durable user-visible state in `pi.appendEntry`, and one-shot steering in `pi.sendMessage(..., { deliverAs: "steer" })`.

- `ReminderGenerator = { id: string; compute(force: boolean): string | null; interval?: number; reset?(): void }`. `compute` returns the reminder text for this call or `null` when it has nothing to say, `interval: N` re-runs `compute(true)` every N calls, and `reset` runs on session start.
- `registerReminderGenerator(generator: ReminderGenerator): void` replaces a generator when the id matches.
- `unregisterReminderGenerator(id: string): boolean` returns true when it removed one.
- `getReminderGenerators(): readonly ReminderGenerator[]` returns a snapshot in registration order.
- `resetReminderGenerators(): void` calls `reset?.()` on every generator.
- `createAnnouncedDelta({ id, getCurrent, getBaseline?, renderAdded, renderRemoved }): ReminderGenerator`. `getCurrent: () => readonly string[]` is the tracked pool, `getBaseline?: () => readonly string[]` seeds the announced set, and both renderers take `readonly string[]`.

## Examples

Two registrations, a standing nudge and a baseline-seeded delta:

```ts
registerReminderGenerator({
  id: "policy-nudge",
  interval: 3,
  compute: (force) => (force ? "Never run `git push` without asking." : null),
});
```

```ts
registerReminderGenerator(createAnnouncedDelta({
  id: "available-tools",
  getCurrent: () => [...pooledTools.keys()],
  getBaseline: () => [...promptedToolNames],
  renderAdded: (names) => `New tools: ${names.join(", ")}.`,
  renderRemoved: (names) => `Dropped tools: ${names.join(", ")}.`,
}));
```
