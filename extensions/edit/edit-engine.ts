import { constants } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ChangeStats, DisplayDiff } from "../_shared/final-diff.ts";
import { explainMissingAnchor, repairAnchor } from "./anchor-alignment.ts";
import { diffFromSpans } from "./span-diff.ts";

/** preview 的 context 行数（与共享 diff 引擎默认一致）。 */
const EDIT_PREVIEW_CONTEXT_LINES = 4;

export type FileEditOperation = {
	oldText: string;
	newText: string;
	replaceAll?: boolean;
};

export type AppliedEditsResult = {
	newContent: string;
	matchedSpans: MatchedEditSpan[];
};

export type MatchedEditSpan = {
	matchIndex: number;
	matchLength: number;
	newText: string;
};

// Hard file-size gate. Files larger than this are rejected before reading.
export const MAX_EDIT_FILE_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB

export const EDIT_TOOL_ERROR_KINDS = ["NOT_FOUND", "DUPLICATE_MATCH", "NO_CHANGE"] as const;
export type RecoverableEditErrorKind = (typeof EDIT_TOOL_ERROR_KINDS)[number];

export interface EditToolError extends Error {
	kind: RecoverableEditErrorKind;
}

export function isEditToolError(error: unknown): error is EditToolError {
	return error instanceof Error
		&& typeof (error as Partial<EditToolError>).kind === "string"
		&& (EDIT_TOOL_ERROR_KINDS as readonly string[]).includes((error as EditToolError).kind);
}

function editError(message: string, kind: RecoverableEditErrorKind): EditToolError {
	const error = new Error(message) as EditToolError;
	error.kind = kind;
	return error;
}

export type EditEngineOperations = {
	access: (absolutePath: string) => Promise<void>;
	readFile: (absolutePath: string) => Promise<string>;
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	stat: (absolutePath: string) => Promise<{ size: number }>;
};

type MatchedEdit = MatchedEditSpan & {
	editIndex: number;
};

type ResolvedMatch = {
	matchIndex: number;
	actualOldText: string;
	/** 仅存在于修复路径：把 newText 里的同类标记翻回文件的写法。 */
	marks?: ReadonlyMap<string, string>;
};

const LEFT_SINGLE_CURLY_QUOTE = "‘";
const RIGHT_SINGLE_CURLY_QUOTE = "’";
const LEFT_DOUBLE_CURLY_QUOTE = "“";
const RIGHT_DOUBLE_CURLY_QUOTE = "”";
export const defaultEditEngineOperations: EditEngineOperations = {
	access: (absolutePath) => access(absolutePath, constants.R_OK | constants.W_OK),
	readFile: (absolutePath) => readFile(absolutePath, "utf-8"),
	writeFile: (absolutePath, content) => writeFile(absolutePath, content, "utf-8"),
	stat: (absolutePath) => stat(absolutePath),
};

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) {
		return "\n";
	}
	if (crlfIdx === -1) {
		return "\n";
	}
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	// Fast path: most files have no \r at all.
	if (text.indexOf("\r") === -1) return text;
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * 定位用的字符等价类。
 *
 * 守的不变式：排印形式的差异（弯引号、全角/半角）不应让一次改写失败——
 * 它们是转写噪声，不是意图。模型无需知道这一层存在。
 * 何时装的：弯引号 2026-08 既有；全角族 2026-08-27。
 * 立项证据：92 个可修复失败锚里 17 个是 1-2 字符漂移，其中 `,`↔`，` 占 4 例；
 * 本对话两例 `,`↔`、`。成本侧：零 token、零模型注意力，所以不适用「省多少轮」那套门槛。
 * 失效条件：折叠开始产生真实歧义（语料里 DUPLICATE_MATCH 里出现因折叠而多命中的
 * 案例），或出现因折叠而改错位置的事故。
 *
 * 不入等价类（证据上就不是同一回事，折了就是改错地方）：
 * - 汉字形近误写（骨→骰、绕→绍）——语料里它们是失败锚的一大类，必须继续失败；
 * - 漏字（`**` 丢掉）——同上；
 * - 破折号 `—`/`–` 与 `-`：`---` 在 Markdown 里是 frontmatter/分割线，折叠有真碰撞面，
 *   且无证据；
 * - 缩进类空白：Python 里缩进就是语义。全角空格 U+3000 例外（它是 ASCII 空格的
 *   全角形式，不作缩进）。
 *
 * 硬约束：映射必须是 **1 字符 → 1 字符**。下游 applyIntentOntoFileBytes 靠
 * 「折叠后与原文等长」来对齐下标；破坏这个不变式会写错位置。
 */
