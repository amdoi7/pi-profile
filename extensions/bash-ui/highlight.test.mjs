import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "vitest";
import { pathToFileURL } from "node:url";

const highlightModuleUrl = pathToFileURL(
	new URL("./highlight.ts", import.meta.url).pathname,
).href;

function tokenizeInIsolatedProcess(command) {
	const source = [
		`import { tokenize } from ${JSON.stringify(highlightModuleUrl)};`,
		`const segments = tokenize(${JSON.stringify(command)});`,
		"process.stdout.write(JSON.stringify(segments));",
	].join("\n");

	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });

		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`tokenize did not terminate for command=${JSON.stringify(command)}`));
		}, 500);

		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			if (code !== 0) {
				reject(new Error(`tokenize subprocess failed code=${code} signal=${signal} stderr=${JSON.stringify(stderr)}`));
				return;
			}
			resolve(JSON.parse(stdout));
		});
	});
}

test("bash highlighting terminates for literal dollar forms", async () => {
	for (const command of ["echo $", "echo $-", "printf '%s' $"]) {
		const segments = await tokenizeInIsolatedProcess(command);
		assert.equal(segments.map((segment) => segment.text).join(""), command);
	}
});

test("tokenize stops at the highlight budget without scanning the tail", async () => {
	const source = [
		`import { tokenize } from ${JSON.stringify(highlightModuleUrl)};`,
		`const segments = tokenize("echo start\\n" + "x".repeat(100000), undefined, 500);`,
		"process.stdout.write(JSON.stringify({ count: segments.length, last: segments.at(-1).text, total: segments.reduce((sum, s) => sum + s.text.length, 0) }));",
	].join("\n");
	const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const result = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code !== 0) return reject(new Error(`tokenize subprocess failed stderr=${JSON.stringify(stderr)}`));
			resolve(JSON.parse(stdout));
		});
	});
	// 预算耗尽：省略 seg 结尾，100KB 尾部未被词法。
	assert.equal(result.last, "…");
	assert.ok(result.total <= 501, `expected bounded total, got ${result.total}`);
	assert.ok(result.count < 1000, `expected bounded segment count, got ${result.count}`);
});
