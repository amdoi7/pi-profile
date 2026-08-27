import { test } from "vitest";
import assert from "node:assert/strict";

import commandPolicyExtension from "./index.ts";
import { evaluateCommand } from "./policy.ts";

test("evaluates command policies in one explicit pipeline", () => {
  const calls = [];
  const decision = evaluateCommand("python app.py && cargo test", {
    getBlockedMessage(command) {
      calls.push(["deny", command]);
      return null;
    },
    rewriteUv(command) {
      calls.push(["uv", command]);
      return "uv run python app.py && cargo test";
    },
  });

  assert.deepEqual(decision, {
    kind: "rewrite",
    originalCommand: "python app.py && cargo test",
    executedCommand: "uv run python app.py && cargo test",
  });
  assert.deepEqual(calls, [
    ["deny", "python app.py && cargo test"],
    ["uv", "python app.py && cargo test"],
    ["deny", "uv run python app.py && cargo test"],
  ]);
});

test("registers one command hook and applies the composed policy", async () => {
  const hooks = new Map();
  commandPolicyExtension({
    on(event, handler) {
      assert.equal(hooks.has(event), false, `duplicate ${event} hook`);
      hooks.set(event, handler);
    },
  });

  assert.deepEqual([...hooks.keys()], ["tool_call"]);

  const call = {
    toolCallId: "call-1",
    toolName: "bash",
    input: { command: "python -c 'print(42)'" },
  };
  await hooks.get("tool_call")(call, {});
  assert.equal(call.input.command, "uv run python -c 'print(42)'");
});

// 行内脚本改写曾被硬拦（2026-08-26 上线，2026-08-27 删除）。删除理由不是它开火少
// ——那次判断是错的，3 次开火量的是它的年龄——而是它在结构上达不成自己宣称的
// 不变式：同一形状经它自己推荐的 perl -pi 流过 1,363 次，其中 57% 是 edit 完全
// 能表达的单/多文件替换；被它禁掉的 python 形状 1,315 次里 84% 在同一条命令里
// 回读或跑测试。模型是在把「改 + 验」压成一次往返，而 edit 只能改不能验。
// 禁一种语法、同时把等价语法写进推荐清单，守住的是语法而不是可审计性。
test("an inline single-file rewrite is no longer blocked", () => {
  const command = `python3 -c "s=open('a.ts').read(); open('a.ts','w').write(s.replace('x','y'))"`;
  const decision = evaluateCommand(command);

  // uv 仍会把 python3 改写成 uv run（环境事实）——这里要的是「不再被拦」。
	assert.notEqual(decision.kind, "block");
});

// uv 留着：它不是纪律约束，是环境事实——这台机器的 python 由 uv 管，
// 模型从代码里读不出来。
test("uv is still enforced because it encodes an environment fact", () => {
  const decision = evaluateCommand("pip install ruff");

  assert.notEqual(decision.kind, "pass");
});