export function normalizeForFuzzyMatch(text: string): string {
	// Fast path: most source files contain no curly quotes at all.
	if (
		text.indexOf(LEFT_SINGLE_CURLY_QUOTE) === -1 &&
		text.indexOf(RIGHT_SINGLE_CURLY_QUOTE) === -1 &&
		text.indexOf(LEFT_DOUBLE_CURLY_QUOTE) === -1 &&
		text.indexOf(RIGHT_DOUBLE_CURLY_QUOTE) === -1
	) {
		return text;
	}
	return text
		.replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
		.replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
		.replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
		.replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"');
}

export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}

function findAllMatchIndices(content: string, needle: string): number[] {
	const indices: number[] = [];
	if (needle.length === 0) {
		return indices;
	}
	let fromIndex = 0;
	while (fromIndex <= content.length - needle.length) {
		const index = content.indexOf(needle, fromIndex);
		if (index === -1) {
			break;
		}
		indices.push(index);
		fromIndex = index + 1;
	}
	return indices;
}

function replacementPrefix(editIndex: number): string {
	return editIndex === 0 ? "" : `replacement ${editIndex + 1}: `;
}

function lineNumberAt(content: string, index: number): number {
	let line = 1;
	for (let cursor = 0; cursor < index && cursor < content.length; cursor += 1) {
		if (content[cursor] === "\n") line += 1;
	}
	return line;
}

function lineNumbersAt(content: string, indices: number[]): number[] {
	// 同一行多次匹配去重：L1, L1 → L1。
	return [...new Set(indices.map((index) => lineNumberAt(content, index)))];
}

/** 只在失败路径计算：错误必须带回文件原文，否则模型只能重读或重试。 */
function getNotFoundError(editIndex: number, content: string, oldText: string): EditToolError {
	return editError(
		`${replacementPrefix(editIndex)}oldText was not found; ${explainMissingAnchor(content, oldText)}`,
		"NOT_FOUND",
	);
}

function getDuplicateError(editIndex: number, occurrences: number, lineNumbers: number[]): EditToolError {
	const locations = lineNumbers.length > 0 ? ` (L${lineNumbers.join(", L")})` : "";
	return editError(
		`${replacementPrefix(editIndex)}oldText matched ${occurrences} locations${locations}`,
		"DUPLICATE_MATCH",
	);
}

function getEmptyOldTextError(editIndex: number): Error {
	return new Error(`${replacementPrefix(editIndex)}oldText must not be empty.`);
}

function resolveEditMatches(
	content: string,
	oldText: string,
	replaceAll: boolean,
	editIndex: number,
	// Pre-normalized content passed in to avoid re-normalizing per edit.
	normalizedContentForFuzzy?: { content: string },
): ResolvedMatch[] {
	const exactMatches = findAllMatchIndices(content, oldText);
	if (exactMatches.length > 0) {
		if (!replaceAll && exactMatches.length > 1) {
			throw getDuplicateError(editIndex, exactMatches.length, lineNumbersAt(content, exactMatches));
		}
		// replaceAll explicitly applies the replacement to every exact match.
		return exactMatches.map((matchIndex) => ({
			matchIndex,
			actualOldText: oldText,
		}));
	}

	const fuzzyContent = normalizedContentForFuzzy?.content ?? normalizeForFuzzyMatch(content);
	const normalizedOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyMatches = findAllMatchIndices(fuzzyContent, normalizedOldText);
	if (fuzzyMatches.length === 0) {
		// 正常路径都没命中 → 看失败原因：若只是同标记的排印变体，拿文件真字节
		// 修好锚，再跑一次普通的精确匹配。它不拓宽全局匹配语义，只作用于这一次失败。
		// replaceAll 不进修复：“每一处”里各处的字节形式可能不同，修成一种会漏掉其余。
		const repair = replaceAll ? undefined : repairAnchor(content, oldText);
		const repairedMatches = repair === undefined ? [] : findAllMatchIndices(content, repair.text);
		if (repair !== undefined && repairedMatches.length === 1) {
			return [{ matchIndex: repairedMatches[0]!, actualOldText: repair.text, marks: repair.marks }];
		}
		throw getNotFoundError(editIndex, content, oldText);
	}
	if (!replaceAll && fuzzyMatches.length > 1) {
		throw getDuplicateError(editIndex, fuzzyMatches.length, lineNumbersAt(content, fuzzyMatches));
	}
	// replaceAll explicitly applies the replacement to every fuzzy match.

	return fuzzyMatches.map((matchIndex) => ({
		matchIndex,
		actualOldText: content.substring(matchIndex, matchIndex + oldText.length),
	}));
}

