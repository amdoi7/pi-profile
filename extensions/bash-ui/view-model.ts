import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import type { ChangeStats, DisplayDiff } from "../_shared/final-diff.ts";
import { displayDiffFromLines, isChangeStats, isDisplayDiff } from "../_shared/final-diff.ts";
import type { DiffInput, DiffOutput, DiffStrategy } from "../_shared/diff-service.ts";
import {
	operationByIndex,
	type ApplyPatchInvocation,
	type ApplyPatchPlan,
	type PlannedPatchOperation,
	type PatchLine,
	type PatchOperation,
} from "./patch-command.ts";
import {
	type ApplyPatchFailure,
	failureMatchesPatch,
	type ParsedApplyPatchResultSequence,
	successMatchesPatch,
	type SuccessfulChange,
} from "./patch-result.ts";
import type { AfterContents, SnapshotSet } from "./patch-snapshot.ts";

export const PATCH_DIFF_CONTEXT_LINES = 2;

/**
 * 一次 batch 提交的返回：undefined 表示 worker 不可用（该批次整体降级 intent diff）。
 * 提交方（registry）负责捕获 worker 失败并返回 undefined。
 */
export type DiffBatchSubmitter = (inputs: readonly DiffInput[]) => Promise<readonly DiffOutput[] | undefined>;

export type ApplyPatchFileDiff = {
	kind: "Add" | "Update" | "Move" | "Delete" | "Rewrite";
	/** 展示用原始 relative path（UI 文字）。 */
	path: string;
	destination?: string;
	/** 所属 invocation 的 cwd：renderer 不再猜路径基础目录。 */
	cwd: string;
	changeStats: ChangeStats;
	diffDisplay: DisplayDiff;
	diffTruncated: boolean;
};

export type ApplyPatchBatchFileDiff = ApplyPatchFileDiff & { patchCount: number };

export type ApplyPatchUnapplied = {
	kind: ApplyPatchFileDiff["kind"];
	path: string;
	destination?: string;
	cwd: string;
};

export type ApplyPatchSkipped = {
	operation?: string;
	path?: string;
	cwd?: string;
	message: string;
};

export type ApplyPatchContextMismatch = {
	expectedLines: string[];
	actualLines: string[];
	actualTruncated: boolean;
};

export type ApplyPatchSingleResultViewModel =
	| {
		kind: "apply-patch-result";
		success: true;
		files: ApplyPatchFileDiff[];
		trailing: string;
		/** 计划中 trailing command（渲染 `$ <cmd>` 头用；standalone patch 无 trailing 时缺省）。 */
		trailingCommand?: string;
	}
	| {
		kind: "apply-patch-result";
		success: false;
		error: {
			code: string;
			message: string;
			path?: string;
			cwd?: string;
			chunkIndex?: number;
		};
		applied: ApplyPatchFileDiff[];
		skipped: ApplyPatchSkipped[];
		contextMismatch?: ApplyPatchContextMismatch;
		unapplied: ApplyPatchUnapplied[];
		trailing: string;
		trailingCommand?: string;
	};

export type ApplyPatchResultViewModel =
	| ApplyPatchSingleResultViewModel
	| {
		kind: "apply-patch-batch-result";
		results: ApplyPatchSingleResultViewModel[];
		finalFiles?: ApplyPatchBatchFileDiff[];
		trailing: string;
		trailingCommand?: string;
	};

// ---------------------------------------------------------------------------
// 收集阶段（阶段 A）：决定每个文件条目的 diff 请求，不做计算。
// ---------------------------------------------------------------------------

/** 一个文件条目的 diff 请求引用；spec 缺省 = 无请求（intent diff）。 */
type CollectedFile = {
	kind: ApplyPatchFileDiff["kind"];
	/** rewrite 配对时存在。 */
	addOp?: PlannedPatchOperation;
	planned: PlannedPatchOperation;
	cwd: string;
	spec?: { fileId: string };
	/** batch finalFiles 聚合计数（普通条目缺省）。 */
	patchCount?: number;
};

