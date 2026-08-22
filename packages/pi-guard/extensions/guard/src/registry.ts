import gitGuard from "./git.ts";
import prGuard from "./pr.ts";
import rmGuard from "./rm.ts";
import type { Guard } from "./types.ts";

export const GUARDS: readonly Guard[] = [gitGuard, prGuard, rmGuard];
