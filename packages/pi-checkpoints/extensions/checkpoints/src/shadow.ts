/**
 * The shadow repository engine: a bare git repository per session that snapshots
 * the files a session's edit tools touched, with the project's own git state left
 * untouched.
 *
 * Adapted from `extensions/git-checkpoint.ts` and `extensions/internal/*.ts` in
 * `ilovepixelart/pi-code` at commit `ff3eb5e` (2026-10-05), MIT licensed, copyright
 * 2025 Mario Zechner and 2026 ilovepixelart. The comments that explain a real git
 * edge case are kept from that source.
 *
 * Every call goes through `git -c core.autocrlf=false --git-dir <shadow> --work-tree
 * <tree>`, so a snapshot layer stays byte-faithful (the Windows default would rewrite
 * every restored file's line endings) and the user's repository is never written to.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExecResult } from "@earendil-works/pi-coding-agent";

/** Sidecar inside the bare shadow repository recording the work tree it snapshots. */
export const CWD_SIDECAR = "pi-work-tree";

/** Checkpoints live under this ref namespace, never as raw shas. */
export const CHECKPOINT_REF_PREFIX = "refs/checkpoints";

/** Marks a commit header in the added-files log, which no file name can contain. */
const COMMIT_MARK = "\x01";

/** `git log` arguments listing, oldest first, the files each commit added: with -z
 * the names arrive raw and NUL-terminated rather than C-quoted ("caf\303\251.md"),
 * which no checkout could name. */
const ADDED_FILES_LOG = [
  "log",
  "-z",
  "--reverse",
  "--diff-filter=A",
  "--name-only",
  `--format=${COMMIT_MARK}%H %s`,
];

export interface ShadowRepo {
  /** The bare repository. */
  dir: string;
  /** The work tree it snapshots. */
  workTree: string;
}

export interface ShadowDeps {
  exec: (
    command: string,
    args: string[],
    options?: { cwd?: string },
  ) => Promise<ExecResult>;
  notify: (message: string, level: "info" | "warning") => void;
}

/** The work tree a shadow repository was created against, or undefined for a
 * repository that predates the sidecar or does not exist yet. */
export function recordedWorkTree(shadowDir: string): string | undefined {
  try {
    return (
      fs.readFileSync(path.join(shadowDir, CWD_SIDECAR), "utf8").trim() ||
      undefined
    );
  } catch {
    return undefined;
  }
}

export function rememberWorkTree(shadowDir: string, workTree: string): void {
  try {
    fs.writeFileSync(path.join(shadowDir, CWD_SIDECAR), `${workTree}\n`);
  } catch {
    // best effort: without the marker the next resume cannot detect a move
  }
}

/** A stable per-directory key, so a session resumed elsewhere gets its own shadow. */
export function cwdSlug(cwd: string): string {
  const resolved = path.resolve(cwd);
  const basename = path.basename(resolved).replace(/[^\w]+/g, "_");
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  return `${basename}-${hash}`;
}

/**
 * The shadow repository for a session and a work tree. The plain
 * `<root>/<sessionId>` is reused while it records the same tree, or while it is new.
 * A resumed session that arrives in a different directory gets `<sessionId>-<slug>`
 * instead, because restoring a tree's commits into another tree would silently
 * overwrite unrelated same-named files; resuming back in the recorded directory takes
 * the original repository and its checkpoints again.
 */
export function shadowDirFor(
  root: string,
  sessionId: string,
  workTree: string,
): ShadowRepo {
  const plain = path.join(root, sessionId);
  const recorded = recordedWorkTree(plain);
  if (
    recorded === undefined ||
    path.resolve(recorded) === path.resolve(workTree)
  ) {
    return { dir: plain, workTree };
  }
  return {
    dir: path.join(root, `${sessionId}-${cwdSlug(workTree)}`),
    workTree,
  };
}

/** A fresh ref name in this shadow. Publishing a ref rather than a raw sha lets a
 * baseline captured later in the run move the checkpoint forward without rewriting a
 * commit an earlier checkpoint may also point at. */
export function runRefFor(shadow: ShadowRepo, seq: number): string {
  const slug = path.basename(shadow.dir).replace(/[^\w.-]+/g, "_");
  return `${CHECKPOINT_REF_PREFIX}/${slug}-${Date.now().toString(36)}-${seq}`;
}

