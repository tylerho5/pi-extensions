import { GUARDS } from "./registry.ts";
import type { GuardSettings, HeadlessFallback } from "./settings.ts";

export type Route =
  | { route: "prompt-local" }
  | { route: "prompt-parent" }
  | { route: "headless"; allow: boolean };

export interface PromptContext {
  hasUI: boolean;
  hasParent: boolean;
  fallback: HeadlessFallback;
}

export function guardReasons(
  command: string,
  settings: GuardSettings,
): string[] {
  const reasons: string[] = [];
  for (const guard of GUARDS) {
    if (!settings[guard.id]) continue;
    const reason = guard.match(command);
    if (reason !== null) reasons.push(reason);
  }
  return reasons;
}

export function routePrompt(ctx: PromptContext): Route {
  if (ctx.hasUI) return { route: "prompt-local" };
  if (ctx.hasParent) return { route: "prompt-parent" };
  return { route: "headless", allow: ctx.fallback === "allow" };
}

export interface GateHooks {
  confirmLocal(title: string, body: string): Promise<boolean>;
  confirmParent(title: string, body: string): Promise<boolean>;
}

export interface GateEnv {
  hasUI: boolean;
  hasParent: boolean;
}

export type GateResult = { block: true; reason: string } | undefined;

export async function evaluateBashGate(
  command: string,
  settings: GuardSettings,
  env: GateEnv,
  hooks: GateHooks,
): Promise<GateResult> {
  const reasons = guardReasons(command, settings);
  if (reasons.length === 0) return undefined;

  const route = routePrompt({
    hasUI: env.hasUI,
    hasParent: env.hasParent,
    fallback: settings.headlessFallback,
  });
  const title =
    route.route === "prompt-parent" ? "Guard — subagent command" : "Guard";
  const body = `Confirm before ${reasons.join(" and ")}:\n\n  ${command}`;

  let approved: boolean;
  switch (route.route) {
    case "prompt-local":
      approved = await hooks.confirmLocal(title, body);
      break;
    case "prompt-parent":
      approved = await hooks.confirmParent(title, body);
      break;
    case "headless":
      approved = route.allow;
      break;
  }

  if (approved) return undefined;
  return { block: true, reason: `Blocked by guard: ${reasons.join(", ")}` };
}
