import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerCommand as gateCommand } from "../../_shared/mode-gate.ts";
import { collectAnalyzedContext } from "./context-state.ts";
import { renderContextOverlay } from "./context-renderer.ts";

export function registerContextCommands(pi: ExtensionAPI): void {
  gateCommand(pi, "context", {
    description: "Show context usage",
    modes: ["tui"],
    handler: async (_args, ctx: ExtensionCommandContext) => {
      try {
        const { breakdown, history } = await collectAnalyzedContext(ctx, pi);

        if (
          breakdown.measuredTotal === null &&
          breakdown.estimatedTotal === 0
        ) {
          ctx.ui.notify("No context data available.", "warning");
          return;
        }

        await renderContextOverlay(breakdown, history, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Error: ${message}`, "error");
      }
    },
  });
}
