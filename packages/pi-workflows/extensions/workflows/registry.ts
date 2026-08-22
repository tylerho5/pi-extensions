/**
 * Saved workflow definitions, mirroring CC's named-workflow registry.
 *
 * A definition is a `.js` file whose contents are an ordinary workflow script
 * with a `export const meta = {...}` header. User-level definitions live in
 * `~/.pi/agent/workflows/*.js`; project-level ones in `<cwd>/.pi/workflows/*.js`
 * and shadow user definitions of the same name. Additional directories (e.g.
 * `~/.claude/workflows` for sharing CC definitions) can be added via the
 * `extraDirs` setting in `workflows.json`; they have the lowest precedence.
 * Run artifacts live in `wf_*` subdirectories of the same user directory, so
 * the two never collide.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { extractMeta, type WorkflowMeta } from "./meta.ts";

const MAX_DEFINITION_BYTES = 512 * 1024;
const SETTINGS_FILE = "workflows.json";

export interface SavedWorkflow {
  name: string;
  description: string;
  whenToUse?: string;
  source: "user" | "project" | "extra";
  filePath: string;
  script: string;
  meta: WorkflowMeta;
}

export interface RegistrySettings {
  /** Extra directories scanned for definitions, at the lowest precedence. */
  extraDirs: string[];
  /** CC-style model alias → pi model ref (provider/id or bare id). */
  modelAliases: Record<string, string>;
}

function expandHome(dir: string): string {
  const trimmed = dir.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/"))
    return path.join(os.homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}

/** Reads `workflows.json` from the agent dir; absent/invalid means no extras. */
export function loadRegistrySettings(): RegistrySettings {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(getAgentDir(), SETTINGS_FILE), "utf8"),
    );
    if (parsed && typeof parsed === "object") {
      const settings: RegistrySettings = { extraDirs: [], modelAliases: {} };
      const dirs = (parsed as { extraDirs?: unknown }).extraDirs;
      if (Array.isArray(dirs)) {
        settings.extraDirs = dirs
          .filter((d): d is string => typeof d === "string" && !!d.trim())
          .map(expandHome);
      }
      const aliases = (parsed as { modelAliases?: unknown }).modelAliases;
      if (aliases && typeof aliases === "object") {
        for (const [alias, target] of Object.entries(aliases)) {
          if (alias.trim() && typeof target === "string" && target.trim()) {
            settings.modelAliases[alias] = target.trim();
          }
        }
      }
      return settings;
    }
  } catch {
    // No configured extras.
  }
  return { extraDirs: [], modelAliases: {} };
}

export function userWorkflowDir() {
  return path.join(getAgentDir(), "workflows");
}

export function projectWorkflowDir(cwd: string) {
  return path.join(cwd, ".pi", "workflows");
}

function loadDir(
  dir: string,
  source: SavedWorkflow["source"],
): SavedWorkflow[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const loaded: SavedWorkflow[] = [];
  for (const name of names) {
    if (!name.endsWith(".js")) continue;
    const filePath = path.join(dir, name);
    try {
      if (fs.statSync(filePath).size > MAX_DEFINITION_BYTES) continue;
      const script = fs.readFileSync(filePath, "utf8");
      const meta = extractMeta(script);
      if (!meta.name || !meta.description) continue;
      loaded.push({
        name: meta.name,
        description: meta.description,
        ...(meta.whenToUse ? { whenToUse: meta.whenToUse } : {}),
        source,
        filePath,
        script,
        meta,
      });
    } catch {
      // A malformed definition is skipped rather than breaking the registry.
    }
  }
  return loaded;
}

/**
 * Merges definitions from all directories. Precedence, lowest first:
 * `extraDirs` (in array order), then user, then project.
 */
export function collectSavedWorkflows(dirs: {
  userDir: string;
  projectDir: string;
  extraDirs?: string[];
}): SavedWorkflow[] {
  const byName = new Map<string, SavedWorkflow>();
  for (const dir of dirs.extraDirs ?? []) {
    for (const workflow of loadDir(dir, "extra")) {
      byName.set(workflow.name, workflow);
    }
  }
  for (const workflow of loadDir(dirs.userDir, "user")) {
    byName.set(workflow.name, workflow);
  }
  for (const workflow of loadDir(dirs.projectDir, "project")) {
    byName.set(workflow.name, workflow);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Project definitions shadow user definitions, which shadow extra dirs. */
export function listSavedWorkflows(cwd: string): SavedWorkflow[] {
  return collectSavedWorkflows({
    userDir: userWorkflowDir(),
    projectDir: projectWorkflowDir(cwd),
    extraDirs: loadRegistrySettings().extraDirs,
  });
}

export function findSavedWorkflow(
  cwd: string,
  name: string,
): SavedWorkflow | undefined {
  return listSavedWorkflows(cwd).find((workflow) => workflow.name === name);
}

/** One line per definition for the tool description's registry section. */
export function describeSavedWorkflows(cwd: string): string {
  const saved = listSavedWorkflows(cwd);
  if (saved.length === 0) return "";
  const lines = saved.map((workflow) => {
    const origin =
      workflow.source === "extra"
        ? ` [from ${shortenHome(path.dirname(workflow.filePath))}]`
        : "";
    return `- ${workflow.name} — ${workflow.description}${
      workflow.whenToUse ? ` (use when: ${workflow.whenToUse})` : ""
    }${origin}`;
  });
  return [
    "",
    "Saved workflows available here — invoke with { name } instead of writing a script:",
    ...lines,
  ].join("\n");
}

function shortenHome(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}
