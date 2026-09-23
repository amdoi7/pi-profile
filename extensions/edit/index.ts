/**
 * edit —— 单文件严格编辑工具。契约见 README：一次调用 = 一个文件的一个编辑脚本；
 * note 是批次唯一意图（docstring：为什么改），path 是唯一目标文件，edits 是
 * 该文件的条目链（顺序链式执行，失败即停、成功保留）。
 *
 * 严格模式：schema 说死唯一形状——条目未声明字段（含 null）、顶层多余键全部拒绝，
 * 错误即时可见，单一真相源才可能被纠正。不向后兼容。
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { evaluateCommand } from "../command-policy/policy.ts";
import { createBashThenRunRunner, executeThenRun, type ThenRunInput } from "../edit/then-run.ts";

import type { EditEntry, EditRequest } from "./match.ts";
import { executeEditScript, type ScriptOutcome } from "./transaction.ts";
import { isScriptOutcome, renderCallView, renderClearedCallState, renderInvalidCall, renderResultView } from "./ui.ts";

// 平铺单对象 schema：path 顶层唯一（一次调用 = 一个文件），match 必填 + 全字段
// 可选。多余键在 schema 层被拒（additionalProperties:false）——schema 是指令通道；
// 它的报错是 generic 的 TypeBox 文案，rich 文案走 prepareArguments（见下）。
const editEntrySchema = Type.Object(
	{
		match: Type.Unsafe<string | null>({
			type: ["string", "null"],
			description: "Smallest text to match. Must be unique in the file — make it longer until it is, or set replace_all: true.",
		}),
		new_str: Type.Optional(Type.Unsafe<string | null>({
			type: ["string", "null"],
			description: "Replacement text; omitted = delete.",
		})),
		replace_all: Type.Optional(Type.Unsafe<boolean | null>({
			type: ["boolean", "null"],
			description: "Replace every occurrence instead of requiring a unique match (renames).",
		})),
	},
	{ additionalProperties: false },
);

// 一次调用 = 一个文件的一个编辑脚本：note 是批次唯一意图（docstring：为什么改），
// path 是唯一目标文件，edits 是该文件的条目链（顺序执行）。条目不带 path——
// 一个意图驱动一个文件的一批修改，文件在调用层只说一次。
const editRequestSchema = Type.Object(
	{
		note: Type.String({
			description: "One line: why this batch of changes exists.",
		}),
		path: Type.String({
			description: "The one file this call edits. One call = one file.",
		}),
		edits: Type.Array(editEntrySchema, {
			description: "Ordered entries for that file; each { match, optional new_str (omitted = delete) }; entries chain against evolving content; stops at the first failed entry.",
			minItems: 1,
		}),
		then_run: Type.Optional(Type.Object(
			{
				command: Type.String({ description: "Bash command to run after the edit is applied." }),
				timeout: Type.Optional(Type.Number({ description: "Timeout in seconds." })),
			},
			{
				additionalProperties: false,
				description: "Optional validation command fused into this call: runs only if the edit script applied (skipped on rejection; a non-zero exit is reported but keeps the edit). Prefer fusing the predictable follow-up check here instead of spending a separate turn on it.",
			},
		)),
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
 * match 必填（new_str 缺省 = 删除）；未声明字段（含 null）一律拒绝——
 * 错误即时可见，单一真相源才可能被纠正。
 *
 * `new_str` 的可选写法有两种：字段不出现，或显式 null —— provider 把
 * 「可选」序列化成 null 是常态（语料 2026-09-09:721 次 edit 调用 718 次
 * 带显式 null），两者同义（= 删除），在入口统一丢弃；null 不是第三种语义。
 * 除 null 以外的错型仍然显式拒绝。
 *
 * 选择器已全部退役（range/regex/after/before）：收窄的唯一办法是把 match
 * 加长到唯一——选择器能表达的，更长的 match 都能表达，少一个原语少一类
 * 失败（选择器自身也可能 NOT_FOUND / 超窗）。
 */
