import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readJsonOrDefault, writeJsonAtomic } from "../../shared/state-file.ts";

export interface NestingConfig {
  maxDepth: number;
}
export const DEFAULT_MAX_DEPTH = 3;

function validDepth(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function parseNestingConfig(value: unknown): NestingConfig {
  const depth =
    value && typeof value === "object" && "maxDepth" in value
      ? value.maxDepth
      : undefined;
  return { maxDepth: validDepth(depth) ? depth : DEFAULT_MAX_DEPTH };
}

export function parseDepthArgument(text: string): number {
  const value = text.trim();
  const depth = Number(value);
  if (!/^[0-9]+$/.test(value) || !validDepth(depth))
    throw new Error("Depth must be a positive safe integer.");
  return depth;
}

export async function runNestingDepthCommand(
  argument: string,
  agentDir = getAgentDir(),
): Promise<string> {
  const text = argument.trim();
  const config = text
    ? { maxDepth: parseDepthArgument(text) }
    : loadNestingConfig(agentDir);
  if (text) await saveNestingConfig(config, agentDir);
  const action = text
    ? `Saved maximum depth ${config.maxDepth}.`
    : `Maximum depth: ${config.maxDepth}.`;
  return `${action} Main is depth 0; its children are depth 1. Saved changes affect new root managers only.`;
}

export function loadNestingConfig(agentDir = getAgentDir()): NestingConfig {
  return readJsonOrDefault(
    join(agentDir, "subagent-nesting.json"),
    { maxDepth: DEFAULT_MAX_DEPTH },
    parseNestingConfig,
  );
}

export async function saveNestingConfig(
  config: NestingConfig,
  agentDir = getAgentDir(),
): Promise<void> {
  if (!validDepth(config.maxDepth))
    throw new Error("Depth must be a positive safe integer.");
  writeJsonAtomic(
    join(agentDir, "subagent-nesting.json"),
    { maxDepth: config.maxDepth },
    0o600,
  );
}
