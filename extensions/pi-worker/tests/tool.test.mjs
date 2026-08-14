import { describe, test } from "vitest";
import assert from "node:assert/strict";

import { WorkerManager } from "../src/manager.ts";
import { registerPiWorkerTool } from "../src/tool.ts";
import { ID_RE, NAME_RE } from "../src/contract.ts";

/** tool 入口单测:dispatch 路由/requireField/formatStatus。不起进程——
 * run 只走合约校验失败路径(spawn 之前抛错)。 */

function setup() {
	const delivered = [];
	const manager = new WorkerManager({
		deliver: (m) => delivered.push(m),
		onChange: () => {},
	});
	let toolDef;
	const pi = { registerTool: (def) => (toolDef = def) };
	registerPiWorkerTool(pi, manager);
	const exec = (params) => toolDef.execute("tc1", params, undefined, undefined, { cwd: "/repo" });
	return { manager, delivered, exec, description: toolDef.description, params: toolDef.parameters };
}

describe("description(L2 契约面 tripwire)", () => {
	test("载异步契约+七动作+kill 终态语义;机制(宽限升级/回调线格式)不进 prompt(模型行动必需且无法他处观察)", () => {
		const { description } = setup();
		assert.ok(description.includes("returns immediately"), "异步契约:run 立即返回(反轮询)");
		assert.ok(description.includes("Do not use"), "误触发边界(when-not)显式");
		for (const a of ["run", "message", "stop", "collect", "kill", "status", "recover"]) {
			assert.ok(description.includes(`- ${a}:`), `动作 ${a}`);
		}
		// 回调线格式是代码间 wire contract(bridge.ts 注释已载),不是模型行动必需信息,不进 prompt
		assert.ok(!description.includes("<worker-settled>"), "回调格式不进 prompt");
		// 机制语义以本描述为唯一权威:kill 终态须与状态机一致(killing→exit→done),不得载错误语义
		const killLine = description.split("\n").find((l) => l.startsWith("- kill:"));
		assert.ok(killLine && killLine.includes("done") && !killLine.includes("failed"), "kill 终态语义");
		assert.ok(!description.includes("宽限"), "机制(宽限升级)不进 prompt");
		const { params } = setup();
		assert.ok(params.properties.id.description.includes("returned by run"), "id 参数载 run 返回 id 寻址");
		assert.ok(params.properties.prompt.description.includes("self-contained"), "prompt 参数载简报标准");
		assert.ok(params.properties.prompt.description.includes("for message"), "task/message 合并为 prompt:按 action 分义");
		assert.ok(!("message" in params.properties), "无独立 message 参数(合并消除静默忽略面)");
	});

	test("机制语义面:tools 合约字段/verdict 终审/重启遗留恢复(模型行动必需且无法他处观察 → 进 description;schema 机器承载的事实不复述)", () => {
		const { description, params } = setup();
		assert.ok(params.properties.tools.description.includes("contract field"), "tools 进 id 合约(变=新 id)");
		assert.ok(params.properties.tools.description.includes("allowed: read,bash,edit,write,grep,find,ls,send_message"), "tools 载可接受范围全集");
		assert.ok(params.properties.verdict.description.includes("final-review verdict"), "verdict 参数载终审语义");
		const statusLine = description.split("\n").find((l) => l.startsWith("- status:"));
		assert.ok(statusLine?.includes("recovered marker"), "status 载崩溃恢复语义(jsonl 恢复,collect 清理)");
		// schema 机器承载(pattern/type/enum 自动进 JSON)的事实不进 prose——克制而非极简,组合推断
		assert.ok(!params.properties.id.description.includes("[0-9a-f]"), "id pattern 由 schema 承载,不复述");
		assert.ok(!params.properties.name.description.includes("a-zA-Z0-9_-"), "name pattern 由 schema 承载,不复述");
		assert.ok(!params.properties.verdict.description.includes("通过"), "verdict 枚举值由 schema enum 承载,不复述");
	});
});

describe("params(寻址契约收紧 tripwire)", () => {
	test("id 载 ID_RE pattern(完整 id 或 name);name 载 NAME_RE pattern(单一事实源)", () => {
		const { params } = setup();
		assert.equal(params.properties.id.pattern, ID_RE.source, "id pattern");
		assert.equal(params.properties.name.pattern, NAME_RE.source, "name pattern");
	});

	test("thinking = CLI 七档枚举(CLI 对非法档位只警告并丢弃,枚举即 fail fast)", () => {
		const { params } = setup();
		assert.deepEqual(
			[...params.properties.thinking.enum].sort(),
			["high", "low", "max", "medium", "minimal", "off", "xhigh"],
			"thinking 枚举",
		);
	});

	test("thinking 可省:required 仅 action(description「omit = default level」须与 schema 一致)", () => {
		const { params } = setup();
		assert.deepEqual(params.required, ["action"], "thinking/model/tools 等均可省,schema 不得强制");
	});

	test("verdict = 终审枚举(collect 用);tools 载逗号分隔白名单 pattern(run 用)", () => {
		const { params } = setup();
		assert.deepEqual(params.properties.verdict.enum, ["通过", "丢弃", "强制放行"], "collect 终审结论枚举");
		assert.ok(params.properties.tools.pattern, "tools pattern fail fast");
	});
});