type CollectedSingle =
	| {
		success: true;
		files: CollectedFile[];
		trailing: string;
		trailingCommand?: string;
	}
	| {
		success: false;
		error: {
			code: string;
			message: string;
			path?: string;
			cwd?: string;
			chunkIndex?: number;
		};
		applied: CollectedFile[];
		skipped: ApplyPatchSkipped[];
		contextMismatch?: ApplyPatchContextMismatch;
		unapplied: ApplyPatchUnapplied[];
		trailing: string;
		trailingCommand?: string;
	};

type DiffCollection = {
	specs: DiffRequestSpec[];
	byKey: Map<string, string>;
};

type DiffRequestSpec = {
	fileId: string;
	input: DiffInput;
};

function specKey(oldContent: string, newContent: string, strategy: DiffStrategy): string {
	return `${strategy.kind}:${strategy.kind === "rewrite" ? strategy.reason : ""}:${oldContent.length}:${oldContent}\u0000${newContent}`;
}

/** 同一 (old, new, strategy) 对只提交一次；返回 fileId（供组装阶段解析）。 */
function collectDiff(
	collection: DiffCollection,
	oldContent: string,
	newContent: string,
	strategy: DiffStrategy,
): string {
	const key = specKey(oldContent, newContent, strategy);
	const existing = collection.byKey.get(key);
	if (existing !== undefined) return existing;
	const fileId = `f${collection.specs.length}`;
	collection.byKey.set(key, fileId);
	collection.specs.push({
		fileId,
		input: {
			fileId,
			oldContent,
			newContent,
			strategy,
			contextLines: PATCH_DIFF_CONTEXT_LINES,
		},
	});
	return fileId;
}

/** 快照对 → exact diff 请求。unavailable 的任何一侧都无法信任：不请求（意图 diff）。 */
function collectExactFileDiff(
	collection: DiffCollection,
	planned: PlannedPatchOperation,
	before: SnapshotSet | undefined,
	afterContents: AfterContents | undefined,
	content?: { oldContent?: string; newContent?: string },
): { fileId: string } | undefined {
	if (content?.oldContent !== undefined && content.newContent !== undefined) {
		// failure payload 自带引擎内容（不依赖快照）。
		return { fileId: collectDiff(collection, content.oldContent, content.newContent, { kind: "exact" }) };
	}
	const beforeSnapshot = before?.get(planned.sourceAbsolutePath);
	if (!beforeSnapshot || beforeSnapshot.kind === "unavailable") return undefined;
	const afterPath = planned.destinationAbsolutePath ?? planned.sourceAbsolutePath;
	if (!before.has(afterPath)) return undefined;
	const afterEntry = afterContents?.get(afterPath);
	if (!afterEntry || afterEntry.kind === "unavailable") return undefined;
	return {
		fileId: collectDiff(
			collection,
			beforeSnapshot.kind === "present" ? beforeSnapshot.content : "",
			afterEntry.kind === "present" ? afterEntry.content : "",
			{ kind: "exact" },
		),
	};
}

/** 可证明的 delete-add pair → rewrite diff（不跑 Myers；快照不可用时回退意图）。 */
function collectRewriteFileDiff(
	collection: DiffCollection,
	deleteOp: PlannedPatchOperation,
	before: SnapshotSet | undefined,
	afterContents: AfterContents | undefined,
): { fileId: string } | undefined {
	const beforeSnapshot = before?.get(deleteOp.sourceAbsolutePath);
	if (!beforeSnapshot || beforeSnapshot.kind === "unavailable") return undefined;
	const afterEntry = afterContents?.get(deleteOp.sourceAbsolutePath);
	if (!afterEntry || afterEntry.kind === "unavailable") return undefined;
	return {
		fileId: collectDiff(
			collection,
			beforeSnapshot.kind === "present" ? beforeSnapshot.content : "",
			afterEntry.kind === "present" ? afterEntry.content : "",
			{ kind: "rewrite", reason: "delete-add-pair" },
		),
	};
}

