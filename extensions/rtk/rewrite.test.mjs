import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { computeRewriteDecision } from "./rewrite.ts";

async function withFakeRtk(run) {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-rtk-policy-"));
  const scriptPath = path.join(tempRoot, "rtk");
  let script = "#!/bin/sh\n";
  script += 'if [ "$1" = "rewrite" ]; then\n';
  script += '  case "${2}" in\n';
  script += '    *NO_REWRITE*) exit 1 ;;\n';
  script += '    *DENY*) exit 2 ;;\n';
  script += '    *ASK*) printf "rtk %s\\n" "$2"; exit 3 ;;\n';
  script += '  esac\n';
  script += '  printf "rtk %s\\n" "$2"\n';
  script += '  exit 0\n';
  script += 'fi\nexit 64\n';
  await fs.promises.writeFile(scriptPath, script, { mode: 0o755 });

  const originalPath = process.env.PATH;
  process.env.PATH = `${tempRoot}${path.delimiter}${originalPath ?? ""}`;
  const rewrite = (command) => computeRewriteDecision(command) ?? command;
  try {
    await run(rewrite);
  } finally {
    process.env.PATH = originalPath;
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
}

test("delegates eligible command groups to RTK", async () => {
  await withFakeRtk((rewrite) => {
    for (const command of [
      "ls -la",
      "gh pr list --json number,title",
      "git status --porcelain",
      "curl http://localhost:3000/health",
    ]) {
      assert.equal(rewrite(command), `rtk ${command}`);
    }
    assert.equal(rewrite("git log -10 | grep feat"), "git log -10 | rtk grep feat");
  });
});

test("preserves upstream no-rewrite and deny decisions but accepts ask rewrites", async () => {
  await withFakeRtk((rewrite) => {
    assert.equal(rewrite("NO_REWRITE git status"), "NO_REWRITE git status");
    assert.equal(rewrite("DENY git status"), "DENY git status");
    assert.equal(rewrite("ASK git status"), "rtk ASK git status");
  });
});

test("keeps find compound predicates raw because upstream RTK rejects them", async () => {
  await withFakeRtk((rewrite) => {
    const command = "find . -maxdepth 3 -type f \\( -name 'mypy.ini' -o -name 'pyrightconfig.json' \\) -print";
    assert.equal(rewrite(command), command);
  });
});

test("keeps uv-owned groups raw while rewriting independent groups", async () => {
  await withFakeRtk((rewrite) => {
    assert.equal(rewrite("uv sync && bun test"), "uv sync && rtk bun test");
    assert.equal(rewrite("python -m pytest && cargo test"), "python -m pytest && rtk cargo test");
    assert.equal(rewrite("pip install ruff; cargo test"), "pip install ruff; rtk cargo test");
    assert.equal(rewrite("uv run python app.py | rg error && bun test"), "uv run python app.py | rtk rg error && rtk bun test");
    assert.equal(rewrite("rg error | uv run python filter.py && bun test"), "rg error | uv run python filter.py && rtk bun test");
  });
});

test("preserves shell operators inside quotes and substitutions", async () => {
  await withFakeRtk((rewrite) => {
    assert.equal(rewrite("uv sync && cargo test -- --ignored 'a && b'"), "uv sync && rtk cargo test -- --ignored 'a && b'");
    assert.equal(rewrite("uv sync && cargo test $(printf 'a && b')"), "uv sync && rtk cargo test $(printf 'a && b')");
  });
});

test("leaves commands wholly owned by uv policy unchanged", async () => {
  await withFakeRtk((rewrite) => {
    for (const command of [
      "uv run python scripts/check.py",
      "python -c 'print(42)'",
      "python -m pip install black",
      "python3 -m venv .venv",
      "pip install ruff",
      "poetry add ruff",
    ]) {
      assert.equal(rewrite(command), command);
    }
  });
});
