import { describe, test, vi } from "vitest";
import assert from "node:assert/strict";

import { RoomBus } from "../src/room-bus.ts";

/** RoomBus 单测:resolve/deliver/audit fan-out/failure receipt,全 fake,无进程。 */
function setup({ resolveAmbiguous = [] } = {}) {
	const delivered = []; // { msg, quiet }
	const transports = []; // { id, text }
	const live = new Map([
		["hank", "pi-worker-hank#aaaaaa"],
		["seal", "pi-worker-seal#bbbbbb"],
	]);
	const bus = new RoomBus({
		deliver: (msg, opts) => delivered.push({ msg, quiet: opts?.quiet === true }),
		resolve: (to) => {
			if (resolveAmbiguous.includes(to)) return undefined; // 歧义与不存在的区分归 manager,bus 只见未命中
			return live.get(to) ?? (live.has(to) ? undefined : undefined);
		},
		transport: async (id, text, mode) => {
			transports.push({ id, text, mode });
			if (text.includes("BOOM")) throw new Error("目标已退出");
			if (mode === "followUp" && id.includes("running")) return "queued";
			return id.includes("running") ? "steer" : "prompt";
		},
		displayNameOf: (id) => id.match(/^pi-worker-(.+)#[0-9a-f]{6}$/)?.[1] ?? id,
	});
	return { bus, delivered, transports };
}

describe("post:resolve 与 deliver", () => {
	test("worker → parent:消息卡,唤醒(quiet=false),from 进 content", async () => {
		const { bus, delivered } = setup();
		const r = await bus.post("pi-worker-hank#aaaaaa", "parent", "验收证据已齐");
		assert.deepEqual(r, { ok: true, via: "display" });
		assert.equal(delivered.length, 1);
		assert.equal(delivered[0].quiet, false); // parent-bound 唤醒:消息即请求注意
		assert.equal(delivered[0].msg.details.type, "message");
		assert.equal(delivered[0].msg.details.text, "验收证据已齐");
		assert.ok(delivered[0].msg.content.includes("hank"));
	});

	test("worker → parent quiet=true → 安静留痕(quiet 透传,不唤醒)", async () => {
		const { bus, delivered } = setup();
		const r = await bus.post("pi-worker-hank#aaaaaa", "parent", "进展同步", true);
		assert.deepEqual(r, { ok: true, via: "display" });
		assert.equal(delivered.length, 1);
		assert.equal(delivered[0].quiet, true);
		assert.equal(delivered[0].msg.details.type, "message");
	});

	test("parent → worker:走 FSM 投递原语,信封带 parent;mode 缺省 steer", async () => {
		const { bus, transports, delivered } = setup();
		const r = await bus.post("parent", "seal", "先修断言");
		assert.deepEqual(r, { ok: true, via: "prompt" });
		assert.deepEqual(transports, [{ id: "pi-worker-seal#bbbbbb", text: "message from “parent”: 先修断言", mode: "steer" }]);
		assert.equal(delivered.length, 0); // parent 发的不需要向 parent 审计
	});

	test("post mode=followUp:透传 delivery primitive(running 排队语义归 manager),via 由原语决定", async () => {
		const { bus, transports } = setup();
		const r = await bus.post("parent", "hank", "改需求", false, "followUp");
		assert.deepEqual(transports, [{ id: "pi-worker-hank#aaaaaa", text: "message from “parent”: 改需求", mode: "followUp" }]);
		assert.equal(r.ok, true);
	});

	test("worker → worker:FSM 投递 + 父 session 安静audit fan-out(父转录与真实执行一致)", async () => {
		const { bus, transports, delivered } = setup();
		const r = await bus.post("pi-worker-hank#aaaaaa", "seal", "证据已齐");
		assert.deepEqual(r, { ok: true, via: "prompt" });
		assert.deepEqual(transports, [{ id: "pi-worker-seal#bbbbbb", text: "message from “hank”: 证据已齐", mode: "steer" }]);
		assert.equal(delivered.length, 1);
		assert.equal(delivered[0].quiet, true); // peer 流量安静留痕,不烧父轮次
		assert.equal(delivered[0].msg.details.type, "action-done");
		assert.ok(delivered[0].msg.content.includes("hank → seal"));
	});
});

describe("post:failure receipt到发送方(能行动的边界)", () => {
	test("目标不存在 → 通知发送方 worker(自我修正),result 带原因与原文", async () => {
		const { bus, transports } = setup();
		const r = await bus.post("pi-worker-hank#aaaaaa", "ghost", "hi");
		assert.equal(r.ok, false);
		assert.ok(r.reason.includes("ghost"));
		assert.equal(transports.length, 1);
		assert.equal(transports[0].id, "pi-worker-hank#aaaaaa"); // 回执给发送方
		assert.ok(transports[0].text.includes("hi"), "原文不丢");
	});

	test("投递异常 → 通知发送方 + result 带原因", async () => {
		const { bus, transports } = setup();
		const r = await bus.post("pi-worker-hank#aaaaaa", "seal", "BOOM");
		assert.equal(r.ok, false);
		assert.ok(r.reason.includes("目标已退出"));
		assert.ok(transports.some((t) => t.id === "pi-worker-hank#aaaaaa" && t.text.length > 0), "回执送达发送方");
	});

	test("发送方是 parent:不回执(调用方拿 result),失败原因上抛", async () => {
		const { bus, transports } = setup();
		const r = await bus.post("parent", "ghost", "hi");
		assert.equal(r.ok, false);
		assert.equal(transports.length, 0);
	});

	test("歧义目标(resolve 未命中)→ 按不存在处理,通知发送方", async () => {
		const { bus, transports } = setup({ resolveAmbiguous: ["seal"] });
		const r = await bus.post("pi-worker-hank#aaaaaa", "seal", "hi");
		assert.equal(r.ok, false);
		assert.ok(transports[0].text.includes("hi"), "回执告知失败(原文不丢)");
	});
});

describe("post:唤醒配额与重复抑制(worker→parent,非 quiet 才占额)", () => {
	test("配额内连发正常唤醒;第 7 条超窗上限 → quiet 降级 + 回执发送方", async () => {
		const { bus, delivered, transports } = setup();
		for (let i = 1; i <= 6; i++) {
			const r = await bus.post("pi-worker-hank#aaaaaa", "parent", `证据 ${i}`);
			assert.deepEqual(r, { ok: true, via: "display" }, `第 ${i} 条应正常`);
			assert.equal(delivered[i - 1].quiet, false, `第 ${i} 条应唤醒`);
		}
		const r = await bus.post("pi-worker-hank#aaaaaa", "parent", "证据 7");
		assert.deepEqual(r, { ok: true, via: "display" }, "降级仍投递(留痕),不丢消息");
		assert.equal(delivered[6].quiet, true, "超限降级为安静留痕");
		const receipt = transports.at(-1);
		assert.ok(receipt && typeof receipt.text === "string" && receipt.text.length > 0, `回执应告知降级: ${receipt?.text}`);
	});

	test("同文重复短窗内 → 整体丢弃 + 回执(loop 断),不算一次唤醒", async () => {
		const { bus, delivered, transports } = setup();
		await bus.post("pi-worker-hank#aaaaaa", "parent", "重复文本");
		const r = await bus.post("pi-worker-hank#aaaaaa", "parent", "重复文本");
		assert.equal(r.ok, false);
		assert.equal(typeof r.reason, "string");
		assert.equal(delivered.length, 1, "第二条不投递");
		assert.ok(transports.at(-1).text.includes("重复文本"), "回执告知丢弃(原文带回执)");
		// 丢弃不占配额:改文本后可继续唤醒
		const r3 = await bus.post("pi-worker-hank#aaaaaa", "parent", "不同文本");
		assert.equal(r3.ok, true);
		assert.equal(delivered[1].quiet, false);
	});

	test("quiet 消息不占唤醒配额;配额窗滑动后恢复唤醒", async () => {
		vi.useFakeTimers();
		try {
			const { bus, delivered } = setup();
			for (let i = 1; i <= 6; i++) await bus.post("pi-worker-hank#aaaaaa", "parent", `唤醒 ${i}`);
			// quiet 不占额
			const rq = await bus.post("pi-worker-hank#aaaaaa", "parent", "安静留痕", true);
			assert.equal(rq.ok, true);
			assert.equal(delivered[6].quiet, true, "quiet 透传(非降级)");
			// 窗内第 7 条唤醒 → 降级
			const r7 = await bus.post("pi-worker-hank#aaaaaa", "parent", "唤醒 7");
			assert.equal(delivered[7].quiet, true, "窗内超限降级");
			// 滑出窗口后恢复
			vi.advanceTimersByTime(121_000);
			const r8 = await bus.post("pi-worker-hank#aaaaaa", "parent", "窗口后唤醒");
			assert.equal(r8.ok, true);
			assert.equal(delivered[8].quiet, false, "窗口滑动后恢复唤醒");
		} finally {
			vi.useRealTimers();
		}
	});

	test("配额按 sender 独立记账:一个 worker 超限不影响另一个", async () => {
		const { bus, delivered } = setup();
		for (let i = 1; i <= 6; i++) await bus.post("pi-worker-hank#aaaaaa", "parent", `hank ${i}`);
		const r = await bus.post("pi-worker-seal#bbbbbb", "parent", "seal 首条");
		assert.equal(r.ok, true);
		assert.equal(delivered.at(-1).quiet, false, "seal 不受 hank 配额影响");
	});
});