// ---------------------------------------------------------------------------
// 组装阶段（阶段 C）：用 batch 输出解析文件条目，worker 不可用时 intent 降级。
// ---------------------------------------------------------------------------

type BuiltFileDiff = Pick<ApplyPatchFileDiff, "changeStats" | "diffDisplay" | "diffTruncated">;

function builtFileDiffFromOutput(diff: DiffOutput | undefined): BuiltFileDiff | undefined {
	if (!diff || diff.stats.changedLines === 0) return undefined;
	return {
		changeStats: diff.stats,
		diffDisplay: diff.display,
		diffTruncated: diff.truncated,
	};
}

/** worker 完全不可用时的本地兜底（patch intent 行，纯展示；正常路径不触发）。 */
function localIntentDiff(lines: readonly PatchLine[]): BuiltFileDiff {
	const additions = lines.filter((line) => line.prefix === "+").length;
	const deletions = lines.filter((line) => line.prefix === "-").length;
	return {
		changeStats: { additions, deletions, changedLines: additions + deletions },
		diffDisplay: displayDiffFromLines(lines),
		diffTruncated: false,
	};
}

function assembleFileDiff(entry: CollectedFile, outputs: ReadonlyMap<string, DiffOutput>): ApplyPatchFileDiff {
	if (entry.kind === "Rewrite") {
		const addOp = entry.addOp!;
		const built = entry.spec ? builtFileDiffFromOutput(outputs.get(entry.spec.fileId)) : undefined;
		if (built) {
			return {
				kind: "Rewrite",
				path: addOp.operation.path,
				cwd: entry.cwd,
				changeStats: built.changeStats,
				diffDisplay: built.diffDisplay,
				diffTruncated: built.diffTruncated,
			};
		}
		return intentRewriteFileDiff(entry.planned, addOp, entry.cwd);
	}
	const operation = entry.planned.operation;
	const built = entry.spec ? builtFileDiffFromOutput(outputs.get(entry.spec.fileId)) : undefined;
	if (built) {
		return {
			kind: entry.kind,
			path: operation.path,
			destination: operation.destination,
			cwd: entry.cwd,
			changeStats: built.changeStats,
			diffDisplay: built.diffDisplay,
			diffTruncated: built.diffTruncated,
		};
	}
	const intent = localIntentDiff(operation.lines);
	return {
		kind: entry.kind,
		path: operation.path,
		destination: operation.destination,
		cwd: entry.cwd,
		changeStats: intent.changeStats,
		diffDisplay: intent.diffDisplay,
		diffTruncated: intent.diffTruncated,
	};
}

function intentRewriteFileDiff(deleteOp: PlannedPatchOperation, addOp: PlannedPatchOperation, cwd: string): ApplyPatchFileDiff {
	const lines = [...deleteOp.operation.lines, ...addOp.operation.lines];
	const built = localIntentDiff(lines);
	return {
		kind: "Rewrite",
		path: addOp.operation.path,
		cwd,
		changeStats: built.changeStats,
		diffDisplay: built.diffDisplay,
		diffTruncated: built.diffTruncated,
	};
}

// ---------------------------------------------------------------------------
// 收集（阶段 A）：invocation 结果 → 文件条目 + diff 请求 spec
// ---------------------------------------------------------------------------

/**
 * CLI 报告顺序：success 输出按文件行列出（一个文件一行，可能异于 patch 顺序），
 * 视图模型按该顺序渲染；rewrite 条目位于其 D/A 行中更靠前的位置。
 */
