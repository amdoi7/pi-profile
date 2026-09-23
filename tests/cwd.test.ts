import { test } from "node:test";
import assert from "node:assert";
test("probe", () => {
  console.log("CWD_IS:" + process.cwd());
  assert.ok(true);
});
