import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkerPaneComponent, paneOverlayOptions } from "../src/pane.ts";

const theme = {
	fg: (c, t) => `<${c}>${t}</>`,
	bold: (t) => `*${t}*`,
	bg: (_c, t) => t,
	accent: "",
};

/** 剥离 theme stub 标记(<c>…</> 与 *bold*),断言纯文本内容。 */
function strip(s) {
	return s.replace(/<\/?[a-zA-Z]*>/g, "").replace(/\*/g, "");
}

function rec(partial) {
	return {
		id: "pi-worker-hank#a1b2c3d4e5f6",
		name: "hank",
		state: "running",
		processExited: false,
		turns: 1,
		createdAt: 1_000_000_000,
		updatedAt: 0,
		recent: [],
		...partial,
	};
}

function fixtureFile(text) {
	const dir = mkdtempSync(join(tmpdir(), "pi-worker-pane-"));
	const file = join(dir, "s.jsonl");
	const header = { type: "session", version: 3, id: "s", timestamp: "t", cwd: "/x" };
	const entries = [header, { type: "message", id: "e0", parentId: null, timestamp: "t", message: { role: "user", content: text } }];
	writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
	return file;
}

const tui = { terminal: { rows: 50, columns: 120 }, requestRender() {} };

function setup(records, files = {}, extra = {}) {
	const calls = { close: 0, executed: [] };
	const pane = new WorkerPaneComponent({
		records: () => records,
		providerNameFor: () => undefined,
		sessionFileFor: (r) => files[r.id] ?? "",
		theme,
		tui,
		onClose: () => calls.close++,
		execute: async (action, r, input) => calls.executed.push({ action: action.value, id: r.id, input }),
		...extra,
	});
	return { pane, calls };
}

