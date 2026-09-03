/**
 * edit —— 条目式精确编辑工具。契约见 README：一次调用 = 一个编辑脚本，
 * `note` 是脚本的 why，`edits[]` 是扁平条目序列（每条目一个原子修改），
 * 顺序链式执行，失败即停、成功保留。
 *
 * 一种形状，从模型到磁盘：条目扁平——`op` 是判别符，`old_str`/`new_str`/`insert_line` 等
 * 字段与它平级。schema 说的形状、校验后的形状、执行层吃的形状是同一个对象；
 * 校验只收窄类型，不重组。

 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { EditEntry, EditRequest } from "./match.ts";
import { executeEditScript, type ScriptOutcome } from "./transaction.ts";
import { isScriptOutcome, renderCallView, renderClearedCallState, renderInvalidCall, renderResultView } from "./ui.ts";

const opNames = ["replace", "replaceAll", "insert", "delete", "create", "write"] as const;
type OpName = (typeof opNames)[number];

/**
 * 枚举发成裸 `{ type: "string", enum }`：Google 的 API 不接受 anyOf/const，而
 * 字面量联合（`Type.Union` + `Type.Literal`）正编译成那个形状
 *（docs/extensions.md）。等价于 pi-ai 的 `StringEnum`——本扩展不依赖
 * pi-ai，就地一份。
 */
function stringEnum<T extends string>(values: readonly T[], description?: string) {
	return Type.Unsafe<T>({
		type: "string",
		enum: [...values],
		...(description !== undefined ? { description } : {}),
	});
}

const opShapesDescription =
	"replace|replaceAll: old_str+new_str; insert: insert_line+new_str; delete: old_str; create: file_text (new file only); write: file_text (always)";
// 平铺单对象 schema（保持，不改为 anyOf/const 判别联合）：op 枚举判别 + 字段全集可选，
// 各 op 必填组合由 OP_REQUIRED 表驱动。字段描述只写一句用途——角色映射在 op 行、
// null 占位在工具 description，都是单一真源，不重复喂给已 RL 后训练的模型。
const entrySchema = Type.Object(
	{
		path: Type.String({ description: "File path, relative to cwd (or absolute)." }),
		op: stringEnum(opNames, opShapesDescription),
		old_str: Type.Optional(Type.Unsafe<string | null>({
			type: ["string", "null"],
			description: "The text to locate in the file.",
		})),
		new_str: Type.Optional(Type.Unsafe<string | null>({
			type: ["string", "null"],
			description: "Replacement text / inserted content / new content.",
		})),
		insert_line: Type.Optional(Type.Unsafe<number | null>({
			type: ["integer", "null"],
			description: "Line after which to insert: 1-based, 0 = file top.",
		})),
		file_text: Type.Optional(Type.Unsafe<string | null>({
			type: ["string", "null"],
			description: "Whole-file content for create/write.",
		})),
	},
	{ additionalProperties: false },
);

// 一次调用 = 一个编辑脚本：note 是脚本级注释（docstring：为什么改），edits
// 是脚本的 what（每条目一个原子修改）——「批次为什么存在」是脚本级属性，
// 条目级再带注释只剩复述，删掉。
const editRequestSchema = Type.Object(
	{
		note: Type.String({
			description: "One line: why this change exists.",
		}),
		edits: Type.Array(entrySchema, { minItems: 1 }),
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

/** 每个 op 必填的参数（类型层在 schema 兜底，这里管「该 op 必须给出」）。 */
const OP_REQUIRED: Record<OpName, { strings?: readonly string[]; integers?: readonly string[] }> = {
	replace: { strings: ["old_str", "new_str"] },
	replaceAll: { strings: ["old_str", "new_str"] },
	insert: { strings: ["new_str"], integers: ["insert_line"] },
	delete: { strings: ["old_str"] },
	create: { strings: ["file_text"] },
	write: { strings: ["file_text"] },
};

/**
 * 校验一个条目并收窄类型：返回的就是传进来的那个对象，没有重组。
 *
 * 必填参数按 op 检查，类型错（含 null）报「got X」；多余参数一律不读——
 * str_replace_editor 语义：op 只用自己该用的字段，未用键（含 null 与非 null）
 * 原样忽略。
 */
function checkEntry(entry: unknown, label: string): EditEntry {
	if (!isRecord(entry)) invalidEditRequest(`${label} must be an object`);
	if (typeof entry.path !== "string") {
		invalidEditRequest(`${label}.path must be a string, got ${describeType(entry.path)}`);
	}
	const op = entry.op;
	if (typeof op !== "string" || !(opNames as readonly string[]).includes(op)) {
		invalidEditRequest(`${label}.op must be one of ${opNames.join(" | ")}`);
	}
	const required = OP_REQUIRED[op as OpName];
	for (const key of required.strings ?? []) {
		if (typeof entry[key] !== "string") {
			invalidEditRequest(`${label}.${key} must be a string, got ${describeType(entry[key])}`);
		}
	}
	for (const key of required.integers ?? []) {
		if (!Number.isInteger(entry[key])) {
			invalidEditRequest(`${label}.${key} must be an integer, got ${describeType(entry[key])}`);
		}
	}
	// 收尾：未用字段的 null 视同省略。条目即终态，不重组。
	for (const key of Object.keys(entry)) {
		if (entry[key] === null) delete entry[key];
	}
	return entry as EditEntry;
}

/** 主形状校验：note + 每条目 path + op 必填参数。 */
export function parseEditRequest(input: unknown): EditRequest {
	if (!isRecord(input)) invalidEditRequest("note must be an object with note and edits");
	for (const key of Object.keys(input)) {
		if (key === "edits" || key === "note") continue;
		invalidEditRequest(`${key} must be removed`);
	}
	if (typeof input.note !== "string" || input.note.trim() === "") {
		invalidEditRequest("note is required: one line naming why this change exists");
	}
	const note = input.note;
	if (!Array.isArray(input.edits)) invalidEditRequest("edits must be an array");
	if (input.edits.length === 0) invalidEditRequest("edits must not be empty");
	return { note, edits: input.edits.map((entry, index) => checkEntry(entry, `edits[${index}]`)) };
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
		// 链式条目序列（先验是 files[].edits[] 批形状）、comment 由 schema
		// required 保证、失败即停由结果信封（skipped）自明。
		description:
			"Edit files as an entry chain — one op per entry on one path; stops at the first failed entry."
			+ " null parameters are treated as omitted.",
		promptSnippet: "Exact file edits",
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
