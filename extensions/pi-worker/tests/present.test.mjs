import { describe, test } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import assert from "node:assert/strict";

import {
	formatFooter,
	formatTokens,
	formatCallbackView,
	formatToolCallLine,
	toastFor,
	formatModelInfo,
	formatRuntime,
	formatOverlayRows,
	actionsFor,
	formatRecentEntry,
	formatAttributionMessage,
	formatActionMessage,
	opFor,
} from "../src/present.ts";

function rec(partial) {
	return {
		id: "pi-worker-hank#a1b2c3",
		name: "hank",
		state: "running",
		oneshot: false,
		processExited: false,
		turns: 0,
		createdAt: 0,
		updatedAt: 0,
		recent: [],
		...partial,
	};
}

/** 测试便捷:直接置 latestStats(快照覆写语义)。 */
function withStats(partial, stats) {
	return { ...partial, latestStats: stats };
}

describe("formatFooter", () => {
	// spinner 帧确定化:running frameMs=1000,4 帧;F0 时 0%4=0 → ⧓;F0+1000 时 1%4=1 → ⧔
	const F0 = 1_000_000_000; // floor/1000=1_000_000,%5=0
	const fg = (c, t) => `<${c}>${t}</>`;

	test("空记录 → undefined", () => {
		assert.equal(formatFooter([], { now: F0 }), undefined);
	});

	test("无投影内容(done/killing)→ undefined", () => {
		const records = [rec({ state: "done" }), rec({ state: "killing" })];
		assert.equal(formatFooter(records, { now: F0 }), undefined);
	});

	test("单工作态:spinner + name + elapsed,无 hash 无 turns", () => {
		const records = [rec({ state: "running", turns: 3, createdAt: F0 })];
		assert.equal(formatFooter(records, { now: F0 + 45_000 }), "⧔   hank · 45s");
	});

	test("单工作态带活动:只留工具名(心跳),参数不进 footer", () => {
		const withAct = [rec({ state: "running", turns: 1, createdAt: F0, currentActivity: 'tool: rg "pi_worker"' })];
		assert.equal(formatFooter(withAct, { now: F0 + 5_000 }), "⧔   hank · rg · 5s");
		const long = [rec({ state: "running", createdAt: F0, currentActivity: "tool: bash " + "x".repeat(40) })];
		const line = formatFooter(long, { now: F0 });
		assert.ok(line.includes("bash"), line);
		assert.ok(!line.includes("x".repeat(10)), line); // 参数一律不进 footer
	});

	test("spinner 帧随秒轮换;fg 给 spinner 套 accent", () => {
		const records = [rec({ state: "running", createdAt: F0 })];
		assert.equal(formatFooter(records, { now: F0 + 1_000 })[0], "⧔");
		assert.equal(formatFooter(records, { now: F0 + 4_000 })[0], "⧓");
		assert.ok(formatFooter(records, { now: F0, fg }).startsWith("<accent>⧓  </>"));
	});

	test("铸约帧族(starting):⦗◦⦘→⦗☯⦘,2s/帧慢呼吸,3 字符槽", () => {
		const records = [rec({ state: "starting", createdAt: F0 })];
		assert.equal(formatFooter(records, { now: F0 })[0], "⦗"); // ⦗◦⦘
		assert.equal(formatFooter(records, { now: F0 + 2_000 })[0], "⦗"); // ⦗☯⦘(2s 后换帧)
		assert.equal(formatFooter(records, { now: F0 + 1_000 })[0], "⦗"); // 1s 未到 2s,仍帧 0
		const line = formatFooter(records, { now: F0 + 6_000 });
		assert.ok(line.startsWith("⦗⧇⦘"), line); // 第 4 帧
	});

	test("裁决帧族(stopping):⧈→╳,warning 色", () => {
		const records = [rec({ state: "stopping", createdAt: F0 })];
		assert.equal(formatFooter(records, { now: F0 })[0], "⧈");
		assert.equal(formatFooter(records, { now: F0 + 2_000 })[0], "╳"); // 2s:2%4=2 → ⧇?⧈⧇╳· 帧 2 = ╳
		assert.ok(formatFooter(records, { now: F0, fg }).startsWith("<warning>⧈  </>"));
	});

	test("三态帧槽等宽:footer 的 name 列位置恒 4 列(无宽度漂移)", () => {
		const at = F0;
		const starting = formatFooter([rec({ state: "starting", createdAt: F0 })], { now: at });
		const running = formatFooter([rec({ state: "running", createdAt: F0 })], { now: at });
		const stopping = formatFooter([rec({ state: "stopping", createdAt: F0 })], { now: at });
		// 帧槽 + 分隔 = 4 列,name 从第 5 列起,三态一致
		assert.equal(visibleWidth(starting.slice(0, starting.indexOf("hank"))), 4);
		assert.equal(visibleWidth(running.slice(0, running.indexOf("hank"))), 4);
		assert.equal(visibleWidth(stopping.slice(0, stopping.indexOf("hank"))), 4);
	});

	test("多工作态聚合:最早创建者具名 +N,Σturns;有 stats 加 Σtok", () => {
		const records = [
			rec({ id: "pi-worker-b#222222", name: "qingliu", state: "running", turns: 1, createdAt: F0 + 2 }),
			withStats({ id: "pi-worker-a#111111", name: "zhizao", state: "running", turns: 3, createdAt: F0 + 1 }, { tokens: { total: 45000 } }),
			rec({ id: "pi-worker-c#333333", name: "zhangyin", state: "stopping", turns: 2, createdAt: F0 + 3 }),
		];
		assert.equal(formatFooter(records, { now: F0 + 60_000 }), "⧓   zhizao +2 · 59s · 45k tok");
	});

	test("tok 格式:formatTokens 纯函数;单 worker 不显示 tok(渐进披露)", () => {
		assert.equal(formatTokens(900), "900");
		assert.equal(formatTokens(1500), "1.5k");
		assert.equal(formatTokens(45200), "45.2k");
		assert.equal(formatTokens(45000), "45k");
		const single = [withStats({ state: "running", turns: 1, createdAt: F0 }, { tokens: { total: 900 } })];
		assert.ok(!formatFooter(single, { now: F0 }).includes("tok"));
		const noStats = [rec({ state: "running", turns: 1, createdAt: F0 })];
		assert.ok(!formatFooter(noStats, { now: F0 }).includes("tok"));
	});

	test("等决策区:✗failed ✓done ⏾exited,按严重度排序(ask 通道已移除)", () => {
		const records = [
			rec({ id: "pi-worker-a#111111", name: "a", state: "idle" }),
			rec({ id: "pi-worker-b#222222", name: "b", state: "idle" }),
			rec({ id: "pi-worker-c#333333", name: "c", state: "idle" }),
			rec({ id: "pi-worker-d#444444", name: "d", state: "failed" }),
			rec({ id: "pi-worker-e#555555", name: "e", state: "exited" }),
		];
		assert.equal(
			formatFooter(records, { now: F0 }),
			"✗ 1 failed · ✓ 3 done · ⏾ 1 exited · /pi-worker",
		);
		const colored = formatFooter(records, { now: F0, fg });
		assert.ok(colored.includes("<error>✗ 1 failed</>"));
		assert.ok(colored.includes("<dim>✓ 3 done</>"));
		assert.ok(colored.includes("<warning>⏾ 1 exited</>"));
		assert.ok(colored.includes("<dim>/pi-worker</>"));
	});

	test("双区并存:工作区 │ 等决策区", () => {
		const records = [
			rec({ state: "running", turns: 3, createdAt: F0 }),
			rec({ id: "pi-worker-a#111111", name: "a", state: "idle" }),
		];
		assert.equal(
			formatFooter(records, { now: F0 + 45_000 }),
			"⧔   hank · 45s │ ✓ 1 done",
		);
	});
});

