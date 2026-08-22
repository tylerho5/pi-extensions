export interface ConfirmUi {
  confirm(title: string, body: string): Promise<boolean>;
}

// The interactive main session's UI, captured at session_start. Headless child
// sessions (subagents) route their guard prompts here so a human still decides.
let parentUi: ConfirmUi | undefined;
// Serializes prompts so concurrent subagents don't collide on the modal.
let queue: Promise<unknown> = Promise.resolve();

export function setParentUi(ui: ConfirmUi | undefined): void {
  parentUi = ui;
}

export function hasParentUi(): boolean {
  return parentUi !== undefined;
}

export function confirmOnParent(title: string, body: string): Promise<boolean> {
  const ui = parentUi;
  if (!ui) return Promise.resolve(false);
  const run = queue.then(() => ui.confirm(title, body));
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
