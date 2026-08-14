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

  assert.deepEqual(calls, [
    ["deny", "python app.py && cargo test"],
    ["uv", "python app.py && cargo test"],
    ["deny", "uv run python app.py && cargo test"],
  ]);
  assert.deepEqual(decision, {
    kind: "rewrite",
    originalCommand: "python app.py && cargo test",
    executedCommand: "uv run python app.py && cargo test",
  });
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
