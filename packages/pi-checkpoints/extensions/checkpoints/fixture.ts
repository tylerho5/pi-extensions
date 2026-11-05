/**
 * Test-only fixture: a real git repository in a temp directory plus a `ShadowDeps`
 * whose `exec` shells out to the real git. Shared by the checkpoints test files so
 * the subprocess plumbing, the temp-directory teardown, and the fixture layout have
 * one copy. Not a `.test.ts`, so the per-extension test glob never runs it.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import type { ShadowDeps } from "./src/shadow.ts";

export interface Notice {
  message: string;
  level: "info" | "warning";
}

export interface Fixture {
  /** Temporary parent: holds the project, the shadow root, and anything else. */
  root: string;
  /** A git repository, the work tree a shadow snapshots. */
  workTree: string;
  deps: ShadowDeps;
  notices: Notice[];
  /** Write `content` at `relative`, creating parent directories. */
  write: (relative: string, content: string) => void;
  cleanup: () => void;
}

/** Run git for real and report what it did, so a fixture's exec is the real thing. */
export function runGit(args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        const code =
          error !== null &&
          typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error !== null
              ? 1
              : 0;
        resolve({ stdout, stderr, code, killed: false });
      },
    );
  });
}

/** A temp directory holding an initialized git repository at `<root>/project`, and
 * the shadow root a caller can place repositories under at `<root>/shadows`. */
export async function makeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "checkpoints-fixture-"));
  const workTree = join(root, "project");
  mkdirSync(workTree);
  await runGit(["init", "--quiet", workTree], root);
  const notices: Notice[] = [];
  return {
    root,
    workTree,
    notices,
    deps: {
      // The extension only ever shells out to git, so the fixture's exec takes
      // git's argv directly.
      exec: (_command, args, options) => runGit(args, options?.cwd ?? workTree),
      notify: (message, level) => {
        notices.push({ message, level });
      },
    },
    write: (relative, content) => {
      const target = join(workTree, relative);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
