import { test } from "vitest";
import assert from "node:assert/strict";

import commandPolicyExtension from "./index.ts";
import { evaluateCommand } from "./policy.ts";
import { getFileMutationBlock } from "./file-mutation.ts";

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

// 语料 2026-08-21..26：580 次 inline 脚本「读回 → 字面替换 → 写回同一文件」，
// 这正是 edit 的活，但走的是没有 diff、没有锁、没有回滚的路径。拦的是这个形状，
// 不是 bash 写文件本身：遍历 glob 的机械改写与 /tmp 草稿仍放行。
test("blocks an inline script that rewrites one repo file by string replacement", () => {
  const command =
    `cd /Users/x/proj && python3 - <<'EOF'\npath = "thinking-splitter.ts"\nsrc = open(path).read()\nold = '''function findWord() {}'''\nsrc = src.replace(old, "function findWord(a) {}")\nopen(path, "w").write(src)\nEOF`;
  const message = getFileMutationBlock(command);
  assert.match(message ?? "", /edit/);
  assert.match(message ?? "", /write/);
});

test("allows the shapes edit cannot express or does not own", () => {
  const globLoop =
    `cd /proj && python3 - <<'PY'\nimport pathlib\nfor p in pathlib.Path("src").rglob("*.py"):\n    s = p.read_text()\n    p.write_text(s.replace("old", "new"))\nPY`;
  const scratch =
    `python3 - <<'PY'\ns = open("/tmp/probe.json").read()\nopen("/tmp/probe.json", "w").write(s.replace("a", "b"))\nPY`;
  const analysisOnly = `python3 - <<'PY'\nprint(open("index.ts").read().count("foo"))\nPY`;
  const heredocWrite = `cat > notes.md <<'EOF'\nhello\nEOF`;

  assert.equal(getFileMutationBlock(globLoop), null);
  assert.equal(getFileMutationBlock(scratch), null);
  assert.equal(getFileMutationBlock(analysisOnly), null);
  assert.equal(getFileMutationBlock(heredocWrite), null);
});

test("the composed policy blocks it through evaluateCommand", () => {
  const command = `python3 -c "s=open('a.ts').read(); open('a.ts','w').write(s.replace('x','y'))"`;
  const decision = evaluateCommand(command);
  assert.equal(decision.kind, "block");
  assert.match(decision.reason, /edit/);
});