function msg(partial) {
	return {
		customType: "pi-worker",
		content: "x",
		details: { id: "pi-worker-hank#a1b2c3", ...partial },
	};
}

describe("formatCallbackView", () => {

	test("settled:⏺ header + markdown 报告 + ⎿ 摘要(turns/tokens/cost)", () => {
		const view = formatCallbackView(
			msg({
				type: "settled",
				name: "hank",
				report: "## 改动\n- 修复 bug",
				turns: 3,
				stats: { tokens: { total: 45200 }, cost: 0.0042 },
			}),
		);
		assert.equal(view.kind, "settled");
		assert.equal(view.header, "⏺ settled hank");
		assert.equal(view.body, "## 改动\n- 修复 bug");
		assert.equal(view.bodyIsMarkdown, true);
		assert.equal(view.summary, "⎿ 3 turns · 45.2k tokens · $0.0042");
	});

	test("settled:无 stats 无 turns → 无摘要", () => {
		const view = formatCallbackView(msg({ type: "settled", name: "hank", report: "r" }));
		assert.equal(view.summary, undefined);
	});

	test("failed:诊断 + stderr 尾", () => {
		const view = formatCallbackView(
			msg({ type: "failed", exitCode: 1, exitSignal: null, stderrTail: "boom" }),
		);
		assert.equal(view.kind, "failed");
		assert.equal(view.header, "⏺ failed hank");
		assert.ok(view.body.includes("exit=1"));
		assert.ok(view.body.includes("boom"));
		assert.equal(view.bodyIsMarkdown, false);
	});

	test("failed:信号退出", () => {
		const view = formatCallbackView(
			msg({ type: "failed", exitCode: null, exitSignal: "SIGKILL", stderrTail: "" }),
		);
		assert.ok(view.body.includes("SIGKILL"));
	});

	test("action-done(审计):content 即 body,不再落空 settled 卡", () => {
		const view = formatCallbackView({
			customType: "pi-worker",
			content: "worker hank → seal:证据已齐",
			details: { type: "action-done", id: "pi-worker-seal#b2c3d4" },
		});
		assert.equal(view.kind, "action");
		assert.equal(view.header, "⏺ action seal");
		assert.equal(view.body, "worker hank → seal:证据已齐");
		assert.equal(view.bodyIsMarkdown, false);
	});

	test("未知 details.type:回退 content 卡片,不静默当 settled", () => {
		const view = formatCallbackView({
			customType: "pi-worker",
			content: "原始文本",
			details: { type: "weird" },
		});
		assert.equal(view.kind, "action");
		assert.equal(view.body, "原始文本");
	});

	test("settled:呈报获取失败 → body 显示错误而非空卡", () => {
		const view = formatCallbackView(
			msg({ type: "settled", name: "hank", report: "", reportError: "RPC 超时" }),
		);
		assert.ok(view.body.includes("呈报获取失败"));
		assert.ok(view.body.includes("RPC 超时"));
	});

	test("settled:无报告无错误 → 标注无呈报", () => {
		const view = formatCallbackView(msg({ type: "settled", name: "hank" }));
		assert.ok(view.body.includes("无呈报"));
	});
});