/** Run git against the shadow with the pinned configuration. */
export function gitShadow(
  deps: ShadowDeps,
  shadow: ShadowRepo,
  args: string[],
): Promise<ExecResult> {
  return deps.exec(
    "git",
    [
      "-c",
      "core.autocrlf=false",
      "--git-dir",
      shadow.dir,
      "--work-tree",
      shadow.workTree,
      ...args,
    ],
    { cwd: shadow.workTree },
  );
}

/** Commit in the shadow, isolated from the user's global signing and hook config. The
 * pinned flags live here so no caller can commit with the user's config by accident. */
export function commitShadow(
  deps: ShadowDeps,
  shadow: ShadowRepo,
  extra: string[],
  message: string,
): Promise<ExecResult> {
  return gitShadow(deps, shadow, [
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    ...extra,
    "-m",
    message,
  ]);
}

/**
 * Make sure the shadow repository exists. False when `git init` failed, after
 * reporting "Checkpoints disabled": every later snapshot would fail against the
 * missing repository, and the user would otherwise learn `/rewind` is dead at the
 * moment they need it.
 */
export async function ensureShadow(
  deps: ShadowDeps,
  shadow: ShadowRepo,
): Promise<boolean> {
  const check = await gitShadow(deps, shadow, ["rev-parse", "--git-dir"]);
  if (check.code !== 0) {
    const init = await deps.exec(
      "git",
      ["init", "--bare", "-b", "main", shadow.dir],
      { cwd: shadow.workTree },
    );
    if (init.code !== 0) {
      deps.notify(
        `Checkpoints disabled: ${init.stderr.trim() || "git init failed"}`,
        "warning",
      );
      return false;
    }
    await deps.exec(
      "git",
      ["--git-dir", shadow.dir, "config", "user.email", "checkpoint@pi"],
      { cwd: shadow.workTree },
    );
    await deps.exec(
      "git",
      ["--git-dir", shadow.dir, "config", "user.name", "pi-checkpoint"],
      { cwd: shadow.workTree },
    );
  }
  // Written on every start, so repositories that predate the sidecar pick it up too.
  rememberWorkTree(shadow.dir, shadow.workTree);
  return true;
}

/**
 * git reads ignore rules from the work tree's `.gitignore` files, the user's global
 * excludes, and `$GIT_DIR/info/exclude`. The shadow is the `GIT_DIR` here, so the
 * repository's own `.git/info/exclude` (where secrets and scratch files that must
 * never be committed live) would otherwise be snapshotted and restored. Mirror it
 * into the shadow; the global excludes stay untouched, because `core.excludesFile`
 * is single-valued and repointing it would drop the user's global rules.
 */
export async function mirrorLocalExcludes(
  deps: ShadowDeps,
  shadow: ShadowRepo,
  cwd: string,
): Promise<void> {
  // Resolved through git so a linked worktree maps to its common dir; outside a
  // repository git exits 128 and there is nothing to mirror.
  const located = await deps.exec(
    "git",
    ["rev-parse", "--git-path", "info/exclude"],
    { cwd },
  );
  const target = path.join(shadow.dir, "info", "exclude");
  try {
    const source =
      located.code === 0 ? path.resolve(cwd, located.stdout.trim()) : undefined;
    if (source !== undefined && fs.existsSync(source)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    } else {
      fs.rmSync(target, { force: true });
    }
  } catch (error) {
    // Without the mirror, files the user excluded locally are snapshotted into the
    // checkpoint store and restored by /rewind, so this is not a silent fallback.
    deps.notify(
      `Checkpoints cannot honor this repository's .git/info/exclude: ${errorText(error)}`,
      "warning",
    );
  }
}

/** The message of a thrown value, whatever was thrown. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A tracked file as git names it: a work-tree-relative slash-separated path, or
 * undefined for anything outside the work tree, which git refuses as a pathspec.
 * Paths are compared in this form throughout, never as absolutes: git echoes a
 * pathspec back verbatim, while one file can spell its absolute path two ways. */
export function workTreePath(
  workTree: string,
  file: string,
): string | undefined {
  const rel = path.relative(workTree, file);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel))
    return undefined;
  return rel.split(path.sep).join("/");
}

