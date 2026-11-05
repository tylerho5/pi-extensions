/**
 * Which files a session touched, and the baselines that make those edits undoable.
 *
 * Adapted from `extensions/internal/tool-target.ts` and `extensions/git-checkpoint.ts`
 * in `ilovepixelart/pi-code` at commit `ff3eb5e` (2026-10-05), MIT licensed, copyright
 * 2025 Mario Zechner and 2026 ilovepixelart.
 *
 * Scope is the set of files this session's edit tools named, never the whole working
 * tree: that set is what bounds snapshot size, so a session running in `$HOME` does not
 * snapshot a home directory.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addPaths,
  BASELINE_MESSAGE,
  commitShadow,
  committedPaths,
  headSha,
  updateRunRef,
  withoutIgnored,
  workTreePath,
  type ShadowDeps,
  type ShadowRepo,
} from "./shadow.ts";

/** pi's tools that change a file. `read` is deliberately absent: checkpoint scope is
 * the set of files the session edited. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);

/** The spaces pi folds to a plain one before resolving (pi dist/utils/paths). */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

// Re-exported so this module keeps the surface its consumers import, while the
// pathspec rules and the baseline commit message stay in one place.
export { BASELINE_MESSAGE, workTreePath };

/**
 * `target` as pi's file tools read it before resolving against a cwd: a leading `@`
 * (which some models add) stripped, `~` expanded, a `file://` URL decoded, unicode
 * spaces folded. pi does this in `resolveToCwd`, which the package does not export, so
 * a reader that skips it judges a different file than the one pi opens.
 */
export function asPiReadsIt(target: string): string {
  const folded = target.replace(UNICODE_SPACES, " ");
  const bare = folded.startsWith("@") ? folded.slice(1) : folded;
  if (bare === "~") return os.homedir();
  if (
    bare.startsWith("~/") ||
    (process.platform === "win32" && bare.startsWith("~\\"))
  ) {
    return path.join(os.homedir(), bare.slice(2));
  }
  if (!bare.startsWith("file://")) return bare;
  try {
    return fileURLToPath(bare);
  } catch {
    return bare;
  }
}

/** The path a file tool call named, or undefined for any other tool, an errored call,
 * or a call that named none. Still relative when the model gave a relative path:
 * callers resolve it against their own cwd. */
export function fileToolTarget(event: {
  toolName: string;
  input?: unknown;
  isError?: boolean;
}): string | undefined {
  if (event.isError === true) return undefined;
  if (!EDIT_TOOLS.has(event.toolName)) return undefined;
  const input = event.input as
    { path?: unknown; file_path?: unknown } | undefined;
  const target =
    typeof input?.path === "string" ? input.path : input?.file_path;
  return typeof target === "string" && target.length > 0
    ? asPiReadsIt(target)
    : undefined;
}

/**
 * `file` named by the real directory it sits in, when a symlink inside the work tree
 * leads there. git refuses a pathspec that passes through a symlink ("beyond a symbolic
 * link"), so the file has to be tracked where it really is. The real directory is
 * mapped back under the work tree as the session spells it: a cwd that is itself a
 * symlinked path (macOS `/var`) must not push every file outside the tree.
 */
export function throughSymlinks(workTree: string, file: string): string {
  try {
    const realTree = fs.realpathSync(workTree);
    const realDir = fs.realpathSync(path.dirname(file));
    const inside = path.relative(realTree, realDir);
    if (inside.startsWith("..") || path.isAbsolute(inside)) return file;
    return path.join(workTree, inside, path.basename(file));
  } catch {
    return file;
  }
}

/**
 * Fold a file's pre-edit content into the run's checkpoint. A file first edited part
 * way through a run is absent from that run's pre-run snapshot, so without this its
 * checkpoint holds no baseline and `/rewind` cannot undo that first edit. Returns
 * without doing anything when there is no run yet, or when the file is gone, ignored,
 * or not stageable.
 */
export async function captureBaseline(
  deps: ShadowDeps,
  shadow: ShadowRepo,
  ref: string | undefined,
  file: string,
): Promise<void> {
  if (ref === undefined) return;
  const rel = workTreePath(shadow.workTree, file);
  if (rel === undefined || !fs.existsSync(file)) return;
  if ((await withoutIgnored(deps, shadow, [rel])).length === 0) return;
  if (!(await addPaths(deps, shadow, [rel]))) return;
  // A commit, never an amend: the run's checkpoint can be a commit an earlier
  // checkpoint also points at, and rewriting it would strand that one. The message
  // lets a rewind to an earlier checkpoint find the file's content there.
  if ((await commitShadow(deps, shadow, [], BASELINE_MESSAGE)).code !== 0)
    return;
  const sha = await headSha(deps, shadow);
  if (sha !== undefined) await updateRunRef(deps, shadow, ref, sha);
}

/** The committed paths, resolved back to absolute paths under the work tree: a resumed
 * session keeps snapshotting the files it was already tracking. */
export async function seedTouched(
  deps: ShadowDeps,
  shadow: ShadowRepo,
): Promise<Set<string>> {
  const committed = await committedPaths(deps, shadow);
  return new Set(
    [...committed].map((rel) => path.resolve(shadow.workTree, rel)),
  );
}
