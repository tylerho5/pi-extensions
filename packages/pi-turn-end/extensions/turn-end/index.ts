import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const ENTRY_TYPE = "turn-end";

export interface TurnEndData {
  startedAt: number;
  endedAt: number;
  durationMs: number;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const TIME_ZONE = "America/New_York";

const edtTime = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const edtDayLabel = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  weekday: "long",
  month: "short",
  day: "numeric",
});

const edtDayKey = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// Day comparison runs at render time, so yesterday's entry gains its date
// once the day rolls over.
function sameEdtDay(ms: number, now: number): boolean {
  return edtDayKey.format(new Date(ms)) === edtDayKey.format(new Date(now));
}

export function formatStoppedAt(ms: number, now = Date.now()): string {
  const at = new Date(ms);
  const time = edtTime.format(at);
  if (sameEdtDay(ms, now)) return time;
  return `${edtDayLabel.format(at)} at ${time}`;
}

export function formatLine(data: TurnEndData, now = Date.now()): string {
  const at = formatStoppedAt(data.endedAt, now);
  const stopped = sameEdtDay(data.endedAt, now)
    ? `stopped at ${at}`
    : `stopped ${at}`;
  return `worked ${formatDuration(data.durationMs)} · ${stopped}`;
}

export default function turnEnd(pi: ExtensionAPI) {
  // First agent_start of a user turn sets the clock; later starts (auto-retry,
  // compaction retry, queued follow-ups) keep it so the duration covers the
  // whole run, matching what the user experiences as "the agent working".
  let startedAt: number | undefined;

  pi.registerEntryRenderer<TurnEndData>(
    ENTRY_TYPE,
    (entry, _options, theme) => {
      const line = entry.data ? formatLine(entry.data) : "turn ended";
      return new Text(theme.fg("dim", line), 0, 0);
    },
  );

  pi.on("session_start", () => {
    startedAt = undefined;
  });

  pi.on("agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || startedAt !== undefined) return;
    startedAt = Date.now();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.mode !== "tui" || startedAt === undefined) return;
    const endedAt = Date.now();
    pi.appendEntry(ENTRY_TYPE, {
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
    } satisfies TurnEndData);
    startedAt = undefined;
  });
}
