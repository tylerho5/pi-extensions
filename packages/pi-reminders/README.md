# @tylerho/pi-reminders

Injects dynamic system-reminder messages before each LLM call from a shared generator registry.

## Install

`pi install npm:@tylerho/pi-reminders`

---

# Reminders

The reminders extension is the system-reminder injector. Before each prompt it runs every generator registered in `shared/reminders.ts` and injects the output as one hidden `<system-reminder>` user message that stays in the conversation. It registers no tools, commands, or shortcuts.

## Claude Code lineage

The injector mirrors Claude Code's system-reminder mechanism: user-role text wrapped in `<system-reminder>` tags, delivered outside the system prompt. `createAnnouncedDelta` follows Claude Code's `deferred_tools_delta` semantics for announced-name tracking. The feature commit `61709db feat(reminders): system-reminder injector` (2026-08-12) and the source record no Claude Code release.

The persistence behavior was verified against Claude Code 2.1.277 on 2026-09-19. CC persists each reminder as an attachment entry that carries a `rendered` copy of the text, and the wire builder folds every attachment entry into each request, so a reminder that fired once is re-sent on later turns. The early implementation dropped the text after one request instead. Reminders that must not replay are lifted out of the wire path by `clearAt: "next_user_message"` on `batching_reminder_sent` and `secondary_reminder_sent`, which makes replay the default.

## How it works

The `before_agent_start` event fires before each prompt. When at least one generator is registered, the handler increments an install-wide `callCount`, runs each generator, and returns one message when any generator produced text. All generators that speak on a prompt share that one message, in registry insertion order, with their trimmed texts joined by `\n\n`. Blank output is skipped, and an empty registry returns nothing.

pi stores the returned message as a `custom_message` entry, so it participates in every later request and survives resume. It carries `customType: "reminder"`, `display: true`, and the `<system-reminder>` body as its content, and pi converts it to a user message on the wire — the shape CC emits for models without mid-conversation system support. A registered renderer draws it as a collapsed `✦ reminder: N blocks` line, with ctrl+o showing the exact body.

The `context` event cannot carry this. It fires before every LLM call with a deep copy of `event.messages`, so a message pushed there reaches the model for that one request and is then discarded. Production is therefore per prompt rather than per LLM call, and `interval` counts prompts.

`lastInjectedAt` records the call count of each generator's last emission, not its last compute. A generator with `interval: N` is called with `force: true` when `callCount - lastInjected >= N`. A forced generator that returns `null` is offered the floor again on each later call until it emits. `session_start` then calls `resetReminderGenerators()`, clears `lastInjectedAt`, and sets `callCount` back to zero, so a new session re-announces state that is already in the conversation.

A reminder persists for the rest of the conversation, so a generator that re-emits standing text on an interval adds a duplicate of text the model already has. Delta generators avoid this by construction. A standing generator should return its text once and then `null`.

`createAnnouncedDelta` tracks a set of announced names. Names from `getBaseline` seed the set without a reminder, since the standing prompt already lists them. Only names that enter or leave the pool after that produce a reminder. `compute` returns `null` when `force` is true, because a standing interval has no meaning for a delta. `reset` re-reads `getBaseline`, so a new session re-announces the current pool.

## API

`extensions/reminders/index.ts` exports:

- `reminders(pi: ExtensionAPI): void` as the default export, which calls `installReminders(pi)`.
- `installReminders(pi: Pick<ExtensionAPI, "on" | "registerMessageRenderer">): void`, which registers the two event handlers and the message renderer. It takes only those two methods, so a test can pass a stub.
- `REMINDER_MESSAGE_TYPE`, the `customType` ("reminder") carried by an injected message.
- `buildReminderMessage(texts: readonly string[]): ReminderMessage`, which joins the texts with `\n\n` and wraps them in the module-private `OPEN_TAG` and `CLOSE_TAG` (`<system-reminder>` and `</system-reminder>`).
- `type ReminderMessage = { customType: string; content: string; display: boolean; details: { texts: string[] } }`, the shape returned from `before_agent_start` for pi to persist.

The injector listens on two events. `before_agent_start` runs the registry and returns the message. `session_start` calls `resetReminderGenerators()`, clears `lastInjectedAt`, and zeroes `callCount`.

The consumer-facing API is the registry in `shared/reminders.ts`, and consumers never import the injector. [shared.md](shared.md) holds the full reference. Static facts belong in a tool `description` or `promptSnippet`, durable user-visible state in `pi.appendEntry`, and one-shot steering in `pi.sendMessage(..., { deliverAs: "steer" })`.

- `ReminderGenerator = { id: string; compute(force: boolean): string | null; interval?: number; reset?(): void }`. `compute` returns the reminder text for this call or `null` when it has nothing to say, `interval: N` re-runs `compute(true)` every N calls, and `reset` runs on session start.
- `registerReminderGenerator(generator: ReminderGenerator): void` replaces a generator when the id matches.
- `unregisterReminderGenerator(id: string): boolean` returns true when it removed one.
- `getReminderGenerators(): readonly ReminderGenerator[]` returns a snapshot in registration order.
- `resetReminderGenerators(): void` calls `reset?.()` on every generator.
- `createAnnouncedDelta({ id, getCurrent, getBaseline?, renderAdded, renderRemoved }): ReminderGenerator`. `getCurrent: () => readonly string[]` is the tracked pool, `getBaseline?: () => readonly string[]` seeds the announced set, and both renderers take `readonly string[]`.

## Examples

Two registrations, a one-time nudge and a baseline-seeded delta:

```ts
registerReminderGenerator({
  id: "policy-nudge",
  compute: () => "Never run `git push` without asking.",
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
