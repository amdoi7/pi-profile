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
	test("载异步契约+五动作;机制(宽限升级/回调线格式)不进 prompt(模型行动必需且无法他处观察)", () => {
		const { description } = setup();
		assert.ok(description.includes("returns immediately"), "异步契约:run 立即返回(反轮询)");
		assert.ok(description.includes("Do not use"), "误触发边界(when-not)显式");
		for (const a of ["run", "send", "stop", "collect", "status"]) {
			assert.ok(description.includes(`- ${a}:`), `动作 ${a}`);
		}
		assert.ok(!description.includes("- kill:"), "kill 移除(生命周期细节固化,模型面只留派/问/收)");
		assert.ok(!description.includes("- recover:"), "recover 移除(启动恢复废除)");
		// 回调线格式是代码间 wire contract(bridge.ts 注释已载),不是模型行动必需信息,不进 prompt
		assert.ok(!description.includes("<worker-settled>"), "回调格式不进 prompt");
		assert.ok(!description.includes("宽限"), "机制(宽限升级)不进 prompt");
		const { params } = setup();
		assert.ok(params.properties.id.description.includes("returned by run"), "id 参数载 run 返回 id 寻址");
		assert.ok(params.properties.text.description.includes("self-contained"), "text 参数载简报标准");
		assert.ok(params.properties.text.description.includes("for send"), "task/send 合并为 text:按 action 分义");
		assert.ok(!("prompt" in params.properties), "无独立 prompt 参数(合并消除静默忽略面)");
	});

	test("机制语义面:tools 合约字段/verdict 终审/exited 冷恢复(模型行动必需且无法他处观察 → 进 description;schema 机器承载的事实不复述)", () => {
		const { description, params } = setup();
		assert.ok(params.properties.tools.description.includes("contract field"), "tools 进 id 合约(变=新 id)");
		assert.ok(params.properties.tools.description.includes("allowed: read,bash,edit,write,grep,find,ls,send_message"), "tools 载可接受范围全集");
		assert.ok(params.properties.verdict.description.includes("final-review verdict"), "verdict 参数载终审语义");
		const statusLine = description.split("\n").find((l) => l.startsWith("- status:"));
		assert.ok(statusLine?.includes("cold-resumed via send"), "status 载 exited 冷恢复语义(send 续接,collect 清理)");
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
		await assert.rejects(exec({ action: "bogus" }), /unknown action: bogus/);
	});

	test("run 合约缺字段 → 校验错误,不 spawn", async () => {
		const { manager, exec } = setup();
		await assert.rejects(exec({ action: "run", name: "a" }), /contract validation failed: missing text/);
		assert.equal(manager.sm.records.size, 0, "校验失败不留记录不 spawn");
	});

	test("run name 非法 → 错误含合法字符说明", async () => {
		const { exec } = setup();
		await assert.rejects(exec({ action: "run", name: "中文", text: "t" }), /invalid name/);
	});

	test("run tools 未知工具 → 校验错误,不 spawn", async () => {
		const { manager, exec } = setup();
		await assert.rejects(exec({ action: "run", name: "a", text: "t", tools: "read,rm" }), /invalid tools.*"rm"/);
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

	test("send/stop/collect/kill 缺 id → requireField 错误", async () => {
		const { exec } = setup();
		for (const action of ["send", "stop", "collect", "kill"]) {
			await assert.rejects(exec({ action }), new RegExp(`missing id; action=${action}`), action);
		}
	});

	test("send 缺文本 → requireField 错误", async () => {
		const { exec } = setup();
		await assert.rejects(exec({ action: "send", id: "pi-worker-a#abcdef" }), /missing text; action=send/);
	});

	test("send 目标不存在 → 错误含目标与存活列表(status 前置解析)", async () => {
		const { exec } = setup();
		await assert.rejects(exec({ action: "send", id: "pi-worker-ghost#000000", text: "hi" }), /id not found: pi-worker-ghost#000000/);
	});
});

describe("pi_worker status(formatStatus)", () => {
	test("空记录 → 明确文案", async () => {
		const { exec } = setup();
		const res = await exec({ action: "status" });
		assert.equal(res.content[0].text, "No worker records.");
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
		await assert.rejects(exec({ action: "status", id: "pi-worker-ghost#000000" }), /id not found/);
	});

	test("每条记录附合法动作列表(工具面表达:零 label→action 映射,能力同构)", async () => {
		const { manager, exec } = setup();
		manager.sm.run({ id: "pi-worker-a#111111", name: "a" }); // starting
		manager.sm.run({ id: "pi-worker-b#222222", name: "b" });
		manager.sm.onStarted("pi-worker-b#222222");
		manager.sm.onSettled("pi-worker-b#222222"); // idle
		const text = (await exec({ action: "status" })).content[0].text;
		assert.ok(text.includes("actions=kill"), "starting → kill");
		assert.ok(
			text.includes("actions=send|collect(verdict=通过|丢弃|强制放行)"),
			"idle → 工具面判决集(collect + verdict 枚举,直接可执行)",
		);
		assert.ok(!text.includes("消息|"), "无中文 label(消息→send 映射由输出面消除)");
	});

	test("exited 记录:冷恢复续接 + collect 清理动作;done 记录载 verdict", async () => {
		const { manager, exec } = setup();
		manager.sm.run({ id: "pi-worker-x#333333", name: "x" });
		manager.sm.onStarted("pi-worker-x#333333");
		manager.sm.onSettled("pi-worker-x#333333");
		manager.sm.onExit("pi-worker-x#333333", { code: 1, signal: null, stderrTail: "" }); // idle 后崩 → exited
		const text = (await exec({ action: "status" })).content[0].text;
		assert.ok(text.includes("state=exited"), "exited 状态显式");
		assert.ok(
			text.includes("actions=send(cold-resume)|collect(verdict=通过|丢弃|强制放行)"),
			"exited 动作 = 冷恢复续接 + 判决收尾(报告已交,判决不因进程死失效)",
		);

		manager.sm.run({ id: "pi-worker-d#444444", name: "d" });
		manager.sm.onStarted("pi-worker-d#444444");
		manager.sm.onSettled("pi-worker-d#444444");
		manager.collect("pi-worker-d#444444", "丢弃");
		const doneText = (await exec({ action: "status", id: "pi-worker-d#444444" })).content[0].text;
		assert.ok(doneText.includes("verdict=丢弃"), "done 记录载终审结论");
	});

	test("多条:汇总头 + 决策优先排序(failed/idle 在 running 前,done 居尾)", async () => {
		const { manager, exec } = setup();
		// 乱序建立:running 先建,failed/idle 后建——排序应仍决策优先
		manager.sm.run({ id: "pi-worker-r#111111", name: "r" });
		manager.sm.onStarted("pi-worker-r#111111"); // running
		manager.sm.run({ id: "pi-worker-f#222222", name: "f" });
		manager.sm.onExit("pi-worker-f#222222", { code: 1, signal: null, stderrTail: "" }); // failed
		manager.sm.run({ id: "pi-worker-i#333333", name: "i" });
		manager.sm.onStarted("pi-worker-i#333333");
		manager.sm.onSettled("pi-worker-i#333333"); // idle
		manager.sm.run({ id: "pi-worker-d#444444", name: "d" });
		manager.sm.onStarted("pi-worker-d#444444");
		manager.sm.onSettled("pi-worker-d#444444");
		manager.collect("pi-worker-d#444444"); // done
		const text = (await exec({ action: "status" })).content[0].text;
		assert.ok(text.startsWith("4 workers: failed×1 · idle×1 · running×1 · done×1\n"), `汇总头: ${text.split("\n")[0]}`);
		const idx = (id) => text.indexOf(`id=${id}`);
		assert.ok(idx("pi-worker-f#222222") < idx("pi-worker-i#333333"), "failed 在 idle 前");
		assert.ok(idx("pi-worker-i#333333") < idx("pi-worker-r#111111"), "idle 在 running 前");
		assert.ok(idx("pi-worker-r#111111") < idx("pi-worker-d#444444"), "running 在 done 前");
	});

	test("status 去过程噪音:recent 工具历史与 pid 不输出(事件走回调/transcript 通道,pid 无操作面且会过期)", async () => {
		const { manager, exec } = setup();
		manager.sm.run({ id: "pi-worker-a#111111", name: "a" });
		manager.sm.onStarted("pi-worker-a#111111");
		const rec = manager.sm.records.get("pi-worker-a#111111");
		rec.pid = 13015;
		const text = (await exec({ action: "status" })).content[0].text;
		assert.ok(!text.includes("pid="), "pid 不输出(LLM 无 pid 操作面,退出即过期)");
		assert.ok(!text.includes("recent"), "recent 不输出(过程信息非状态快照)");
	});

	test("model/tools 不输出(自己 run 的是已知 input,回显即冗余)", async () => {
		const { manager, exec } = setup();
		manager.sm.run({ id: "pi-worker-a#111111", name: "a" });
		manager.sm.onStarted("pi-worker-a#111111");
		const a = manager.sm.records.get("pi-worker-a#111111");
		a.modelInfo = { provider: "r4", id: "deepseek-v4-flash", thinkingLevel: "" };
		a.tools = "read,bash";
		const text = (await exec({ action: "status" })).content[0].text;
		assert.ok(!text.includes("model=r4"), "不输出 model(已知 input)");
		assert.ok(!text.includes("tools="), "不输出 tools(已知 input)");
	});

	test("记录行带 turns/stopReason/reportError(RPC 父唯一可见面);cost 定 4 位", async () => {
		const { manager, exec } = setup();
		manager.sm.run({ id: "pi-worker-h#111111", name: "h" });
		manager.sm.onStarted("pi-worker-h#111111");
		manager.sm.onSettled("pi-worker-h#111111"); // idle
		const rec = manager.sm.records.get("pi-worker-h#111111");
		rec.turns = 3;
		rec.stopReason = "length";
		rec.reportError = "deliver 失败: boom";
		rec.latestStats = { cost: 0.001234567 };
		const text = (await exec({ action: "status" })).content[0].text;
		assert.ok(text.includes("turns=3"), "turns 进展信号");
		assert.ok(text.includes("stopReason=length"), "非正常收尾诊断");
		assert.ok(text.includes('reportError="deliver 失败: boom"'), "deliver 失败留痕可见");
		assert.ok(text.includes("cost=0.0012"), "cost 定 4 位");
		// stop 是正常收尾,不占位
		rec.stopReason = "stop";
		const okText = (await exec({ action: "status" })).content[0].text;
		assert.ok(!okText.includes("stopReason="), "stop 不输出");
	});
});