function checkEntry(entry: unknown, label: string): EditEntry {
	if (!isRecord(entry)) invalidEditRequest(`${label} must be an object`);
	// 单一真相源：允许字段 = schema 声明的属性（校验与 schema 永不脱节）。
	const allowed = Object.keys(editEntrySchema.properties);
	for (const key of Object.keys(entry)) {
		if (!allowed.includes(key)) {
			invalidEditRequest(`${label}.${key} must be removed`);
		}
	}
	if (typeof entry.match !== "string") {
		invalidEditRequest(`${label}.match must be a string, got ${describeType(entry.match)}`);
	}
	// null = omit 的唯一归一点:provider 把「可选」序列化成 null(语料 718/721),
	// 统一丢弃,后续层只看 undefined —— 删除语义(new_str 缺省 = 替换为空)不变。
	if (entry.new_str === null) delete entry.new_str;
	if (entry.new_str !== undefined && typeof entry.new_str !== "string") {
		invalidEditRequest(`${label}.new_str must be a string, got ${describeType(entry.new_str)}`);
	}
	if (entry.replace_all === null) delete entry.replace_all;
	if (entry.replace_all !== undefined && typeof entry.replace_all !== "boolean") {
		invalidEditRequest(`${label}.replace_all must be a boolean, got ${describeType(entry.replace_all)}`);
	}
	return entry as EditEntry;
}

/**
 * 主形状校验：note + path + edits（单文件条目链）。校验即收窄：schema 说死的
 * 形状和执行层吃的形状是同一个，输入即内部形状，无第二层映射。
 *
 * 严格闸门在这里，不依赖 TypeBox 的松 Array 校验：任何多余键（含 null）、
 * 条目未用字段、缺失必填、空 note/edits 都在这里即时拒绝，错误带字段名与
 * 当前值——单一真相源，一次错误立即纠正，不静默忽略。
 */
function checkThenRun(value: unknown): ThenRunInput {
	if (!isRecord(value)) invalidEditRequest("then_run must be an object: {command, timeout?}");
	for (const key of Object.keys(value)) {
		if (key !== "command" && key !== "timeout") {
			invalidEditRequest(`then_run.${key} must be removed`);
		}
	}
	if (typeof value.command !== "string" || value.command.trim() === "") {
		invalidEditRequest("then_run.command must be a non-empty string");
	}
	if (value.timeout !== undefined && (typeof value.timeout !== "number" || !(value.timeout > 0))) {
		invalidEditRequest("then_run.timeout must be a positive number");
	}
	return value as ThenRunInput;
}

/** 与 transaction.ts 的 canonicalizePath 同规则(那里不导出,路径归一在两层保持一致)。 */
function resolveAbsolutePath(filePath: string, cwd: string): string {
	const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
	try {
		return fs.realpathSync.native(resolvedPath);
	} catch {
		return path.normalize(resolvedPath);
	}
}

export function parseEditRequest(input: unknown): EditRequest {
	if (!isRecord(input)) invalidEditRequest("edit expects an object: {note, path, edits}");
	for (const key of Object.keys(input)) {
		if (key === "note" || key === "path" || key === "edits" || key === "then_run") continue;
		invalidEditRequest(`${key} must be removed`);
	}
	if (typeof input.note !== "string" || input.note.trim() === "") {
		invalidEditRequest("note is required: one line naming why this batch exists");
	}
	if (typeof input.path !== "string" || input.path.trim() === "") {
		invalidEditRequest("path is required: the one file this call edits");
	}
	if (!Array.isArray(input.edits)) invalidEditRequest("edits must be an array");
	if (input.edits.length === 0) invalidEditRequest("edits must not be empty");
	const edits: EditEntry[] = input.edits.map((rawEntry, index) => checkEntry(rawEntry, `edits[${index}]`));
	return {
		note: input.note,
		path: input.path,
		edits,
		...(input.then_run !== undefined && input.then_run !== null
			? { then_run: checkThenRun(input.then_run) }
			: {}),
	};
}

