import { test } from "vitest";
import assert from "node:assert/strict";

import { rules } from "./rules.ts";
import runtimeHintsExtension from "./index.ts";

function bashEvent(command, text, isError) {
  return { toolName: "bash", isError, command, text };
}

function matchAll(event) {
  return rules.map((rule) => rule.match(event)).filter((hint) => hint !== undefined);
}

test("rg exit 1 with empty output yields the no-matches hint", () => {
  const hints = matchAll(bashEvent("rg pattern src/", "Command exited with code 1", true));
  assert.equal(hints.length, 1);
  assert.match(hints[0], /^\[hint:rg-grep-exit-1\] /);
});

test("grep after cd prefix exit 1 with empty output yields the no-matches hint", () => {
  const hints = matchAll(
    bashEvent("cd /repo/sub && grep -rh foo .", "Command exited with code 1", true),
  );
  assert.equal(hints.length, 1);
  assert.match(hints[0], /rg-grep-exit-1/);
});

test("rg exit 1 is not a no-match signal when output is present", () => {
  const hints = matchAll(
    bashEvent("rg pattern src/", "src/a.ts:1:pattern\n\nCommand exited with code 1", true),
  );
  assert.equal(hints.length, 0);
});

test("exit code 2 is a real rg failure, not no-matches", () => {
  const hints = matchAll(bashEvent("rg pattern missing/", "Command exited with code 2", true));
  assert.equal(hints.length, 0);
});

test("non-search verb with empty exit 1 gets no hint", () => {
  const hints = matchAll(bashEvent("ls missing-dir", "Command exited with code 1", true));
  assert.equal(hints.length, 0);
});

test("compound pipelines are out of scope for the no-matches hint", () => {
  const hints = matchAll(bashEvent("rg foo | head -5", "Command exited with code 1", true));
  assert.equal(hints.length, 0);
});

test("successful search gets no hint", () => {
  const hints = matchAll(bashEvent("rg pattern src/", "src/a.ts:1:pattern", false));
  assert.equal(hints.length, 0);
});

test("apply_patch INVALID_PATCH yields the envelope hint", () => {
  const text = '{"ok":false,"exitCode":1,"error":{"code":"INVALID_PATCH","message":"..."},"appliedPrefix":[]}';
  const hints = matchAll(bashEvent("apply_patch <<'EOF'", text, true));
  assert.equal(hints.length, 1);
  assert.match(hints[0], /^\[hint:apply-patch-invalid\] /);
  assert.match(hints[0], /patch-authoring\.md/);
});

test("apply_patch PARTIAL_APPLY yields the context-mismatch hint", () => {
  const text = '{"ok":false,"exitCode":1,"error":{"code":"PARTIAL_APPLY","message":"..."},"appliedPrefix":[]}';
  const hints = matchAll(bashEvent("cd /repo && apply_patch <<'EOF'", text, true));
  assert.equal(hints.length, 1);
  assert.match(hints[0], /^\[hint:apply-patch-partial\] /);
});

test("apply_patch failure without a known code gets no hint", () => {
  const text = '{"ok":false,"exitCode":1,"error":{"code":"IO_ERROR","message":"..."},"appliedPrefix":[]}';
  const hints = matchAll(bashEvent("apply_patch <<'EOF'", text, true));
  assert.equal(hints.length, 0);
});

test("cat heredoc write yields the mutation-contract hint", () => {
  const hints = matchAll(bashEvent("cat > src/x.test.ts << 'EOF'", "", false));
  assert.equal(hints.length, 1);
  assert.match(hints[0], /^\[hint:bash-file-mutation\] /);
});

test("sed -i yields the mutation-contract hint", () => {
  const hints = matchAll(bashEvent("sed -i.bak 's/a/b/' file.ts", "", false));
  assert.equal(hints.length, 1);
  assert.match(hints[0], /bash-file-mutation/);
});

test("python heredoc yields the mutation-contract hint", () => {
  const hints = matchAll(bashEvent("python3 - <<'EOF'", "", false));
  assert.equal(hints.length, 1);
  assert.match(hints[0], /bash-file-mutation/);
});

test("git commit heredoc is not a file mutation", () => {
  const hints = matchAll(bashEvent(`git commit -m "$(cat <<'EOF'"`, "", false));
  assert.equal(hints.length, 0);
});

test("perl -pi is a sanctioned mutation path and gets no hint", () => {
  const hints = matchAll(bashEvent("perl -pi -e 's/a/b/' file.ts", "", false));
  assert.equal(hints.length, 0);
});

test("non-bash tools never match", () => {
  const hints = matchAll({ toolName: "edit", isError: true, command: undefined, text: "Command exited with code 1" });
  assert.equal(hints.length, 0);
});

test("every rule carries a transcript evidence reference", () => {
  for (const rule of rules) {
    assert.ok(rule.name.length > 0);
    assert.match(rule.evidence, /\d+/);
  }
});

test("hints fire once per session and reset on session_start", async () => {
  const hooks = new Map();
  runtimeHintsExtension({
    on(event, handler) {
      assert.equal(hooks.has(event), false, `duplicate ${event} hook`);
      hooks.set(event, handler);
    },
  });

  const toolResult = hooks.get("tool_result");
  const sessionStart = hooks.get("session_start");
  const event = {
    toolName: "bash",
    toolCallId: "t1",
    input: { command: "rg pattern src/" },
    content: [{ type: "text", text: "Command exited with code 1" }],
    isError: true,
  };

  const first = await toolResult(event, {});
  assert.ok(first, "first hit should patch the result");
  assert.equal(first.content.length, 2);
  assert.match(first.content[1].text, /rg-grep-exit-1/);

  const second = await toolResult(event, {});
  assert.equal(second, undefined, "same rule must not fire twice in one session");

  await sessionStart({}, {});
  const third = await toolResult(event, {});
  assert.ok(third, "session_start resets the once-per-session guard");
});

test("the patch appends one text block and never touches isError or details", async () => {
  const hooks = new Map();
  runtimeHintsExtension({ on(event, handler) { hooks.set(event, handler); } });
  const toolResult = hooks.get("tool_result");

  const details = { exitCode: 1 };
  const event = {
    toolName: "bash",
    toolCallId: "t1",
    input: { command: "rg pattern src/" },
    content: [{ type: "text", text: "Command exited with code 1" }],
    details,
    isError: true,
  };
  const patch = await toolResult(event, {});
  assert.deepEqual(Object.keys(patch), ["content"]);
  assert.equal(patch.content[0], event.content[0], "original blocks preserved by reference");
});
