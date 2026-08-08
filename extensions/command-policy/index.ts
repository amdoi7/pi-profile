import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { evaluateCommand } from "./policy.ts";

const COMMAND_TOOL_NAMES = new Set(["bash", "run_experiment"]);

export default function commandPolicyExtension(pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
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
  });
}
