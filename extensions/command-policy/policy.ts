import { computeUvRewriteDecision, getBlockedCommandMessage } from "../uv/rewrite.ts";
import { getFileMutationBlock } from "./file-mutation.ts";

export type CommandDecision =
  | { kind: "pass"; command: string }
  | { kind: "block"; command: string; reason: string }
  | { kind: "rewrite"; originalCommand: string; executedCommand: string };

type CommandPolicies = {
  getBlockedMessage(command: string): string | null | undefined;
  rewriteUv(command: string): string | null;
};

// 两个拦截源共用一个入口：uv 管 python 打包工具链，file-mutation 管变更路径。
const defaultPolicies: CommandPolicies = {
  getBlockedMessage: (command) => getBlockedCommandMessage(command) ?? getFileMutationBlock(command),
  rewriteUv: computeUvRewriteDecision,
};

export function evaluateCommand(
  originalCommand: string,
  policies: CommandPolicies = defaultPolicies,
): CommandDecision {
  const initialBlock = policies.getBlockedMessage(originalCommand);
  if (initialBlock) {
    return { kind: "block", command: originalCommand, reason: initialBlock };
  }

  const executedCommand = policies.rewriteUv(originalCommand) ?? originalCommand;
  const finalBlock = policies.getBlockedMessage(executedCommand);
  if (finalBlock) {
    return { kind: "block", command: executedCommand, reason: finalBlock };
  }
  if (executedCommand === originalCommand) {
    return { kind: "pass", command: originalCommand };
  }
  return { kind: "rewrite", originalCommand, executedCommand };
}
