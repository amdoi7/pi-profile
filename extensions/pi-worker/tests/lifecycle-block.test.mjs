import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
	appendLifecycleEntry,
	LIFECYCLE_ENTRY_TYPE,
	LifecycleBlockComponent,
} from "../src/lifecycle-block.ts";

const theme = {
	fg: (c, t) => `<${c}>${t}</>`,
	bold: (t) => `*${t}*`,
	bg: (_c, t) => t,
};

function rec(partial) {
	return {
		id: "pi-worker-hank#a1b2c3d4e5f6",
		name: "hank",
		state: "running",
		processExited: false,
		turns: 0,
		createdAt: 1_000_000_000,
		updatedAt: 0,
		recent: [],
		...partial,
	};
}

function setup(record) {
	// 活引用 manager stub(与 manager.status() 全量返回契约一致):投影每次 render 重读,验证活性(非快照)
	const manager = { status: () => (record ? [record] : []) };
	const data = { id: record?.id ?? "pi-worker-hank#a1b2c3d4e5f6", name: "hank", prompt: "fix auth bug", createdAt: 1_000_000_000 };
	return { manager, data };
}

describe("LifecycleBlockComponent", () => {
	test("render 反映活记录:状态迁移后重渲染文本随之变化(原位更新核心断言)", () => {
		const record = rec({ state: "running", currentActivity: "tool: rg x" });
		const { manager, data } = setup(record);
		const c = new LifecycleBlockComponent(manager, data, theme, false);
		const before = c.render(120).join("\n");
		assert.ok(before.includes("●"), "running 图标");
		assert.ok(before.includes("rg x"), "活动上屏");
		record.state = "idle";
		record.currentActivity = undefined;
		const after = c.render(120).join("\n");
		assert.ok(after.includes("✓"), "idle 图标");
		assert.ok(!after.includes("rg x"), "活动消失");
	});

	test("记录缺失(collect 后):静态回退 entry data,不抛错", () => {
		const { manager, data } = setup(undefined);
		const c = new LifecycleBlockComponent(manager, data, theme, false);
		const out = c.render(120).join("\n");
		assert.ok(out.includes('hank "fix auth bug"'));
	});

	test("宽度约束:每行可见宽 ≤ width", () => {
		const record = rec({ state: "running", currentActivity: `tool: bash ${"y".repeat(80)}` });
		const { manager, data } = setup(record);
		const c = new LifecycleBlockComponent(manager, data, theme, false);
		for (const line of c.render(40)) {
			assert.ok(visibleWidth(line) <= 40, `行宽 ${visibleWidth(line)} ≤ 40: ${line}`);
		}
	});

	test("expanded:渲染 details(模型/activity 等补充行)", () => {
		const record = rec({
			state: "idle",
			modelInfo: { provider: "p", id: "m", thinkingLevel: "low" },
			sessionFile: "/tmp/s.jsonl",
		});
		const { manager, data } = setup(record);
		const collapsed = new LifecycleBlockComponent(manager, data, theme, false).render(120);
		const expanded = new LifecycleBlockComponent(manager, data, theme, true).render(120);
		assert.ok(expanded.length > collapsed.length, "expanded 更多行");
		assert.ok(expanded.join("\n").includes("p/m"), "模型行");
	});
});

describe("appendLifecycleEntry", () => {
	test("追加 entry:type/必要字段(渲染回退的数据契约)", () => {
		const appended = [];
		const pi = { appendEntry: (type, data) => appended.push({ type, data }) };
		appendLifecycleEntry(pi, rec({}), "fix auth bug");
		assert.equal(appended.length, 1);
		assert.equal(appended[0].type, LIFECYCLE_ENTRY_TYPE);
		assert.equal(appended[0].data.id, "pi-worker-hank#a1b2c3d4e5f6");
		assert.equal(appended[0].data.name, "hank");
		assert.equal(appended[0].data.prompt, "fix auth bug");
		assert.equal(typeof appended[0].data.createdAt, "number");
	});
});