describe("formatToolCallLine", () => {
	test("run:name + task 摘要(40 字符截断)+ 显式 model/thinking", () => {
		assert.equal(formatToolCallLine("run", { name: "zhizao", task: "写测试" }), 'run zhizao "写测试"');
		assert.equal(
			formatToolCallLine("run", { name: "zhizao", task: "写测试", model: "opencode-go/deepseek-v4-flash", thinking: "max" }),
			'run zhizao "写测试" · opencode-go/deepseek-v4-flash think:max',
		);
		assert.equal(
			formatToolCallLine("run", { name: "zhizao", task: "t".repeat(50) }),
			`run zhizao "${"t".repeat(40)}…"`,
		);
		// thinking 单独指定(默认模型 + 升档):无 model 段
		assert.equal(formatToolCallLine("run", { name: "zhizao", task: "x", thinking: "high" }), 'run zhizao "x" · think:high');
	});

	test("message:id 显示为 name(去 hash)+ 消息文本摘要", () => {
		assert.equal(
			formatToolCallLine("message", { id: "pi-worker-hank#a1b2c3", message: "先修断言" }),
			'message hank "先修断言"',
		);
	});

	test("stop/collect/kill:仅目标;status 无 id 即列全部", () => {
		assert.equal(formatToolCallLine("kill", { id: "pi-worker-hank#a1b2c3" }), "kill hank");
		assert.equal(formatToolCallLine("status", {}), "status");
		assert.equal(formatToolCallLine("status", { id: "pi-worker-hank#a1b2c3" }), "status hank");
	});
});

describe("toastFor", () => {
	test("failed → error toast,含 id 与 exit", () => {
		const toast = toastFor(msg({ type: "failed", exitCode: 1, exitSignal: null, stderrTail: "x" }));
		assert.equal(toast.level, "error");
		assert.ok(toast.text.includes("worker"));
		assert.ok(toast.text.includes("pi-worker-hank#a1b2c3"));
		assert.ok(toast.text.includes("exit=1"));
	});

	test("settled → 无 toast", () => {
		assert.equal(toastFor(msg({ type: "settled", name: "hank", report: "r" })), null);
	});
});