describe("pi_worker dispatch 路由", () => {
	test("未知 action → actionable 错误", async () => {
		const { exec } = setup();
		await assert.rejects(exec({ action: "bogus" }), /未知 action: bogus/);
	});

	test("run 合约缺字段 → 校验错误,不 spawn", async () => {
		const { manager, exec } = setup();
		await assert.rejects(exec({ action: "run", name: "a" }), /合约缺字段: prompt 缺失/);
		assert.equal(manager.sm.records.size, 0, "校验失败不留记录不 spawn");
	});

	test("run name 非法 → 错误含合法字符说明", async () => {
		const { exec } = setup();
		await assert.rejects(exec({ action: "run", name: "中文", prompt: "t" }), /name 非法/);
	});

	test("run tools 未知工具 → 校验错误,不 spawn", async () => {
		const { manager, exec } = setup();
		await assert.rejects(exec({ action: "run", name: "a", prompt: "t", tools: "read,rm" }), /tools 非法.*"rm"/);
		assert.equal(manager.sm.records.size, 0, "校验失败不留记录不 spawn");
	});

	test("collect 带 verdict → 落记录 + 结果文本载 verdict(终审结论成工具参数)", async () => {
		const { manager, exec } = setup();
		manager.sm.run({ id: "pi-worker-hank#aaaaaa", name: "hank" });
		manager.sm.onStarted("pi-worker-hank#aaaaaa");
		manager.sm.onSettled("pi-worker-hank#aaaaaa");
		const res = await exec({ action: "collect", id: "pi-worker-hank#aaaaaa", verdict: "通过" });
		assert.ok(res.content[0].text.includes("verdict=通过"), res.content[0].text);
		assert.equal(manager.sm.records.get("pi-worker-hank#aaaaaa").verdict, "通过");
	});

	test("message/stop/collect/kill 缺 id → requireField 错误", async () => {
		const { exec } = setup();
		for (const action of ["message", "stop", "collect", "kill"]) {
			await assert.rejects(exec({ action }), new RegExp(`缺 id 参数;action=${action}`), action);
		}
	});

	test("message 缺文本 → requireField 错误", async () => {
		const { exec } = setup();
		await assert.rejects(exec({ action: "message", id: "pi-worker-a#abcdef" }), /缺 prompt 参数;action=message/);
	});

	test("message 目标不存在 → 错误含目标与解析失败原因", async () => {
		const { exec } = setup();
		await assert.rejects(exec({ action: "message", id: "pi-worker-ghost#000000", prompt: "hi" }), /目标「pi-worker-ghost#000000」不存在或歧义/);
	});
});

describe("pi_worker status(formatStatus)", () => {
	test("空记录 → 明确文案", async () => {
		const { exec } = setup();
		const res = await exec({ action: "status" });
		assert.equal(res.content[0].text, "无worker 记录。");
	});

	test("记录行含 id/state,exit 与 stderr 尾带出诊断", async () => {
		const { manager, exec } = setup();
		manager.sm.run({ id: "pi-worker-hank#aaaaaa", name: "hank" });
		manager.sm.onExit("pi-worker-hank#aaaaaa", { code: 1, signal: null, stderrTail: "boom" });
		const res = await exec({ action: "status" });
		const text = res.content[0].text;
		assert.ok(text.includes("id=pi-worker-hank#aaaaaa"), "id");
		assert.ok(text.includes("state=failed"), "failed 状态");
		assert.ok(text.includes('stderr="boom"'), "stderr 尾诊断");
	});

	test("status id 过滤单条;不存在 → 错误含存活列表", async () => {
		const { manager, exec } = setup();
		manager.sm.run({ id: "pi-worker-a#111111", name: "a" });
		manager.sm.run({ id: "pi-worker-b#222222", name: "b" });
		const res = await exec({ action: "status", id: "pi-worker-a#111111" });
		assert.ok(res.content[0].text.includes("pi-worker-a#111111"));
		assert.ok(!res.content[0].text.includes("pi-worker-b#222222"), "不含其他记录");
		await assert.rejects(exec({ action: "status", id: "pi-worker-ghost#000000" }), /id 不存在/);
	});

	test("每条记录附合法动作列表(G4:rpc 父决策队列,复用 actionsFor)", async () => {
		const { manager, exec } = setup();
		manager.sm.run({ id: "pi-worker-a#111111", name: "a" }); // starting
		manager.sm.run({ id: "pi-worker-b#222222", name: "b" });
		manager.sm.onStarted("pi-worker-b#222222");
		manager.sm.onSettled("pi-worker-b#222222"); // idle
		const text = (await exec({ action: "status" })).content[0].text;
		assert.ok(text.includes("actions=kill"), "starting → kill");
		assert.ok(text.includes("actions=通过|消息|丢弃|强制放行"), "idle → 判决集");
	});

	test("遗留记录:recovered marker + session 指针 + collect 动作;done 记录载 verdict", async () => {
		const { manager, exec } = setup();
		manager.sm.recover({
			id: "pi-worker-old#333333",
			name: "old",
			sessionFile: "/repo/.pi/worker-sessions/old.jsonl",
			createdAt: 1,
			updatedAt: 2,
		});
		const text = (await exec({ action: "status" })).content[0].text;
		assert.ok(text.includes("state=exited") && text.includes("recovered"), "recovered provenance 显式");
		assert.ok(text.includes("session=/repo/.pi/worker-sessions/old.jsonl"), "审计指针");
		assert.ok(text.includes("actions=collect"), "遗留记录唯一动作 = collect 清理");

		manager.sm.run({ id: "pi-worker-d#444444", name: "d" });
		manager.sm.onStarted("pi-worker-d#444444");
		manager.sm.onSettled("pi-worker-d#444444");
		manager.collect("pi-worker-d#444444", "丢弃");
		const doneText = (await exec({ action: "status", id: "pi-worker-d#444444" })).content[0].text;
		assert.ok(doneText.includes("verdict=丢弃"), "done 记录载终审结论");
	});
});

describe("run 成功 → 生命周期 entry 追加(transcript block 的数据来源)", () => {
	test("appendEntry 一次,type/数据契约齐;createdAt 取记录值", async () => {
		const record = { id: "pi-worker-hank#aaaaaa", name: "hank", createdAt: 123_000 };
		const stubManager = {
			run: () => ({ id: record.id, pid: 42 }),
			status: (id) => (id === record.id ? record : [record]),
		};
		const appended = [];
		let toolDef;
		const pi = {
			registerTool: (def) => (toolDef = def),
			appendEntry: (t, d) => appended.push({ t, d }),
		};
		registerPiWorkerTool(pi, stubManager);
		const res = await toolDef.execute("tc1", { action: "run", name: "hank", prompt: "do it" }, undefined, undefined, { cwd: "/repo" });
		assert.ok(res.content[0].text.includes("id=pi-worker-hank#aaaaaa"), "run 结果不受影响");
		assert.equal(appended.length, 1, "恰一次 append");
		assert.equal(appended[0].t, "pi-worker-lifecycle");
		assert.deepEqual(appended[0].d, { id: record.id, name: "hank", prompt: "do it", createdAt: 123_000 });
	});

	test("run 校验失败 → 不 append(无遗留幽灵 block)", async () => {
		const { exec } = setup();
		await assert.rejects(exec({ action: "run", name: "a" }), /合约缺字段/);
		// setup() 的 pi stub 无 appendEntry:若接线调用了会抛 TypeError,此断言靠不抛新错误隐式覆盖
	});
});

describe("recover action(显式认领遗留 worker)", () => {
	test("recover → 按 branch 归属分类:own 认领,foreign 载 pi --resume 指引", async () => {
		let calledWith, calledClaim;
		const stubManager = {
			recoverFromDisk: async (cwd, opts) => {
				calledWith = cwd;
				calledClaim = opts?.claim;
				return {
					recovered: 1,
					skippedFiles: [],
					heldElsewhere: [],
					foreign: [{ id: "pi-worker-x#111111111111", name: "x", sessionFile: "/tmp/x.jsonl" }],
				};
			},
		};
		let toolDef;
		const pi = { registerTool: (def) => (toolDef = def), appendEntry: () => {} };
		registerPiWorkerTool(pi, stubManager);
		const ctx = { cwd: "/repo", sessionManager: { getBranch: () => [{ type: "message" }] } };
		const res = await toolDef.execute("tc1", { action: "recover" }, undefined, undefined, ctx);
		assert.equal(calledWith, "/repo");
		assert.equal(typeof calledClaim, "function", "claim 谓词传入");
		assert.ok(res.content[0].text.includes("1"), "own 认领数");
		assert.ok(res.content[0].text.includes("pi --session /tmp/x.jsonl") && res.content[0].text.includes("pi --fork /tmp/x.jsonl"), "foreign 查看/派生新会话指引");
	});
});
