import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const rootIndexPath = path.join(dir, "..", "index.ts");

test("context-ui has a root entrypoint after separation from memory", () => {
  assert.equal(fs.existsSync(rootIndexPath), true);
});
