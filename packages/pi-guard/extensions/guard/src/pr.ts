import type { Guard } from "./types.ts";

const ghPr = (name: string) =>
  new RegExp(
    `gh(\\s+-\\S+(\\s+[^-]\\S*)?)*\\s+pr(\\s+-\\S+(\\s+[^-]\\S*)?)*\\s+${name}(\\s|$)`,
  );

const CREATE = ghPr("create");
const EDIT = ghPr("edit");
// A body/title flag: --body (also covers --body-file), --title, or short -b/-t/-F.
const BODY_OR_TITLE_FLAG = /(--body|--title|(^|\s)-[btF](\s|$))/;

const prGuard: Guard = {
  id: "pr",
  label: "pr",
  match(command: string): string | null {
    if (CREATE.test(command)) return "creating a PR";
    if (EDIT.test(command) && BODY_OR_TITLE_FLAG.test(command)) {
      return "editing a PR description";
    }
    return null;
  },
};

export default prGuard;