/**
 * A pathspec that names exactly one file. Git pathspecs glob by default, so a tracked
 * file called `note[1].txt` also matches `note1.txt`: `git add` would stage the sibling
 * and `git checkout` would overwrite it, which is data loss on a file the session never
 * touched. `:(literal)` turns the globbing off for that one argument.
 *
 * `check-ignore` is the one path-taking command this cannot be applied to. It rejects
 * pathspec magic outright and treats its arguments as plain pathnames already.
 */
function literal(rel: string): string {
  return `:(literal)${rel}`;
}

/** The paths a ref's tree holds. -z because git otherwise quotes and octal-escapes a
 * non-ASCII name, and the quoted form is a pathspec that matches nothing. */
export async function treePaths(
  deps: ShadowDeps,
  shadow: ShadowRepo,
  ref: string,
): Promise<Set<string>> {
  const listed = await gitShadow(deps, shadow, [
    "ls-tree",
    "-r",
    "--name-only",
    "-z",
    ref,
  ]);
  if (listed.code !== 0) return new Set();
  return new Set(listed.stdout.split("\0").filter(Boolean));
}

/** The paths the last checkpoint commit holds. A tracked file deleted since then
 * still matches a pathspec through this, so its removal is staged instead of the
 * stale index entry silently riding along into the next checkpoint. */
export function committedPaths(
  deps: ShadowDeps,
  shadow: ShadowRepo,
): Promise<Set<string>> {
  return treePaths(deps, shadow, "HEAD");
}

/** Drop the paths git would refuse as one pathspec: it rejects the whole add when a
 * single entry is ignored, which would cost the run its checkpoint. */
export async function withoutIgnored(
  deps: ShadowDeps,
  shadow: ShadowRepo,
  paths: readonly string[],
): Promise<string[]> {
  if (paths.length === 0) return [];
  const checked = await gitShadow(deps, shadow, [
    "-c",
    "core.quotePath=false",
    "check-ignore",
    "--",
    ...paths,
  ]);
  if (checked.code !== 0) return [...paths];
  const ignored = new Set(checked.stdout.split("\n").filter(Boolean));
  return paths.filter((file) => !ignored.has(file));
}

/** The tracked files git will accept: inside the work tree, and either on disk or in
 * the last commit. A pathspec matching neither aborts the whole add, taking the
 * checkpoint with it. */
export async function addablePaths(
  deps: ShadowDeps,
  shadow: ShadowRepo,
  touched: Iterable<string>,
): Promise<string[]> {
  const inside: Array<{ file: string; rel: string }> = [];
  for (const file of touched) {
    const rel = workTreePath(shadow.workTree, file);
    if (rel !== undefined) inside.push({ file, rel });
  }
  if (inside.length === 0) return [];
  const committed = await committedPaths(deps, shadow);
  const live = inside
    .filter(({ file, rel }) => fs.existsSync(file) || committed.has(rel))
    .map(({ rel }) => rel);
  return live.length === 0 ? [] : withoutIgnored(deps, shadow, live);
}

/** Write a path to the index directly. `git add` exits zero on a path under another
 * repository (a workspace of clones, a submodule, `$HOME`) and stages nothing, so the
 * edit was never snapshotted while /rewind still reported success. `checkout` restores
 * a hand-written index entry like any other. A deletion needs nothing: `git add` does
 * stage the removal of an entry the index already holds. */
async function indexDirectly(
  deps: ShadowDeps,
  shadow: ShadowRepo,
  rel: string,
): Promise<void> {
  const blob = await gitShadow(deps, shadow, ["hash-object", "-w", "--", rel]);
  if (blob.code !== 0) return;
  const executable =
    (fs.statSync(path.join(shadow.workTree, rel)).mode & 0o111) !== 0;
  await gitShadow(deps, shadow, [
    "update-index",
    "--add",
    "--cacheinfo",
    `${executable ? "100755" : "100644"},${blob.stdout.trim()},${rel}`,
  ]);
}

async function stageSkippedPaths(
  deps: ShadowDeps,
  shadow: ShadowRepo,
  paths: readonly string[],
): Promise<void> {
  const listed = await gitShadow(deps, shadow, [
    "ls-files",
    "-z",
    "--",
    ...paths.map(literal),
  ]);
  if (listed.code !== 0) return;
  const indexed = new Set(listed.stdout.split("\0").filter(Boolean));
  for (const rel of paths) {
    if (!indexed.has(rel) && fs.existsSync(path.join(shadow.workTree, rel))) {
      await indexDirectly(deps, shadow, rel);
    }
  }
}

