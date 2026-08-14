import { test } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { makeWorkerId, validateRunInput, normalizeTools, buildInitialPrompt, buildWorkerPreamble, workerSessionDir, NAME_RE, ID_RE } from "../src/contract.ts";

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
	assert.ok(unknown.some((m) => m.includes("tools 非法") && m.includes('"rm"')), unknown.join());
	assert.ok(validateRunInput({ ...base, tools: "  " }).some((m) => m.includes("tools 非法")));
	assert.ok(validateRunInput({ ...base, tools: "read,,ls" }).some((m) => m.includes("tools 非法")));
});

test("validateRunInput: 合法输入无错误", () => {
	assert.deepEqual(validateRunInput(base), []);
	assert.deepEqual(validateRunInput({ name: "hank", prompt: "x" }), []);
});

test("validateRunInput: name 缺失/非法", () => {
	const missing = validateRunInput({ prompt: "x" });
	assert.ok(missing.some((m) => m.includes("name") && m.includes("缺失")));

	const invalid = validateRunInput({ name: "bad name!", prompt: "x" });
	assert.ok(invalid.some((m) => m.includes("name 非法") && m.includes("a-zA-Z0-9_-")));

	const tooLong = validateRunInput({ name: "a".repeat(33), prompt: "x" });
	assert.ok(tooLong.some((m) => m.includes("name 非法")));
});

test("validateRunInput: prompt 缺失列缺失项", () => {
	const errors = validateRunInput({ name: "hank" });
	assert.deepEqual(errors, ["prompt 缺失"]);
});

test("validateRunInput: thinking 非法列可选档位", () => {
	const errors = validateRunInput({ ...base, thinking: "ultra" });
	assert.ok(errors.some((m) => m.includes("thinking 非法") && m.includes("off|minimal|low|medium|high|xhigh|max")));
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
	assert.ok(preamble.includes("worker「hank」"), "身份(声明一次)");
	assert.ok(preamble.includes("验收") && preamble.includes("追加轮次") && preamble.includes("撤换"), "父-worker 关系");
	assert.ok(preamble.includes("先回执") && preamble.includes("计划概要"), "先回执契约");
	assert.ok(!preamble.includes("四要素"), "四要素在质量契约(机制加载),不重复");
	assert.ok(preamble.includes("提问优先于死磕") && preamble.includes("问父"), "反问条款:合约疑点问父,不独自脑补");
	assert.ok(preamble.includes("阻塞提问后结束本轮等答复"), "阻塞提问的回合语义");
	assert.ok(preamble.includes("低风险默认推进"), "repo 证据可裁决的不确定自己推进");
	assert.ok(preamble.includes("证据存疑") && preamble.includes("视同合约不清"), "草稿/过时/冲突证据不构成默认依据");
	assert.ok(preamble.includes("及时上报"), "关键发现/阻塞及时上报,不攒到最终呈报");
});

test("buildInitialPrompt: 全字段替换 + 机制要点", () => {
	const prompt = buildInitialPrompt({ ...base, id: "pi-worker-hank#abc123" });
	assert.ok(!prompt.includes("worker「hank」"), "身份在 preamble 声明一次,初始 prompt 不重复");
	assert.ok(prompt.includes("修复 bug"));
	assert.ok(prompt.includes("send_message"));
	assert.ok(prompt.includes("回执与常规沟通直接写在回复文本中"), "回执不得走 ask 通道");
	assert.ok(prompt.includes("阻塞提问后结束本轮等答复"), "提问与报告的回合语义区分");
});

test("buildInitialPrompt: 任务 + 通信两节", () => {
	const prompt = buildInitialPrompt({ name: "hank", prompt: "x", id: "i" });
	assert.ok(prompt.includes("任务\nx"));
	assert.ok(prompt.includes("通信"));
});

test("PI_WORKER_COMMS_FILE 整体替换通信节(拟合循环 A/B 钩子,与 preamble 钩子配套)", () => {
	const f = join(tmpdir(), `pi-worker-comms-${process.pid}.txt`);
	writeFileSync(f, "通信\nOLD COMMS\n");
	process.env.PI_WORKER_COMMS_FILE = f;
	try {
		const prompt = buildInitialPrompt({ name: "hank", prompt: "x", id: "i" });
		assert.ok(prompt.includes("OLD COMMS"), "env 文件内容替换缺省通信节");
		assert.ok(!prompt.includes("阻塞提问后结束本轮等答复"), "缺省通信节被整体替换");
	} finally {
		delete process.env.PI_WORKER_COMMS_FILE;
		rmSync(f, { force: true });
	}
});

test("workerSessionDir(父 pid 命名空间:归属编码进目录):带 parentPid → p<pid> 子目录(spawn 用);不带 → 平铺基目录(scan 用)", () => {
	assert.equal(workerSessionDir("/repo"), "/repo/.pi/worker-sessions");
	assert.equal(workerSessionDir("/repo", 4242), "/repo/.pi/worker-sessions/p4242");
});
