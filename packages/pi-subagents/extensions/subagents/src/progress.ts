/**
 * Live status line for running subagents. On each interval, an agent whose
 * activity changed gets one fast-tier call that turns short notes (the task,
 * the previous line, and a capped tail of recent activity) into a one-line
 * present-tense status. The full transcript is never sent.
 */

import type { SubagentSnapshot, TranscriptItem } from "./domain.ts";
import type { SubagentReadModel } from "./manager.ts";

export const PROGRESS_PROMPT =
  'Write a status line for this coding agent: what it is doing right now, in at most 8 words, present tense, starting with a verb (e.g. "Reading the auth middleware"). If the previous status still fits, repeat it. Output only the line.';
export const PROGRESS_MAX_TOKENS = 40;
export const PROGRESS_NOTES_CHAR_CAP = 1_500;

const NOTE_ITEMS = 8;
const NOTE_LINE_CHARS = 160;
const LINE_MAX_CHARS = 80;

const oneLine = (text: string, max = NOTE_LINE_CHARS) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function itemNotes(item: TranscriptItem): string[] {
  switch (item.kind) {
    case "user":
      return [`user: ${oneLine(item.text)}`];
    case "toolResult":
      return item.isError ? [`${item.name} failed`] : [];
    case "assistant":
      return item.parts.flatMap((part) => {
        if (part.type === "text" && part.text.trim())
          return [`said: ${oneLine(part.text)}`];
        if (part.type === "toolCall")
          return [`${part.name} ${oneLine(part.argsPreview ?? "")}`.trim()];
        return [];
      });
  }
}

/** The capped notes a status call sees, newest last. */
export function buildProgressNotes(
  snap: SubagentSnapshot,
  previous?: string,
): string {
  const recent = snap.transcript.slice(-NOTE_ITEMS).flatMap(itemNotes);
  const live = snap.liveTools
    .filter((tool) => !tool.done)
    .map((tool) => `running ${tool.name} ${oneLine(tool.argsPreview ?? "")}`);
  const streaming = snap.liveAssistant?.text.trim();
  const lines = [
    `Task: ${oneLine(snap.description)}`,
    ...(previous ? [`Previous status: ${previous}`] : []),
    "Recent activity:",
    ...recent.map((line) => `- ${line}`),
    ...live.map((line) => `- ${line.trim()}`),
    ...(streaming ? [`- writing: ${oneLine(streaming.slice(-400))}`] : []),
  ];
  const notes = lines.join("\n");
  return notes.length > PROGRESS_NOTES_CHAR_CAP
    ? notes.slice(notes.length - PROGRESS_NOTES_CHAR_CAP)
    : notes;
}

/** Changes whenever the agent does something new, so idle agents cost nothing. */
export function activityFingerprint(snap: SubagentSnapshot): string {
  const doneTools = snap.liveTools.filter((tool) => tool.done).length;
  return `${snap.transcript.length}:${snap.liveTools.length}:${doneTools}`;
}

/** First line, no trailing period or wrapping quotes, bounded. */
export function cleanProgressLine(raw: string): string | undefined {
  const first = raw.trim().split("\n")[0]?.trim() ?? "";
  const line = first.replace(/^["'`]+|["'`]+$/g, "").replace(/\.+$/, "");
  return line ? oneLine(line, LINE_MAX_CHARS) : undefined;
}

const keyOf = (snap: SubagentSnapshot) => `${snap.id}#${snap.runSequence}`;

const tracked = (snap: SubagentSnapshot) =>
  snap.origin === "model" && snap.status === "running";

export interface ProgressTracker {
  lineFor(id: string): string | undefined;
  /** Run one refresh pass now; the interval calls this. */
  tick(): Promise<void>;
  dispose(): void;
}

export function createProgressTracker(options: {
  view: Pick<SubagentReadModel, "list" | "subscribe">;
  intervalMs: number;
  summarize: (
    notes: string,
    signal: AbortSignal,
  ) => Promise<string | undefined>;
  onChange: () => void;
}): ProgressTracker {
  const entries = new Map<string, { line?: string; fingerprint: string }>();
  const controller = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;

  const running = () => options.view.list().filter(tracked);

  const prune = () => {
    const live = new Set(running().map(keyOf));
    for (const key of entries.keys()) if (!live.has(key)) entries.delete(key);
  };

  const tick = async () => {
    if (ticking || controller.signal.aborted) return;
    ticking = true;
    try {
      for (const snap of running()) {
        if (controller.signal.aborted) return;
        const key = keyOf(snap);
        const fingerprint = activityFingerprint(snap);
        const entry = entries.get(key);
        if (entry?.fingerprint === fingerprint) continue;
        const raw = await options
          .summarize(buildProgressNotes(snap, entry?.line), controller.signal)
          .catch(() => undefined);
        if (controller.signal.aborted) return;
        // A failed call records the fingerprint too, so a broken model is
        // retried only after the agent does something new.
        const line = (raw && cleanProgressLine(raw)) || entry?.line;
        entries.set(key, { line, fingerprint });
        if (line !== entry?.line) options.onChange();
      }
      prune();
    } finally {
      ticking = false;
    }
  };

  const syncTimer = () => {
    prune();
    if (running().length > 0) {
      timer ??= setInterval(() => void tick(), options.intervalMs);
      timer.unref?.();
      return;
    }
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const unsubscribe = options.view.subscribe(syncTimer);
  syncTimer();

  return {
    lineFor(id) {
      const snap = options.view.list().find((s) => s.id === id);
      return snap && tracked(snap) ? entries.get(keyOf(snap))?.line : undefined;
    },
    tick,
    dispose() {
      controller.abort();
      unsubscribe();
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      entries.clear();
    },
  };
}
