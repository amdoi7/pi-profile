import type {
  ExtensionAPI,
  ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { collectContextInputs, analyzeContext } from "./context-analyzer.ts";
import { analyzeHistory } from "./history-analyzer.ts";

export async function collectAnalyzedContext(
  ctx: Pick<ExtensionContext, "sessionManager" | "getContextUsage" | "getSystemPrompt">,
  pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
) {
  const inputs = await collectContextInputs(ctx, pi as ExtensionAPI);
  const breakdown = analyzeContext(inputs);
  const history = analyzeHistory(ctx.sessionManager as SessionManager);

  return {
    inputs,
    breakdown,
    history,
  };
}
