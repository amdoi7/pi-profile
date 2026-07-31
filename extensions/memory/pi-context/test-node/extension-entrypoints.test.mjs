import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const rootIndexPath = path.join(dir, "..", "index.ts");
const packageJsonPath = path.join(dir, "..", "package.json");

test("pi-context has no root entrypoint because memory owns runtime registration", () => {
  assert.equal(fs.existsSync(packageJsonPath), false);
  assert.equal(fs.existsSync(rootIndexPath), false);
});