function reorderFilesByChanges(files: CollectedFile[], changes: SuccessfulChange[]): void {
	const changeOrder = new Map<string, number>();
	changes.forEach((change, index) => {
		const key = `${change.status} ${change.path}`;
		if (!changeOrder.has(key)) changeOrder.set(key, index);
	});
	const position = (file: CollectedFile): number => {
		if (file.kind === "Rewrite") {
			const add = changeOrder.get(`A ${file.addOp!.operation.path}`);
			const del = changeOrder.get(`D ${file.planned.operation.path}`);
			if (add === undefined && del === undefined) return Number.MAX_SAFE_INTEGER;
			return Math.min(add ?? Number.MAX_SAFE_INTEGER, del ?? Number.MAX_SAFE_INTEGER);
		}
		// Move 的 CLI 行是目标路径（M <destination>），与其余类型一致按展示路径排序。
		const operation = file.planned.operation;
		const displayPath = operation.destination ?? operation.path;
		const status = file.kind === "Add" ? "A" : file.kind === "Delete" ? "D" : "M";
		return changeOrder.get(`${status} ${displayPath}`) ?? Number.MAX_SAFE_INTEGER;
	};
	files.sort((a, b) => position(a) - position(b));
}

function plannedByIndex(invocation: ApplyPatchInvocation, index: number): PlannedPatchOperation | undefined {
	return invocation.operations.find((planned) => planned.operation.index === index);
}

/** delete 后第一个同 absolute target 的 add 是重写配对（引擎按序应用）。 */
function findRewritePartner(operations: readonly PlannedPatchOperation[], start: number): number | undefined {
	const operation = operations[start]!;
	if (operation.operation.kind !== "delete") return undefined;
	for (let i = start + 1; i < operations.length; i++) {
		const candidate = operations[i]!;
		if (candidate.operation.kind === "add" && candidate.sourceAbsolutePath === operation.sourceAbsolutePath) return i;
	}
	return undefined;
}