const LETTER_RE = /\p{L}/u;

function isOpeningContext(chars: string[], index: number): boolean {
	if (index === 0) {
		return true;
	}
	const previous = chars[index - 1]!;
	return previous === " " || previous === "\t" || previous === "\n" || previous === "\r" || previous === "(" || previous === "[" || previous === "{" || previous === "\u2014" || previous === "\u2013";
}

function applyCurlyDoubleQuotes(text: string): string {
	const chars = [...text];
	let result = "";
	for (let index = 0; index < chars.length; index += 1) {
		if (chars[index] === '"') {
			result += isOpeningContext(chars, index) ? LEFT_DOUBLE_CURLY_QUOTE : RIGHT_DOUBLE_CURLY_QUOTE;
		} else {
			result += chars[index]!;
		}
	}
	return result;
}

function applyCurlySingleQuotes(text: string): string {
	const chars = [...text];
	let result = "";
	for (let index = 0; index < chars.length; index += 1) {
		if (chars[index] !== "'") {
			result += chars[index]!;
			continue;
		}
		const previous = index > 0 ? chars[index - 1] : undefined;
		const next = index < chars.length - 1 ? chars[index + 1] : undefined;
		const previousIsLetter = previous !== undefined && LETTER_RE.test(previous);
		const nextIsLetter = next !== undefined && LETTER_RE.test(next);
		if (previousIsLetter && nextIsLetter) {
			result += RIGHT_SINGLE_CURLY_QUOTE;
		} else {
			result += isOpeningContext(chars, index) ? LEFT_SINGLE_CURLY_QUOTE : RIGHT_SINGLE_CURLY_QUOTE;
		}
	}
	return result;
}

function preserveQuoteStyle(oldText: string, actualOldText: string, newText: string): string {
	if (oldText === actualOldText) {
		return newText;
	}
	const hasDoubleQuotes = actualOldText.includes(LEFT_DOUBLE_CURLY_QUOTE) || actualOldText.includes(RIGHT_DOUBLE_CURLY_QUOTE);
	const hasSingleQuotes = actualOldText.includes(LEFT_SINGLE_CURLY_QUOTE) || actualOldText.includes(RIGHT_SINGLE_CURLY_QUOTE);
	if (!hasDoubleQuotes && !hasSingleQuotes) {
		return newText;
	}
	let result = newText;
	if (hasDoubleQuotes) {
		result = applyCurlyDoubleQuotes(result);
	}
	if (hasSingleQuotes) {
		result = applyCurlySingleQuotes(result);
	}
	return result;
}

/** 修复路径交回的方言表：把 newText 里的同类标记翻回文件的写法。 */
function applyRepairedMarks(newText: string, marks: ReadonlyMap<string, string> | undefined): string {
	if (marks === undefined || marks.size === 0) return newText;
	let result = "";
	for (const character of newText) result += marks.get(character) ?? character;
	return result;
}

