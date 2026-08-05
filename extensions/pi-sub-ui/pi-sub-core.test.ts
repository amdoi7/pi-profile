import { describe, expect, test } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimRunNotification,
  extractRecentActivity,
  parseListOutput,
  readWorkerStderr,
  readRunOutput,
  reconcileActiveRuns,
  releaseRunNotification,
  scanRunsDir,
  scanRunHistory,
  type ActiveRun,
  type CompletedRun,
  type ListedRun,
} from "./pi-sub-core.ts";

const OWNER = "019fc0d6-53f1-7b5b-b382-2ddee71c0353";
const OTHER_OWNER = "019fc0d6-53f1-7b5b-b382-2ddee71c0354";

function makeRunsDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-sub-ui-test-"));
}

function makeRun(runsDir: string, runId: string, state: string, exitCode = "0", owner = OWNER): string {
	const dir = join(runsDir, runId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "status"), `${state}\t${exitCode}\n`);
	if (owner !== "") writeFileSync(join(dir, "owner-session-id"), `${owner}\n`);
	if (state === "complete") {
		writeFileSync(join(dir, "stdout"), "");
		writeFileSync(join(dir, "stderr"), "");
	}
	return dir;
}

function makeHistoryRun(runsDir: string, runId: string, state: "queued" | "running" | "complete" | "lost", exitCode = "0", owner = OWNER): string {
	const dir = makeRun(runsDir, runId, state, exitCode, owner);
	if (state === "complete") {
		writeFileSync(join(dir, "stdout"), `result of ${runId}\n`);
		writeFileSync(join(dir, "stderr"), "");
	}
	return dir;
}

function collect(runsDir: string, owner = OWNER): CompletedRun[] {
	const runs: CompletedRun[] = [];
	scanRunsDir(runsDir, owner, (run) => runs.push(run));
	runs.sort((a, b) => a.runId.localeCompare(b.runId));
	return runs;
}

function active(runsDir: string, owner = OWNER): ActiveRun[] {
	return scanRunsDir(runsDir, owner, () => {});
}

function writeMetadata(
	runDir: string,
	metadata: { alias: string; taskMode: "read-only" | "mutation"; tools: string; provider?: string; model?: string; thinking?: string; writeScopes?: string[] },
): void {
	writeFileSync(join(runDir, "alias"), `${metadata.alias}\n`);
	writeFileSync(join(runDir, "task-mode"), `${metadata.taskMode}\n`);
	writeFileSync(join(runDir, "tools"), `${metadata.tools}\n`);
	if (metadata.provider) writeFileSync(join(runDir, "provider"), `${metadata.provider}\n`);
	writeFileSync(join(runDir, "model"), `${metadata.model ?? "test-model"}\n`);
	if (metadata.thinking) writeFileSync(join(runDir, "thinking"), `${metadata.thinking}\n`);
	writeFileSync(join(runDir, "project-cwd"), "/workspace/project\n");
	writeFileSync(join(runDir, "write-scopes"), `${(metadata.writeScopes ?? []).join("\n")}${metadata.writeScopes?.length ? "\n" : ""}`);
}

