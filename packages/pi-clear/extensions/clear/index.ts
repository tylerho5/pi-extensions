import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("clear", {
    description: "Start a new session (alias for /new)",
    handler: async (_args, ctx) => {
      await ctx.newSession({
        withSession: async (newCtx) => {
          newCtx.ui.notify("✓ New session started", "info");
        },
      });
    },
  });
}
