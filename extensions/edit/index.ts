/**
 * edit —— 文件作用域化的严格编辑工具。契约见 README：
 * 一次调用 = 一个编辑脚本；note 是批次唯一意图（docstring：为什么改），
 * files[path] 是每个文件的条目链（顺序链式执行，失败即停、成功保留）。
 *
 * 严格模式：schema 说死唯一形状——op 未用字段（含 null）、顶层多余键全部拒绝，
 * 错误即时可见，单一真相源才可能被纠正。不向后兼容。
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { EditEntry, EditRequest } from "./match.ts";
import { executeEditScript, type ScriptOutcome } from "./transaction.ts";
import { isScriptOutcome, renderCallView, renderClearedCallState, renderInvalidCall, renderResultView } from "./ui.ts";

// 平铺单对象 schema：match 必填 + 全字段可选。多余键在 schema 层被拒
//（additionalProperties:false），未声明字段（含 null）也随之被 schema 拒绝——
// 这就是严格模式：错误在 schema 就可见，不等到执行。
const filesEntrySchema = Type.Object(
	{
		match: Type.Unsafe<string | null>({
			type: ["string", "null"],
			description: "Smallest text to match.",
		}),
		new_str: Type.Optional(Type.Unsafe<string | null>({
			type: ["string", "null"],
			description: "Replacement text; omitted = delete.",
		})),
		occurrence: Type.Optional(Type.Unsafe<number | null>({
			type: ["integer", "null"],
		})),
		limit: Type.Optional(Type.Unsafe<number | null>({
			type: ["integer", "null"],
		})),
		after: Type.Optional(Type.Unsafe<string | null>({
			type: ["string", "null"],
		})),
		before: Type.Optional(Type.Unsafe<string | null>({
			type: ["string", "null"],
		})),
		regex: Type.Optional(Type.Unsafe<boolean | null>({
			type: ["boolean", "null"],
		})),
	},
	{ additionalProperties: false },
);

// 一次调用 = 一个编辑脚本：note 是批次唯一意图（docstring：为什么改），
// files 是每个文件的 op 链（顺序执行）。op 条目不带注释——一个意图驱动一批修改。
const editRequestSchema = Type.Object(
	{
		note: Type.String({
			description: "One line: why this batch of changes exists.",
		}),
		files: Type.Record(
			Type.String(),
			Type.Array(filesEntrySchema, { minItems: 1 }),
			{ description: "Map of file path → ordered entries for that file." },
		),

	},
	{ additionalProperties: false },
);

export const editRequestParameters: ToolDefinition["parameters"] = editRequestSchema;

function invalidEditRequest(message: string): never {
	throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 报错要带当前值：“must be a string” 不告诉模型它实际发了什么。 */
function describeType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

/**
 * 严格校验一个条目并收窄类型：返回的就是传进来的那个对象，没有重组。
 * 必填参数按 op 检查；op 未用的字段（含 null）一律拒绝——错误即时可见，
 * 单一真相源才可能被纠正。
 */
function checkEntry(entry: unknown, label: string): EditEntry {
	if (!isRecord(entry)) invalidEditRequest(`${label} must be an object`);
	// 单一真相源：允许字段 = schema 声明的属性（校验与 schema 永不脱节）。
	const allowed = Object.keys(filesEntrySchema.properties);
	for (const key of Object.keys(entry)) {
		if (!allowed.includes(key)) {
			invalidEditRequest(`${label}.${key} must be removed`);
		}
	}
	if (typeof entry.match !== "string") {
		invalidEditRequest(`${label}.match must be a string, got ${describeType(entry.match)}`);
	}
	if (entry.new_str !== undefined && typeof entry.new_str !== "string") {
		invalidEditRequest(`${label}.new_str must be a string, got ${describeType(entry.new_str)}`);
	}
	return entry as EditEntry;
}

/**
 * 主形状校验：note + files（path → op 链）。校验即投影：files 展平成
 * 内部条目序列（条目带 path），执行层继续吃同一种形状——schema 说死的形状
 * 和执行层吃的形状仍是同一个，只是校验处多做一次确定性投影。
 *
 * 严格闸门在这里，不依赖 TypeBox 的松 Record 校验：任何多余键（含 null）、
 * op 未用字段、缺失必填、空 note/files 都在这里即时拒绝，错误带字段名与
 * 当前值——单一真相源，一次错误立即纠正，不静默忽略。
 */
