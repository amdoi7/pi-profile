import { createHash } from "node:crypto";
import type { RunInput } from "./types.ts";

export const NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * id = pi-worker-<name>#<6hex>:name 是路由与期望缓存(稳定身份),hash 是合约内容
 * 摘要——改合约/升档(model/thinking)自动新 id,撤换无需专用机制。
 * oneshot 是生命周期模式,不进 hash。
 */
export function makeWorkerId(input: RunInput): string {
	const parts: Array<[string, string]> = [];
	for (const key of ["name", "task", "role", "acceptance", "contextRefs", "model", "thinking"] as const) {
		const v = input[key];
		if (v === undefined) continue;
		const trimmed = v.trim();
		if (!trimmed) continue;
		parts.push([key, trimmed]);
	}
	const canonical = JSON.stringify(parts);
	const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 6);
	return `pi-worker-${input.name.trim()}#${hash}`;
}

/** run 合约校验:返回缺失/非法项文案列表;空数组 = 合法。 */
export function validateRunInput(input: Partial<RunInput>): string[] {
	const errors: string[] = [];

	const name = input.name?.trim() ?? "";
	if (!name) {
		errors.push("name 缺失");
	} else if (!NAME_RE.test(name)) {
		errors.push(`name 非法: "${name}";合法字符 [a-zA-Z0-9_-],长度 1-32`);
	}

	const task = input.task?.trim() ?? "";
	if (!task) errors.push("task 缺失");

	if (input.thinking !== undefined) {
		const thinking = input.thinking.trim();
		if (!THINKING_LEVELS.includes(thinking as (typeof THINKING_LEVELS)[number])) {
			errors.push(`thinking 非法: "${thinking}";可选 ${THINKING_LEVELS.join("|")}`);
		}
	}

	if (input.model !== undefined && !input.model.trim()) {
		errors.push("model 非法: 空字符串");
	}

	return errors;
}

/**
 * worker 宪法(append-system-prompt 注入,子进程 --no-context-files 不加载父
 * AGENTS.md):身份 + 治理契约(四要素/先回执/失败归因/事实核验)。
 * 与 AGENTS.md「黄河水清」worker 契约同源——改动任一方需同步(显式注入的
 * 代价:维护副本;收益:worker 不依赖父 cwd 的 AGENTS.md 存在与否)。
 */
export function buildWorkerCharter(input: { name: string; id: string; sessionDir: string }): string {
	return [
		`你是 worker「${input.name}」:由父 session 经 pi_worker 工具分发的独立异步执行者,与父上下文隔离。`,
		"父 session 负责验收、追加轮次与撤换决策;你只看到本任务与后续轮次,独立执行。",
		"交付契约:改动、原因、核验证据、遗留问题四要素齐备;先回执(确认接收 + 计划概要)再执行;" +
			"无测试过程的改动不视为完成。",
		"失败归因:先检查输入(任务合约、验收命令、边界),收紧输入重派;输入干净仍不符才考虑自身能力。",
		"事实核验优先级:repo 产物与测试结果 > 回调呈报 > 子 session 审计。",
		"自主:受阻按低风险默认推进;无法推进时在呈报「遗留」中说明阻塞并结束本轮,父会以新轮次跟进。",
		`审计:本会话记录于 ${input.sessionDir};会话 id:${input.id}。`,
	].join("\n");
}

/** 子初始 prompt 模板:任务/角色/验收/自主(实例数据)。身份/关系/行为准则已在
 * charter(系统提示,每轮可见);prompt 只留实例 + 引用,不重复宪法内容。 */
export function buildInitialPrompt(
	input: RunInput & { id: string; sessionDir: string },
): string {
	const sections: string[] = [
		`你是 worker「${input.name.trim()}」,执行下述任务;治理契约见系统提示末尾(worker 宪法)。`,
		`任务\n${input.task.trim()}`,
	];
	if (input.role?.trim()) sections.push(`角色\n${input.role.trim()}`);
	if (input.acceptance?.trim()) sections.push(`验收标准\n${input.acceptance.trim()}`);
	if (input.contextRefs?.trim()) sections.push(`上下文引用\n${input.contextRefs.trim()}`);
	sections.push(
		`自主\n与 parent 或其他 worker 通信用 send_message(异步,发出后继续推进,不等答复);回执与常规沟通直接写在回复文本中。`,
	);
	return sections.join("\n\n");
}