/**
 * 严格校验在工具参数进 schema 闸门之前先跑：非法输入以字段名+当前值先炸，
 * generic 的 TypeBox 文案轮不到出场；合法输入原样返回（输入即内部形状，
 * 无重组）。不向后兼容：旧形状直接被拒，错误教新形状。
 */
export function prepareEditArguments<T>(args: T): T {
	parseEditRequest(args);
	return args;
}

/**
 * agent 结果：逐条目事实。path 提到顶层（一次调用只改这一个文件），条目只带
 * 自己的结局。成功列 stats/定位；失败列错误与 kind；skipped 列被中断的条目
 * （模型据此只重发 failed + skipped 段）。
 */
export function buildOutcomeAgentContent(outcome: ScriptOutcome): string {
	const entries = outcome.entries.map((entry) => {
		if (entry.status === "applied") {
			return {
				changes: entry.changeStats,
				...(entry.firstChangedLine !== undefined ? { firstChangedLine: entry.firstChangedLine } : {}),
			};
		}
		if (entry.status === "failed") {
			return {
				...(entry.errorKind !== undefined ? { kind: entry.errorKind } : {}),
				message: entry.error,
				// NOT_FOUND 的照抄载荷:文件原文整行,无前缀 —— 重发 match 直接用它。
				...(entry.closest !== undefined ? { closest: entry.closest } : {}),
			};
		}
		return { skipped: true };
	});
	return JSON.stringify({ status: outcome.status, path: outcome.path, entries });
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "edit",
		label: "edit",
		renderShell: "default",
		// prompt 面说清形状：一次调用 = 一个文件；path 顶层唯一，edits 是该文件
		// 的 match 链；match 缺省必须唯一命中，重命名用 replace_all。
		description:
			"Edit ONE file with a batch of chained replacements. "
			+ "note: one line why. path: the single file this call edits. "
			+ "edits: ordered entries, each { match, optional new_str (omitted = delete), optional replace_all }; "
			+ "entries chain against evolving content; stops at the first failed entry. "
			+ "replace_all: true replaces every occurrence (renames); without it, match must be unique in the file — make it longer until it is. "
			+ "One call edits one file — issue separate calls for other files. "
			+ "Prefer this tool for modifying existing files; do not use perl/python/sed "
			+ "one-liners or heredoc rewrites to mutate files. "
			+ "then_run: optional {command, timeout?} to fuse the predictable follow-up "
			+ "validation into this call — runs only if the edit applied; a non-zero exit "
			+ "is reported but keeps the edit.",
		parameters: editRequestParameters,
		// rich 错误通道：schema 闸门之前先跑严格校验（见 prepareEditArguments）。
		// execute 里的 parseEditRequest 是最终守卫（防绕过校验的直调路径），
		// canonical 输入零成本复检。
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const request = parseEditRequest(params);
			const outcome = await executeEditScript(request, ctx.cwd, signal);

			let thenRunText = "";
			if (request.then_run !== undefined) {
				// 命令与交互式 bash 走同一条 command-policy 通道(block/rewrite 一致);
				// rewrite 后的命令才是真正运行的。
				const decision = evaluateCommand(request.then_run.command);
				const runner = createBashThenRunRunner(ctx);
				if (decision.kind === "block") {
					thenRunText = "\n\n[then_run:blocked] " + decision.reason;
				} else {
					const command = decision.kind === "rewrite" ? decision.executedCommand : decision.command;
					thenRunText = "\n\n" + await executeThenRun(
						outcome,
						{ ...request.then_run, command },
						resolveAbsolutePath(request.path, ctx.cwd),
						runner,
						signal,
					);
				}
			}

			// AgentToolResult 没有 isError 字段：信封由 harness 写，写在这里会被静默丢弃；
			// 软失败靠下面的 tool_result handler 改信封。
			return {
				content: [{ type: "text" as const, text: buildOutcomeAgentContent(outcome) + thenRunText }],
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
