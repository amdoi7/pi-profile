import { stat } from "node:fs/promises";

import {
	defaultEditEngineOperations,
	executeFileGroupEdits,
	isEditToolError,
	type ExecutedFileEditResult,
	type FileEditOperation,
} from "./edit-engine.ts";
import {
	type ExecutionOutcomeGroup,
	type ExecutionPlan,
	type ExecutionPlanGroup,
	type FailedExecutionOutcomeGroup,
	type SuccessfulExecutionOutcomeGroup,
} from "./pipeline.ts";

// Maximum total bytes of file content allowed in-flight concurrently.
// Small files can run in parallel; large files run alone.
const MAX_INFLIGHT_BYTES = 4 * 1024 * 1024; // 4 MB

type ExecutePlanGroup = (
	absolutePath: string,
	displayPath: string,
	edits: FileEditOperation[],
	signal?: AbortSignal,
) => Promise<ExecutedFileEditResult>;

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}

function isOperationAborted(error: unknown): boolean {
	return error instanceof Error && error.message === "Operation aborted";
}

async function executeSinglePlanGroup(
	planGroup: ExecutionPlanGroup,
	signal: AbortSignal | undefined,
	executePlanGroup: ExecutePlanGroup,
): Promise<ExecutionOutcomeGroup> {
	throwIfAborted(signal);

	try {
		const result = await executePlanGroup(
			planGroup.canonicalPath,
			planGroup.path,
			planGroup.edits,
			signal,
		);

		const groupResult: SuccessfulExecutionOutcomeGroup = {
			path: planGroup.path,
			canonicalPath: planGroup.canonicalPath,
			edits: planGroup.edits,
			editCount: planGroup.edits.length,
			status: "applied",
			operation: "replace",
			previewText: result.previewText,
			previewTruncated: result.previewTruncated,
			changeStats: result.changeStats,
		};
		if (typeof result.previewStartLine === "number") {
			groupResult.previewStartLine = result.previewStartLine;
		}
		if (result.summary.trim().length > 0) {
			groupResult.summary = result.summary.trim();
		}
		return groupResult;
	} catch (error) {
		if (signal?.aborted || isOperationAborted(error)) {
			throw error instanceof Error ? error : new Error(String(error));
		}

		const baseError = error instanceof Error ? error : new Error(String(error));

		const failedGroupResult: FailedExecutionOutcomeGroup = {
			path: planGroup.path,
			canonicalPath: planGroup.canonicalPath,
			edits: planGroup.edits,
			editCount: planGroup.edits.length,
			status: "failed",
			error: baseError.message,
			errorKind: isEditToolError(baseError) ? baseError.kind : undefined,
		};
		return failedGroupResult;
	}
}

/**
 * Byte-budget scheduler: runs items concurrently but caps total in-flight
 * estimated bytes at MAX_INFLIGHT_BYTES. Items with unknown size (stat failed)
 * are treated as MAX_INFLIGHT_BYTES so they run alone.
 */
async function runWithByteBudget<TOutput>(
	groups: readonly ExecutionPlanGroup[],
	maxConcurrency: number,
	estimatedBytes: readonly number[],
	runItem: (group: ExecutionPlanGroup) => Promise<TOutput>,
): Promise<TOutput[]> {
	const results = new Array<TOutput>(groups.length);
	let inflightBytes = 0;
	let inflightCount = 0;
	const waiters: Array<() => void> = [];

	// Wake ALL waiters so every one that can now fit within budget gets a chance.
	// Waking only one risks starvation when the released slot fits a different
	// waiter but not the one at the front of the queue.
	function notifyAll(): void {
		const pending = waiters.splice(0);
		for (const waiter of pending) waiter();
	}
	function waitForSlot(): Promise<void> {
		return new Promise((resolve) => waiters.push(resolve));
	}

	async function runOne(index: number): Promise<void> {
		const bytes = estimatedBytes[index]!;
		// Wait until there is budget: either nothing in-flight, or adding this
		// item stays within budget and concurrency limit.
		while (
			inflightCount > 0 &&
			(inflightCount >= maxConcurrency || inflightBytes + bytes > MAX_INFLIGHT_BYTES)
		) {
			await waitForSlot();
		}
		inflightBytes += bytes;
		inflightCount += 1;
		try {
			results[index] = await runItem(groups[index]!);
		} finally {
			inflightBytes -= bytes;
			inflightCount -= 1;
			notifyAll();
		}
	}

	await Promise.all(groups.map((_, i) => runOne(i)));
	return results;
}

export async function executeExecutionPlan(
	plan: ExecutionPlan,
	signal?: AbortSignal,
	executePlanGroup: ExecutePlanGroup = executeFileGroupEdits,
): Promise<ExecutionOutcomeGroup[]> {
	throwIfAborted(signal);
	if (plan.groups.length === 0) {
		return [];
	}

	// Stat all files upfront to get byte estimates for the budget scheduler.
	// Unknown size (new file, stat error) → treat as MAX_INFLIGHT_BYTES so it runs alone.
	const statResults = await Promise.all(
		plan.groups.map(async (group) => {
			try {
				return await stat(group.canonicalPath);
			} catch {
				return null;
			}
		}),
	);

	// Build a Map for O(1) lookup in wrappedExecutor — avoids O(k) findIndex per call.
	const statByPath = new Map<string, Awaited<ReturnType<typeof stat>>>();
	const estimatedBytes: number[] = [];
	for (let i = 0; i < plan.groups.length; i++) {
		const s = statResults[i]!;
		estimatedBytes.push(s?.size ?? MAX_INFLIGHT_BYTES);
		if (s !== null) statByPath.set(plan.groups[i]!.canonicalPath, s);
	}

	// When using the default executor, inject the already-known stat result so
	// executeFileGroupEdits skips its own preflight stat syscall.
	const isDefaultExecutor = executePlanGroup === executeFileGroupEdits;
	const wrappedExecutor: ExecutePlanGroup = isDefaultExecutor
		? (absolutePath, displayPath, edits, sig) => {
				const knownStat = statByPath.get(absolutePath) ?? null;
				return executeFileGroupEdits(absolutePath, displayPath, edits, sig, {
					...defaultEditEngineOperations,
					stat: knownStat !== null
						? async () => knownStat
						: (p) => stat(p),
				});
		  }
		: executePlanGroup;

	return runWithByteBudget(
		plan.groups,
		plan.maxConcurrency,
		estimatedBytes,
		(planGroup) => executeSinglePlanGroup(
			planGroup,
			signal,
			wrappedExecutor,
		),
	);
}
