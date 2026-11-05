/**
 * The `/rewind` menu and its five actions.
 *
 * `/rewind` takes no arguments and does nothing without dialog-capable UI, which is how
 * a non-interactive mode stays out of the way. Two selects: pick a checkpoint, then pick
 * an action. Cancel at either step does nothing.
 *
 * The shadow drivers arrive through `MenuDeps` rather than being called directly, so the
 * dispatch is testable without a git repository and the wiring in `index.ts` stays the
 * only place that knows where the shadow lives.
 */

import type {
  CompactionResult,
  ExtensionCommandContext,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  generateSummaryWithUsage,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type { RestorePlanEntry } from "./plan.ts";
import { checkpointLabel, messageText, type Checkpoint } from "./store.ts";

/** Claude Code's actions, in its order. */
export const RESTORE_MODES = [
  "Restore code and conversation",
  "Restore conversation",
  "Restore code",
  "Summarize from here",
  "Summarize up to here",
  "Never mind",
] as const;

const CODE_AND_CONVERSATION = "Restore code and conversation";
const CONVERSATION_ONLY = "Restore conversation";
const CODE_ONLY = "Restore code";
const SUMMARIZE_FROM_HERE = "Summarize from here";
const SUMMARIZE_UP_TO_HERE = "Summarize up to here";

/** The two actions that write files. Both are withdrawn when a restore would change
 * nothing, which is what the checkpoint's own plan decides. */
const CODE_ACTIONS: readonly string[] = [CODE_AND_CONVERSATION, CODE_ONLY];

/** The actions to offer: the code ones only when a restore would change something. */
export function availableModes(hasCodeChanges: boolean): string[] {
  return hasCodeChanges
    ? [...RESTORE_MODES]
    : RESTORE_MODES.filter((mode) => !CODE_ACTIONS.includes(mode));
}

/** The boundary a manual compaction must use, set just before `compact()` is called and
 * consumed by `session_before_compact`. Process state: the command and the hook run in
 * the same turn, so it never needs to survive a restart. */
export interface CompactionState {
  pendingBoundary: string | undefined;
}

export interface MenuDeps {
  /** The checkpoints to offer, oldest first. */
  records: () => Checkpoint[];
  /** The shadow this session is bound to. A record naming another is listed but refused. */
  shadowDir: () => string;
  plan: (ref: string) => Promise<RestorePlanEntry[]>;
  hasChanges: (plan: readonly RestorePlanEntry[]) => Promise<boolean>;
  apply: (
    plan: readonly RestorePlanEntry[],
  ) => Promise<{ applied: number; skipped: number }>;
  state: CompactionState;
}

export type Summarize = (request: {
  messages: ContextMessage[];
  model: SummarizeModel;
  reserveTokens: number;
  apiKey: string | undefined;
  headers: Record<string, string | null> | undefined;
  env: Record<string, string> | undefined;
  thinkingLevel: ThinkingLevelName;
  signal: AbortSignal | undefined;
  customInstructions: string | undefined;
}) => Promise<{ text: string; usage: SummaryUsage }>;

/** The message type pi's summarizer takes, taken from the exported builder so this
 * module needs no second source for it. */
type ContextMessage = ReturnType<typeof sessionEntryToContextMessages>[number];
type SummarizeModel = NonNullable<ExtensionContext["model"]>;
type ThinkingLevelName = ExtensionContext["thinkingLevel"];
type SummaryUsage = Awaited<
  ReturnType<typeof generateSummaryWithUsage>
>["usage"];

export interface CompactDeps {
  /** The reserve budget for the summary. */
  reserveTokens: () => number;
  /** Defaults to pi's own summarizer; a test injects a fake so no provider is needed. */
  summarize?: Summarize;
}

const piSummarize: Summarize = async (request) => {
  // Resolved headers can carry an explicit null, which the summarizer's signature does
  // not accept; a null means "no value" either way.
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (value !== null) headers[name] = value;
  }
  const result = await generateSummaryWithUsage(
    request.messages,
    request.model,
    request.reserveTokens,
    request.apiKey,
    Object.keys(headers).length > 0 ? headers : undefined,
    request.signal,
    request.customInstructions,
    undefined,
    request.thinkingLevel,
    undefined,
    request.env,
  );
  return { text: result.text, usage: result.usage };
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type ConversationOutcome = "restored" | "cancelled" | "failed";

/**
 * `navigateTree`'s published type omits `editorText`, but the runtime returns it and the
 * interactive caller puts it in the editor. This reads it when present and falls back to
 * the target entry's own text, so neither an undocumented field nor the entry text alone
 * carries the behavior.
 */
async function navigate(
  ctx: ExtensionCommandContext,
  entryId: string,
  summarize: boolean,
): Promise<ConversationOutcome> {
  try {
    const result = (await ctx.navigateTree(entryId, { summarize })) as {
      cancelled: boolean;
      editorText?: string;
    };
    if (result.cancelled) return "cancelled";
    const text =
      typeof result.editorText === "string"
        ? result.editorText
        : entryText(ctx, entryId);
    if (text !== "") ctx.ui.setEditorText(text);
    return "restored";
  } catch (error) {
    ctx.ui.notify(`Conversation restore failed: ${errorText(error)}`, "error");
    return "failed";
  }
}

function entryText(ctx: ExtensionContext, entryId: string): string {
  const entry = ctx.sessionManager.getEntry(entryId);
  if (entry === undefined || entry.type !== "message") return "";
  // A session message is not always a chat message, so read `content` structurally.
  return messageText((entry.message as { content?: unknown }).content, " ");
}

/** Land the conversation before the selected prompt and put that prompt in the editor. */
export function restoreConversation(
  ctx: ExtensionCommandContext,
  entryId: string,
): Promise<ConversationOutcome> {
  return navigate(ctx, entryId, false);
}

/** The same, but the entries after the target on the abandoned branch are summarized. */
export function summarizeFromHere(
  ctx: ExtensionCommandContext,
  entryId: string,
): Promise<ConversationOutcome> {
  return navigate(ctx, entryId, true);
}

/**
 * Compress everything before the selected prompt, keeping what follows it intact, by
 * handing `session_before_compact` an exact boundary. The editor is left untouched, as
 * in Claude Code.
 *
 * `ctx.compact()` reports failure through its callbacks, and pi's own guards (a session
 * too small to compact, an already-compacted tail) run before the hook fires; those
 * arrive through `onError` and are reported with pi's message.
 */
export function requestSummarizeUpTo(
  ctx: ExtensionCommandContext,
  entryId: string,
  state: CompactionState,
): void {
  state.pendingBoundary = entryId;
  try {
    ctx.compact({
      onError: (error) => {
        ctx.ui.notify(
          `Summarize up to here failed: ${error.message}`,
          "warning",
        );
      },
    });
  } catch (error) {
    // `compact()` hands off before the hook runs, so a throw here means the hook will
    // never see this boundary: drop it rather than let a later compaction pick it up.
    state.pendingBoundary = undefined;
    ctx.ui.notify(
      `Summarize up to here failed: ${errorText(error)}`,
      "warning",
    );
  }
}

/**
 * Supply the boundary `/rewind` asked for. Only a manual compaction is intercepted:
 * an automatic one must neither consume nor clear a pending boundary.
 */
export async function handleBeforeCompact(
  ctx: ExtensionContext,
  event: SessionBeforeCompactEvent,
  state: CompactionState,
  deps: CompactDeps,
): Promise<{ compaction: CompactionResult } | undefined> {
  if (event.reason !== "manual") return undefined;
  const boundary = state.pendingBoundary;
  if (boundary === undefined) return undefined;
  // Cleared before the summarization call, so a compaction re-entering while this one
  // runs cannot consume the same boundary.
  state.pendingBoundary = undefined;

  const branch = ctx.sessionManager.getBranch();
  const index = branch.findIndex((entry) => entry.id === boundary);
  if (index === -1) return undefined;
  const messagesToSummarize = branch
    .slice(0, index)
    .flatMap((entry) => sessionEntryToContextMessages(entry));

  const model = ctx.model;
  if (model === undefined) return undefined;
  const auth = await ctx.modelRegistry
    .getApiKeyAndHeaders(model)
    .catch(() => undefined);

  const summarize = deps.summarize ?? piSummarize;
  const { text: summary, usage } = await summarize({
    messages: messagesToSummarize,
    model: model,
    reserveTokens:
      deps.reserveTokens() ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    apiKey: auth?.ok === true ? auth.apiKey : undefined,
    headers: auth?.ok === true ? auth.headers : undefined,
    env: auth?.ok === true ? auth.env : undefined,
    thinkingLevel: ctx.thinkingLevel,
    signal: event.signal,
    customInstructions: event.customInstructions,
  });
  const tokensBefore = messagesToSummarize.reduce(
    (total, message) => total + estimateTokens(message),
    0,
  );
  return {
    compaction: { summary, firstKeptEntryId: boundary, tokensBefore, usage },
  };
}

/**
 * Restore the code a checkpoint plan names, reporting what it did. A record from another
 * shadow is refused here as well as in the menu, so the refusal does not depend on the
 * menu's gating.
 *
 * `partial` is not `ok`: a per-ref checkout that fails leaves files the user asked to
 * restore still on disk, and calling that a complete rewind would hide it.
 */
async function restoreCode(
  ctx: ExtensionCommandContext,
  record: Checkpoint,
  deps: MenuDeps,
): Promise<"ok" | "partial" | "failed"> {
  if (record.shadow !== deps.shadowDir()) {
    ctx.ui.notify(
      `Checkpoint recorded in ${record.shadow}; code left untouched`,
      "warning",
    );
    return "failed";
  }
  const plan = await deps.plan(record.ref);
  if (plan.length === 0) {
    ctx.ui.notify("Checkpoint has no files; code left untouched", "warning");
    return "ok";
  }
  const result = await deps.apply(plan);
  if (result.applied === 0) {
    ctx.ui.notify("Code restore failed; nothing was written", "warning");
    return "failed";
  }
  if (result.skipped > 0) {
    ctx.ui.notify(
      `Code restore incomplete: ${result.skipped} of ${plan.length} files were not written`,
      "warning",
    );
    return "partial";
  }
  return "ok";
}

async function dispatch(
  ctx: ExtensionCommandContext,
  record: Checkpoint,
  mode: string,
  deps: MenuDeps,
): Promise<void> {
  if (mode === SUMMARIZE_UP_TO_HERE) {
    requestSummarizeUpTo(ctx, record.entryId, deps.state);
    return;
  }
  if (mode === SUMMARIZE_FROM_HERE || mode === CONVERSATION_ONLY) {
    const outcome =
      mode === SUMMARIZE_FROM_HERE
        ? await summarizeFromHere(ctx, record.entryId)
        : await restoreConversation(ctx, record.entryId);
    if (outcome === "restored") ctx.ui.notify("Conversation restored", "info");
    else if (outcome === "cancelled") {
      ctx.ui.notify("Conversation left unchanged", "info");
    }
    return;
  }

  const code = await restoreCode(ctx, record, deps);
  if (code === "failed") return;
  if (mode === CODE_ONLY) {
    ctx.ui.notify(
      code === "partial" ? "Code restored in part" : "Code restored",
      code === "partial" ? "warning" : "info",
    );
    return;
  }
  const outcome = await restoreConversation(ctx, record.entryId);
  reportConversation(ctx, outcome, code);
}

/** What the user is told once a code restore did (or did not) land alongside the
 * conversation. A partial code restore is a warning, never a completed rewind. */
function reportConversation(
  ctx: ExtensionContext,
  outcome: ConversationOutcome,
  code: "ok" | "partial",
): void {
  if (outcome === "failed") return;
  const partial = code === "partial";
  const message =
    outcome === "restored"
      ? partial
        ? "Code restored in part; conversation restored"
        : "Rewind complete"
      : partial
        ? "Code restored in part; conversation left unchanged"
        : "Code restored; conversation left unchanged";
  ctx.ui.notify(message, partial ? "warning" : "info");
}

/** Pick a checkpoint and an action, then carry it out. */
export async function runRewindCommand(
  ctx: ExtensionCommandContext,
  deps: MenuDeps,
): Promise<void> {
  if (!ctx.hasUI) return;
  const ordered = [...deps.records()].reverse();
  if (ordered.length === 0) {
    ctx.ui.notify("No checkpoints recorded yet", "info");
    return;
  }
  const bound = deps.shadowDir();
  const labels = ordered.map((record, index) =>
    checkpointLabel(record, index, record.shadow === bound),
  );
  const choice = await ctx.ui.select("Rewind to checkpoint:", labels);
  if (choice === undefined) return;
  const record = ordered[labels.indexOf(choice)];
  if (record === undefined) return;

  const restorable = record.shadow === bound;
  const plan = restorable ? await deps.plan(record.ref) : [];
  const hasCodeChanges = restorable && (await deps.hasChanges(plan));
  const mode = await ctx.ui.select(
    "Restore mode:",
    availableModes(hasCodeChanges),
  );
  if (mode === undefined || !RESTORE_MODES.includes(mode as never)) return;
  await dispatch(ctx, record, mode, deps);
}