/**
 * Stage the given paths. git fails the whole add when one pathspec is refused, so on
 * a failure each path is added alone and any path git still refuses is reported
 * through `onRefused`, which lets the caller drop it from the tracked set: one bad
 * path then costs its own checkpoint and nobody else's. False only when nothing at
 * all could be staged.
 *
 * A per-path retry that exits zero can still have staged nothing, exactly as a batch add
 * can: that is what a path under another repository does. `stageSkippedPaths` runs after
 * the per-path retries for the same reason it runs after a batch add.
 */
export async function addPaths(
  deps: ShadowDeps,
  shadow: ShadowRepo,
  paths: readonly string[],
  onRefused?: (rel: string) => void,
): Promise<boolean> {
  if (paths.length === 0) return false;
  if (
    (await gitShadow(deps, shadow, ["add", "--", ...paths.map(literal)]))
      .code === 0
  ) {
    await stageSkippedPaths(deps, shadow, paths);
    return true;
  }
  const retried: string[] = [];
  for (const rel of paths) {
    if (
      (await gitShadow(deps, shadow, ["add", "--", literal(rel)])).code === 0
    ) {
      retried.push(rel);
    } else {
      onRefused?.(rel);
    }
  }
  if (retried.length > 0) await stageSkippedPaths(deps, shadow, retried);
  return retried.length > 0;
}

export async function headSha(
  deps: ShadowDeps,
  shadow: ShadowRepo,
): Promise<string | undefined> {
  const head = await gitShadow(deps, shadow, ["rev-parse", "HEAD"]);
  return head.code === 0 ? head.stdout.trim() : undefined;
}

export async function updateRunRef(
  deps: ShadowDeps,
  shadow: ShadowRepo,
  ref: string,
  sha: string,
): Promise<void> {
  await gitShadow(deps, shadow, ["update-ref", ref, sha]);
}

export async function refExists(
  deps: ShadowDeps,
  shadow: ShadowRepo,
  ref: string,
): Promise<boolean> {
  const check = await gitShadow(deps, shadow, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]);
  return check.code === 0;
}

/** A module-local sequence so two snapshots in one process never mint the same ref. */
let refSeq = 0;

/** Publish a commit under a fresh ref. Falls back to the raw sha when the ref could
 * not be written, so the checkpoint is still recorded even then. */
async function publishRun(
  deps: ShadowDeps,
  shadow: ShadowRepo,
  sha: string,
  createdAt: string,
): Promise<{ ref: string; createdAt: string }> {
  const ref = runRefFor(shadow, ++refSeq);
  const update = await gitShadow(deps, shadow, ["update-ref", ref, sha]);
  return update.code === 0 ? { ref, createdAt } : { ref: sha, createdAt };
}

/**
 * Snapshot the given paths and publish the result.
 *
 * "Nothing changed" is decided from `git status --porcelain --untracked-files=no`,
 * not from the commit exit code: a commit can also fail on the user's global signing
 * or hook config, and reusing `HEAD` then would record a ref that predates the tree.
 * Untracked files are excluded because the work tree is full of files this session
 * never edited; counting them would make every run look changed. A genuine commit
 * failure returns undefined rather than a stale ref.
 */
export async function snapshotShadow(
  deps: ShadowDeps,
  shadow: ShadowRepo,
  paths: readonly string[],
): Promise<{ ref: string; createdAt: string } | undefined> {
  const createdAt = new Date().toISOString();
  if (paths.length > 0 && !(await addPaths(deps, shadow, paths)))
    return undefined;
  const status = await gitShadow(deps, shadow, [
    "status",
    "--porcelain",
    "--untracked-files=no",
  ]);
  const nothingChanged = status.code === 0 && status.stdout.trim() === "";
  if (nothingChanged) {
    const head = await headSha(deps, shadow);
    if (head !== undefined) return publishRun(deps, shadow, head, createdAt);
    // A repository with no commits still needs one to publish a tree at all.
    const empty = await commitShadow(
      deps,
      shadow,
      ["--allow-empty"],
      "checkpoint",
    );
    if (empty.code !== 0) return undefined;
  } else if ((await commitShadow(deps, shadow, [], "checkpoint")).code !== 0) {
    return undefined;
  }
  const sha = await headSha(deps, shadow);
  return sha === undefined
    ? undefined
    : publishRun(deps, shadow, sha, createdAt);
}