describe("pi-sub UI owner routing", () => {
	test("ignores a missing or empty runs directory", () => {
		expect(collect("/nonexistent/pi-sub-ui-runs")).toEqual([]);
		const runsDir = makeRunsDir();
		try {
			expect(collect(runsDir)).toEqual([]);
		} finally {
			rmSync(runsDir, { recursive: true, force: true });
		}
	});

	test("reports only completed runs owned by the current session", () => {
		const runsDir = makeRunsDir();
		try {
			makeRun(runsDir, "owned.complete", "complete", "7");
			makeRun(runsDir, "owned.running", "running");
			makeRun(runsDir, "other.complete", "complete", "0", OTHER_OWNER);
			makeRun(runsDir, "unowned.complete", "complete", "0", "");

			expect(collect(runsDir)).toEqual([{ runId: "owned.complete", exitCode: "7", stdout: "", stderr: "" }]);
		} finally {
			rmSync(runsDir, { recursive: true, force: true });
		}
	});

	test("returns owner-scoped active runs with orchestration metadata", () => {
		const runsDir = makeRunsDir();
		try {
			const queued = makeRun(runsDir, "review.queued", "queued");
			writeMetadata(queued, { alias: "review", taskMode: "read-only", tools: "read,grep" });
			const running = makeRun(runsDir, "impl.running", "running");
			writeMetadata(running, {
				alias: "impl",
				taskMode: "mutation",
				tools: "read,bash,edit",
				provider: "ciii",
				thinking: "high",
				writeScopes: ["src/auth", "tests/auth"],
			});
			makeRun(runsDir, "other.running", "running", "", OTHER_OWNER);

			expect(active(runsDir)).toEqual([
				{
					runId: "impl.running",
					state: "running",
					alias: "impl",
					taskMode: "mutation",
					tools: "read,bash,edit",
					provider: "ciii",
					model: "test-model",
					thinking: "high",
					projectCwd: "/workspace/project",
					writeScopes: ["src/auth", "tests/auth"],
				},
				{
					runId: "review.queued",
					state: "queued",
					alias: "review",
					taskMode: "read-only",
					tools: "read,grep",
					model: "test-model",
					projectCwd: "/workspace/project",
					writeScopes: [],
				},
			]);
		} finally {
			rmSync(runsDir, { recursive: true, force: true });
		}
	});

	test("includes run metadata in a completion notification", () => {
		const runsDir = makeRunsDir();
		try {
			const runDir = makeRun(runsDir, "impl.complete", "complete", "7");
			writeMetadata(runDir, {
				alias: "impl",
				taskMode: "mutation",
				tools: "read,bash,write",
				model: "test-model",
				writeScopes: ["src"],
			});
			writeFileSync(join(runDir, "stdout"), "implemented auth flow\nall tests passed\n");
			writeFileSync(join(runDir, "stderr"), "provider warning\n");

			expect(collect(runsDir)).toEqual([{
				runId: "impl.complete",
				exitCode: "7",
				alias: "impl",
				taskMode: "mutation",
				tools: "read,bash,write",
				model: "test-model",
				projectCwd: "/workspace/project",
				writeScopes: ["src"],
				stdout: "implemented auth flow\nall tests passed\n",
				stderr: "provider warning\n",
			}]);
		} finally {
			rmSync(runsDir, { recursive: true, force: true });
		}
	});

	test("omits metadata containing terminal control bytes", () => {
		const runsDir = makeRunsDir();
		try {
			const runDir = makeRun(runsDir, "unsafe.running", "running");
			writeMetadata(runDir, { alias: "unsafe", taskMode: "mutation", tools: "read,bash", writeScopes: ["src"] });
			writeFileSync(join(runDir, "model"), "model\u001b[31m\n");
			writeFileSync(join(runDir, "project-cwd"), "/workspace\u001b[31m\n");
			writeFileSync(join(runDir, "write-scopes"), "src\u001b[31m\n");

			expect(active(runsDir)).toEqual([{
				runId: "unsafe.running",
				state: "running",
				alias: "unsafe",
				taskMode: "mutation",
				tools: "read,bash",
			}]);
		} finally {
			rmSync(runsDir, { recursive: true, force: true });
		}
	});

	test("atomically claims a completion across scans and watcher instances", () => {
		const runsDir = makeRunsDir();
		try {
			const runDir = makeRun(runsDir, "task.once", "complete");

			expect(collect(runsDir)).toEqual([{ runId: "task.once", exitCode: "0", stdout: "", stderr: "" }]);
			expect(collect(runsDir)).toEqual([]);
			expect(() => openSync(join(runDir, "notification-claimed"), "wx")).toThrow();
		} finally {
			rmSync(runsDir, { recursive: true, force: true });
		}
	});

	test("releases the claim when delivery fails so a later scan can retry", () => {
		const runsDir = makeRunsDir();
		try {
			makeRun(runsDir, "task.retry", "complete");
			expect(() =>
				scanRunsDir(runsDir, OWNER, () => {
					throw new Error("delivery failed");
				}),
			).toThrow("delivery failed");
			expect(collect(runsDir)).toEqual([{ runId: "task.retry", exitCode: "0", stdout: "", stderr: "" }]);
		} finally {
			rmSync(runsDir, { recursive: true, force: true });
		}
	});

	test("skips a run whose completion was already claimed", () => {
		const runsDir = makeRunsDir();
		try {
			const runDir = makeRun(runsDir, "task.claimed", "complete");
			closeSync(openSync(join(runDir, "notification-claimed"), "wx", 0o600));
			rmSync(join(runDir, "stdout"));
			rmSync(join(runDir, "stderr"));
			expect(collect(runsDir)).toEqual([]);
		} finally {
			rmSync(runsDir, { recursive: true, force: true });
		}
	});

	test("parses the CLI list JSON into typed run snapshots", () => {
		expect(
			parseListOutput(
				'[{"runId":"review.a1","alias":"review","state":"running","exitCode":null,"model":null,"stateAgeSeconds":12},' +
					'{"runId":"impl.b2","alias":"impl","state":"complete","exitCode":7,"model":"m1","stateAgeSeconds":3}]',
			),
		).toEqual([
			{ runId: "review.a1", alias: "review", state: "running", exitCode: null, model: null, stateAgeSeconds: 12 },
			{ runId: "impl.b2", alias: "impl", state: "complete", exitCode: 7, model: "m1", stateAgeSeconds: 3 },
		]);
		expect(parseListOutput("[]")).toEqual([]);
	});

	test("rejects malformed CLI list output with a structured error", () => {
		expect(() => parseListOutput("not json")).toThrow(/pi_sub_list_invalid_json/);
		expect(() => parseListOutput('{"runId":"x"}')).toThrow(/pi_sub_list_invalid_shape/);
		expect(() => parseListOutput('[{"runId":1}]')).toThrow(/pi_sub_list_invalid_entry/);
		expect(() =>
			parseListOutput('[{"runId":"a.b","alias":null,"state":"gone","exitCode":null,"model":null,"stateAgeSeconds":1}]'),
		).toThrow(/pi_sub_list_invalid_entry/);
		expect(() =>
			parseListOutput('[{"runId":"a.b","alias":null,"state":"running","exitCode":null,"model":null,"stateAgeSeconds":"1"}]'),
		).toThrow(/pi_sub_list_invalid_entry/);
		expect(() =>
			parseListOutput('[{"runId":"a.b","alias":null,"state":"lost","exitCode":3,"model":null,"stateAgeSeconds":1}]'),
		).toThrow(/pi_sub_list_invalid_entry/);
	});

	test("reconciles artifact state with authoritative CLI state", () => {
		const artifact: ActiveRun[] = [
			{ runId: "a.1", state: "running" },
			{ runId: "b.1", state: "queued" },
			{ runId: "c.1", state: "running" },
		];
		const listed: ListedRun[] = [
			{ runId: "a.1", alias: "a", state: "running", exitCode: null, model: null, stateAgeSeconds: 42 },
			{ runId: "b.1", alias: "b", state: "lost", exitCode: null, model: null, stateAgeSeconds: 9 },
			{ runId: "c.1", alias: "c", state: "complete", exitCode: 0, model: null, stateAgeSeconds: 1 },
		];
		expect(reconcileActiveRuns(artifact, listed)).toEqual([
			{ runId: "a.1", state: "running", stateAgeSeconds: 42 },
			{ runId: "b.1", state: "lost", stateAgeSeconds: 9 },
		]);
	});

	test("keeps artifact runs the CLI did not list", () => {
		expect(reconcileActiveRuns([{ runId: "a.1", state: "running" }], [])).toEqual([
			{ runId: "a.1", state: "running" },
		]);
	});

	test("claims and releases lost-run notifications like completions", () => {
		const runsDir = makeRunsDir();
		try {
			const runDir = makeRun(runsDir, "task.lost", "running");
			const claimPath = claimRunNotification(runDir);
			expect(claimPath).toBe(join(runDir, "notification-claimed"));
			expect(claimRunNotification(runDir)).toBeUndefined();
			expect(() => releaseRunNotification(claimPath as string, new Error("delivery failed"))).toThrow(
				"delivery failed",
			);
			expect(claimRunNotification(runDir)).toBe(join(runDir, "notification-claimed"));
		} finally {
			rmSync(runsDir, { recursive: true, force: true });
		}
	});

	test("reads worker stderr as optional input for lost runs", () => {
		const runsDir = makeRunsDir();
		try {
			const runDir = makeRun(runsDir, "task.lost", "running");
			expect(readWorkerStderr(runDir)).toBe("");
			writeFileSync(join(runDir, "worker.stderr"), "worker died\n");
			expect(readWorkerStderr(runDir)).toBe("worker died\n");
		} finally {
			rmSync(runsDir, { recursive: true, force: true });
		}
	});

	test("extracts the most recent tool activity from an events stream", () => {
		const runsDir = makeRunsDir();
		try {
			const runDir = makeRun(runsDir, "task.active", "running");
			writeFileSync(
				join(runDir, "events"),
				[
					'{"type":"session","version":3,"id":"x","cwd":"/w"}',
					'{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash","args":{"command":"rg auth.go"}}',
					'{"type":"tool_execution_end","toolCallId":"t1","toolName":"bash","result":"","isError":false}',
					'{"type":"tool_execution_start","toolCallId":"t2","toolName":"grep","args":{}}',
				].join("\n"),
			);
			expect(extractRecentActivity(join(runDir, "events"))).toBe("Tool grep");
		} finally {
			rmSync(runsDir, { recursive: true, force: true });
		}
	});

	test("formats bash activity as a truncated shell command", () => {
		const runsDir = makeRunsDir();
		try {
			const runDir = makeRun(runsDir, "task.bash", "running");
			const longCommand = "rg --no-heading --line-number auth-very-long-pattern src/auth/helpers/auth-provider.ts";
			writeFileSync(
				join(runDir, "events"),
				`{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash","args":{"command":${JSON.stringify(longCommand)}}}\n`,
			);
			const activity = extractRecentActivity(join(runDir, "events"));
			expect(activity?.startsWith("$ rg --no-heading")).toBeTrue();
			expect(activity?.length).toBeLessThanOrEqual(40);
		} finally {
			rmSync(runsDir, { recursive: true, force: true });
		}
	});

	test("returns undefined without tool activity or events file", () => {
		const runsDir = makeRunsDir();
		try {
			expect(extractRecentActivity(join(runsDir, "missing", "events"))).toBeUndefined();
			const runDir = makeRun(runsDir, "task.quiet", "running");
			writeFileSync(join(runDir, "events"), '{"type":"agent_start"}\n{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"stop"}}\n');
			expect(extractRecentActivity(join(runDir, "events"))).toBeUndefined();
			const unsafeDir = makeRun(runsDir, "task.unsafe", "running");
			writeFileSync(
				join(unsafeDir, "events"),
				'{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash","args":{"command":"\u001b[31mred"}}\n',
			);
			expect(extractRecentActivity(join(unsafeDir, "events"))).toBeUndefined();
		} finally {
			rmSync(runsDir, { recursive: true, force: true });
		}
	});

	test("scans run history with states, exit codes, and output", () => {
		const runsDir = makeRunsDir();
		try {
			const done = makeHistoryRun(runsDir, "review.done", "complete", "0");
			writeMetadata(done, { alias: "review", taskMode: "read-only", tools: "read,grep", provider: "ciii", model: "deepseek-v4-flash", thinking: "high" });
			const failed = makeHistoryRun(runsDir, "impl.failed", "complete", "7");
			writeMetadata(failed, { alias: "impl", taskMode: "mutation", tools: "read,bash,edit,write", writeScopes: ["src"] });
			const cancelled = makeHistoryRun(runsDir, "audit.cx", "complete", "130");
			writeMetadata(cancelled, { alias: "audit", taskMode: "read-only", tools: "read" });
			const running = makeHistoryRun(runsDir, "busy.run", "running", "");
			writeMetadata(running, { alias: "busy", taskMode: "mutation", tools: "read,bash,edit,write" });
			const other = makeHistoryRun(runsDir, "other.owner", "complete", "0", OTHER_OWNER);
			writeMetadata(other, { alias: "other", taskMode: "read-only", tools: "read" });

			const history = scanRunHistory(runsDir, OWNER);
			expect(history).toHaveLength(4);
			const byId = new Map(history.map((run) => [run.runId, run]));
			expect(byId.get("review.done")?.state).toBe("complete");
			expect(byId.get("review.done")?.exitCode).toBe("0");
			expect(byId.get("review.done")?.alias).toBe("review");
			expect(byId.get("review.done")?.model).toBe("deepseek-v4-flash");
			expect(byId.get("review.done")?.provider).toBe("ciii");
			expect(byId.get("review.done")?.thinking).toBe("high");
			expect(byId.get("impl.failed")?.exitCode).toBe("7");
			expect(byId.get("impl.failed")?.writeScopes).toEqual(["src"]);
			expect(byId.get("audit.cx")?.exitCode).toBe("130");
			expect(byId.get("busy.run")?.state).toBe("running");
			expect(byId.get("busy.run")?.exitCode).toBeNull();
			expect(byId.has("other.owner")).toBeFalse();
			// Newest run first.
			const times = history.map((run) => run.startedAtMs);
			expect(times).toEqual([...times].sort((a, b) => b - a));

			// Output is loaded lazily per run.
			expect(readRunOutput(runsDir, "review.done").stdout).toBe("result of review.done\n");
			expect(readRunOutput(runsDir, "review.done").stderr).toBe("");
			expect(readRunOutput(runsDir, "missing.run")).toEqual({ stdout: "", stderr: "" });
		} finally {
			rmSync(runsDir, { recursive: true, force: true });
		}
	});

	test("scanRunHistory ignores runs without a valid status", () => {
		const runsDir = makeRunsDir();
		try {
			const dir = makeRun(runsDir, "ghost.no-status", "running");
			writeFileSync(join(dir, "status"), "\n");
			const history = scanRunHistory(runsDir, OWNER);
			expect(history).toEqual([]);
		} finally {
			rmSync(runsDir, { recursive: true, force: true });
		}
	});
});