function collectSingleResult(
	invocation: ApplyPatchInvocation,
	parsed: ParsedApplyPatchResultSequence["results"][number],
	before: SnapshotSet | undefined,
	afterContents: AfterContents | undefined,
	collection: DiffCollection,
	trailingCommand: string | undefined,
): CollectedSingle | undefined {
	if (parsed.success) {
		if (!successMatchesPatch(invocation.patch, parsed.changes)) return undefined;
		const files: CollectedFile[] = [];
		const used = new Set<number>();
		const partners = new Map<number, number>();
		for (let i = 0; i < invocation.operations.length; i++) {
			const partner = findRewritePartner(invocation.operations, i);
			if (partner !== undefined) partners.set(i, partner);
		}
		for (let i = 0; i < invocation.operations.length; i++) {
			if (used.has(i)) continue;
			const planned = invocation.operations[i]!;
			const partner = partners.get(i);
			if (partner !== undefined) {
				used.add(i);
				used.add(partner);
				files.push({
					kind: "Rewrite",
					planned,
					addOp: invocation.operations[partner]!,
					cwd: invocation.cwd,
					spec: collectRewriteFileDiff(collection, planned, before, afterContents),
				});
				continue;
			}
			files.push({
				kind: operationKindWord(planned.operation),
				planned,
				cwd: invocation.cwd,
				spec: collectExactFileDiff(collection, planned, before, afterContents),
			});
		}
		reorderFilesByChanges(files, parsed.changes);
		return { success: true, files, trailing: "", trailingCommand };
	}
	const failure = parsed.failure;
	if (!failureMatchesPatch(invocation.patch, failure)) return undefined;
	const applied: CollectedFile[] = [];
	const appliedSpecs = new Map<number, { fileId: string } | undefined>();
	for (const change of failure.appliedPrefix) {
		const planned = plannedByIndex(invocation, change.index);
		if (!planned) return undefined;
		appliedSpecs.set(change.index, collectExactFileDiff(collection, planned, before, afterContents, change));
	}
	const used = new Set<number>();
	for (const change of failure.appliedPrefix) {
		if (used.has(change.index)) continue;
		if (change.operation === "delete") {
			const partner = failure.appliedPrefix.find((candidate) =>
				candidate.index !== change.index && candidate.operation === "add" && candidate.path === change.path);
			if (partner !== undefined) {
				used.add(change.index);
				used.add(partner.index);
				const deleteOp = plannedByIndex(invocation, change.index)!;
				const addOp = plannedByIndex(invocation, partner.index)!;
				applied.push({
					kind: "Rewrite",
					planned: deleteOp,
					addOp,
					cwd: invocation.cwd,
					spec: collectRewriteFileDiff(collection, deleteOp, before, afterContents),
				});
				continue;
			}
		}
		const planned = plannedByIndex(invocation, change.index)!;
		applied.push({
			kind: operationKindWord(planned.operation),
			planned,
			cwd: invocation.cwd,
			spec: appliedSpecs.get(change.index),
		});
	}
	const appliedIndexes = new Set(failure.appliedPrefix.map((change) => change.index));
	const skippedIndexes = new Set(failure.skipped.map((skip) => skip.index));
	const skipped: ApplyPatchSkipped[] = failure.skipped.map((skip) => ({
		operation: skip.operation,
		path: skip.path,
		cwd: skip.path === undefined ? undefined : invocation.cwd,
		message: skip.message,
	}));
	const unapplied: ApplyPatchUnapplied[] = invocation.patch.operations
		.filter((operation) => !appliedIndexes.has(operation.index) && !skippedIndexes.has(operation.index))
		.map((operation) => ({
			kind: operationKindWord(operation),
			path: operation.path,
			destination: operation.destination,
			cwd: invocation.cwd,
		}));
	const contextMismatch = buildContextMismatch(invocation, failure, before);
	return {
		success: false,
		error: {
			code: failure.error.code,
			message: failure.error.message,
			path: failure.error.hunk?.path,
			cwd: failure.error.hunk?.path === undefined ? undefined : invocation.cwd,
			chunkIndex: failure.error.hunk?.chunkIndex,
		},
		applied,
		skipped,
		contextMismatch,
		unapplied,
		trailing: "",
		trailingCommand,
	};
}

