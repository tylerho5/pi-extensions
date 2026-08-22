import type { Guard } from "./types.ts";

// `git`, then any number of global flags (`-C path`, `--git-dir=x`, `-c k=v`),
// then the guarded subcommand. Unanchored, matching the CC script's grep -qE.
const subcommand = (name: string) =>
  new RegExp(`git(\\s+-\\S+(\\s+[^-]\\S*)?)*\\s+${name}(\\s|$)`);

const SUBCOMMANDS: ReadonlyArray<readonly [RegExp, string]> = [
  [subcommand("commit"), "committing"],
  [subcommand("push"), "pushing"],
  [subcommand("reset"), "resetting"],
  [subcommand("merge"), "merging"],
];

const gitGuard: Guard = {
  id: "git",
  label: "git",
  match(command: string): string | null {
    for (const [pattern, reason] of SUBCOMMANDS) {
      if (pattern.test(command)) return reason;
    }
    return null;
  },
};

export default gitGuard;
