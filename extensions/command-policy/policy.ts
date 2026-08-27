import { computeUvRewriteDecision, getBlockedCommandMessage } from "../uv/rewrite.ts";

export type CommandDecision =
  | { kind: "pass"; command: string }
  | { kind: "block"; command: string; reason: string }
  | { kind: "rewrite"; originalCommand: string; executedCommand: string };

type CommandPolicies = {
  getBlockedMessage(command: string): string | null | undefined;
  rewriteUv(command: string): string | null;
};

// 只剩 uv：它编码的是环境事实（这台机器的 python 工具链），模型从代码里读不出来。
// 行内脚本改写的硬拦截已删：见 index.test.mjs 里的理由。
const defaultPolicies: CommandPolicies = {
  getBlockedMessage: (command) => getBlockedCommandMessage(command),
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
