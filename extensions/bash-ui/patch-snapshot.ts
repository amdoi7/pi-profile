import { readFile, stat } from "node:fs/promises";

import { isRecord, type ApplyPatchPlan } from "./recognize.ts";

/**
 * 文件快照三态：
 * - present：可读内容；
 * - missing：ENOENT（文件确实不存在，delete 目标 / add 前状态）；
 * - unavailable：无法信任内容（超大文件 / 权限 / IO 错误），不伪装成"不存在"。
 */
export type FileSnapshot =
	| { kind: "present"; absolutePath: string; content: string }
	| { kind: "missing"; absolutePath: string }
	| { kind: "unavailable"; absolutePath: string; reason: "too-large" | "permission" | "io-error" };

/** key 是 absolutePath（snapshot、aggregation、rewrite pairing 的唯一 identity）。 */
export type SnapshotSet = ReadonlyMap<string, FileSnapshot>;

/** 执行中冻结的 after 快照：key 是 absolutePath，按路径去重、每路径只读一次。 */
export type AfterContents = ReadonlyMap<string, FileSnapshot>;

/**
 * before 快照大小上限：超出视为非源码文件（生成物/数据），跳过行号 diff（回退意图 diff）。
 * 实测最大源码文件约 2.5MB（ai4x 生成物），此处留 3 倍余量。
 */
const BEFORE_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

/** ENOENT 才是 missing；EACCES/EPERM 是 permission；其余是 io-error。 */
function errorSnapshot(absolutePath: string, error: unknown): FileSnapshot {
	if (!isRecord(error) || typeof error.code !== "string") {
		return { kind: "unavailable", absolutePath, reason: "io-error" };
	}
	if (error.code === "ENOENT") return { kind: "missing", absolutePath };
	if (error.code === "EACCES" || error.code === "EPERM") {
		return { kind: "unavailable", absolutePath, reason: "permission" };
	}
	return { kind: "unavailable", absolutePath, reason: "io-error" };
}

async function readSnapshotEntry(absolutePath: string): Promise<FileSnapshot> {
	try {
		if ((await stat(absolutePath)).size > BEFORE_SNAPSHOT_MAX_BYTES) {
			return { kind: "unavailable", absolutePath, reason: "too-large" };
		}
		const content = await readFile(absolutePath, "utf8");
		return { kind: "present", absolutePath, content };
	} catch (error) {
		return errorSnapshot(absolutePath, error);
	}
}

/**
 * 执行者架构的快照 API：按 absolute path 去重读取（每路径只读一次）。
 * 快照时机由执行者 bracket（队列内、spawn 前/后），无 sibling 竞态窗口。
 */
export async function snapshotPaths(absolutePaths: readonly string[]): Promise<SnapshotSet> {
	const snapshots = new Map<string, FileSnapshot>();
	for (const absolutePath of absolutePaths) {
		if (!snapshots.has(absolutePath)) {
			snapshots.set(absolutePath, await readSnapshotEntry(absolutePath));
		}
	}
	return snapshots;
}

/**
 * 执行前捕获 before 快照（tool_call：并行 sibling execution 之前）。
 * 同一 absolute path 只读一次；一个文件被多 operation 引用时共享同一 entry。
 */
export async function captureBeforeSnapshots(plan: ApplyPatchPlan): Promise<SnapshotSet> {
	const snapshots = new Map<string, FileSnapshot>();
	for (const invocation of plan.invocations) {
		for (const planned of invocation.operations) {
			if (!snapshots.has(planned.sourceAbsolutePath)) {
				snapshots.set(planned.sourceAbsolutePath, await readSnapshotEntry(planned.sourceAbsolutePath));
			}
			if (planned.destinationAbsolutePath !== undefined && !snapshots.has(planned.destinationAbsolutePath)) {
				snapshots.set(planned.destinationAbsolutePath, await readSnapshotEntry(planned.destinationAbsolutePath));
			}
		}
	}
	return snapshots;
}

/**
 * 冻结 after 快照：patch 结果块首次完整时读取（trailing command 改写文件之前的最早观察点）。
 * 只读 before 中出现过的路径，按 absolute path 去重。
 */
export async function captureAfterSnapshots(plan: ApplyPatchPlan, before: SnapshotSet): Promise<AfterContents> {
	const contents = new Map<string, FileSnapshot>();
	for (const invocation of plan.invocations) {
		for (const planned of invocation.operations) {
			const afterPath = planned.destinationAbsolutePath ?? planned.sourceAbsolutePath;
			if (!before.has(afterPath) || contents.has(afterPath)) continue;
			contents.set(afterPath, await readSnapshotEntry(afterPath));
		}
	}
	return contents;
}
