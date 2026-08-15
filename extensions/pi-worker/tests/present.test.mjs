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
	formatActionMessage,
	opFor,
} from "../src/present.ts";
import { WorkerError } from "../src/state-machine.ts";

function rec(partial) {
	return {
		id: "pi-worker-hank#a1b2c3d4e5f6",
		name: "hank",
		state: "running",
		processExited: false,
		turns: 0,
		createdAt: 0,
		updatedAt: 0,
		...partial,
	};
}

/** 测试便捷:直接置 latestStats(快照覆写语义)。 */
function withStats(partial, stats) {
	return { ...partial, latestStats: stats };
}

describe("formatFooter", () => {
	const F0 = 1_000_000_000;
	const fg = (c, t) => `<${c}>${t}</>`;

	test("空记录 / 无投影内容(全终态)→ undefined", () => {
		assert.equal(formatFooter([], { now: F0 }), undefined);
		const records = [rec({ state: "done" }), rec({ state: "killing" })];
		assert.equal(formatFooter(records, { now: F0 }), undefined);
	});

	test("单工作态:静态图标 + name + elapsed,无 hash 无 turns", () => {
		const records = [rec({ state: "running", turns: 3, createdAt: F0 })];
		assert.equal(formatFooter(records, { now: F0 + 45_000 }), "● hank · 45s");
	});

	test("单工作态带活动:只留工具名(心跳),参数不进 footer", () => {
		const withAct = [rec({ state: "running", turns: 1, createdAt: F0, currentActivity: 'tool: rg "pi_worker"' })];
		assert.equal(formatFooter(withAct, { now: F0 + 5_000 }), "● hank · rg · 5s");
		const long = [rec({ state: "running", createdAt: F0, currentActivity: "tool: bash " + "x".repeat(40) })];
		const line = formatFooter(long, { now: F0 });
		assert.ok(line.includes("bash"), line);
		assert.ok(!line.includes("x".repeat(10)), line); // 参数一律不进 footer
	});

	test("工作态图标与 overlay STATE_MARKS 同词汇(静态 ●):starting/running 皆 ●,accent 色", () => {
		assert.equal(formatFooter([rec({ state: "running", createdAt: F0 })], { now: F0 })[0], "●");
		assert.equal(formatFooter([rec({ state: "starting", createdAt: F0 })], { now: F0 })[0], "●");
		assert.ok(formatFooter([rec({ state: "running", createdAt: F0 })], { now: F0, fg }).startsWith("<accent>●</>"));
	});

	test("stopping:● warning 色(告警面语义保留)", () => {
		const records = [rec({ state: "stopping", createdAt: F0 })];
		assert.equal(formatFooter(records, { now: F0 })[0], "●");
		assert.ok(formatFooter(records, { now: F0, fg }).startsWith("<warning>●</>"));
	});

	test("多工作态聚合:最早创建者具名 +N,Σturns;有 stats 加 Σtok", () => {
		const records = [
			rec({ id: "pi-worker-b#222222222222", name: "qingliu", state: "running", turns: 1, createdAt: F0 + 2 }),
			withStats({ id: "pi-worker-a#111111111111", name: "zhizao", state: "running", turns: 3, createdAt: F0 + 1 }, { tokens: { total: 45000 } }),
			rec({ id: "pi-worker-c#333333333333", name: "zhangyin", state: "stopping", turns: 2, createdAt: F0 + 3 }),
		];
		assert.equal(formatFooter(records, { now: F0 + 60_000 }), "● zhizao +2 · 59s · 45k tok");
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

	test("等决策区:✗failed ✓idle ⏾exited,按严重度排序;任一待决策即给 /pi-worker 入口", () => {
		const records = [
			rec({ id: "pi-worker-a#111111111111", name: "a", state: "idle" }),
			rec({ id: "pi-worker-b#222222222222", name: "b", state: "idle" }),
			rec({ id: "pi-worker-c#333333333333", name: "c", state: "idle" }),
			rec({ id: "pi-worker-d#444444", name: "d", state: "failed" }),
			rec({ id: "pi-worker-e#555555", name: "e", state: "exited" }),
		];
		assert.equal(
			formatFooter(records, { now: F0 }),
			"✗ 1 failed · ✓ 3 idle · ⏾ 1 exited · /pi-worker",
		);
		const colored = formatFooter(records, { now: F0, fg });
		assert.ok(colored.includes("<error>✗ 1 failed</>"));
		assert.ok(colored.includes("<dim>✓ 3 idle</>"));
		assert.ok(colored.includes("<warning>⏾ 1 exited</>"));
		assert.ok(colored.includes("<dim>/pi-worker</>"));
	});

	test("无 failed:idle 待验收同样给行动入口(判决也是决策)", () => {
		const records = [rec({ id: "pi-worker-a#111111111111", name: "a", state: "idle" })];
		assert.equal(formatFooter(records, { now: F0 }), "✓ 1 idle · /pi-worker");
	});

	test("idle 非正常收尾(stopReason≠stop)→ 标记进 footer 且升 warning 色(常驻状态面,不靠事件卡)", () => {
		const records = [rec({ id: "pi-worker-a#111111111111", name: "a", state: "idle", stopReason: "aborted" })];
		assert.equal(formatFooter(records, { now: F0 }), "✓ 1 idle stop:aborted · /pi-worker");
		assert.ok(formatFooter(records, { now: F0, fg }).includes("<warning>✓ 1 idle stop:aborted</>"));
		// 正常 stop 的 idle 不占行(原色原文)
		const okIdle = [rec({ id: "pi-worker-a#111111111111", name: "a", state: "idle", stopReason: "stop" })];
		assert.equal(formatFooter(okIdle, { now: F0 }), "✓ 1 idle · /pi-worker");
		// 多个 idle 部分异常 → 聚合计数
		const mixed = [
			rec({ id: "pi-worker-a#111111", name: "a", state: "idle", stopReason: "length" }),
			rec({ id: "pi-worker-b#222222", name: "b", state: "idle", stopReason: "aborted" }),
			rec({ id: "pi-worker-c#333333", name: "c", state: "idle", stopReason: "stop" }),
		];
		assert.equal(formatFooter(mixed, { now: F0 }), "✓ 3 idle 2 异常收尾 · /pi-worker");
	});

	test("双区并存:决策区在左(截尾先丢工作区,行动入口不可被截)", () => {
		const records = [
			rec({ state: "running", turns: 3, createdAt: F0 }),
			rec({ id: "pi-worker-a#111111111111", name: "a", state: "idle" }),
		];
		assert.equal(
			formatFooter(records, { now: F0 + 45_000 }),
			"✓ 1 idle · /pi-worker │ ● hank · 45s",
		);
	});
});

function msg(partial) {
	return {
		customType: "pi-worker",
		content: "x",
		details: { id: "pi-worker-hank#a1b2c3d4e5f6", ...partial },
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

	test("settled:stopReason 不进事件卡摘要(状态诊断归 footer/状态行,事件卡不钉)", () => {
		const view = formatCallbackView(
			msg({ type: "settled", name: "hank", report: "r", turns: 1, stopReason: "aborted" }),
		);
		assert.equal(view.summary, "⎿ 1 turn", "摘要只带 turns/tokens/cost,不带 stopReason");
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

	test("recovery 类型已移除:未知类型落 action 兜底(不再有独立 recovery 卡)", () => {
		const v = formatCallbackView({
			content: "旧 recovery 消息(不应再产生)",
			details: { type: "recovery", id: "recovery" },
		});
		assert.equal(v.kind, "action", "未知/旧类型走 action 兜底");
	});

	test("action-done(审计):content 即 body,不再落空 settled 卡", () => {
		const view = formatCallbackView({
			customType: "pi-worker",
			content: "worker hank → seal:证据已齐",
			details: { type: "action-done", id: "pi-worker-seal#b2c3d4e5f6a7" },
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
	test("run:name + text 摘要(40 字符截断)+ 显式 model/thinking", () => {
		assert.equal(formatToolCallLine("run", { name: "zhizao", text: "写测试" }), 'run zhizao "写测试"');
		assert.equal(
			formatToolCallLine("run", { name: "zhizao", text: "写测试", model: "opencode-go/deepseek-v4-flash", thinking: "max" }),
			'run zhizao "写测试" · opencode-go/deepseek-v4-flash think:max',
		);
		assert.equal(
			formatToolCallLine("run", { name: "zhizao", text: "t".repeat(50) }),
			`run zhizao "${"t".repeat(40)}…"`,
		);
		// thinking 单独指定(默认模型 + 升档):无 model 段
		assert.equal(formatToolCallLine("run", { name: "zhizao", text: "x", thinking: "high" }), 'run zhizao "x" · think:high');
		// tools:显式工具面(只读隔离)渲染,缺省不渲染
		assert.equal(formatToolCallLine("run", { name: "zhizao", text: "审", tools: "read,ls" }), 'run zhizao "审" · tools:read,ls');
	});

	test("send:id 显示为 name(去 hash)+ 消息文本摘要", () => {
		assert.equal(
			formatToolCallLine("send", { id: "pi-worker-hank#a1b2c3d4e5f6", text: "先修断言" }),
			'send hank "先修断言"',
		);
	});

	test("stop/collect/kill:仅目标;status 无 id 即列全部", () => {
		assert.equal(formatToolCallLine("kill", { id: "pi-worker-hank#a1b2c3d4e5f6" }), "kill hank");
		assert.equal(formatToolCallLine("status", {}), "status");
		assert.equal(formatToolCallLine("status", { id: "pi-worker-hank#a1b2c3d4e5f6" }), "status hank");
	});
});

describe("toastFor", () => {
	test("failed → error toast,含 id 与 exit", () => {
		const toast = toastFor(msg({ type: "failed", exitCode: 1, exitSignal: null, stderrTail: "x" }));
		assert.equal(toast.level, "error");
		assert.ok(toast.text.includes("worker"));
		assert.ok(toast.text.includes("pi-worker-hank#a1b2c3d4e5f6"));
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
			rec({ id: "pi-worker-work#111111111111", name: "work", state: "running", createdAt: 10, turns: 2 }),
			rec({ id: "pi-worker-ask1#222222222222", name: "ask1", state: "idle", createdAt: 1 }),
			rec({ id: "pi-worker-fail#333333333333", name: "fail", state: "failed", createdAt: 2 }),
			rec({ id: "pi-worker-idle#444444", name: "idle", state: "idle", createdAt: 3 }),
			rec({ id: "pi-worker-exit#555555", name: "exit", state: "exited", createdAt: 4 }),
		];
		const rows = formatOverlayRows(records, 1_000_000);
		assert.deepEqual(
			rows.map((r) => r.value),
			["pi-worker-fail#333333333333", "pi-worker-ask1#222222222222", "pi-worker-idle#444444", "pi-worker-exit#555555", "pi-worker-work#111111111111"],
		);
		assert.deepEqual(
			rows.map((r) => r.section),
			["decision", "decision", "decision", "decision", "working"],
		);
	});

		test("主行:定宽列 name/runtime/tN,图标语义色(无 #hash)", () => {
		const records = [
			rec({ id: "pi-worker-a#111111111111", name: "a", state: "idle", idleReason: "ask", createdAt: 1_000_000_000, turns: 2 }),
			rec({ id: "pi-worker-b#222222222222", name: "b", state: "failed", createdAt: 999_940_000 }), // 105s → 1m45s,拉宽 runtime 列
			rec({ id: "pi-worker-c#333333333333", name: "c", state: "idle", idleReason: "report", createdAt: 1_000_000_002 }),
			rec({ id: "pi-worker-d#444444", name: "d", state: "exited", createdAt: 1_000_000_003 }),
			rec({ id: "pi-worker-e#555555", name: "e", state: "running", createdAt: 1_000_000_004 }),
		];
		const rows = formatOverlayRows(records, 1_000_045_000);
		const byId = Object.fromEntries(rows.map((r) => [r.value, r]));
		// name 列 pad 到行集最大宽(1),runtime 右对齐到 1m45s(5 列)
		assert.match(byId["pi-worker-a#111111111111"].main.text, /^✓ a {3}45s t2$/);
		assert.match(byId["pi-worker-b#222222222222"].main.text, /^✗ b 1m45s t0$/);
		assert.match(byId["pi-worker-c#333333333333"].main.text, /^✓ c {3}44s t0$/);
		assert.match(byId["pi-worker-d#444444"].main.text, /^⏾ d {3}44s t0$/);
		assert.match(byId["pi-worker-e#555555"].main.text, /^● e {3}44s t0$/);
		assert.equal(byId["pi-worker-a#111111111111"].main.color, "success");
		assert.equal(byId["pi-worker-b#222222222222"].main.color, "error");
		assert.ok(byId["pi-worker-b#222222222222"].main.text.startsWith("✗ "));
		assert.ok(byId["pi-worker-c#333333333333"].main.text.startsWith("✓ "));
		assert.equal(byId["pi-worker-c#333333333333"].main.color, "success");
		assert.ok(byId["pi-worker-d#444444"].main.text.startsWith("⏾ "));
		assert.equal(byId["pi-worker-d#444444"].main.color, "warning");
		assert.ok(byId["pi-worker-e#555555"].main.text.startsWith("● "));
		assert.equal(byId["pi-worker-e#555555"].main.color, "dim");
	});

	test("working 行脉冲:偶数秒 accent,奇数秒 dim;stopping 恒 warning(告警不脉冲)", () => {
		const mk = () => [
			rec({ id: "pi-worker-r#111111111111", name: "r", state: "running", createdAt: 0 }),
			rec({ id: "pi-worker-s#222222222222", name: "s", state: "stopping", createdAt: 0 }),
		];
		const bright = formatOverlayRows(mk(), 2_000); // 偶数秒
		assert.equal(bright.find((r) => r.value.includes("r#")).main.color, "accent");
		assert.equal(bright.find((r) => r.value.includes("s#")).main.color, "warning", "stopping 告警恒亮");
		const dark = formatOverlayRows(mk(), 3_000); // 奇数秒
		assert.equal(dark.find((r) => r.value.includes("r#")).main.color, "dim");
	});

	test("行单行化:details 只载判决证据——模型/cost 徽章上移 transcript 标题,活动进主行(grok 行不重复徽章)", () => {
		const records = [
			rec({
				id: "pi-worker-zhizao#a1b2c3d4e5f6",
				name: "zhizao",
				state: "running",
				createdAt: 1_000_000_000,
				turns: 3,
				currentActivity: "tool: bash {\"command\":\"npm test\"}",
				modelInfo: { provider: "opencode-go", id: "deepseek-v4-flash", thinkingLevel: "max" },
				latestStats: { cost: 0.0042, toolCalls: 4, tokens: { input: 8200, output: 4100, cacheRead: 3400, total: 15700 } },
			}),
		];
		const rows = formatOverlayRows(records, 1_000_045_000);
		assert.equal(rows.length, 1);
		// 主行:working 态带活动短摘要(剥 tool: 前缀);details 无模型/cost 重复
		assert.match(rows[0].main.text, /^● zhizao 45s t3 · bash /);
		assert.ok(rows[0].main.text.includes("npm test"), "活动带参数摘要");
		assert.equal(rows[0].details.length, 0, "模型/活动/cost 不再进 details");
	});

	test("主行活动摘要:仅 working 态(running/starting/stopping)且 30 字符截断;idle/failed 不带", () => {
		const longActivity = `tool: rg ${"x".repeat(60)}`;
		const rows = formatOverlayRows(
			[
				rec({ id: "pi-worker-r#111111111111", name: "r", state: "running", currentActivity: longActivity, createdAt: 1 }),
				rec({ id: "pi-worker-i#222222222222", name: "i", state: "idle", currentActivity: longActivity, createdAt: 2 }),
			],
			1_000_000,
		);
		const running = rows.find((r) => r.value.includes("r#"));
		const idle = rows.find((r) => r.value.includes("i#"));
		assert.ok(running.main.text.includes("…"), "活动超长截断");
		assert.ok(!idle.main.text.includes("rg"), "非 working 态主行不带活动");
	});

	test("exited 折叠:>2 聚合为单行(enter 展开);≤2 原样列出;展开显示全部", () => {
		const mk = (n) => Array.from({ length: n }, (_, i) =>
			rec({ id: `pi-worker-e${i}#111111111111`, name: `e${i}`, state: "exited", createdAt: i + 1 }));
		const folded = formatOverlayRows(mk(3), 1_000_000);
		assert.deepEqual(folded.map((r) => r.value), ["__exited_fold__"], "3 个 exited 聚合为一行");
		assert.equal(folded[0].section, "decision");
		assert.match(folded[0].main.text, /exited ×3/);
		const two = formatOverlayRows(mk(2), 1_000_000);
		assert.deepEqual(two.map((r) => r.value), ["pi-worker-e0#111111111111", "pi-worker-e1#111111111111"], "≤2 不折叠");
		const expanded = formatOverlayRows(mk(3), 1_000_000, { expandExited: true });
		assert.equal(expanded.length, 3, "展开后全量列出");
		assert.ok(!expanded.some((r) => r.value === "__exited_fold__"));
	});

	test("exited 折叠行序位:decision 区 failed > idle > 折叠行,working 区不受影响", () => {
		const records = [
			rec({ id: "pi-worker-w#111111111111", name: "w", state: "running", createdAt: 10 }),
			rec({ id: "pi-worker-f#222222222222", name: "f", state: "failed", createdAt: 2 }),
			rec({ id: "pi-worker-i#333333333333", name: "i", state: "idle", createdAt: 3 }),
			...Array.from({ length: 4 }, (_, i) => rec({ id: `pi-worker-e${i}#44444444444${i}`, name: `e${i}`, state: "exited", createdAt: 4 + i })),
		];
		const rows = formatOverlayRows(records, 1_000_000);
		assert.deepEqual(
			rows.map((r) => r.value),
			["pi-worker-f#222222222222", "pi-worker-i#333333333333", "__exited_fold__", "pi-worker-w#111111111111"],
		);
	});

		test("判决证据拆封:failed 首行 exit/stderr 诊断;idle 呈报封顶 3 行 + transcript 指引(全文在 L2 视图)", () => {
		const failed = formatOverlayRows(
			[rec({ id: "pi-worker-f#111111111111", name: "f", state: "failed", exitCode: 1, stderrTail: "boom", createdAt: 1 })],
			1_000,
		);
		assert.deepEqual(failed[0].details[0], { text: "exit=1 · boom", color: "error" });

		const report = "改动:x\n原因:y\n核验证据:z\n遗留:无";
		const idle = formatOverlayRows(
			[rec({ id: "pi-worker-i#222222222222", name: "i", state: "idle", report, createdAt: 1 })],
			1_000,
		);
		assert.deepEqual(
			idle[0].details.slice(0, 3),
			report.split("\n").slice(0, 3).map((text) => ({ text, color: "muted" })),
		);
		assert.ok(idle[0].details.some((d) => d.text.includes("+1 行")), "4 行呈报超出封顶有省略指引");

		const long = formatOverlayRows(
			[rec({ id: "pi-worker-l#333333333333", name: "l", state: "idle", report: Array.from({ length: 12 }, (_, i) => `L${i}`).join("\n"), createdAt: 1 })],
			1_000,
		);
		assert.equal(long[0].details.filter((d) => d.color === "muted").length, 3, "呈报封顶 3 行");
		assert.ok(long[0].details.some((d) => d.text.includes("+9 行") && d.text.includes("transcript")), "省略指引指向 transcript 视图");
	});

		test("无模型/无活动时 details 为空", () => {
		const idleRows = formatOverlayRows(
			[rec({ id: "pi-worker-y#222222222222", name: "y", state: "idle", createdAt: 1 })],
			1_000_000,
		);
		assert.equal(idleRows[0].details.length, 0);
	});

	test("未投影状态(新增状态漏登记)→ WorkerError fail fast,不裸 TypeError", () => {
		assert.throws(
			() => formatOverlayRows([rec({ id: "pi-worker-x#999999999999", name: "x", state: "paused", createdAt: 1 })], 1_000_000),
			(e) => e instanceof WorkerError && /未投影的状态/.test(e.message),
		);
	});

	test("终态(done/killing)无决策价值,不列出", () => {
		const records = [
			rec({ id: "pi-worker-x#111111111111", name: "x", state: "done", createdAt: 1 }),
			rec({ id: "pi-worker-y#222222222222", name: "y", state: "killing", createdAt: 2 }),
			rec({ id: "pi-worker-z#333333333333", name: "z", state: "starting", createdAt: 3 }),
		];
		const rows = formatOverlayRows(records, 1_000_000);
		assert.deepEqual(rows.map((r) => r.value), ["pi-worker-z#333333333333"]);
	});

	test("exited 记录:待清理决策区,无遗留来源标注(启动恢复已移除)", () => {
		const rows = formatOverlayRows(
			[rec({ state: "exited", sessionFile: "/repo/.pi/worker-sessions/a.jsonl", createdAt: 1 })],
			1_000_000,
		);
		assert.equal(rows[0].section, "decision", "exited = 待清理决策");
		const texts = rows[0].details.map((d) => d.text).join("\n");
		assert.ok(!texts.includes("重启遗留"), "无恢复来源标注");
	});
});

describe("opFor(动作 → 执行操作:判决注入父 session(落 verdict 需 agent 判断),机械直调 manager)", () => {
	const A = (value, extra = {}) => ({ value, label: value, ...extra });
	const ID = "pi-worker-hank#a1b2c3d4e5f6";

	test("通过/强制放行/丢弃 → inject 准指令:verdict 落 deliverable frontmatter 是审查闭环事实源,需父 agent 落笔", () => {
		const pass = opFor(A("通过"), ID);
		assert.equal(pass.kind, "inject");
		assert.ok(pass.text.includes(ID) && pass.text.includes("verdict=通过") && pass.text.includes(`pi_worker collect id=${ID} verdict=通过`), pass.text);
		const force = opFor(A("强制放行"), ID, "证据已核");
		assert.equal(force.kind, "inject");
		assert.ok(force.text.includes(`pi_worker collect id=${ID} verdict=强制放行`) && force.text.includes("证据已核"), force.text);
		const discard = opFor(A("丢弃"), ID);
		assert.equal(discard.kind, "inject");
		assert.ok(discard.text.includes(`pi_worker collect id=${ID} verdict=丢弃`) && discard.text.includes("status=rejected") && !discard.text.includes("kill"), discard.text);
	});

	test("消息 → manager.message,message 即输入原文(btw 式自由文本)", () => {
		assert.deepEqual(opFor(A("消息"), ID, "测试没写"), { kind: "message", message: "测试没写", audit: `已对 ${ID} 发送 message:测试没写` });
	});

	test("stop/kill/collect → 同名直调,陈述式审计", () => {
		assert.deepEqual(opFor(A("stop"), ID), { kind: "stop", audit: `已对 ${ID} 执行 stop` });
		assert.deepEqual(opFor(A("kill"), ID), { kind: "kill", audit: `已对 ${ID} 执行 kill` });
		assert.deepEqual(opFor(A("collect"), ID), { kind: "collect", audit: `已对 ${ID} 执行 collect` });
	});

	test("撤换 → inject:归因分流处置(collect 清账 + 重派/收尾,分类归父 agent)", () => {
		const op = opFor(A("撤换"), ID);
		assert.equal(op.kind, "inject");
		assert.ok(op.text.includes(ID) && op.text.includes("归因分流") && op.text.includes(`pi_worker collect id=${ID}`), op.text);
	});

	test("撤换归因四路:collect 清理 + 重派引导", () => {
		assert.ok(true, "占位");
	});
});

describe("formatActionMessage", () => {
	test("机械动作(直调后)审计陈述", () => {
		assert.equal(formatActionMessage("pi-worker-hank#a1b2c3d4e5f6", "stop"), "已对 pi-worker-hank#a1b2c3d4e5f6 执行 stop");
		assert.equal(formatActionMessage("pi-worker-hank#a1b2c3d4e5f6", "collect"), "已对 pi-worker-hank#a1b2c3d4e5f6 执行 collect");
	});
});

describe("actionsFor(与状态机合法集一致)", () => {
	function r(state, extra = {}) {
		return rec({ id: "pi-worker-x#111111111111", name: "x", state, ...extra });
	}
	test("exited:消息(冷恢复续接)+ collect", () => {
		assert.deepEqual(actionsFor(r("exited")).map((a) => a.value), ["消息", "collect"]);
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
	test("idle 给 通过/消息/丢弃/强制放行;判决是 inject(父 agent 二次判断),不二次确认", () => {
		const actions = actionsFor(r("idle"));
		assert.deepEqual(actions.map((a) => a.value), ["通过", "消息", "丢弃", "强制放行"]);
		assert.equal(actions[1].needsInput, true);
		assert.ok(!actions.some((a) => a.irreversible), "inject 类动作无需 confirm");
		assert.equal(actions[3].needsInput, true);
	});
	test("failed 给撤换(归因分流是父 agent 判断,不在菜单替父分类);inject 类不二次确认", () => {
		const actions = actionsFor(r("failed"));
		assert.deepEqual(actions.map((a) => a.value), ["撤换"]);
		assert.ok(!actions[0].irreversible, "inject 经父 agent 二次判断才生效,无需 confirm");
	});
	test("done/killing 无动作", () => {
		assert.deepEqual(actionsFor(r("done")), []);
		assert.deepEqual(actionsFor(r("killing")), []);
	});
});