describe("合并单窗口(list + transcript 同屏)", () => {
	test("一个 render 同时含决策队列与选中 worker 的 transcript(取消多窗口)", () => {
		const a = rec({ id: "pi-worker-a#111111111111", name: "a", state: "idle", report: "改动:x" });
		const out = strip(setup([a], { [a.id]: fixtureFile("任务全文A") }).pane.render(80).join("\n"));
		assert.ok(out.includes("待决策"), "list 区");
		assert.ok(out.includes("✓ a"), "worker 行");
		assert.ok(out.includes("改动:x"), "判决证据拆封内联");
		assert.ok(out.includes("❯ 任务全文A"), "transcript 区同屏");
	});

	test("选中切换 → transcript 区跟随重定向", () => {
		const a = rec({ id: "pi-worker-a#111111111111", name: "a", state: "idle" });
		const b = rec({ id: "pi-worker-b#222222222222", name: "b", state: "idle" });
		const { pane } = setup([a, b], { [a.id]: fixtureFile("内容A"), [b.id]: fixtureFile("内容B") });
		assert.ok(strip(pane.render(80).join("\n")).includes("内容A"));
		pane.handleInput("\x1b[B"); // ↓ 选中 b
		const out = strip(pane.render(80).join("\n"));
		assert.ok(out.includes("内容B"), "transcript 跟随选中");
		assert.ok(!out.includes("内容A"));
	});

	test("transcript 区显示标题行(图标+name+elapsed);缺文件提示不崩", () => {
		const a = rec({ id: "pi-worker-a#111111111111", name: "a", state: "idle", createdAt: 1_000_000_000 });
		const { pane } = setup([a], {});
		const out = strip(pane.render(80).join("\n"));
		assert.ok(out.includes("✓ a"), "transcript 标题行");
		assert.ok(out.includes("无 session 文件"), "缺文件提示");
	});

	test("tab 切到 transcript 区:↓ 滚动 transcript 而非移动选中;esc 回 list 区不关窗", () => {
		const a = rec({ id: "pi-worker-a#111111111111", name: "a", state: "idle" });
		const b = rec({ id: "pi-worker-b#222222222222", name: "b", state: "idle" });
		const { pane, calls } = setup([a, b], { [a.id]: fixtureFile("A"), [b.id]: fixtureFile("B") });
		pane.handleInput("\t"); // → transcript 区
		pane.handleInput("\x1b[B"); // ↓:滚动 transcript,选中不动
		const out = strip(pane.render(80).join("\n"));
		assert.ok(out.split("\n").some((l) => l.startsWith("→ ✓ a")), "选中仍是 a");
		pane.handleInput("\x1b"); // esc:回 list 区
		assert.equal(calls.close, 0, "不关窗");
		pane.handleInput("\x1b[B");
		assert.ok(strip(pane.render(80).join("\n")).split("\n").some((l) => l.startsWith("→ ✓ b")), "回 list 后 ↓ 移动选中");
	});

	test("esc 在 list 区关闭窗口", () => {
		const { pane, calls } = setup([rec({ state: "idle" })], {});
		pane.handleInput("\x1b");
		assert.equal(calls.close, 1);
	});

	test("exited 折叠行:>2 聚合列出;折叠行选中时 transcript 区预览成员;enter 展开", () => {
		const records = [
			rec({ id: "pi-worker-a#111111111111", name: "a", state: "idle" }),
			...Array.from({ length: 3 }, (_, i) => rec({ id: `pi-worker-e${i}#22222222222${i}`, name: `e${i}`, state: "exited" })),
		];
		const { pane } = setup(records, { "pi-worker-a#111111111111": fixtureFile("甲") });
		let out = strip(pane.render(80).join("\n"));
		assert.ok(out.includes("exited ×3"), "聚合行");
		assert.ok(!out.includes("⏾ e0"), "exited 行不单独列出");
		assert.ok(out.includes("❯ 甲"), "初始 transcript 是首个真实选中");
		pane.handleInput("\x1b[B"); // ↓ 选中折叠行
		out = strip(pane.render(80).join("\n"));
		assert.ok(out.includes("→ ⏾ exited ×3"), "折叠行可选中");
		assert.ok(out.includes("⏾ e0") && out.includes("⏾ e2"), "折叠行选中:transcript 区预览被聚合成员");
		pane.handleInput("\r"); // enter 展开
		out = strip(pane.render(80).join("\n"));
		assert.ok(out.includes("⏾ e0") && out.includes("⏾ e2"), "展开列出全部");
		assert.ok(!out.includes("exited ×3"), "展开后聚合行消失");
	});

	test("小视口:渲染高度受限,选中行与 transcript 区均在界内", () => {
		const records = Array.from({ length: 8 }, (_, i) =>
			rec({ id: `pi-worker-w${i}#111111111111`, name: `w${i}`, state: "idle", report: "r1\nr2\nr3" }),
		);
		const small = { terminal: { rows: 20, columns: 80 }, requestRender() {} };
		const { pane } = setup(records, {}, { tui: small });
		for (let i = 0; i < 7; i++) pane.handleInput("\x1b[B");
		const lines = pane.render(60);
		assert.ok(lines.length <= 20, `渲染 ${lines.length} 行 ≤ 终端高度`);
		assert.ok(strip(lines.join("\n")).split("\n").some((l) => l.startsWith("→ ✓ w7")), "选中行可见");
	});
});

