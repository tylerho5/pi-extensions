import {
  type ExtensionAPI,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { confirmOnParent, hasParentUi, setParentUi } from "./src/bridge.ts";
import { evaluateBashGate } from "./src/decision.ts";
import {
  type GuardSettings,
  globalSettingsPath,
  loadGuardSettings,
  writeGuardSetting,
} from "./src/settings.ts";
import type { GuardId } from "./src/types.ts";

const GUARD_IDS: readonly GuardId[] = ["git", "pr", "rm"];

const isGuardId = (value: string): value is GuardId =>
  (GUARD_IDS as readonly string[]).includes(value);

const statusLine = (s: GuardSettings) =>
  `guards — git: ${on(s.git)}, pr: ${on(s.pr)}, rm: ${on(s.rm)} (headless fallback: ${s.headlessFallback})`;

const on = (enabled: boolean) => (enabled ? "on" : "off");

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) {
      setParentUi({ confirm: (title, body) => ctx.ui.confirm(title, body) });
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return undefined;
    return evaluateBashGate(
      event.input.command,
      loadGuardSettings(globalSettingsPath()),
      { hasUI: ctx.hasUI, hasParent: hasParentUi() },
      {
        confirmLocal: (title, body) => ctx.ui.confirm(title, body),
        confirmParent: (title, body) => confirmOnParent(title, body),
      },
    );
  });

  pi.registerCommand("guard", {
    description: "Toggle git/pr/rm command guards (on|off|status)",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const path = globalSettingsPath();
      const settings = loadGuardSettings(path);

      if (parts.length === 0 || parts[0] === "status") {
        ctx.ui.notify(statusLine(settings), "info");
        return;
      }

      const [id, action] = parts;
      if (!isGuardId(id)) {
        ctx.ui.notify(`Unknown guard "${id}". Use git, pr, or rm.`, "warning");
        return;
      }
      if (action === undefined || action === "status") {
        ctx.ui.notify(`${id} guard is ${on(settings[id])}`, "info");
        return;
      }
      if (action !== "on" && action !== "off") {
        ctx.ui.notify(`Usage: /guard ${id} on|off|status`, "warning");
        return;
      }

      writeGuardSetting(path, {
        [id]: action === "on",
      } as Partial<GuardSettings>);
      ctx.ui.notify(`${id} guard ${action === "on" ? "ON" : "OFF"}`, "info");
    },
  });
}