describe("formatModelInfo", () => {
	test("握手后:provider/id · think 档位;providerName 显示名优先", () => {
		const r = rec({ modelInfo: { provider: "opencode-go", id: "deepseek-v4-flash", thinkingLevel: "max" } });
		assert.equal(formatModelInfo(r), "opencode-go/deepseek-v4-flash · think:max");
		assert.equal(formatModelInfo(r, "OpenCode Go"), "OpenCode Go/deepseek-v4-flash · think:max");
	});

	test("握手前:spawn 参数;无参数 → 空", () => {
		const r = rec({ model: "opencode-go/deepseek-v4-flash", thinking: "high" });
		assert.equal(formatModelInfo(r), "opencode-go/deepseek-v4-flash · think:high");
		assert.equal(formatModelInfo(rec({})), "");
	});
});

describe("formatRuntime", () => {
	test("打开时算一次,无定时器", () => {
		const r = rec({ createdAt: 1_000_000_000 });
		assert.equal(formatRuntime(r, 1_000_045_000), "45s");
		assert.equal(formatRuntime(r, 1_000_065_000), "1m5s");
		assert.equal(formatRuntime(r, 1_005_451_000), "1h30m51s");
	});
});


describe("formatOverlayRows", () => {
	test("分区:decision(failed/idle/exited)在前,working 在后;区内按创建序", () => {
		const records = [
			rec({ id: "pi-worker-work#111111", name: "work", state: "running", createdAt: 10, turns: 2 }),
			rec({ id: "pi-worker-ask1#222222", name: "ask1", state: "idle", createdAt: 1 }),
			rec({ id: "pi-worker-fail#333333", name: "fail", state: "failed", createdAt: 2 }),
			rec({ id: "pi-worker-idle#444444", name: "idle", state: "idle", createdAt: 3 }),
			rec({ id: "pi-worker-exit#555555", name: "exit", state: "exited", createdAt: 4 }),
		];
		const rows = formatOverlayRows(records, 1_000_000);
		assert.deepEqual(
			rows.map((r) => r.value),
			["pi-worker-fail#333333", "pi-worker-ask1#222222", "pi-worker-idle#444444", "pi-worker-exit#555555", "pi-worker-work#111111"],
		);
		assert.deepEqual(
			rows.map((r) => r.section),
			["decision", "decision", "decision", "decision", "working"],
		);
	});

		test("主行:定宽列 name/runtime/tN,图标语义色(无 #hash 无 role)", () => {
		const records = [
			rec({ id: "pi-worker-a#111111", name: "a", state: "idle", idleReason: "ask", createdAt: 1_000_000_000, role: "织造", turns: 2 }),
			rec({ id: "pi-worker-b#222222", name: "b", state: "failed", createdAt: 999_940_000 }), // 105s → 1m45s,拉宽 runtime 列
			rec({ id: "pi-worker-c#333333", name: "c", state: "idle", idleReason: "report", createdAt: 1_000_000_002 }),
			rec({ id: "pi-worker-d#444444", name: "d", state: "exited", createdAt: 1_000_000_003 }),
			rec({ id: "pi-worker-e#555555", name: "e", state: "running", createdAt: 1_000_000_004 }),
		];
		const rows = formatOverlayRows(records, 1_000_045_000);
		const byId = Object.fromEntries(rows.map((r) => [r.value, r]));
		// name 列 pad 到行集最大宽(1),runtime 右对齐到 1m45s(5 列);role 不进显示层
		assert.match(byId["pi-worker-a#111111"].main.text, /^✓ a {3}45s t2$/);
		assert.match(byId["pi-worker-b#222222"].main.text, /^✗ b 1m45s t0$/);
		assert.match(byId["pi-worker-c#333333"].main.text, /^✓ c {3}44s t0$/);
		assert.match(byId["pi-worker-d#444444"].main.text, /^⏾ d {3}44s t0$/);
		assert.match(byId["pi-worker-e#555555"].main.text, /^● e {3}44s t0$/);
		assert.equal(byId["pi-worker-a#111111"].main.color, "success");
		assert.equal(byId["pi-worker-b#222222"].main.color, "error");
		assert.ok(byId["pi-worker-b#222222"].main.text.startsWith("✗ "));
		assert.ok(byId["pi-worker-c#333333"].main.text.startsWith("✓ "));
		assert.equal(byId["pi-worker-c#333333"].main.color, "success");
		assert.ok(byId["pi-worker-d#444444"].main.text.startsWith("⏾ "));
		assert.equal(byId["pi-worker-d#444444"].main.color, "warning");
		assert.ok(byId["pi-worker-e#555555"].main.text.startsWith("● "));
		assert.equal(byId["pi-worker-e#555555"].main.color, "dim");
	});

	test("details:模型行 + 活动/cost/ask 行,选中才渲染(结构提供,渲染层控制)", () => {
		const records = [
			rec({
				id: "pi-worker-zhizao#a1b2c3",
				name: "zhizao",
				state: "running",
				createdAt: 1_000_000_000,
				turns: 3,
				currentActivity: "tool: bash {\"command\":\"npm test\"}",
				modelInfo: { provider: "opencode-go", id: "deepseek-v4-flash", thinkingLevel: "max" },
				latestStats: { cost: 0.0042, toolCalls: 4, tokens: { input: 8200, output: 4100, cacheRead: 3400, total: 15700 } },
			}),
		];
		const rows = formatOverlayRows(records, 1_000_045_000, () => "OpenCode Go");
		assert.equal(rows.length, 1);
		const [model, extra] = rows[0].details;
		assert.equal(model.text, "OpenCode Go/deepseek-v4-flash · think:max");
		assert.equal(model.color, "dim");
		// extras:活动(带参数,诊断面)+ cost;tool 计数与 token 细分不进(无决策价值)
		assert.equal(extra.text, 'tool: bash {"command":"npm test"} · cost $0.0042');
		assert.equal(extra.color, "dim");
		assert.equal(rows[0].details.length, 2);
	});

		describe("formatRecentEntry(tool call 可读行)", () => {
		test("start:args 已是 watcher 摘要,直接拼 tool: args", () => {
			assert.equal(formatRecentEntry("start:bash cd /Users/amdoi7/Desktop/ai4x"), "bash: cd /Users/amdoi7/Desktop/ai4x");
			assert.equal(formatRecentEntry("start:read src/foo.ts"), "read: src/foo.ts");
			const long = "x".repeat(70);
			assert.equal(formatRecentEntry(`start:bash ${long}`).length, 61); // 总行 60 截断
		});
		test("end 标完成,turn_end/msg 保文字", () => {
			assert.equal(formatRecentEntry("end:bash"), "bash ✓");
			assert.equal(formatRecentEntry("turn_end"), "turn_end");
			assert.equal(formatRecentEntry("msg:seal→zhizao 证据已齐"), "msg:seal→zhizao 证据已齐");
		});
	});

	test("无模型/无活动时 details 为空", () => {
		const idleRows = formatOverlayRows(
			[rec({ id: "pi-worker-y#222222", name: "y", state: "idle", createdAt: 1 })],
			1_000_000,
		);
		assert.equal(idleRows[0].details.length, 0);
	});

	test("终态(done/killing)无决策价值,不列出", () => {
		const records = [
			rec({ id: "pi-worker-x#111111", name: "x", state: "done", createdAt: 1 }),
			rec({ id: "pi-worker-y#222222", name: "y", state: "killing", createdAt: 2 }),
			rec({ id: "pi-worker-z#333333", name: "z", state: "starting", createdAt: 3 }),
		];
		const rows = formatOverlayRows(records, 1_000_000);
		assert.deepEqual(rows.map((r) => r.value), ["pi-worker-z#333333"]);
	});
});

