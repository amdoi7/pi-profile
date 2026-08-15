import { test } from "vitest";
import assert from "node:assert/strict";

import { makeWorkerId, validateRunInput, normalizeTools, buildInitialPrompt, buildWorkerPreamble, cwdFromWorkerSessionFile, workerSessionDir, NAME_RE, ID_RE } from "../src/contract.ts";

const base = {
	name: "hank",
	prompt: "修复 bug",
	model: "opencode-go/deepseek-v4-flash",
	thinking: "low",
};

test("makeWorkerId: 格式 pi-worker-<name>#<12hex>", () => {
	const id = makeWorkerId(base);
	assert.match(id, /^pi-worker-hank#[0-9a-f]{12}$/);
});

test("makeWorkerId: 同合约确定性", () => {
	assert.equal(makeWorkerId(base), makeWorkerId({ ...base }));
});

test("makeWorkerId: 合约字段任一变化 → 新 id", () => {
	const variants = [
		{ ...base, prompt: "修复另一个 bug" },
		{ ...base, name: "rin" },
	];
	const ids = variants.map((v) => makeWorkerId(v));
	assert.equal(new Set(ids).size, ids.length);
	for (const id of ids) assert.notEqual(id, makeWorkerId(base));
});

test("makeWorkerId: model/thinking 变化 → 新 id(升档=新分发)", () => {
	assert.notEqual(makeWorkerId({ ...base, model: "other/model" }), makeWorkerId(base));
	assert.notEqual(makeWorkerId({ ...base, thinking: "high" }), makeWorkerId(base));
});

test("makeWorkerId: 字段顺序无关(canonical)", () => {
	const shuffled = { prompt: base.prompt, name: base.name, thinking: base.thinking, model: base.model };
	assert.equal(makeWorkerId(base), makeWorkerId(shuffled));
});

test("makeWorkerId: 值去空白后 hash", () => {
	assert.equal(makeWorkerId(base), makeWorkerId({ ...base, prompt: "  修复 bug  " }));
});

test("makeWorkerId: tools 进 hash(合约变=新 id);集合语义——顺序/重复/空白无关", () => {
	assert.notEqual(makeWorkerId({ ...base, tools: "read,ls" }), makeWorkerId(base), "tools 是合约字段");
	assert.equal(makeWorkerId({ ...base, tools: "read,ls" }), makeWorkerId({ ...base, tools: "ls,read" }), "顺序无关");
	assert.equal(makeWorkerId({ ...base, tools: "read,ls" }), makeWorkerId({ ...base, tools: " read , ls ,read" }), "去重去空白");
});

test("normalizeTools: 排序去重;未给/全空 → undefined(缺省白名单)", () => {
	assert.equal(normalizeTools("read,ls"), "ls,read");
	assert.equal(normalizeTools(" read , bash ,read"), "bash,read");
	assert.equal(normalizeTools(undefined), undefined);
});

test("validateRunInput: tools 只准在已知集合内收缩;未知工具/空串/空段 fail fast", () => {
	assert.deepEqual(validateRunInput({ ...base, tools: "read,grep,find,ls" }), []);
	assert.deepEqual(validateRunInput({ ...base, tools: "send_message" }), [], "send_message 在合法集");
	const unknown = validateRunInput({ ...base, tools: "read,rm" });
	assert.ok(unknown.some((m) => m.includes("invalid tools") && m.includes('"rm"')), unknown.join());
	assert.ok(validateRunInput({ ...base, tools: "  " }).some((m) => m.includes("invalid tools")));
	assert.ok(validateRunInput({ ...base, tools: "read,,ls" }).some((m) => m.includes("invalid tools")));
});

test("validateRunInput: 合法输入无错误", () => {
	assert.deepEqual(validateRunInput(base), []);
	assert.deepEqual(validateRunInput({ name: "hank", prompt: "x" }), []);
});

test("validateRunInput: name 缺失/非法", () => {
	const missing = validateRunInput({ prompt: "x" });
	assert.ok(missing.some((m) => m.includes("missing name")));

	const invalid = validateRunInput({ name: "bad name!", prompt: "x" });
	assert.ok(invalid.some((m) => m.includes("invalid name") && m.includes("a-zA-Z0-9_-")));

	const tooLong = validateRunInput({ name: "a".repeat(33), prompt: "x" });
	assert.ok(tooLong.some((m) => m.includes("invalid name")));
});

test("validateRunInput: prompt 缺失列缺失项", () => {
	const errors = validateRunInput({ name: "hank" });
	assert.deepEqual(errors, ["missing text"]);
});

test("validateRunInput: thinking 非法列可选档位", () => {
	const errors = validateRunInput({ ...base, thinking: "ultra" });
	assert.ok(errors.some((m) => m.includes("invalid thinking") && m.includes("off|minimal|low|medium|high|xhigh|max")));
});

test("NAME_RE: 合法名", () => {
	for (const n of ["hank", "Hank-2", "rin_3", "a"]) assert.ok(NAME_RE.test(n), n);
	for (const n of ["", "a b", "中文", "a/b", "a".repeat(33), "#x"]) assert.ok(!NAME_RE.test(n), n);
});

test("ID_RE: 仅完整 id 形态(name 不进寻址面,唯一判定以 id 为准)", () => {
	for (const v of ["pi-worker-hank#a1b2c3d4e5f6", "pi-worker-rin_3#00ff00deadbe"]) assert.ok(ID_RE.test(v), v);
	for (const v of [
		"hank",
		"Hank-2",
		"",
		"a b",
		"pi-worker-hank#abc123",
		"pi-worker-hank#abc1234567890",
		"pi-worker-hank#a1b2c3d4e5f6g7",
		"pi-worker-hank#",
		"pi-worker-hank#ABC123def456",
		"pi-worker-#a1b2c3d4e5f6",
		"#a1b2c3d4e5f6",
	]) {
		assert.ok(!ID_RE.test(v), v);
	}
});

test("buildWorkerPreamble: worker 特有交互条款不退化(tripwire)", () => {
	const preamble = buildWorkerPreamble({ name: "hank", id: "pi-worker-hank#abc123" });
	// 条款级断言(非全文快照):身份关系/先回执/四要素/阻塞处理被砍即红灯。
	// AGENTS.md 链与 skills 由 pi 机制加载(与父同),不属于 preamble 职责。
	assert.ok(preamble.includes('worker "hank"'), "identity(declared once)");
	assert.ok(preamble.includes("accepts") && preamble.includes("appends turns") && preamble.includes("retires"), "parent-worker relation");
	assert.ok(preamble.includes("Ack first") && preamble.includes("plan outline"), "ack contract");
	assert.ok(!preamble.includes("四要素"), "四要素 in quality contract (mechanism-loaded), not duplicated");
	assert.ok(preamble.includes("Ask over struggle") && preamble.includes("parent immediately"), "ask clause: unclear contract → ask parent");
	assert.ok(preamble.includes("ends this turn"), "blocking question turn semantics");
	assert.ok(preamble.includes("low-risk default progress"), "repo evidence-decidable uncertainty → proceed");
	assert.ok(preamble.includes("Dubious evidence") && preamble.includes("unclear contract"), "draft/stale/conflicting evidence ≠ default");
	assert.ok(preamble.includes("Report key findings"), "prompt reporting of key findings and blockages");
});

test("buildInitialPrompt: 仅任务节(身份/通信在 preamble 与工具 description,不重复)", () => {
	const prompt = buildInitialPrompt({ ...base, id: "pi-worker-hank#abc123" });
	assert.ok(!prompt.includes('worker "hank"'), "身份在 preamble 声明一次,初始 prompt 不重复");
	assert.ok(prompt.includes("Task\n修复 bug"), "任务节前缀");
	assert.ok(!prompt.includes("send_message"), "通信语义在 send_message 工具 description,不注入 prompt");
	assert.ok(!prompt.includes("通信") && !prompt.includes("同伴"), "无通信节/名册节");
});

test("cwdFromWorkerSessionFile:平铺与 p<pid> 布局同锚反解;非本扩展产物 → undefined", () => {
	assert.equal(cwdFromWorkerSessionFile("/repo/.pi/worker-sessions/p123/x.jsonl"), "/repo");
	assert.equal(cwdFromWorkerSessionFile("/repo/.pi/worker-sessions/x.jsonl"), "/repo");
	assert.equal(cwdFromWorkerSessionFile("/elsewhere/x.jsonl"), undefined);
});

test("workerSessionDir(审计目录内置约定):<cwd>/.pi/worker-sessions", () => {
	assert.equal(workerSessionDir("/repo"), "/repo/.pi/worker-sessions");
});