export function applyEditsToNormalizedContent(normalizedContent: string, edits: FileEditOperation[]): AppliedEditsResult {
	// Validate edit invariants upfront before any allocation.
	for (let index = 0; index < edits.length; index += 1) {
		const edit = edits[index]!;
		if (edit.oldText.length === 0) {
			throw getEmptyOldTextError(index);
		}
	}

	// Lazily normalize content for fuzzy matching — computed at most once
	// regardless of how many edits fall through to the fuzzy path.
	let fuzzyContentCache: { content: string } | undefined;
	function getFuzzyContent(): { content: string } {
		if (fuzzyContentCache === undefined) {
			fuzzyContentCache = { content: normalizeForFuzzyMatch(normalizedContent) };
		}
		return fuzzyContentCache;
	}

	// Normalize edits and resolve matches in a single pass — avoids allocating
	// a separate normalizedEdits array. 全部校验后再应用：任一失败时聚合报告
	// 所有失败点（agent 一次修正全部，而非逐个失败逐个重读）。
	const matchedEdits: MatchedEdit[] = [];
	const failures: EditToolError[] = [];
	for (let index = 0; index < edits.length; index += 1) {
		const edit = edits[index]!;
		const oldText = normalizeToLF(edit.oldText);
		const newText = normalizeToLF(edit.newText);
		let resolvedMatches: ResolvedMatch[];
		try {
			resolvedMatches = resolveEditMatches(
				normalizedContent,
				oldText,
				edit.replaceAll === true,
				index,
				getFuzzyContent(),
			);
		} catch (error) {
			if (isEditToolError(error)) {
				failures.push(error);
				continue;
			}
			throw error;
		}
		for (const resolvedMatch of resolvedMatches) {
			matchedEdits.push({
				editIndex: index,
				matchIndex: resolvedMatch.matchIndex,
				matchLength: resolvedMatch.actualOldText.length,
				newText: applyRepairedMarks(
					preserveQuoteStyle(oldText, resolvedMatch.actualOldText, newText),
					resolvedMatch.marks,
				),
			});
		}
	}
	if (failures.length === 1) {
		throw failures[0]!;
	}
	if (failures.length > 1) {
		throw editError(
			`edit failed (${failures.length} of ${edits.length}):\n${failures.map((failure) => `  ${failure.message}`).join("\n")}`,
			failures[0]!.kind,
		);
	}

	// Sort only when there are multiple edits — single-edit is already sorted.
	if (matchedEdits.length > 1) {
		matchedEdits.sort((left, right) => left.matchIndex - right.matchIndex);
	}
	for (let index = 1; index < matchedEdits.length; index += 1) {
		const previous = matchedEdits[index - 1]!;
		const current = matchedEdits[index]!;
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			// 两个 span 的位置引擎手里就有，不报等于让模型再去找一遍。
			const span = (edit: MatchedEdit): string =>
				`L${lineNumberAt(normalizedContent, edit.matchIndex)}`
				+ `-L${lineNumberAt(normalizedContent, edit.matchIndex + edit.matchLength - 1)}`;
			throw new Error(
				`replacement ${current.editIndex + 1} (${span(current)}) overlaps`
				+ ` replacement ${previous.editIndex + 1} (${span(previous)}); merge them into one edit`,
			);
		}
	}

	// Apply edits forward, collecting segments, then join once.
	// Avoids O(k²) intermediate string allocations from repeated concatenation.
	const segments: string[] = [];
	let cursor = 0;
	for (let index = 0; index < matchedEdits.length; index += 1) {
		const edit = matchedEdits[index]!;
		segments.push(normalizedContent.substring(cursor, edit.matchIndex));
		segments.push(edit.newText);
		cursor = edit.matchIndex + edit.matchLength;
	}
	segments.push(normalizedContent.substring(cursor));
	const newContent = segments.join("");
	if (newContent === normalizedContent) {
		throw editError(
			"No change: newText normalizes to oldText",
			"NO_CHANGE",
		);
	}
	// matchedEdits already has matchIndex/matchLength/newText — reuse as MatchedEditSpan[].
	return { newContent, matchedSpans: matchedEdits };
}

function formatAccessError(error: unknown): Error {
	if (error instanceof Error) {
		const errorWithCode = error as Error & { code?: string };
		if (errorWithCode.code === "ENOENT") {
			return new Error("File not found.");
		}
		if (errorWithCode.code === "EACCES" || errorWithCode.code === "EPERM") {
			return new Error("File must be readable and writable. Check permissions.");
		}
		return error;
	}
	return new Error(String(error));
}