describe("actions(判决语义不变)", () => {
	test("enter 进动作列表;动作 = actionsFor 合法集(无「查看 transcript」——transcript 已同屏)", async () => {
		const r = rec({ state: "idle" });
		const { pane, calls } = setup([r], {});
		pane.handleInput("\r");
		const out = strip(pane.render(80).join("\n"));
		assert.ok(out.includes("通过"), "判决动作在");
		assert.ok(!out.includes("查看 transcript"), "多窗口入口已取消");
		pane.handleInput("\r"); // 通过
		await new Promise((r2) => setImmediate(r2));
		assert.deepEqual(calls.executed.map((e) => e.action), ["通过"]);
	});

	test("kill(不可逆)→ confirm;确认后 execute", async () => {
		const r = rec({ state: "running" });
		const { pane, calls } = setup([r], {});
		pane.handleInput("\r"); // → actions(消息/stop/kill)
		pane.handleInput("\x1b[B");
		pane.handleInput("\x1b[B"); // → kill
		pane.handleInput("\r");
		assert.ok(strip(pane.render(80).join("\n")).includes("确认"), "confirm stage");
		assert.equal(calls.executed.length, 0);
		pane.handleInput("\r");
		await new Promise((r2) => setImmediate(r2));
		assert.deepEqual(calls.executed.map((e) => e.action), ["kill"]);
	});

	test("消息(needsInput)→ input;提交文本进 execute;actions esc 返回 list", async () => {
		const r = rec({ state: "running" });
		const { pane, calls } = setup([r], {});
		pane.handleInput("\r");
		pane.handleInput("\x1b"); // actions → list
		assert.ok(strip(pane.render(80).join("\n")).includes("待决策") || strip(pane.render(80).join("\n")).includes("工作中"), "回 list");
		pane.handleInput("\r");
		pane.handleInput("\r"); // 消息
		pane.handleInput("hi");
		pane.handleInput("\r");
		await new Promise((r2) => setImmediate(r2));
		assert.deepEqual(calls.executed, [{ action: "消息", id: r.id, input: "hi" }]);
	});
});

describe("paneOverlayOptions(合并窗口布局)", () => {
	test("宽终端:居中 85%×90%(transcript 需要宽度,单窗口即全部)", () => {
		const o = paneOverlayOptions(160, 50);
		assert.equal(o.anchor, "center");
		assert.equal(o.width, "85%");
		assert.equal(o.maxHeight, "90%");
	});

	test("窄终端(<100 列):95% 回退", () => {
		const o = paneOverlayOptions(90, 40);
		assert.equal(o.anchor, "center");
		assert.equal(o.width, "95%");
	});
});

describe("布局契约", () => {
	// 东亚宽字符计 2 列(线框/● 等符号是 1 列——>0xff 启发式会把它们误判为 2)
	const visWidth = (s) => {
		let w = 0;
		for (const ch of strip(s)) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
		return w;
	};

	test("details 只在选中行渲染(list 下方预览条带),非选中行不展开", () => {
		const { pane } = setup([
			rec({ name: "aaa", state: "failed", exitCode: 1, stderrTail: "AAA-STDERR-MARKER" }),
			rec({ id: "pi-worker-bbb#b1b2c3d4e5f6", name: "bbb", state: "idle", report: "BBB-REPORT-MARKER\nline2" }),
		]);
		// 默认选中第一行(failed aaa):bbb 的报告不得出现,aaa 的诊断必须出现
		const text = pane.render(100).map(strip).join("\n");
		assert.ok(text.includes("AAA-STDERR-MARKER"), "selected row details must render");
		assert.ok(!text.includes("BBB-REPORT-MARKER"), "non-selected row details must NOT render");
	});

	test("所有渲染行不超过 overlay 宽度(长 stderr 不溢出边框)", () => {
		const { pane } = setup([rec({ name: "aaa", state: "failed", exitCode: 1, stderrTail: "E".repeat(200) })]);
		for (const line of pane.render(80)) {
			assert.ok(visWidth(line) <= 80, `line overflows ${visWidth(line)} > 80: ${strip(line).slice(0, 60)}`);
		}
	});

	test("空/短 transcript 不独占剩余高度(连续空白 ≤ 2 行)", () => {
		const { pane } = setup([rec({ name: "solo", state: "idle", report: "r" })]);
		const blankRun = pane.render(120).map(strip).join("\n").match(/\n(\s*\n){2,}/);
		assert.ok(!blankRun, "found >2 consecutive blank lines");
	});
});
