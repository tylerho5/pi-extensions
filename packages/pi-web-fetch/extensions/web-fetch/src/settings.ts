/**
 * web-fetch configuration: which cheap model applies the `prompt` to fetched
 * page content, independent of the main agent's model. Persisted at
 * ~/.pi/agent/web-fetch.json and edited through /web-fetch-model.
 * Follows the advisor/settings pattern — per-field fallback and atomic writes
 * so a corrupt or half-edited file can never break the main session.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface WebFetchSettings {
  readonly provider: string;
  readonly model: string;
  /** Bounds the apply model's total output (thinking + text) per call. */
  readonly maxTokens: number;
}

/** The apply step should always be cheap; flash models are the right default. */
export const DEFAULT_WEB_FETCH_SETTINGS: WebFetchSettings = {
  provider: "deepseek",
  model: "deepseek-v4-flash",
  maxTokens: 4_096,
};

export const WEB_FETCH_SETTINGS_PATH = join(getAgentDir(), "web-fetch.json");

export const modelKey = (
  settings: Pick<WebFetchSettings, "provider" | "model">,
) => `${settings.provider}/${settings.model}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** Each field falls back independently, so one bad value keeps the rest. */
export function parseWebFetchSettings(value: unknown): WebFetchSettings {
  if (!isRecord(value)) return DEFAULT_WEB_FETCH_SETTINGS;
  const defaults = DEFAULT_WEB_FETCH_SETTINGS;
  const maxTokens = value.maxTokens;
  return {
    provider: nonEmpty(value.provider) ?? defaults.provider,
    model: nonEmpty(value.model) ?? defaults.model,
    maxTokens:
      typeof maxTokens === "number" &&
      Number.isFinite(maxTokens) &&
      maxTokens >= 1_000
        ? Math.floor(maxTokens)
        : defaults.maxTokens,
  };
}

export function loadWebFetchSettings(): WebFetchSettings {
  try {
    return parseWebFetchSettings(
      JSON.parse(readFileSync(WEB_FETCH_SETTINGS_PATH, "utf8")),
    );
  } catch {
    return DEFAULT_WEB_FETCH_SETTINGS;
  }
}

export async function saveWebFetchSettings(settings: WebFetchSettings) {
  const tempPath = `${WEB_FETCH_SETTINGS_PATH}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(WEB_FETCH_SETTINGS_PATH), { recursive: true });
  try {
    await writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await rename(tempPath, WEB_FETCH_SETTINGS_PATH);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
