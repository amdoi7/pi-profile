import { describe, test } from "vitest";
import assert from "node:assert/strict";

import { formatCallback, CALLBACK_TYPE } from "../src/bridge.ts";

/** settled 回调:首行摘要保留(兼容既有解析),XML 模板注入结构化字段供父机器断言。 */
describe("formatCallback settled XML 注入", () => {
	test("完整字段:id/name/status/turns/usage(tool_calls/tokens/cost),report 全文在 <report> 内", () => {
		const msg = formatCallback({
			type: "settled",
			id: "pi-worker-hank#aaaaaa",
			name: "hank",
			report: "改动:修复空指针\n证据:测试通过\n遗留:无",
			stats: { tokens: { input: 8200, output: 4100, cacheRead: 3400, cacheWrite: 1200, total: 16900 }, toolCalls: 4, cost: 0.0042 },
			turns: 3,
		});
		assert.equal(msg.customType, CALLBACK_TYPE);
		assert.match(msg.content, /^settled id=pi-worker-hank#aaaaaa name=hank\n/);
		assert.match(msg.content, /<worker-settled>/);
		assert.match(msg.content, /<id>pi-worker-hank#aaaaaa<\/id>/);
		assert.match(msg.content, /<name>hank<\/name>/);
		assert.match(msg.content, /<status>settled<\/status>/);
		assert.match(msg.content, /<turns>3<\/turns>/);
		assert.match(msg.content, /<tool_calls>4<\/tool_calls>/);
		assert.match(msg.content, /<tokens><input>8200<\/input><output>4100<\/output><cacheRead>3400<\/cacheRead><cacheWrite>1200<\/cacheWrite><total>16900<\/total><\/tokens>/);
		assert.match(msg.content, /<cost>0.0042<\/cost>/);
		assert.match(msg.content, /<report>\n改动:修复空指针\n证据:测试通过\n遗留:无\n<\/report>/);
		assert.match(msg.content, /<\/worker-settled>$/);
		// details 保持机器字段(渲染层依赖 details.report 纯文本,不受注入影响)
		assert.equal(msg.details.report, "改动:修复空指针\n证据:测试通过\n遗留:无");
		assert.equal(msg.details.turns, 3);
	});

	test("report 含 XML 特殊字符 → 实体转义,模板不被破坏", () => {
		const msg = formatCallback({
			type: "settled",
			id: "pi-worker-hank#aaaaaa",
			name: "hank",
			report: "a < b && c > d",
			stats: { tokens: { total: 15 }, cost: 0.001 },
		});
		assert.match(msg.content, /<report>\na &lt; b &amp;&amp; c &gt; d\n<\/report>/);
		assert.ok(!/<report>\na </.test(msg.content), "raw < 不得出现在 report 内");
	});

	test("name 含特殊字符(用户可输入)→ 实体转义", () => {
		const msg = formatCallback({
			type: "settled",
			id: "pi-worker-a&b#cccccc",
			name: "a<b>&c",
			report: "r",
			stats: { tokens: { total: 15 }, cost: 0.001 },
		});
		assert.match(msg.content, /<name>a&lt;b&gt;&amp;c<\/name>/);
	});

	test("无 stats 无 turns → 无 <usage> <turns> 段,仅 id/name/status/report", () => {
		const msg = formatCallback({ type: "settled", id: "pi-worker-hank#aaaaaa", name: "hank", report: "r" });
		assert.ok(!msg.content.includes("<usage>"));
		assert.ok(!msg.content.includes("<turns>"));
		assert.match(msg.content, /<status>settled<\/status>/);
		assert.match(msg.content, /<report>\nr\n<\/report>/);
	});

	test("report 缺失 → 回退占位进 <report>,details.report 保留原始值", () => {
		const msg = formatCallback({ type: "settled", id: "pi-worker-hank#aaaaaa", name: "hank", reportError: "rpc 断" });
		assert.match(msg.content, /<report>\n\(呈报获取失败: rpc 断\)\n<\/report>/);
		assert.equal(msg.details.report, undefined);
		assert.equal(msg.details.reportError, "rpc 断");
	});

	test("stats 部分字段缺失(toolCalls/cost/cacheRead 缺省)→ 有值的段输出,无值省略", () => {
		const msg = formatCallback({
			type: "settled",
			id: "pi-worker-hank#aaaaaa",
			name: "hank",
			report: "r",
			stats: { tokens: { total: 100 } },
			turns: 1,
		});
		assert.match(msg.content, /<usage>\n<tokens><total>100<\/total><\/tokens>\n<\/usage>/);
		assert.ok(!msg.content.includes("<tool_calls>"));
		assert.ok(!msg.content.includes("<cost>"));
	});
});

describe("formatCallback failed(回归:不变)", () => {
	test("failed:exit + stderr 尾不变", () => {
		const msg = formatCallback({ type: "failed", id: "pi-worker-hank#aaaaaa", exitCode: 2, exitSignal: null, stderrTail: "boom" });
		assert.equal(msg.content, "failed id=pi-worker-hank#aaaaaa exit=2 stderr=boom");
		assert.equal(msg.details.exitCode, 2);
	});
});

describe("formatCallback sessionFile(原生审计指针)", () => {
	const SESSION = "/repo/.pi/worker-sessions/x.jsonl";

	test("settled 带 sessionFile → details 机器字段 + content 行携带路径", () => {
		const msg = formatCallback({ type: "settled", id: "pi-worker-hank#aaaaaa", name: "hank", report: "r", sessionFile: SESSION });
		assert.equal(msg.details.sessionFile, SESSION);
		assert.ok(msg.content.includes(` session=${SESSION}`), msg.content);
	});

	test("无 sessionFile(握手未成)→ details 无字段,content 行不变", () => {
		const msg = formatCallback({ type: "settled", id: "pi-worker-hank#aaaaaa", name: "hank", report: "r" });
		assert.ok(!("sessionFile" in msg.details));
		assert.ok(!msg.content.includes("session="));
	});

	test("failed 带 sessionFile → details + content 行携带", () => {
		const msg = formatCallback({ type: "failed", id: "pi-worker-hank#aaaaaa", exitCode: 2, exitSignal: null, stderrTail: "boom", sessionFile: SESSION });
		assert.equal(msg.details.sessionFile, SESSION);
		assert.ok(msg.content.includes(` session=${SESSION}`));
	});
});
