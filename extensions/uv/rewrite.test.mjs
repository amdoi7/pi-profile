import test from "node:test";
import assert from "node:assert/strict";

import { computeUvRewriteDecision, getBlockedCommandMessage } from "./rewrite.ts";

const rewrite = (command) => computeUvRewriteDecision(command) ?? command;

test("rewrites bare Python interpreters through uv", () => {
  assert.equal(rewrite("python -c 'print(42)'"), "uv run python -c 'print(42)'");
  assert.equal(rewrite("python3 -m pytest"), "uv run python -m pytest");
  assert.equal(rewrite("python3.12 script.py"), "uv run python script.py");
  assert.equal(rewrite("VAR=1 python app.py"), "VAR=1 uv run python app.py");
});

test("preserves Python heredoc stdin", () => {
  const command = "python3 - <<'PY'\nimport os\nprint(os.getcwd())\nPY";
  assert.equal(rewrite(command), "uv run python - <<'PY'\nimport os\nprint(os.getcwd())\nPY");
});

test("keeps explicit interpreters and non-Python commands unchanged", () => {
  for (const command of [
    "uv run python scripts/check.py",
    ".venv/bin/python -c 'print(42)'",
    "/usr/bin/python3 -c 'print(42)'",
    "node - <<'JS'\nconsole.log(42)\nJS",
    "bun test",
  ]) {
    assert.equal(rewrite(command), command);
  }
});

test("rewrites Python segments in mixed top-level chains", () => {
  assert.equal(rewrite("python -m pytest && cargo test"), "uv run python -m pytest && cargo test");
  assert.equal(rewrite("rg error | python3 filter.py"), "rg error | uv run python filter.py");
  assert.equal(
    rewrite("python3 -c 'print(1)' || python3 -c 'print(2)'"),
    "uv run python -c 'print(1)' || uv run python -c 'print(2)'",
  );
});

test("blocks Python package-manager and environment bypasses", () => {
  assert.match(getBlockedCommandMessage("pip install ruff") ?? "", /pip is disabled/);
  assert.match(getBlockedCommandMessage("pip3 install ruff") ?? "", /pip3 is disabled/);
  assert.match(getBlockedCommandMessage("poetry add ruff") ?? "", /poetry is disabled/);
  assert.match(getBlockedCommandMessage("python -m pip install black") ?? "", /python -m pip.*disabled/);
  assert.match(getBlockedCommandMessage("python3 -m venv .venv") ?? "", /python -m venv.*disabled/);
  assert.match(getBlockedCommandMessage("python3 -m py_compile app.py") ?? "", /py_compile.*disabled/);
});

test("detects bypasses after RTK rewrite", () => {
  assert.match(getBlockedCommandMessage("rtk pip install ruff") ?? "", /pip is disabled/);
  assert.match(getBlockedCommandMessage("rtk proxy pip install ruff") ?? "", /pip is disabled/);
  assert.match(getBlockedCommandMessage("rtk python -m pip install black") ?? "", /python -m pip.*disabled/);
});
