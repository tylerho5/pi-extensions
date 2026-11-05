/**
 * The restore plan: one function that answers both "what would a rewind change?" (the
 * menu's gating) and "put it back" (the restore itself), so the two can never disagree
 * about which files a checkpoint covers.
 *
 * Adapted from `extensions/git-checkpoint.ts` in `ilovepixelart/pi-code` at commit
 * `ff3eb5e` (2026-10-05), MIT licensed, copyright 2025 Mario Zechner and 2026
 * ilovepixelart.
 */

import * as path from "node:path";
import {
  checkoutRef,
  firstAddedPaths,
  gitShadow,
  recordedWorkTree,
  type ShadowDeps,
  type ShadowRepo,
} from "./shadow.ts";

export interface RestorePlanEntry {
  /** Work-tree-relative, slash-separated, the form git accepts as a pathspec. */
  path: string;
  /** The blob the restore would write. */
  blobSha: string;
  /** The ref to check that path out from. */
  fromRef: string;
}

/** Every path a ref's tree holds, with the blob each one points at. */
async function blobShasAt(
  deps: ShadowDeps,
  shadow: ShadowRepo,
  treeish: string,
): Promise<Map<string, string>> {
  const listed = await gitShadow(deps, shadow, [
    "ls-tree",
    "-r",
    "-z",
    treeish,
  ]);
  const blobs = new Map<string, string>();
  if (listed.code !== 0) return blobs;
  for (const record of listed.stdout.split("\0")) {
    if (record === "") continue;
    // `<mode> SP <type> SP <object> TAB <file>`; -z keeps the file name raw.
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const object = record.slice(0, tab).split(" ")[2];
    const file = record.slice(tab + 1);
    if (object !== undefined) blobs.set(file, object);
  }
  return blobs;
}

/** Group plan entries by the ref they come from, preserving first-seen order. */
function byRef(plan: readonly RestorePlanEntry[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const entry of plan) {
    groups.set(entry.fromRef, [
      ...(groups.get(entry.fromRef) ?? []),
      entry.path,
    ]);
  }
  return groups;
}

/**
 * The files a rewind to `ref` would write:
 *
 * - every path in the checkpoint's tree, at the content that tree holds, and
 * - every path whose first addition after the checkpoint is a `baseline` commit, at
 *   the baseline content.
 *
 * The second group is why gating cannot look at the checkpoint tree alone. A checkpoint
 * taken before any edit has an empty tree, and a file the session first edited in a
 * later run exists in that later run's checkpoint as its pre-edit baseline. Rewinding
 * to the earlier checkpoint must still put that file back.
 */
export async function planRestore(
  deps: ShadowDeps,
  shadow: ShadowRepo,
  ref: string,
): Promise<RestorePlanEntry[]> {
  const plan: RestorePlanEntry[] = [];
  for (const [file, blobSha] of await blobShasAt(deps, shadow, ref)) {
    plan.push({ path: file, blobSha, fromRef: ref });
  }
  const laterAdditions = new Map<string, string[]>();
  for (const [file, commit] of await firstAddedPaths(deps, shadow, ref)) {
    if (!commit.baseline) continue;
    laterAdditions.set(commit.sha, [
      ...(laterAdditions.get(commit.sha) ?? []),
      file,
    ]);
  }
  for (const [sha, files] of laterAdditions) {
    const blobs = await blobShasAt(deps, shadow, sha);
    for (const file of files) {
      const blobSha = blobs.get(file);
      if (blobSha !== undefined)
        plan.push({ path: file, blobSha, fromRef: sha });
    }
  }
  return plan;
}

/**
 * Whether a restore would change anything: the plan must name files, and at least one
 * of them must be missing on disk or hold different content. Hashed with `hash-object`
 * so no index is touched and the next snapshot is undisturbed.
 */
export async function planHasChanges(
  deps: ShadowDeps,
  shadow: ShadowRepo,
  plan: readonly RestorePlanEntry[],
): Promise<boolean> {
  for (const entry of plan) {
    const live = await gitShadow(deps, shadow, [
      "hash-object",
      "--",
      entry.path,
    ]);
    if (live.code !== 0 || live.stdout.trim() !== entry.blobSha) return true;
  }
  return false;
}

/**
 * Write the plan's files back over the working tree. One sequential `checkout -f` per
 * source ref, because git takes the shadow repository's index lock.
 *
 * Refused, applying nothing, when the shadow's sidecar names another work tree: a
 * record can outlive the directory it was taken in, and writing one tree's contents
 * into an unrelated tree that happens to share file names is the data loss this guards.
 */
export async function applyRestore(
  deps: ShadowDeps,
  shadow: ShadowRepo,
  plan: readonly RestorePlanEntry[],
): Promise<{ applied: number; skipped: number }> {
  if (plan.length === 0) return { applied: 0, skipped: 0 };
  const recorded = recordedWorkTree(shadow.dir);
  if (
    recorded === undefined ||
    path.resolve(recorded) !== path.resolve(shadow.workTree)
  ) {
    return { applied: 0, skipped: 0 };
  }
  let applied = 0;
  let skipped = 0;
  for (const [ref, paths] of byRef(plan)) {
    const result = await checkoutRef(deps, shadow, ref, paths);
    if (result.code === 0) applied += paths.length;
    else skipped += paths.length;
  }
  return { applied, skipped };
}
