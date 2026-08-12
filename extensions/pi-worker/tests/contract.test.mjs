import { test } from "vitest";
import assert from "node:assert/strict";

import { makeWorkerId, validateRunInput, buildInitialPrompt, buildWorkerCharter, NAME_RE } from "../src/contract.ts";

const base = {
	name: "hank",
	task: "修复 bug",
	role: "织造",
	acceptance: "测试通过",
	contextRefs: "src/foo.ts",
	model: "opencode-go/deepseek-v4-flash",
	thinking: "low",
};

test("makeWorkerId: 格式 pi-worker-<name>#<6hex>", () => {
	const id = makeWorkerId(base);
	assert.match(id, /^pi-worker-hank#[0-9a-f]{6}$/);
});

test("makeWorkerId: 同合约确定性", () => {
	assert.equal(makeWorkerId(base), makeWorkerId({ ...base }));
});

test("makeWorkerId: 合约字段任一变化 → 新 id", () => {
	const variants = [
		{ ...base, task: "修复另一个 bug" },
		{ ...base, role: "清流" },
		{ ...base, acceptance: "不同验收" },
		{ ...base, contextRefs: "src/bar.ts" },
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

test("makeWorkerId: oneshot 不进 hash", () => {
	assert.equal(makeWorkerId(base), makeWorkerId({ ...base, oneshot: true }));
});

test("makeWorkerId: 字段顺序无关(canonical)", () => {
	const shuffled = { role: base.role, task: base.task, name: base.name, thinking: base.thinking, model: base.model, contextRefs: base.contextRefs, acceptance: base.acceptance };
	assert.equal(makeWorkerId(base), makeWorkerId(shuffled));
});

test("makeWorkerId: 值去空白后 hash", () => {
	assert.equal(makeWorkerId(base), makeWorkerId({ ...base, task: "  修复 bug  " }));
});

test("validateRunInput: 合法输入无错误", () => {
	assert.deepEqual(validateRunInput(base), []);
	assert.deepEqual(validateRunInput({ name: "hank", task: "x" }), []);
});

test("validateRunInput: name 缺失/非法", () => {
	const missing = validateRunInput({ task: "x" });
	assert.ok(missing.some((m) => m.includes("name") && m.includes("缺失")));

	const invalid = validateRunInput({ name: "bad name!", task: "x" });
	assert.ok(invalid.some((m) => m.includes("name 非法") && m.includes("a-zA-Z0-9_-")));

	const tooLong = validateRunInput({ name: "a".repeat(33), task: "x" });
	assert.ok(tooLong.some((m) => m.includes("name 非法")));
});

test("validateRunInput: task 缺失列缺失项", () => {
	const errors = validateRunInput({ name: "hank" });
	assert.deepEqual(errors, ["task 缺失"]);
});

test("validateRunInput: thinking 非法列可选档位", () => {
	const errors = validateRunInput({ ...base, thinking: "ultra" });
	assert.ok(errors.some((m) => m.includes("thinking 非法") && m.includes("off|minimal|low|medium|high|xhigh|max")));
});

test("NAME_RE: 合法名", () => {
	for (const n of ["hank", "Hank-2", "rin_3", "a"]) assert.ok(NAME_RE.test(n), n);
	for (const n of ["", "a b", "中文", "a/b", "a".repeat(33), "#x"]) assert.ok(!NAME_RE.test(n), n);
});

test("buildWorkerCharter: 治理条款不退化(四要素/先回执/失败归因/事实核验/审计)", () => {
	const charter = buildWorkerCharter({ name: "hank", id: "pi-worker-hank#abc123", sessionDir: "/proj/.pi/worker/sessions" });
	// 条款级断言(非全文快照):任一核心治理条款被砍即红灯。
	// charter 是 worker 子进程(--no-context-files,不加载父 AGENTS.md)治理的全部来源,
	// 与 AGENTS.md「黄河水清」worker 契约同源,双源漂移由本测试兜底。
	assert.ok(charter.includes("四要素"), "四要素呈报契约");
	assert.ok(charter.includes("改动") && charter.includes("原因") && charter.includes("核验证据") && charter.includes("遗留"), "四要素逐项");
	assert.ok(charter.includes("先回执") && charter.includes("计划概要"), "先回执契约");
	assert.ok(charter.includes("失败归因") && charter.includes("收紧输入重派"), "失败归因契约");
	assert.ok(charter.includes("事实核验优先级") && charter.includes("repo 产物"), "事实核验优先级");
	assert.ok(charter.includes("父 session 负责验收"), "父-worker 关系条款");
	assert.ok(charter.includes("低风险默认推进"), "自主条款(prompt 收敛移入)");
	assert.ok(charter.includes("/proj/.pi/worker/sessions") && charter.includes("pi-worker-hank#abc123"), "审计路径与会话 id");
});

test("buildInitialPrompt: 全字段替换 + 机制要点", () => {
	const prompt = buildInitialPrompt({ ...base, id: "pi-worker-hank#abc123", sessionDir: "/proj/.pi/worker/sessions" });
	assert.ok(prompt.includes("hank"));
	assert.ok(prompt.includes("修复 bug"));
	assert.ok(prompt.includes("织造"));
	assert.ok(prompt.includes("测试通过"));
	assert.ok(prompt.includes("src/foo.ts"));
	assert.ok(prompt.includes("send_message"));
	assert.ok(prompt.includes("回执与常规沟通直接写在回复文本中"), "回执不得走 ask 通道");
	assert.ok(prompt.includes("治理契约见系统提示末尾"), "治理由 charter 承担(子进程 --no-context-files)");
	// 审计路径与会话 id 已移入 worker 宪法(buildWorkerCharter),prompt 不再重复
	assert.ok(!prompt.includes("/proj/.pi/worker/sessions"));
	assert.ok(!prompt.includes("pi-worker-hank#abc123"));
});

test("buildInitialPrompt: 可选节缺失时省略", () => {
	const prompt = buildInitialPrompt({ name: "hank", task: "x", id: "i", sessionDir: "d" });
	assert.ok(!prompt.includes("角色"));
	assert.ok(!prompt.includes("验收标准"));
	assert.ok(!prompt.includes("上下文引用"));
	assert.ok(prompt.includes("任务\nx"));
});
