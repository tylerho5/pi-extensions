import type { Guard } from "./types.ts";

// An `rm` invocation at a command boundary, optionally via sudo or an absolute
// path (`/bin/rm`). Mirrors the CC script's grep -qE classes.
const RM_INVOCATION = /(^|[\s;&|(])(sudo\s+)?(\/[A-Za-z0-9._/-]*\/)?rm\s/;
// A recursive flag: bundled short (`-rf`, `-fr`, `-Rf`) or long (`--recursive`).
const RECURSIVE_FLAG = /((^|[^-A-Za-z0-9])-[A-Za-z0-9]*[rR]|--recursive)/;

const rmGuard: Guard = {
  id: "rm",
  label: "rm",
  match(command: string): string | null {
    if (RM_INVOCATION.test(command) && RECURSIVE_FLAG.test(command)) {
      return "a recursive delete (rm -r)";
    }
    return null;
  },
};

export default rmGuard;
