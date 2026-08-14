import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
/**
 * worker session 目录。带 parentPid = spawn 用的归属命名空间(同 cwd 多 TUI
 * 窗口互不认领;所有权编码进目录结构,零 sidecar);不带 = 扫描基目录。
 */
export function workerSessionDir(cwd: string, parentPid?: number): string {
	const base = join(cwd, ".pi", "worker-sessions");
	return parentPid === undefined ? base : join(base, `p${parentPid}`);
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

	const prompt = input.prompt?.trim() ?? "";
	if (!prompt) errors.push("prompt 缺失");

	if (input.thinking !== undefined) {
		const thinking = input.thinking.trim();
		if (!THINKING_LEVELS.includes(thinking as (typeof THINKING_LEVELS)[number])) {
			errors.push(`thinking 非法: "${thinking}";可选 ${THINKING_LEVELS.join("|")}`);
		}
	}

	if (input.model !== undefined && !input.model.trim()) {
		errors.push("model 非法: 空字符串");
	}

	if (input.tools !== undefined) {
		if (!input.tools.trim()) {
			errors.push("tools 非法: 空字符串");
		} else if (input.tools.split(",").some((s) => !s.trim())) {
			errors.push(`tools 非法: "${input.tools}" 含空段;逗号分隔,如 read,grep,find,ls`);
		} else {
			const unknown = [...new Set(input.tools.split(",").map((s) => s.trim()))].filter(
				(s) => !(KNOWN_WORKER_TOOLS as readonly string[]).includes(s),
			);
			if (unknown.length > 0) {
				errors.push(`tools 非法: 未知工具 ${unknown.map((u) => `"${u}"`).join(",")};可选 ${KNOWN_WORKER_TOOLS.join(",")}`);
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
		`你是 worker「${input.name}」:父 session 经 pi_worker 分发的独立异步执行者;父负责验收、追加轮次与撤换。`,
		"先回执(确认接收 + 计划概要)再执行。",
		"提问优先于死磕:合约不清、与实测冲突、或涉 scope/取舍,立即 send_message 问父(父可被唤醒即时答复),阻塞提问后结束本轮等答复——不独自脑补,不在沉默中空转。",
		"证据存疑(草稿/过时/与任务口径冲突)视同合约不清——问父;仅证据明确无歧义时按低风险默认推进。关键发现与阻塞及时上报,不攒到最终呈报。",
	].join("\n");
}

/** 拟合循环 A/B 钩子:PI_WORKER_COMMS_FILE 设置时以其文件内容整体替换缺省
 * 通信节(仅 eval 对照实验用,与 spawner 的 PI_WORKER_PREAMBLE_FILE 配套)。 */
function commsOverride(): string {
	const f = process.env.PI_WORKER_COMMS_FILE;
	if (f) return readFileSync(f, "utf8").trim();
	return `通信\n回执与常规沟通直接写在回复文本中;提问、阻塞与需父即时处理的信息经 send_message 发送(父被唤醒,答复作为新轮次到达):报告类发出后继续推进,阻塞提问后结束本轮等答复。`;
}

/** 子初始 prompt:任务实例数据 + 通信机制。身份/行为契约在 preamble(系统提示,每轮
 * 可见),prompt 不重复。 */
export function buildInitialPrompt(input: RunInput & { id: string }): string {
	const sections: string[] = [`任务\n${input.prompt.trim()}`];
	sections.push(commsOverride());
	return sections.join("\n\n");
}