export function parseEditRequest(input: unknown): EditRequest {
	if (!isRecord(input)) invalidEditRequest("note must be an object with note and files");
	for (const key of Object.keys(input)) {
		if (key === "files" || key === "note") continue;
		invalidEditRequest(`${key} must be removed`);
	}
	if (typeof input.note !== "string" || input.note.trim() === "") {
		invalidEditRequest("note is required: one line naming why this batch exists");
	}
	const note = input.note;
	if (!isRecord(input.files)) invalidEditRequest("files must be an object");
	// 自有键枚举（getOwnPropertyNames）：__proto__/constructor 等原型键不可见但
	// 会被 for..in 之外的方式携带——严格模式必须枚举并拒绝它们，不能静默丢弃。
	const fileKeys = Object.getOwnPropertyNames(input.files);
	if (fileKeys.length === 0) invalidEditRequest("files must not be empty");
	const edits: EditEntry[] = [];
	for (const filePath of fileKeys) {
		const chain = input.files[filePath];
		if (!Array.isArray(chain)) invalidEditRequest(`files["${filePath}"] must be an array`);
		if (chain.length === 0) invalidEditRequest(`files["${filePath}"] must not be empty`);
		for (const rawEntry of chain) {
			const entry = checkEntry(rawEntry, `files["${filePath}"]`);
			edits.push({ path: filePath, ...entry });
		}
	}
	return { note, edits };
}

/**
 * agent 结果：逐条目事实。成功列 stats/定位；失败列错误与 kind；
 * skipped 列被中断的条目（模型据此只重发 failed + skipped 段）。
 */
export function buildOutcomeAgentContent(outcome: ScriptOutcome): string {
	const entries = outcome.entries.map((entry) => {
		const identity = { path: entry.edit.path, op: entry.edit.op };
		if (entry.status === "applied") {
			return {
				...identity,
				changes: entry.changeStats,
				...(entry.firstChangedLine !== undefined ? { firstChangedLine: entry.firstChangedLine } : {}),
			};
		}
		if (entry.status === "failed") {
			return {
				...identity,
				...(entry.errorKind !== undefined ? { kind: entry.errorKind } : {}),
				message: entry.error,
			};
		}
		return { ...identity, skipped: true };
	});
	return JSON.stringify({ status: outcome.status, entries });
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "edit",
		label: "edit",
		renderShell: "default",
		// prompt 面只写「与后训练先验的差量」，强 RL 模型自明的话一字不写：
		// 链式条目序列（先验是 files[].edits[] 批形状）、note 由 schema
		// required 保证、失败即停由结果信封（skipped）自明。
		description:
			"Entry = match + optional new_str (omitted = delete)."
			+ "Chain multiple entries per file in order; stops at the first failed entry.",
		parameters: editRequestParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const request = parseEditRequest(params);
			const outcome = await executeEditScript(request, ctx.cwd, signal);

			// AgentToolResult 没有 isError 字段：信封由 harness 写，写在这里会被静默丢弃；
			// 软失败靠下面的 tool_result handler 改信封。
			return {
				content: [{ type: "text" as const, text: buildOutcomeAgentContent(outcome) }],
				details: outcome,
			};
		},
		renderCall(args, theme, context) {
			if (!context.argsComplete) return renderClearedCallState(context);
			try {
				return renderCallView(parseEditRequest(args), theme, context);
			} catch (error) {
				return renderInvalidCall(error instanceof Error ? error.message : String(error), theme);
			}
		},
		renderResult(result, options, theme, context) {
			return renderResultView(
				result as { content: Array<{ type: string; text?: string }>; details?: unknown },
				options,
				theme,
				context,
			);
		},
	});

	// rejected（零写入）是失败，partial（部分条目已成、部分失败）不是：
	// partial 的状态与失败明细都在 content 里完整可见，置 isError 只会让
	// provider 端的错误样式与统计把每次修复现实践踏成失败。
	pi.on("tool_result", (event) => {
		if (event.toolName !== "edit" || event.isError) return;
		const details: unknown = event.details;
		if (!isScriptOutcome(details) || details.status !== "rejected") return;
		return { isError: true };
	});
}