describe("opFor(动作 → 执行操作:判决直调 manager,仅归因注入父 session)", () => {
	const A = (value, extra = {}) => ({ value, label: value, ...extra });
	const ID = "pi-worker-hank#a1b2c3";

	test("通过/强制放行 → collect;丢弃 → kill(人到人决,无 LLM 中转)", () => {
		assert.deepEqual(opFor(A("通过"), ID), { kind: "collect", audit: `已对 ${ID} 验收通过(collect)` });
		assert.deepEqual(opFor(A("强制放行"), ID, "证据已核"), { kind: "collect", audit: `已对 ${ID} 强制放行(collect),理由:证据已核` });
		assert.deepEqual(opFor(A("丢弃"), ID), { kind: "kill", audit: `已对 ${ID} 丢弃(kill)` });
	});

	test("消息 → manager.message,message 即输入原文(btw 式自由文本)", () => {
		assert.deepEqual(opFor(A("消息"), ID, "测试没写"), { kind: "message", message: "测试没写", audit: `已对 ${ID} 发送 message:测试没写` });
	});

	test("stop/kill/collect → 同名直调,陈述式审计", () => {
		assert.deepEqual(opFor(A("stop"), ID), { kind: "stop", audit: `已对 ${ID} 执行 stop` });
		assert.deepEqual(opFor(A("kill"), ID), { kind: "kill", audit: `已对 ${ID} 执行 kill` });
		assert.deepEqual(opFor(A("collect"), ID), { kind: "collect", audit: `已对 ${ID} 执行 collect` });
	});

	test("归因四路 → inject 准指令(修合约重派是真判断,保留 LLM 路径)", () => {
		assert.deepEqual(opFor(A("归因:输入"), ID), {
			kind: "inject",
			text: `对 ${ID} 撤换归因:输入 → 请执行 pi_worker collect id=${ID},修合约后同 name 重派`,
		});
		assert.equal(opFor(A("归因:收益递减"), ID).kind, "inject");
	});

	test("撤换归因四路:collect 清理 + 重派引导", () => {
		assert.equal(
			formatAttributionMessage("pi-worker-hank#a1b2c3", "输入"),
			"对 pi-worker-hank#a1b2c3 撤换归因:输入 → 请执行 pi_worker collect id=pi-worker-hank#a1b2c3,修合约后同 name 重派",
		);
		assert.equal(
			formatAttributionMessage("pi-worker-hank#a1b2c3", "能力"),
			"对 pi-worker-hank#a1b2c3 撤换归因:能力 → 请执行 pi_worker collect id=pi-worker-hank#a1b2c3,同 name 带 model/thinking 重派",
		);
		assert.equal(
			formatAttributionMessage("pi-worker-hank#a1b2c3", "胜任度"),
			"对 pi-worker-hank#a1b2c3 撤换归因:胜任度 → 请执行 pi_worker collect id=pi-worker-hank#a1b2c3,换 name 重派",
		);
		assert.equal(
			formatAttributionMessage("pi-worker-hank#a1b2c3", "收益递减"),
			"对 pi-worker-hank#a1b2c3 撤换归因:收益递减 → 请执行 pi_worker collect id=pi-worker-hank#a1b2c3,父收尾不重派",
		);
	});
});

