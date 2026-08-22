export type GuardId = "git" | "pr" | "rm";

export interface Guard {
  readonly id: GuardId;
  readonly label: string;
  /** null when the command is not guarded; otherwise the confirm reason. */
  match(command: string): string | null;
}