function buildContextMismatch(
	invocation: ApplyPatchInvocation,
	failure: ApplyPatchFailure,
	before: SnapshotSet | undefined,
): ApplyPatchContextMismatch | undefined {
	if (failure.error.code !== "CONTEXT_NOT_FOUND" || !failure.error.hunk?.path) return undefined;
	const hunk = failure.error.hunk;
	if (hunk.index === undefined || hunk.chunkIndex === undefined) return undefined;
	const path = hunk.path;
	if (path === undefined) return undefined;
	const operation = operationByIndex(invocation.patch, hunk.index);
	const chunk = operation?.chunks?.[hunk.chunkIndex];
	if (!chunk) return undefined;
	const expectedLines = chunk.lines.filter((line) => line.prefix !== "+").map((line) => line.text);
	const planned = plannedByIndex(invocation, hunk.index);
	const beforeSnapshot = planned ? before?.get(planned.sourceAbsolutePath) : undefined;
	if (!beforeSnapshot || beforeSnapshot.kind !== "present") return undefined;
	const actual = truncateHead(beforeSnapshot.content, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	return {
		expectedLines,
		actualLines: actual.content.split("\n"),
		actualTruncated: actual.truncated,
	};
}

// ---------------------------------------------------------------------------
// batch finalFiles（多 invocation 成功时的聚合展示）
// ---------------------------------------------------------------------------

type BatchGroup =
	| { kind: Exclude<ApplyPatchFileDiff["kind"], "Rewrite">; planned: PlannedPatchOperation; cwd: string; patchCount: number }
	| { kind: "Rewrite"; deleteOp: PlannedPatchOperation; addOp: PlannedPatchOperation; cwd: string; patchCount: number };

async function collectBatchFinalFiles(
	invocations: readonly ApplyPatchInvocation[],
	before: SnapshotSet | undefined,
	afterContents: AfterContents | undefined,
	collection: DiffCollection,
): Promise<CollectedFile[] | undefined> {
	if (!before) return undefined;
	const grouped = new Map<string, BatchGroup>();
	for (const invocation of invocations) {
		const used = new Set<number>();
		for (let i = 0; i < invocation.operations.length; i++) {
			if (used.has(i)) continue;
			const planned = invocation.operations[i]!;
			const partner = findRewritePartner(invocation.operations, i);
			if (partner !== undefined) {
				used.add(i);
				used.add(partner);
				const key = JSON.stringify(["Rewrite", planned.sourceAbsolutePath]);
				const current = grouped.get(key);
				if (current && current.kind === "Rewrite") current.patchCount += 1;
				else grouped.set(key, { kind: "Rewrite", deleteOp: planned, addOp: invocation.operations[partner]!, cwd: invocation.cwd, patchCount: 1 });
				continue;
			}
			const key = JSON.stringify([operationKindWord(planned.operation), planned.sourceAbsolutePath, planned.destinationAbsolutePath]);
			const current = grouped.get(key);
			if (current && current.kind !== "Rewrite") current.patchCount += 1;
			else grouped.set(key, { kind: operationKindWord(planned.operation), planned, cwd: invocation.cwd, patchCount: 1 });
		}
	}
	mergeCrossPatchRewrites(grouped);
	const files: CollectedFile[] = [];
	for (const group of grouped.values()) {
		if (group.kind === "Rewrite") {
			files.push({
				kind: "Rewrite",
				planned: group.deleteOp,
				addOp: group.addOp,
				cwd: group.cwd,
				spec: collectRewriteFileDiff(collection, group.deleteOp, before, afterContents),
				patchCount: group.patchCount,
			});
			continue;
		}
		files.push({
			kind: group.kind,
			planned: group.planned,
			cwd: group.cwd,
			spec: collectExactFileDiff(collection, group.planned, before, afterContents),
			patchCount: group.patchCount,
		});
	}
	return files;
}

function mergeCrossPatchRewrites(grouped: Map<string, BatchGroup>): void {
	for (const [deleteKey, group] of [...grouped.entries()]) {
		if (group.kind !== "Delete") continue;
		const addKey = JSON.stringify(["Add", group.planned.sourceAbsolutePath, undefined]);
		const addGroup = grouped.get(addKey);
		if (!addGroup || addGroup.kind !== "Add") continue;
		grouped.set(deleteKey, {
			kind: "Rewrite",
			deleteOp: group.planned,
			addOp: addGroup.planned,
			cwd: group.cwd,
			patchCount: group.patchCount + addGroup.patchCount,
		});
		grouped.delete(addKey);
	}
}

// ---------------------------------------------------------------------------
// 顶层：收集 → batch 提交 → 组装
// ---------------------------------------------------------------------------

/**
 * 纯 view model 构建（两阶段）：
 * 阶段 A 收集所有文件的 DiffInput（不计算）；阶段 B 一次 batch 提交到 worker；
 * 阶段 C 用输出组装 view model（worker 不可用时整体降级 intent diff）。
 * 不做任何文件 IO 与本地 diff（intent 仅是 worker 不可用的兜底）。
 * parsed 与 plan 必须来自同一次命令（registry 保证）。
 */
export async function buildResultViewModel(
	plan: ApplyPatchPlan,
	parsed: ParsedApplyPatchResultSequence,
	before: SnapshotSet | undefined,
	afterContents: AfterContents | undefined,
	submitter: DiffBatchSubmitter,
): Promise<ApplyPatchResultViewModel | undefined> {
	if (parsed.results.length !== plan.invocations.length) return undefined;
	const trailingCommand = plan.trailingCommand;
	const snapshot = plan.invocations.length === 1 ? before : undefined;
	const collection: DiffCollection = { specs: [], byKey: new Map() };

	// 阶段 A：收集（决定 diff 请求，不 await）。
	const collected: CollectedSingle[] = [];
	for (const [index, invocation] of plan.invocations.entries()) {
		const single = collectSingleResult(invocation, parsed.results[index]!, snapshot, afterContents, collection, trailingCommand);
		if (!single) return undefined;
		collected.push(single);
	}
	// batch finalFiles 的请求也并入同一批（避免二次提交）。
	let finalCollected: CollectedFile[] | undefined;
	if (collected.length > 1 && collected.every((entry) => entry.success)) {
		finalCollected = await collectBatchFinalFiles(plan.invocations, before, afterContents, collection);
	}

	// 阶段 B：一次 batch 提交。
	const inputs = collection.specs.map((spec) => spec.input);
	const outputs = inputs.length === 0
		? new Map<string, DiffOutput>()
		: new Map((await submitter(inputs))?.map((output) => [output.fileId, output]));

	// 阶段 C：组装。
	const results: ApplyPatchSingleResultViewModel[] = collected.map((single) => {
		if (single.success) {
			return {
				kind: "apply-patch-result",
				success: true,
				files: single.files.map((entry) => assembleFileDiff(entry, outputs)),
				trailing: single.trailing,
				trailingCommand: single.trailingCommand,
			};
		}
		return {
			kind: "apply-patch-result",
			success: false,
			error: single.error,
			applied: single.applied.map((entry) => assembleFileDiff(entry, outputs)),
			skipped: single.skipped,
			contextMismatch: single.contextMismatch,
			unapplied: single.unapplied,
			trailing: single.trailing,
			trailingCommand: single.trailingCommand,
		};
	});
	if (results.length === 1) return { ...results[0]!, trailing: parsed.trailing, trailingCommand };
	const finalFiles = finalCollected === undefined
		? undefined
		: finalCollected.map((entry) => ({ ...assembleFileDiff(entry, outputs), patchCount: entry.patchCount ?? 1 }));
	return { kind: "apply-patch-batch-result", results, finalFiles, trailing: parsed.trailing, trailingCommand };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isFileDiff(value: unknown): value is ApplyPatchFileDiff {
	return isRecord(value) &&
		["Add", "Update", "Move", "Delete", "Rewrite"].includes(String(value.kind)) &&
		typeof value.path === "string" &&
		(value.destination === undefined || typeof value.destination === "string") &&
		typeof value.cwd === "string" &&
		isChangeStats(value.changeStats) &&
		isDisplayDiff(value.diffDisplay) &&
		typeof value.diffTruncated === "boolean";
}

function isBatchFileDiff(value: unknown): value is ApplyPatchBatchFileDiff {
	if (!isRecord(value)) return false;
	const patchCount = value.patchCount;
	return isFileDiff(value) &&
		typeof patchCount === "number" &&
		Number.isInteger(patchCount) &&
		patchCount > 0;
}

function isUnapplied(value: unknown): value is ApplyPatchUnapplied {
	return isRecord(value) &&
		["Add", "Update", "Move", "Delete"].includes(String(value.kind)) &&
		typeof value.path === "string" &&
		(value.destination === undefined || typeof value.destination === "string") &&
		typeof value.cwd === "string";
}

function isSkipped(value: unknown): value is ApplyPatchSkipped {
	return isRecord(value) &&
		(value.operation === undefined || typeof value.operation === "string") &&
		(value.path === undefined || typeof value.path === "string") &&
		(value.cwd === undefined || typeof value.cwd === "string") &&
		typeof value.message === "string";
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function parseContextMismatch(value: unknown): ApplyPatchContextMismatch | undefined {
	if (!isRecord(value) || !Array.isArray(value.expectedLines) || !Array.isArray(value.actualLines)) return undefined;
	if (!value.expectedLines.every((line) => typeof line === "string")) return undefined;
	if (!value.actualLines.every((line) => typeof line === "string")) return undefined;
	return {
		expectedLines: value.expectedLines,
		actualLines: value.actualLines,
		actualTruncated: value.actualTruncated === true,
	};
}

function parseSingleRenderedResultPayload(details: unknown): ApplyPatchSingleResultViewModel | undefined {
	if (!isRecord(details) || details.kind !== "apply-patch-result" || typeof details.success !== "boolean") return undefined;
	if (!isOptionalString(details.trailingCommand)) return undefined;
	if (details.success === true) {
		if (!Array.isArray(details.files) || !details.files.every(isFileDiff) || typeof details.trailing !== "string") return undefined;
		return {
			kind: "apply-patch-result",
			success: true,
			files: details.files,
			trailing: details.trailing,
			trailingCommand: details.trailingCommand,
		};
	}
	if (
		!isRecord(details.error) ||
		typeof details.error.code !== "string" ||
		typeof details.error.message !== "string" ||
		!isOptionalString(details.error.cwd) ||
		!Array.isArray(details.applied) ||
		!details.applied.every(isFileDiff) ||
		!Array.isArray(details.skipped) ||
		!details.skipped.every(isSkipped) ||
		!Array.isArray(details.unapplied) ||
		!details.unapplied.every(isUnapplied) ||
		typeof details.trailing !== "string"
	) return undefined;
	const contextMismatch = details.contextMismatch === undefined ? undefined : parseContextMismatch(details.contextMismatch);
	if (details.contextMismatch !== undefined && !contextMismatch) return undefined;
	return {
		kind: "apply-patch-result",
		success: false,
		error: {
			code: details.error.code,
			message: details.error.message,
			path: typeof details.error.path === "string" ? details.error.path : undefined,
			cwd: typeof details.error.cwd === "string" ? details.error.cwd : undefined,
			chunkIndex: typeof details.error.chunkIndex === "number" ? details.error.chunkIndex : undefined,
		},
		applied: details.applied,
		skipped: details.skipped,
		contextMismatch,
		unapplied: details.unapplied,
		trailing: details.trailing,
		trailingCommand: details.trailingCommand,
	};
}

/** 从 result.details 解析结构化结果（tool_result 注入），渲染层只消费它。 */
export function parseRenderedResultPayload(details: unknown): ApplyPatchResultViewModel | undefined {
	const single = parseSingleRenderedResultPayload(details);
	if (single) return single;
	if (
		!isRecord(details) ||
		details.kind !== "apply-patch-batch-result" ||
		!Array.isArray(details.results) ||
		(details.finalFiles !== undefined && (!Array.isArray(details.finalFiles) || !details.finalFiles.every(isBatchFileDiff))) ||
		typeof details.trailing !== "string" ||
		!isOptionalString(details.trailingCommand)
	) {
		return undefined;
	}
	const results = details.results.map(parseSingleRenderedResultPayload);
	return results.some((result) => result === undefined)
		? undefined
		: {
			kind: "apply-patch-batch-result",
			results: results as ApplyPatchSingleResultViewModel[],
			finalFiles: details.finalFiles as ApplyPatchBatchFileDiff[] | undefined,
			trailing: details.trailing,
			trailingCommand: details.trailingCommand,
		};
}

export function operationKindWord(operation: Pick<PatchOperation, "kind" | "destination">): Exclude<ApplyPatchFileDiff["kind"], "Rewrite"> {
	if (operation.kind === "add") return "Add";
	if (operation.kind === "delete") return "Delete";
	return operation.destination ? "Move" : "Update";
}

export function changeMatchesOperation(change: SuccessfulChange, operation: Pick<PatchOperation, "kind" | "path" | "destination">): boolean {
	const status = operation.kind === "add" ? "A" : operation.kind === "delete" ? "D" : "M";
	return status === change.status && (operation.destination ?? operation.path) === change.path;
}
