import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type HeadlessFallback = "deny" | "allow";

export interface GuardSettings {
  readonly git: boolean;
  readonly pr: boolean;
  readonly rm: boolean;
  readonly headlessFallback: HeadlessFallback;
}

export const DEFAULT_GUARD_SETTINGS: GuardSettings = {
  git: true,
  pr: true,
  rm: true,
  headlessFallback: "deny",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFallback = (value: unknown): value is HeadlessFallback =>
  value === "deny" || value === "allow";

export function parseGuardSettings(value: unknown): GuardSettings {
  if (!isRecord(value)) return DEFAULT_GUARD_SETTINGS;
  return {
    git:
      typeof value.git === "boolean" ? value.git : DEFAULT_GUARD_SETTINGS.git,
    pr: typeof value.pr === "boolean" ? value.pr : DEFAULT_GUARD_SETTINGS.pr,
    rm: typeof value.rm === "boolean" ? value.rm : DEFAULT_GUARD_SETTINGS.rm,
    headlessFallback: isFallback(value.headlessFallback)
      ? value.headlessFallback
      : DEFAULT_GUARD_SETTINGS.headlessFallback,
  };
}

const readSettingsFile = (settingsPath: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const truthy = (value: string | undefined) =>
  value !== undefined &&
  ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());

export function loadGuardSettings(
  settingsPath: string,
  env: NodeJS.ProcessEnv = process.env,
): GuardSettings {
  const settings = parseGuardSettings(readSettingsFile(settingsPath).guard);
  if (truthy(env.PI_DISABLE_GUARDS)) {
    return { ...settings, git: false, pr: false, rm: false };
  }
  return settings;
}

export function writeGuardSetting(
  settingsPath: string,
  patch: Partial<GuardSettings>,
): void {
  const raw = readSettingsFile(settingsPath);
  const current = parseGuardSettings(raw.guard);
  raw.guard = { ...current, ...patch };
  writeFileSync(settingsPath, `${JSON.stringify(raw, null, 2)}\n`);
}

export function globalSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}