/**
 * 一次事务持有 batch 内全部文件的 mutation lock。
 *
 * 获取顺序 = canonical path 字典序（全局一致的顺序 → 并发 batch 之间的等待图
 * 无环 → 无死锁；内置 write/edit 只取单锁，同样不成环）。同一 queue key 重复
 * 获取会自锁，调用方必须先按 canonical path 去重。
 */
async function withAllFileMutationQueues<T>(
	absolutePaths: readonly string[],
	run: () => Promise<T>,
): Promise<T> {
	const ordered = [...absolutePaths].sort();
	const acquire = (index: number): Promise<T> =>
		index === ordered.length
			? run()
			: withFileMutationQueue(ordered[index]!, () => acquire(index + 1));
	return acquire(0);
}

export type BatchFileEditRequest = {
	/** 已 canonicalize 的绝对路径；同一 batch 内必须互不相同（pipeline 去重）。 */
	absolutePath: string;
	edits: FileEditOperation[];
};

export type FileDiffPreview = {
	previewDisplay: DisplayDiff;
	previewStartLine?: number;
	previewTruncated: boolean;
	changeStats: ChangeStats;
};

export type BatchFileOutcome =
	/** 落盘完成（batch status=partial 时表示回滚失败、内容仍留在盘上）。 */
	| { status: "applied"; preview: FileDiffPreview }
	| { status: "failed"; error: string; errorKind?: RecoverableEditErrorKind }
	/** 匹配无误但整批被拒，未落盘；restored=true 表示写过又被回滚。 */
	| { status: "notWritten"; restored: boolean };

export type BatchEditResult = {
	/** applied=全部落盘；rejected=一个字节都没落；partial=部分留在盘上且无法回滚。 */
	status: "applied" | "rejected" | "partial";
	/** 与输入同序同长。 */
	files: BatchFileOutcome[];
};

type PreparedFile = {
	absolutePath: string;
	/** 原始字节（含 BOM / 原行尾）——回滚按 verbatim 还原，不经归一化往返。 */
	rawContent: string;
	bom: string;
	lineEnding: "\r\n" | "\n";
	normalizedContent: string;
	newContent: string;
	matchedSpans: MatchedEditSpan[];
};

type PreparedFileResult =
	| { kind: "prepared"; prepared: PreparedFile }
	| { kind: "failed"; error: string; errorKind?: RecoverableEditErrorKind };

function toFailure(error: unknown): PreparedFileResult {
	if (isEditToolError(error)) {
		return { kind: "failed", error: error.message, errorKind: error.kind };
	}
	return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
}

/**
 * 解析面（只读）：尺寸闸门 → 可读写 → 读入 → 内存内应用 edits。
 * 不写任何字节；失败作为 per-file 事实返回，abort 直接抛出。
 */
async function prepareFileEdit(
	request: BatchFileEditRequest,
	operations: EditEngineOperations,
	signal: AbortSignal | undefined,
): Promise<PreparedFileResult> {
	throwIfAborted(signal);
	try {
		// Preflight: hard file-size gate before reading content into memory.
		try {
			const fileStat = await operations.stat(request.absolutePath);
			if (fileStat.size > MAX_EDIT_FILE_SIZE_BYTES) {
				throw new Error(
					`File too large: sizeBytes=${fileStat.size} limitBytes=${MAX_EDIT_FILE_SIZE_BYTES}; use a narrower oldText or a streaming tool.`,
				);
			}
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("File too large")) throw error;
			// stat failure falls through to access check for a cleaner error
		}

		try {
			await operations.access(request.absolutePath);
		} catch (error) {
			throw formatAccessError(error);
		}
		throwIfAborted(signal);

		const rawContent = await operations.readFile(request.absolutePath);
		throwIfAborted(signal);

		const { bom, text } = stripBom(rawContent);
		const lineEnding = detectLineEnding(text);
		const normalizedContent = normalizeToLF(text);
		// applyEditsToNormalizedContent 是匹配语义的唯一来源。
		const { newContent, matchedSpans } = applyEditsToNormalizedContent(normalizedContent, request.edits);
		return {
			kind: "prepared",
			prepared: {
				absolutePath: request.absolutePath,
				rawContent,
				bom,
				lineEnding,
				normalizedContent,
				newContent,
				matchedSpans,
			},
		};
	} catch (error) {
		// abort 不是 per-file 事实：直接上抛，整批不落盘。
		if (signal?.aborted || (error instanceof Error && error.message === "Operation aborted")) throw error;
		return toFailure(error);
	}
}