/** For each file first added after `ref`, the commit that added it and whether that
 * commit is a baseline, skipping files `ref`'s tree already holds. */
export async function firstAddedPaths(
  deps: ShadowDeps,
  shadow: ShadowRepo,
  ref: string,
): Promise<Map<string, { sha: string; baseline: boolean }>> {
  const atRef = await treePaths(deps, shadow, ref);
  const added = await gitShadow(deps, shadow, [
    ...ADDED_FILES_LOG,
    `${ref}..HEAD`,
  ]);
  if (added.code !== 0) return new Map();
  return firstAdditions(added.stdout, atRef);
}

/** The message of a commit that records a file's content before its first edit. */
export const BASELINE_MESSAGE = "baseline";

/** For each file the added-files log names, the first commit that added it. */
function firstAdditions(
  log: string,
  skip: ReadonlySet<string>,
): Map<string, { sha: string; baseline: boolean }> {
  const first = new Map<string, { sha: string; baseline: boolean }>();
  let commit: { sha: string; baseline: boolean } | undefined;
  for (const raw of log.split("\0")) {
    // git separates a commit's header from its names with a newline.
    const token = raw.startsWith("\n") ? raw.slice(1) : raw;
    if (token.startsWith(COMMIT_MARK)) {
      const header = token.slice(1);
      const space = header.indexOf(" ");
      commit =
        space === -1
          ? undefined
          : {
              sha: header.slice(0, space),
              baseline: header.slice(space + 1) === BASELINE_MESSAGE,
            };
    } else if (
      commit !== undefined &&
      token !== "" &&
      !skip.has(token) &&
      !first.has(token)
    ) {
      first.set(token, commit);
    }
  }
  return first;
}

/** Check out `paths` (the whole tree by default) from `ref` over the work tree. */
export function checkoutRef(
  deps: ShadowDeps,
  shadow: ShadowRepo,
  ref: string,
  paths: readonly string[] = ["."],
): Promise<ExecResult> {
  return gitShadow(deps, shadow, [
    "checkout",
    "-f",
    ref,
    "--",
    ...paths.map(literal),
  ]);
}

/**
 * Bring a parent shadow's checkpoint refs across. `/fork` writes a new session file and
 * copies the branch's checkpoint entries into it, while the shadow repository is keyed to
 * the session: a restore from the fork's own would answer "invalid reference". Best
 * effort, because a parent shadow already pruned leaves those checkpoints unrestorable,
 * as they were.
 */
export async function inheritRefs(
  deps: ShadowDeps,
  shadow: ShadowRepo,
  parentShadowDir: string,
): Promise<void> {
  if (path.resolve(parentShadowDir) === path.resolve(shadow.dir)) return;
  if (!fs.existsSync(parentShadowDir)) return;
  await gitShadow(deps, shadow, [
    "fetch",
    "--quiet",
    parentShadowDir,
    `+${CHECKPOINT_REF_PREFIX}/*:${CHECKPOINT_REF_PREFIX}/*`,
  ]);
}

/**
 * Keep the shadow root out of any repository that happens to contain it. The store holds
 * a copy of every file a session edited, dotfiles and `.env` files included, so a broad
 * `git add` in a checkout that contains the store would commit them. A `*` ignore inside
 * the store defends itself in every install, which an enclosing repository's own
 * `.gitignore` cannot do. An existing file is left alone. Best effort.
 */
export function markShadowRootUntracked(root: string): void {
  try {
    fs.mkdirSync(root, { recursive: true });
    const marker = path.join(root, ".gitignore");
    if (!fs.existsSync(marker)) fs.writeFileSync(marker, "*\n");
  } catch {
    // best effort: housekeeping must not stop a session from starting
  }
}

/** Remove shadow repositories untouched for longer than the retention window. The
 * live session's repository is always kept, whatever its age: a long session's
 * directory mtime can predate the window. Failures are ignored; this is housekeeping,
 * not a gate. */
export function pruneShadowRepos(
  root: string,
  retentionDays: number,
  keepDir?: string,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (keepDir !== undefined && path.resolve(dir) === path.resolve(keepDir))
      continue;
    try {
      if (fs.statSync(dir).mtimeMs >= cutoff) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // a repository we cannot stat or remove stays; housekeeping must not break startup
    }
  }
}
