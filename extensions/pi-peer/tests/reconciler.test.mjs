import { describe, test } from "vitest";
import assert from "node:assert/strict";

import { startReconciler } from "../src/reconciler.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 大 interval:运行态由测试手动 tick 驱动,排除定时器竞态 */
const MANUAL = 3_600_000;

describe("reconciler(在场循环:接管重试 + 退役门)", () => {
	test("首轮收敛:启动返回时已服务(session_start 即刻在场)", async () => {
		let serveCalls = 0;
		const rec = await startReconciler({
			tryServe: async () => {
				serveCalls++;
				return true;
			},
			intervalMs: MANUAL,
		});
		assert.equal(rec.serving(), true);
		assert.equal(serveCalls, 1);
		await rec.tick();
		assert.equal(serveCalls, 1, "已服务后不再尝试接管");
		rec.stop();
	});

	test("退让不是终态:占用方消失后下个 tick 接管;onYield 只通知一次", async () => {
		let holderAlive = true;
		let yields = 0;
		const rec = await startReconciler({
			tryServe: async () => !holderAlive,
			onYield: () => yields++,
			intervalMs: MANUAL,
		});
		assert.equal(rec.serving(), false, "占用方在场 → 退让");
		await rec.tick();
		assert.equal(yields, 1, "反复退让只通知一次");
		holderAlive = false; // 占用方退出
		await rec.tick();
		assert.equal(rec.serving(), true, "接管成功");
		rec.stop();
	});

	test("interval 驱动:周期重试接管;stop 后冻结", async () => {
		let serveCalls = 0;
		const rec = await startReconciler({
			tryServe: async () => {
				serveCalls++;
				return false; // 一直退让 → 每周期重试
			},
			intervalMs: 10,
		});
		await sleep(60);
		rec.stop();
		const at = serveCalls;
		assert.ok(at >= 3, `interval 应驱动多次接管重试(实际 ${at})`);
		await sleep(40);
		assert.equal(serveCalls, at, "stop 后不再 tick");
	});

	test("tryServe 抛错:onError 上报,不致命,下 tick 重试成功", async () => {
		let calls = 0;
		const errors = [];
		const rec = await startReconciler({
			tryServe: async () => {
				calls++;
				if (calls === 1) throw new Error("listen EACCES");
				return true;
			},
			onError: (e) => errors.push(String(e)),
			intervalMs: MANUAL,
		});
		assert.equal(rec.serving(), false);
		assert.equal(errors.length, 1);
		await rec.tick();
		assert.equal(rec.serving(), true, "错误后重试成功");
		rec.stop();
	});

	test("不重入:挂起的 tick 阻挡后续 tick(接管含 IO,禁止并发抢占自己)", async () => {
		let pending;
		let serveCalls = 0;
		let alive = false;
		const rec = await startReconciler({
			tryServe: async () => {
				serveCalls++;
				if (!alive) return false; // 首轮:退让,立即返回
				await new Promise((r) => (pending = r)); // 后续:挂起模拟慢接管
				return true;
			},
			intervalMs: MANUAL,
		});
		alive = true;
		const slow = rec.tick(); // 挂起中
		await rec.tick(); // 在途 → 空转
		await rec.tick(); // 在途 → 空转
		assert.equal(serveCalls, 2, "首轮 + 挂起中的一次;重入被挡");
		pending();
		await slow;
		assert.equal(rec.serving(), true);
		rec.stop();
	});

	test("退役门(服务中终端脱离):onRetire(wasServing=true) 恰一次,永久停机", async () => {
		let detached = false;
		let serveCalls = 0;
		const retired = [];
		const rec = await startReconciler({
			tryServe: async () => {
				serveCalls++;
				return true;
			},
			shouldRetire: () => detached,
			onRetire: (wasServing) => retired.push(wasServing),
			intervalMs: MANUAL,
		});
		assert.equal(rec.serving(), true);
		detached = true;
		await rec.tick();
		assert.deepEqual(retired, [true], "退役告知需释放 socket");
		assert.equal(rec.serving(), false);
		await rec.tick();
		await rec.tick();
		assert.equal(serveCalls, 1, "退役后冻结,不再接管");
		assert.deepEqual(retired, [true], "onRetire 不重发");
	});

	test("退役门(首轮即脱离):不尝试接管,onRetire(wasServing=false)", async () => {
		let serveCalls = 0;
		const retired = [];
		const rec = await startReconciler({
			tryServe: async () => {
				serveCalls++;
				return true;
			},
			shouldRetire: () => true,
			onRetire: (wasServing) => retired.push(wasServing),
			intervalMs: MANUAL,
		});
		assert.equal(serveCalls, 0, "退役优先于接管");
		assert.deepEqual(retired, [false], "未服务过,无需释放");
		assert.equal(rec.serving(), false);
	});

	test("影子检测(服务中):amIServing 返回 taken → 退役;gone → 席位重建", async () => {
		// taken:另一进程 rm+listen 接管了同一 socket,本进程 fd 已失效 → 退役让位。
		// gone:路径被外部移除 → 不退役,置 serving=false 重建,下 tick 重新接管。
		const retired = [];
		let serveCalls = 0;
		let shadow;
		const rec = await startReconciler({
			tryServe: async () => {
				serveCalls++;
				return true; // 首轮接管成功
			},
			amIServing: () => shadow,
			onRetire: (wasServing) => retired.push(wasServing),
			intervalMs: MANUAL,
		});
		assert.equal(rec.serving(), true, "首轮在场");
		shadow = "taken"; // 被接管
		await rec.tick();
		assert.deepEqual(retired, [true], "taken → 退役并释放 socket");
		assert.equal(rec.serving(), false);
		await rec.tick();
		assert.equal(serveCalls, 1, "退役后冻结,不再尝试接管(身份已让渡)");
	});

	test("影子检测(gone):路径被外部移除 → 席位重建,下 tick 重新接管", async () => {
		const retired = [];
		let serveCalls = 0;
		let shadow = "ok";
		const rec = await startReconciler({
			tryServe: async () => {
				serveCalls++;
				return true;
			},
			amIServing: () => shadow,
			onRetire: (wasServing) => retired.push(wasServing),
			intervalMs: MANUAL,
		});
		assert.equal(rec.serving(), true, "首轮在场");
		shadow = "gone"; // 外部移除
		await rec.tick();
		assert.deepEqual(retired, [], "gone 不退役");
		assert.equal(rec.serving(), true, "gone 同 tick 内即重建(置 serving=false 后立即 tryServe)");
		shadow = "ok"; // 外部接管方退出,自己重新接管成功
		await rec.tick();
		assert.equal(rec.serving(), true, "重建成功");
		rec.stop();
	});

	test("影子检测(退让中):未服务也检查,被接管后退役", async () => {
		const retired = [];
		const rec = await startReconciler({
			tryServe: async () => false, // 一直退让
			amIServing: () => "taken", // 从未真正服务(被接管)
			onRetire: (wasServing) => retired.push(wasServing),
			intervalMs: MANUAL,
		});
		await rec.tick();
		assert.deepEqual(retired, [false], "未服务被接管 → 退役(无需释放 socket)");
	});
});
