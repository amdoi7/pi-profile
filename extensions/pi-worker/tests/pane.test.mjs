import { describe, test } from "vitest";
import assert from "node:assert/strict";

import { WorkerPaneComponent, paneOverlayOptions, executePaneAction } from "../src/pane.ts";
import { WorkerManager } from "../src/manager.ts";

// 测试 theme stub 输出真实 ANSI 序列(与 pi 渲染一致):truncateToWidth 只认
// ANSI 不认 <c> 标记,双栏窄宽截断必须走真实路径才不破坏样式结构。
const theme = {
	fg: (c, t) => `\x1b[38;5;1m${t}\x1b[0m`,
	bold: (t) => `\x1b[1m${t}\x1b[0m`,
	bg: (c, t) => `\x1b[48;5;1m${t}\x1b[0m`,
	accent: "",
};

/** 剥离 ANSI 序列,断言纯文本内容。 */
function strip(s) {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
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
		...partial,
	};
}

function fixtureEntries(text) {
	// transcript 数据源已平铺为 SessionEntry[](manager 持有);测试直给条目,不建文件
	return [{ type: "message", message: { role: "user", content: text } }];
}

const tui = { terminal: { rows: 50, columns: 120 }, requestRender() {} };

function setup(records, files = {}, extra = {}) {
	const calls = { close: 0, executed: [] };
	const pane = new WorkerPaneComponent({
		records: () => records,
		providerNameFor: () => undefined,
		transcriptView: (id) => files[id],
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
		const out = strip(setup([a], { [a.id]: fixtureEntries("任务全文A") }).pane.render(80).join("\n"));
		assert.ok(out.includes("待决策"), "list 区");
		assert.ok(out.includes("✓ a"), "worker 行");
		assert.ok(out.includes("改动:x"), "判决证据拆封内联");
		assert.ok(out.includes("❯ 任务全文A"), "transcript 区同屏");
	});

	test("选中切换 → transcript 区跟随重定向", () => {
		const a = rec({ id: "pi-worker-a#111111111111", name: "a", state: "idle" });
		const b = rec({ id: "pi-worker-b#222222222222", name: "b", state: "idle" });
		const { pane } = setup([a, b], { [a.id]: fixtureEntries("内容A"), [b.id]: fixtureEntries("内容B") });
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

	test("单焦点无切换:tab 无操作;PgUp/PgDn 翻看 transcript 不改变选中;esc 直接关窗", () => {
		const a = rec({ id: "pi-worker-a#111111111111", name: "a", state: "idle" });
		const b = rec({ id: "pi-worker-b#222222222222", name: "b", state: "idle" });
		const { pane, calls } = setup([a, b], { [a.id]: fixtureEntries("A"), [b.id]: fixtureEntries("B") });
		pane.handleInput("\t"); // tab 无操作(无 zone 切换,单焦点)
		pane.handleInput("\x1b[B"); // ↓:恒选择 worker(不是滚动 transcript)
		const out = strip(pane.render(80).join("\n"));
		assert.ok(out.split("\n").some((l) => l.startsWith("→ └─ ✓ b")), "↓ 恒移动选中");
		pane.handleInput("\x1b"); // esc:直接关窗(无 zone 分层)
		assert.equal(calls.close, 1, "esc 关窗");
	});

	test("esc 在 list 区关闭窗口", () => {
		const { pane, calls } = setup([rec({ state: "idle" })], {});
		pane.handleInput("\x1b");
		assert.equal(calls.close, 1);
	});

	test("空格进入 history(transcript 焦点):列表光标让位,↑↓ 不改选中,space/esc 返回", () => {
		const a = rec({ id: "pi-worker-a#111111111111", name: "a", state: "idle" });
		const b = rec({ id: "pi-worker-b#222222222222", name: "b", state: "idle" });
		const { pane } = setup([a, b], { [a.id]: fixtureEntries("A"), [b.id]: fixtureEntries("B") });
		pane.handleInput(" "); // → history
		let out = strip(pane.render(80).join("\n"));
		assert.ok(out.includes("space/esc 返回"), "history hint");
		assert.ok(!out.split("\n").some((l) => l.startsWith("→ ")), "列表光标让位(transcript 唯一光标)");
		pane.handleInput("\x1b[B"); // ↓ 在 history 内:不改选中
		out = strip(pane.render(80).join("\n"));
		assert.ok(out.includes("❯ A"), "transcript 仍是 a 的");
		pane.handleInput(" "); // 返回列表
		out = strip(pane.render(80).join("\n"));
		assert.ok(out.split("\n").some((l) => l.startsWith("→ ├─ ✓ a")), "返回后列表光标恢复");
		pane.handleInput("\x1b[B");
		assert.ok(strip(pane.render(80).join("\n")).includes("❯ B"), "返回后 ↑↓ 恢复选择");
	});

	test("history 焦点:↑↓ 消息粒度移动,锚点行带 → 光标", () => {
		const a = rec({ id: "pi-worker-a#111111111111", name: "a", state: "idle" });
		const entries = [
			{ type: "message", message: { role: "user", content: "第一问" } },
			{ type: "message", message: { role: "user", content: "第二问" } },
		];
		const { pane } = setup([a], { [a.id]: entries });
		pane.handleInput(" ");
		pane.handleInput("\x1b[A"); // 首次 ↑:阅读位置=第二问,上一消息
		let lines = pane.render(120);
		assert.ok(lines.some((l) => strip(l).includes("→ ❯ 第一问")), "光标落第一问: " + strip(lines.join("\n")).slice(0, 120));
		pane.handleInput("\x1b[B");
		lines = pane.render(120);
		assert.ok(lines.some((l) => strip(l).includes("→ ❯ 第二问")), "↓ 光标落第二问");
	});

	test("左栏自适应:短内容时右栏变宽;history 焦点再缩一档(长行单行完整)", () => {
		const a = rec({ id: "pi-worker-a#111111111111", name: "a", state: "idle", createdAt: Date.now() - 60_000 });
		const { pane } = setup([a], { [a.id]: fixtureEntries("L".repeat(70)) });
		// list 焦点:右栏 transW=67 → 72 列长行折 2 行(内容完整不截断)
		let lines = pane.render(100).map(strip);
		const listLines = lines.filter((l) => l.includes("L") && l.trim().length > 0);
		assert.equal(listLines.length, 2, "list 焦点折行(右栏 ≈67 列)");
		// history 焦点:右栏 ≥70 列 → 单行完整
		pane.handleInput(" ");
		lines = pane.render(100).map(strip);
		const histLines = lines.filter((l) => l.includes("L") && l.trim().length > 0);
		assert.equal(histLines.length, 1, "history 焦点右栏更宽,长行单行");
		assert.equal((histLines.join("\n").match(/L/g) ?? []).length, 70, "内容完整");
	});

	test("exited 折叠行:>2 聚合列出;折叠行选中时 transcript 区预览成员;enter 展开", () => {
		const records = [
			rec({ id: "pi-worker-a#111111111111", name: "a", state: "idle" }),
			...Array.from({ length: 3 }, (_, i) => rec({ id: `pi-worker-e${i}#22222222222${i}`, name: `e${i}`, state: "exited" })),
		];
		const { pane } = setup(records, { "pi-worker-a#111111111111": fixtureEntries("甲") });
		let out = strip(pane.render(80).join("\n"));
		assert.ok(out.includes("exited ×3"), "聚合行");
		assert.ok(!out.includes("⏾ e0"), "exited 行不单独列出");
		assert.ok(out.includes("❯ 甲"), "初始 transcript 是首个真实选中");
		pane.handleInput("\x1b[B"); // ↓ 选中折叠行
		out = strip(pane.render(80).join("\n"));
		assert.ok(out.includes("→ └─ ⏾ exited ×3"), "折叠行可选中");
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
		assert.ok(strip(lines.join("\n")).split("\n").some((l) => l.startsWith("→ └─ ✓ w7")), "选中行可见");
	});
});

describe("光标可见性(选中行恒 → + selectedBg 整行高亮)", () => {
	// 断言模式:strip 后定位光标行文本,再验 raw 行首 selectedBg 标记(整行高亮)
	const cursorLine = (pane, startsWith) => {
		const raw = pane.render(80);
		const line = raw.find((l) => strip(l).startsWith(startsWith));
		assert.ok(line, `找不到光标行: ${startsWith}`);
		assert.ok(line.startsWith("\x1b[48"), `光标行未整行高亮: ${strip(line).slice(0, 40)}`);
		return raw;
	};

	test("list 区:选中行 → + selectedBg 整行高亮,非选中行不高亮", () => {
		const a = rec({ id: "pi-worker-a#111111111111", name: "a", state: "idle" });
		const b = rec({ id: "pi-worker-b#222222222222", name: "b", state: "idle" });
		const { pane } = setup([a, b], {});
		cursorLine(pane, "→ ├─ ✓ a");
		const other = pane.render(80).find((l) => strip(l).startsWith("  └─ ✓ b"));
		assert.ok(other && !other.startsWith("\x1b[48"), "非选中行不高亮");
	});

	test("transcript 标题行不带箭头(单焦点,list 的 → 即唯一光标)", () => {
		const a = rec({ id: "pi-worker-a#111111111111", name: "a", state: "idle" });
		const b = rec({ id: "pi-worker-b#222222222222", name: "b", state: "idle" });
		const { pane } = setup([a, b], {});
		const lines = pane.render(80);
		const title = lines.find((l) => strip(l).includes("✓ a") && !strip(l).includes("t1"));
		assert.ok(title, "标题行在(右栏)");
		assert.ok(!strip(title).trimStart().startsWith("→ "), "标题行无箭头(唯一光标在左栏)");
	});

	test("actions stage:选中动作行同样高亮", () => {
		const r = rec({ state: "idle" });
		const { pane } = setup([r], {});
		pane.handleInput("\r"); // → actions
		const raw = pane.render(80);
		const line = raw.find((l) => strip(l).startsWith("→ 通过"));
		assert.ok(line && line.startsWith("\x1b[48"), "选中动作 → + 高亮");
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

	test("peer chat:消息提交后回 list 不关窗(关窗权在 execute,聊天循环不退出)", async () => {
		const r = rec({ state: "idle" });
		const { pane, calls } = setup([r], {});
		// 完整 chat 循环:enter → ↓消息(idle 动作集 通过/消息/丢弃/强制放行)→ 输入 → 提交 → 回 list
		const send = async (text) => {
			pane.handleInput("\r");
			pane.handleInput("\x1b[B"); // → 消息
			pane.handleInput("\r");
			pane.handleInput(text);
			pane.handleInput("\r");
			await new Promise((r2) => setImmediate(r2));
		};
		await send("hello");
		assert.equal(calls.close, 0, "消息后不关窗(等回复继续聊)");
		assert.ok(strip(pane.render(80).join("\n")).includes("↑↓ 选择"), "提交后回 list 焦点");
		await send("again");
		assert.equal(calls.executed.length, 2, "连续两轮消息(chat 循环)");
		assert.deepEqual(calls.executed.map((e) => e.input), ["hello", "again"]);
	});

	test("chat 草稿(btw 借鉴):提交成功清草稿,失败保留可编辑重试", async () => {
		const r = rec({ state: "idle" });
		let ok = true;
		const { pane } = setup(
			[r],
			{},
			{
				execute: async (_action, _rec, _input) => ok,
			},
		);
		const openInput = () => {
			pane.handleInput("\r");
			pane.handleInput("\x1b[B"); // → 消息
			pane.handleInput("\r");
		};
		// 第一轮:提交成功(execute=true)→ 草稿清空,下次进入输入态为空
		openInput();
		pane.handleInput("hello");
		pane.handleInput("\r");
		await new Promise((r2) => setImmediate(r2));
		openInput();
		assert.ok(!strip(pane.render(80).join("\n")).includes("hello"), "成功提交后草稿清空");
		pane.handleInput("\x1b"); // 退出输入
		// 第二轮:提交失败(execute=false)→ 草稿保留,可编辑重试
		ok = false;
		openInput();
		pane.handleInput("retry me");
		pane.handleInput("\r");
		await new Promise((r2) => setImmediate(r2));
		openInput();
		assert.ok(strip(pane.render(80).join("\n")).includes("retry me"), "失败后草稿保留可重试");
	});
});

	describe("段头(纯分区标签,不参与光标导航)", () => {
	// 行断言聚焦分区与光标行为:段头不可选中(↑↓ 跳过),两条目仍在
	const lineText = (pane) => strip(pane.render(80).join("\n"));

	// 组装:两段各一个 worker(decision = idle, working = running)
	function twoSections() {
		return [
			rec({ id: "pi-worker-d#333333333333", name: "d", state: "idle" }),
			rec({ id: "pi-worker-w#444444444444", name: "w", state: "running" }),
		];
	}

	test("段头渲染为纯标签(无 chevron),初始选中落到首条真实行", () => {
		const { pane } = setup(twoSections(), {});
		const out = lineText(pane);
		assert.ok(out.includes("待决策 (1)") && out.includes("工作中 (1)"), "两段头标签");
		assert.ok(!out.includes("▸") && !out.includes("▾"), "无折叠 chevron(无折叠语义)");
		assert.ok(out.split("\n").some((l) => l.startsWith("→ └─ ✓ d")), "默认选中首条真实 worker");
	});

	test("↑↓ 跳过段头:光标只落真实 worker,身份恒连续", () => {
		const { pane } = setup(twoSections(), {});
		pane.handleInput("\x1b[A"); // ↑ 从 d 向上:跳过 decision 段头,环绕到 w
		let out = lineText(pane);
		assert.ok(out.split("\n").some((l) => l.startsWith("→ └─ ● w")), "↑ 跳过段头到上一段末条真实行");
		pane.handleInput("\x1b[A"); // ↑ 从 w 向上:跳过 working 段头,环绕到 d
		out = lineText(pane);
		assert.ok(out.split("\n").some((l) => l.startsWith("→ └─ ✓ d")), "↑ 再次跳过段头环绕");
		pane.handleInput("\x1b[B"); // ↓ 回到 w
		pane.handleInput("\x1b[B"); // ↓ 从 w 向下:跳过 working 段头,环绕到 d
		out = lineText(pane);
		assert.ok(out.split("\n").some((l) => l.startsWith("→ └─ ✓ d")), "↓ 跳过段头环绕");
		assert.ok(!out.split("\n").some((l) => l.startsWith("→ 待决策") || l.startsWith("→ 工作中")), "光标不落段头");
	});

	test("段头不可 enter(无折叠语义);enter 在真实行恒进动作流", () => {
		const { pane, calls } = setup(twoSections(), {});
		pane.handleInput("\r"); // d 上 enter
		assert.ok(strip(pane.render(80).join("\n")).includes("通过"), "真实行 enter → 动作流");
		pane.handleInput("\x1b"); // 回 list
		pane.handleInput("\x1b[B"); // → w
		pane.handleInput("\r");
		assert.ok(strip(pane.render(80).join("\n")).includes("stop"), "working 行 enter → 动作流");
		pane.handleInput("\x1b");
	});

	test("PgUp/PgDn 翻看 transcript,不改变选中(list 无翻页,单焦点)", () => {
		const { pane } = setup(twoSections(), {});
		pane.handleInput("\x1b[5~"); // PgUp
		const out = lineText(pane);
		assert.ok(out.split("\n").some((l) => l.startsWith("→ └─ ✓ d")), "PgUp 不改变选中(翻看 transcript)");
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

	test("超宽终端:宽度封顶 ≈160 列(行不过长,居中留白)", () => {
		assert.equal(paneOverlayOptions(240, 50).width, "67%", "240 列 → 160 列");
		assert.equal(paneOverlayOptions(200, 50).width, "80%", "200 列 → 160 列");
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

	test("补全:短 transcript 窗内留白(高度恒满,不随内容重排)", () => {
		const { pane } = setup([rec({ name: "solo", state: "idle", report: "r" })]);
		const out = pane.render(120);
		assert.equal(out.length, 45, "面板恒满高(补全契约)");
	});

	test("补全:面板恒满高(窗口稳定,内容短时窗内留白,底边框位置恒定)", () => {
		const a = rec({ id: "pi-worker-a#111111111111", name: "a", state: "idle" });
		const { pane } = setup([a], { [a.id]: fixtureEntries("短") });
		const short = pane.render(100);
		const long = (() => {
			const { pane: p2 } = setup([a], { [a.id]: fixtureEntries("L".repeat(200)) });
			return p2.render(100);
		})();
		// tui 50 行:viewport = floor(50*0.9) - 5(边框+标题+统计+hint)= 40,总高 45
		assert.equal(short.length, 45, "短内容面板恒满高");
		assert.equal(long.length, 45, "长内容面板同高(窗口不随内容重排)");
		assert.ok(strip(short.join("\n")).includes("无 session 文件") || strip(short.join("\n")).includes("❯ 短"), "内容仍在");
	});

	test("标题统计行:✗failed ✓idle ⏾exited ●工作中(与 footer 同词汇同色),全终态省略", () => {
		const { pane } = setup([
			rec({ id: "pi-worker-a#111111111111", name: "a", state: "idle" }),
			rec({ id: "pi-worker-b#222222222222", name: "b", state: "running" }),
			rec({ id: "pi-worker-c#333333333333", name: "c", state: "exited" }),
		]);
		const out = strip(pane.render(100).join("\n"));
		assert.ok(out.includes("✓ 1 idle"), "idle 计数");
		assert.ok(out.includes("● 1 工作中"), "工作中计数");
		assert.ok(out.includes("⏾ 1 exited"), "exited 计数");
		const done = setup([rec({ id: "pi-worker-d#444444444444", name: "d", state: "done" })]);
		assert.ok(!strip(done.pane.render(100).join("\n")).includes("工作中"), "全终态省略统计行");
	});

	test("分区隔离补全:空分区也显示段头(结构恒在),段头标签加粗", () => {
		const { pane } = setup([rec({ id: "pi-worker-a#111111111111", name: "a", state: "idle" })]);
		const out = strip(pane.render(100).join("\n"));
		assert.ok(out.includes("待决策 (1)"), "决策段头");
		assert.ok(out.includes("工作中 (0)"), "空分区段头恒在(结构补全)");
	});

	test("preview 上限固定:判决证据最多 4 行,list 窗口不随选中行抖动", () => {
		const many = [rec({ name: "aaa", state: "failed", exitCode: 1, stderrTail: "D", report: "r1\nr2\nr3\nr4\nr5" })];
		const { pane } = setup(many);
		const out = strip(pane.render(100).join("\n"));
		const previewLines = out.split("\n").filter((l) => l.includes("⎿") || l.includes("exit="));
		assert.ok(previewLines.length <= 4, `判决证据 ≤ 4 行: ${previewLines.length}`);
	});

	test("空态兜底:全终态时左栏给提示,不空白;右栏给派发引导(panel 无记录也打开)", () => {
		const { pane } = setup([
			rec({ id: "pi-worker-a#111111111111", name: "a", state: "done" }),
			rec({ id: "pi-worker-b#222222222222", name: "b", state: "done" }),
		]);
		const out = strip(pane.render(100).join("\n"));
		assert.ok(out.includes("无 worker"), "空态提示");
		assert.ok(out.includes("尚无 worker"), "右栏空态标题");
		assert.ok(out.includes("pi_worker run"), "右栏派发引导");
		// 文案去重:esc 关闭 只留底部 hint 一处;左栏提示与右栏引导不再重复带 esc
		assert.equal((out.match(/esc 关闭/g) ?? []).length, 1, "esc 关闭 唯一(底部 hint)");
		assert.ok(!out.includes("无 worker 记录 · esc 关闭"), "左栏提示不带 esc 关闭");
	});

	test("统计行与列表同源(快照一致):记录变更但未 refresh 时,计数与左栏不矛盾", () => {
		const records = [rec({ id: "pi-worker-a#111111111111", name: "a", state: "idle" })];
		const { pane } = setup(records);
		// 外部 collect 清空记录,但 tick 的 refresh 还没跑(1 tick 窗口内):
		// 统计行必须与列表同快照,不得出现 "✓ 1 idle" 与 "无 worker 记录" 同屏
		records.length = 0;
		const stale = strip(pane.render(100).join("\n"));
		assert.ok(stale.includes("✓ 1 idle"), "统计行跟随快照(与左栏一致)");
		assert.ok(!stale.includes("无 worker 记录"), "同快照下不出现空态提示(不矛盾)");
		pane.refresh(); // 下一 tick
		const fresh = strip(pane.render(100).join("\n"));
		assert.ok(!fresh.includes("✓ 1 idle"), "refresh 后统计行消失");
		assert.ok(fresh.includes("无 worker 记录"), "refresh 后空态提示出现");
	});

	test("段头 ─ 线不延伸到分隔线(右缘留白);左栏行右缘齐平(选中行高亮整行)", () => {
		const { pane } = setup([rec({ id: "pi-worker-a#111111111111", name: "a", state: "idle" })]);
		const text = pane.render(100).map(strip);
		const header = text.find((l) => l.includes("待决策"));
		assert.ok(header, "段头行存在");
		const headerLeft = header.slice(0, header.indexOf("│") - 1);
		const gap = headerLeft.length - 1 - headerLeft.lastIndexOf("─");
		assert.ok(gap >= 2, `段头 ─ 线距分隔线留白 ≥2 列(实际 ${gap}): ${header}`);
		const selRow = text.find((l) => l.includes("→ └─"));
		assert.ok(selRow, "选中行存在");
		const selLeft = selRow.slice(0, selRow.indexOf("│") - 1);
		assert.equal(visWidth(selLeft), visWidth(headerLeft), "选中行右缘与段头线齐平(整行高亮,非内容宽)");
	});

	test("右栏 transcript 自动换行:长行内容完整不截断,无省略号,行不超窗口宽", () => {
		const a = rec({ id: "pi-worker-a#111111111111", name: "a", state: "idle" });
		const { pane } = setup([a], { [a.id]: fixtureEntries("L".repeat(120)) });
		const out = pane.render(80);
		const text = strip(out.join("\n"));
		assert.equal((text.match(/L/g) ?? []).length, 120, "长行内容完整(折行不截断)");
		assert.ok(!text.includes("…"), "无截断省略号");
		for (const line of out) assert.ok(visWidth(line) <= 80, `overflow ${visWidth(line)} > 80`);
	});

	test("右栏 markdown 长行同样折行完整(标题栏仍截断,正文不丢)", () => {
		const a = rec({ id: "pi-worker-a#111111111111", name: "a", state: "idle" });
		// assistant text 块走 markdown 管线:超长行不得被 fitR 截断丢内容
		const entries = [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "M".repeat(120) }] } }];
		const { pane } = setup([a], { [a.id]: entries });
		const text = strip(pane.render(80).join("\n"));
		assert.equal((text.match(/M/g) ?? []).length, 120, "markdown 长行内容完整");
	});
});

describe("executePaneAction(动作执行:判决机械收尾+注入指引;动作后不关窗)", () => {
	function mkManager() {
		const manager = new WorkerManager({ deliver: () => {}, onChange: () => {} });
		return manager;
	}
	function mkDeps(manager, calls) {
		return {
			manager,
			sendUserMessage: (t) => calls.user.push(t),
			sendAudit: (c) => calls.audit.push(c),
			notify: (t, l) => calls.notify.push({ t, l }),
		};
	}
	const ID = "pi-worker-hank#a1b2c3d4e5f6";

	test("通过 → collect(verdict) 立即执行 + frontmatter 指引注入父会话;返回 true(不关窗)", async () => {
		const manager = mkManager();
		manager.sm.run({ id: ID, name: "hank" });
		manager.sm.onStarted(ID);
		manager.sm.onSettled(ID); // → idle(待验收)
		const calls = { user: [], audit: [], notify: [] };
		const ok = await executePaneAction(mkDeps(manager, calls), { value: "通过", label: "通过" }, manager.status(ID));
		assert.equal(ok, true);
		const rec = manager.status(ID);
		assert.equal(rec.state, "done", "机械 collect 立即生效(面板反馈即实际状态)");
		assert.equal(rec.verdict, "通过");
		assert.equal(calls.user.length, 1, "frontmatter 指引注入父会话");
		assert.ok(calls.user[0].includes("frontmatter"), calls.user[0]);
		assert.equal(calls.audit.length, 1, "机械动作审计留痕");
	});

	test("撤换 → collect 清账(无 verdict)+ 归因分流指引", async () => {
		const manager = mkManager();
		manager.sm.run({ id: ID, name: "hank" });
		manager.sm.onExit(ID, { code: 1, signal: null, stderrTail: "boom" }); // running→failed
		const calls = { user: [], audit: [], notify: [] };
		const ok = await executePaneAction(mkDeps(manager, calls), { value: "撤换", label: "撤换" }, manager.status(ID));
		assert.equal(ok, true);
		const rec = manager.status(ID);
		assert.equal(rec.state, "done", "撤换 = collect 清账(终端清理)");
		assert.equal(rec.verdict, undefined, "清账不落判决");
		assert.ok(calls.user[0].includes("归因分流"), calls.user[0]);
	});

	test("stop → manager.stop 直调(记录转 stopping,倒计时起点落记录)", async () => {
		const manager = mkManager();
		manager.sm.run({ id: ID, name: "hank" });
		manager.sm.onStarted(ID); // → running
		manager.handles.set(ID, {
			rpc: { send: async () => ({ ok: true }), writeRaw: () => {} },
			proc: { exitCode: null, signalCode: null, kill: () => {} },
			sessionDir: "/tmp",
			watcher: { dispose: () => {} },
		});
		manager.transcripts.set(ID, { entries: [], hydrated: false, hydrating: false, queue: [] });
		const calls = { user: [], audit: [], notify: [] };
		const ok = await executePaneAction(mkDeps(manager, calls), { value: "stop", label: "stop" }, manager.status(ID));
		assert.equal(ok, true);
		assert.equal(manager.status(ID).state, "stopping");
		assert.ok(typeof manager.status(ID).stopStartedAt === "number");
	});

	test("消息投递失败(句柄缺失)→ 返回 false(error notify,输入草稿保留语义)", async () => {
		const manager = mkManager();
		manager.sm.run({ id: ID, name: "hank" });
		manager.sm.onStarted(ID);
		manager.sm.onSettled(ID); // → idle,无 handle
		const calls = { user: [], audit: [], notify: [] };
		const ok = await executePaneAction(mkDeps(manager, calls), { value: "消息", label: "消息" }, manager.status(ID), "hi");
		assert.equal(ok, false, "失败返回 false(可重试)");
		assert.ok(calls.notify.some((n) => n.l === "error"), "错误提示带 level=error");
	});

	test("不可逆动作(kill)不二次确认于执行层(确认在 UI stage)", async () => {
		const manager = mkManager();
		manager.sm.run({ id: ID, name: "hank" });
		manager.sm.onStarted(ID);
		manager.handles.set(ID, {
			rpc: { send: async () => ({ ok: true }), writeRaw: () => {} },
			proc: { exitCode: null, signalCode: null, kill: () => {} },
			sessionDir: "/tmp",
			watcher: { dispose: () => {} },
		});
		manager.transcripts.set(ID, { entries: [], hydrated: false, hydrating: false, queue: [] });
		const calls = { user: [], audit: [], notify: [] };
		const ok = await executePaneAction(mkDeps(manager, calls), { value: "kill", label: "kill" }, manager.status(ID));
		assert.equal(ok, true);
		assert.equal(manager.status(ID).state, "killing");
	});
});
