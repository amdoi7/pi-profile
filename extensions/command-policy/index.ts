import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { summarizeCommandRewrite } from "../_shared/code-preview.ts";
import { evaluateCommand } from "./policy.ts";

const STATUS_ID = "command-policy";
const COMMAND_TOOL_NAMES = new Set(["bash", "run_experiment"]);

export default function commandPolicyExtension(pi: ExtensionAPI) {
  pi.on("tool_call", (event, ctx) => {
    if (!COMMAND_TOOL_NAMES.has(event.toolName)) return;

    const input = event.input as { command?: unknown };
    if (typeof input.command !== "string") {
      throw new Error(`Expected ${event.toolName}.command to be a string for command policy`);
    }

    const decision = evaluateCommand(input.command);
    if (decision.kind === "block") {
      return { block: true, reason: decision.reason };
    }
    if (decision.kind === "pass") return;

    input.command = decision.executedCommand;
    if (ctx.hasUI) {
      ctx.ui.setStatus(
        STATUS_ID,
        summarizeCommandRewrite(decision.originalCommand, decision.executedCommand),
      );
    }
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (COMMAND_TOOL_NAMES.has(event.toolName) && ctx.hasUI) {
      ctx.ui.setStatus(STATUS_ID, undefined);
    }
  });
}