describe("formatActionMessage", () => {
	test("机械动作(直调后)审计陈述", () => {
		assert.equal(formatActionMessage("pi-worker-hank#a1b2c3", "stop"), "已对 pi-worker-hank#a1b2c3 执行 stop");
		assert.equal(formatActionMessage("pi-worker-hank#a1b2c3", "collect"), "已对 pi-worker-hank#a1b2c3 执行 collect");
	});
});

describe("actionsFor(与状态机合法集一致)", () => {
	function r(state, extra = {}) {
		return rec({ id: "pi-worker-x#111111", name: "x", state, ...extra });
	}
	test("exited 只给 collect", () => {
		assert.deepEqual(actionsFor(r("exited")).map((a) => a.value), ["collect"]);
	});
	test("stopping 只给 kill", () => {
		assert.deepEqual(actionsFor(r("stopping")).map((a) => a.value), ["kill"]);
	});
	test("starting 只给 kill", () => {
		assert.deepEqual(actionsFor(r("starting")).map((a) => a.value), ["kill"]);
	});
	test("running 给 消息/stop/kill,kill 不可逆", () => {
		const actions = actionsFor(r("running"));
		assert.deepEqual(actions.map((a) => a.value), ["消息", "stop", "kill"]);
		assert.equal(actions[0].needsInput, true);
		assert.equal(actions[2].irreversible, true);
	});
	test("idle 给 通过/消息/丢弃/强制放行,丢弃/强制放行不可逆", () => {
		const actions = actionsFor(r("idle"));
		assert.deepEqual(actions.map((a) => a.value), ["通过", "消息", "丢弃", "强制放行"]);
		assert.equal(actions[1].needsInput, true);
		assert.equal(actions[2].irreversible, true);
		assert.equal(actions[3].irreversible, true);
		assert.equal(actions[3].needsInput, true);
	});
	test("failed 给归因四路,全部不可逆", () => {
		const actions = actionsFor(r("failed"));
		assert.deepEqual(actions.map((a) => a.value), ["归因:输入", "归因:能力", "归因:胜任度", "归因:收益递减"]);
		assert.ok(actions.every((a) => a.irreversible));
	});
	test("done/killing 无动作", () => {
		assert.deepEqual(actionsFor(r("done")), []);
		assert.deepEqual(actionsFor(r("killing")), []);
	});
});
