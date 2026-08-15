import { createHash } from "node:crypto";
import { join, sep } from "node:path";
import type { RunInput } from "./types.ts";

export const NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;
/** id 寻址唯一形态:完整 id(pi-worker-<name>#<12hex>)。name 不进寻址面——
 * name 可重名,唯一判定一律以系统生成的 id 为准;hash 为小写 hex(12 位,碰撞可忽略)。 */
export const ID_RE = /^pi-worker-[a-zA-Z0-9_-]{1,32}#[0-9a-f]{12}$/;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** worker 可声明的工具全集 = pi 内建 7 + 自身 send_message;tools 参数只准在此集合内
 * 收缩,无扩权面(缺省白名单已含 bash 全功率,收缩即隔离)。 */
export const KNOWN_WORKER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "send_message"] as const;

/** 子进程缺省工具白名单:基础工作面(read/bash/edit/write)+ 通信(send_message)。
 * 排除父环境的扩展工具(pi_worker/uv 等)——worker 不需要,且限面即安全。 */
export const WORKER_TOOL_ALLOWLIST = "read,bash,edit,write,send_message";

/** tools 归一化:集合语义(排序去重去空白),id hash 与 spawn 共用单一事实源;
 * 未给/全空 → undefined(缺省白名单,不进 hash——旧合约 id 稳定)。 */
export function normalizeTools(tools?: string): string | undefined {
	if (tools === undefined) return undefined;
	const set = [...new Set(tools.split(",").map((s) => s.trim()).filter((s) => s.length > 0))].sort();
	return set.length > 0 ? set.join(",") : undefined;
}

/**
 * id = pi-worker-<name>#<12hex>:name 是显示与重派标识(可重名),hash 是合约内容
 * 摘要——改合约/升档(model/thinking)自动新 id;12 hex = 48 bit,碰撞概率可忽略。
 */
export function makeWorkerId(input: RunInput): string {
	const parts: Array<[string, string]> = [];
	for (const key of ["name", "prompt", "model", "thinking"] as const) {
		const v = input[key];
		if (v === undefined) continue;
		const trimmed = v.trim();
		if (!trimmed) continue;
		parts.push([key, trimmed]);
	}
	const tools = normalizeTools(input.tools);
	if (tools) parts.push(["tools", tools]);
	const canonical = JSON.stringify(parts);
	const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
	return `pi-worker-${input.name.trim()}#${hash}`;
}

/** 子 session 审计目录(内置约定,不作参数):<cwd>/.pi/worker-sessions。 */
export function workerSessionDir(cwd: string): string {
	return join(cwd, ".pi", "worker-sessions");
}

/** O3 冷恢复:从 worker jsonl 绝对路径反解父 cwd(锚点 = worker-sessions 目录约定)。
 * 锚点缺失 = 非本扩展产物,返回 undefined 由调用方拒绝。 */
export function cwdFromWorkerSessionFile(sessionFile: string): string | undefined {
	const anchor = `${sep}.pi${sep}worker-sessions${sep}`;
	const i = sessionFile.lastIndexOf(anchor);
	return i > 0 ? sessionFile.slice(0, i) : undefined;
}

/** run 合约校验:返回缺失/非法项文案列表;空数组 = 合法。 */
export function validateRunInput(input: Partial<RunInput>): string[] {
	const errors: string[] = [];

	const name = input.name?.trim() ?? "";
	if (!name) {
		errors.push("missing name");
	} else if (!NAME_RE.test(name)) {
		errors.push(`invalid name: "${name}"; allowed chars [a-zA-Z0-9_-], length 1-32`);
	}

	// 工具面参数名是 text(RunInput 内部保持 prompt 作 handler 输入)——错误对 LLM 说 text
	const prompt = input.prompt?.trim() ?? "";
	if (!prompt) errors.push("missing text");

	if (input.thinking !== undefined) {
		const thinking = input.thinking.trim();
		if (!THINKING_LEVELS.includes(thinking as (typeof THINKING_LEVELS)[number])) {
			errors.push(`invalid thinking: "${thinking}"; allowed ${THINKING_LEVELS.join("|")}`);
		}
	}

	if (input.model !== undefined && !input.model.trim()) {
		errors.push("invalid model: empty string");
	}

	if (input.tools !== undefined) {
		if (!input.tools.trim()) {
			errors.push("invalid tools: empty string");
		} else if (input.tools.split(",").some((s) => !s.trim())) {
			errors.push(`invalid tools: "${input.tools}" contains empty segment; comma-separated, e.g. read,grep,find,ls`);
		} else {
			const unknown = [...new Set(input.tools.split(",").map((s) => s.trim()))].filter(
				(s) => !(KNOWN_WORKER_TOOLS as readonly string[]).includes(s),
			);
			if (unknown.length > 0) {
				errors.push(`invalid tools: unknown ${unknown.map((u) => `"${u}"`).join(",")}; allowed ${KNOWN_WORKER_TOOLS.join(",")}`);
			}
		}
	}

	return errors;
}

/**
 * worker 附言(append-system-prompt 注入):只载 worker 独有、代码不可强制、
 * 他处没有的条款——身份关系(声明一次)、先回执、反问与阻塞处理。
 * 反问是常态不是例外:父是常驻 agent,send_message 唤醒即答,问比独自死磕
 * 便宜(沉默的思考烧的是不可见轮次);repo 证据能裁决的才按低风险默认自推。
 * 四要素/测试过程在全局 AGENTS.md 质量契约(worker 经 pi 机制同载),不重复;
 * 设计理由与机制解释归代码注释与 memory issues,不进 prompt。
 */
export function buildWorkerPreamble(input: { name: string; id: string }): string {
	return [
		`You are worker "${input.name}": an independent async executor dispatched by the parent session via pi_worker; the parent accepts, appends turns, and retires you.`,
		"Ack first (confirm receipt + plan outline) before executing.",
		"Ask over struggle: ambiguous contract, conflict with measured reality, or scope/trade-off decisions — send_message to the parent immediately (it wakes on message; a blocking question ends this turn to await a reply). Do not assume, do not spin silently.",
		"Dubious evidence (draft/stale/conflicting) counts as an unclear contract — ask the parent; only clear unambiguous evidence allows low-risk default progress. Report key findings and blockages promptly, not only in the final report.",
	].join("\n");
}

/** 子初始 prompt:任务实例数据。身份/行为契约在 preamble(系统提示,每轮
 * 可见),通信语义在 send_message 工具 description(L2),均不在 prompt 重复。 */
export function buildInitialPrompt(input: RunInput & { id: string }): string {
	return `Task\n${input.prompt.trim()}`;
}
