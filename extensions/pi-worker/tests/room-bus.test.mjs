import { describe, test } from "vitest";
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
		transport: async (id, text) => {
			transports.push({ id, text });
			if (text.includes("BOOM")) throw new Error("目标已退出");
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

	test("parent → worker:走 FSM 投递原语,信封带 parent", async () => {
		const { bus, transports, delivered } = setup();
		const r = await bus.post("parent", "seal", "先修断言");
		assert.deepEqual(r, { ok: true, via: "prompt" });
		assert.deepEqual(transports, [{ id: "pi-worker-seal#bbbbbb", text: "来自「parent」的消息:先修断言" }]);
		assert.equal(delivered.length, 0); // parent 发的不需要向 parent 审计
	});

	test("worker → worker:FSM 投递 + 父 session 安静audit fan-out(世界模型不瞎)", async () => {
		const { bus, transports, delivered } = setup();
		const r = await bus.post("pi-worker-hank#aaaaaa", "seal", "证据已齐");
		assert.deepEqual(r, { ok: true, via: "prompt" });
		assert.deepEqual(transports, [{ id: "pi-worker-seal#bbbbbb", text: "来自「hank」的消息:证据已齐" }]);
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
		assert.ok(transports[0].text.includes("投递失败") && transports[0].text.includes("hi")); // 原文不丢
	});

	test("投递异常 → 通知发送方 + result 带原因", async () => {
		const { bus, transports } = setup();
		const r = await bus.post("pi-worker-hank#aaaaaa", "seal", "BOOM");
		assert.equal(r.ok, false);
		assert.ok(r.reason.includes("目标已退出"));
		assert.ok(transports.some((t) => t.id === "pi-worker-hank#aaaaaa" && t.text.includes("投递失败")));
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
		assert.ok(transports[0].text.includes("投递失败"));
	});
});