function serializeForDisk(prepared: PreparedFile): string {
	return prepared.bom + restoreLineEndings(prepared.newContent, prepared.lineEnding);
}

/**
 * 展示 diff：用已知的 matched spans 直接构造（span-diff），规模 = 编辑规模。
 * 没有 worker、没有超时 tripwire、没有阈值预算——因为没有要「求解」的东西。
 */
function computePreview(file: PreparedFile): FileDiffPreview {
	const diff = diffFromSpans(
		file.normalizedContent,
		file.newContent,
		file.matchedSpans,
		EDIT_PREVIEW_CONTEXT_LINES,
	);
	return {
		previewDisplay: diff.display,
		previewStartLine: diff.firstChangedLine,
		previewTruncated: diff.truncated,
		changeStats: diff.stats,
	};
}

/**
 * 一个意图 = 一个事务：batch 内全部文件先解析、再整批落盘。
 *
 * - 解析面任一文件失败 → 一个字节都不写，全部失败一次性回报（status=rejected）；
 * - 落盘面 IO 失败 → 已写文件按原始字节回滚；全部还原 = rejected，
 *   还原失败的留在盘上 = partial（响亮报出，绝不静默半提交）；
 * - abort 在提交点之前生效；越过提交点后事务必须走完，避免半写状态。
 */
export async function executeBatchEdits(
	files: readonly BatchFileEditRequest[],
	signal?: AbortSignal,
	operations: EditEngineOperations = defaultEditEngineOperations,
): Promise<BatchEditResult> {
	return withAllFileMutationQueues(files.map((file) => file.absolutePath), async () => {
		throwIfAborted(signal);

		const resolutions: PreparedFileResult[] = [];
		for (const file of files) {
			resolutions.push(await prepareFileEdit(file, operations, signal));
		}

		if (resolutions.some((resolution) => resolution.kind === "failed")) {
			return {
				status: "rejected",
				files: resolutions.map((resolution) =>
					resolution.kind === "failed"
						? { status: "failed", error: resolution.error, errorKind: resolution.errorKind }
						: { status: "notWritten", restored: false }
				),
			};
		}

		const prepared = resolutions.map((resolution) => {
			if (resolution.kind !== "prepared") throw new Error("unreachable: unresolved batch entry");
			return resolution.prepared;
		});
		// 提交点：此后不再检查 abort，事务走完，避免半写状态。
		throwIfAborted(signal);

		const written: PreparedFile[] = [];
		let writeFailure: { index: number; message: string } | undefined;
		for (let index = 0; index < prepared.length; index += 1) {
			const file = prepared[index]!;
			try {
				await operations.writeFile(file.absolutePath, serializeForDisk(file));
				written.push(file);
			} catch (error) {
				writeFailure = { index, message: error instanceof Error ? error.message : String(error) };
				break;
			}
		}

		if (writeFailure === undefined) {
			return {
				status: "applied",
				files: prepared.map((file) => ({ status: "applied" as const, preview: computePreview(file) })),
			};
		}

		// 回滚：逆序写回原始字节（锁仍在手，无第三方写入窗口）。
		const restored = new Set<string>();
		for (const file of [...written].reverse()) {
			try {
				await operations.writeFile(file.absolutePath, file.rawContent);
				restored.add(file.absolutePath);
			} catch {
				// 无法还原 → 该文件留在盘上，由 partial 状态响亮报出。
			}
		}
		const stranded = written.filter((file) => !restored.has(file.absolutePath));
		const strandedPaths = new Set(stranded.map((file) => file.absolutePath));

		return {
			status: stranded.length > 0 ? "partial" : "rejected",
			files: prepared.map((file, index) => {
				if (index === writeFailure.index) {
					return { status: "failed" as const, error: writeFailure.message };
				}
				if (strandedPaths.has(file.absolutePath)) {
					return { status: "applied" as const, preview: computePreview(file) };
				}
				return { status: "notWritten" as const, restored: restored.has(file.absolutePath) };
			}),
		};
	});
}
