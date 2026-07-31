import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { PatchOperation } from "./patch-command.ts";


type Snapshot =
	| { state: "content"; content: string }
	| { state: "missing" }
	| { state: "unavailable"; diagnostic: SnapshotDiagnostic };

export type SnapshotDiagnostic = {
	code: "INVALID_PATH" | "PATH_ESCAPE" | "READ_FAILED" | "ROOT_UNAVAILABLE" | "QUEUE_UNAVAILABLE";
	path: string;
	phase: "before" | "after" | "setup";
	message: string;
	remediation: string;
};

export type EphemeralPatchRun = {
	operations: PatchOperation[];
	before: Map<string, Snapshot>;
	after: Map<string, Snapshot>;
	diagnostics: SnapshotDiagnostic[];
};

type SnapshotTarget = {
	path: string;
	absolutePath: string;
	queuePath: string;
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}

function isMissing(error: unknown): boolean {
	const code = errorCode(error);
	return code === "ENOENT" || code === "ENOTDIR";
}

function isWithin(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function operationPaths(operations: readonly PatchOperation[]): string[] {
	const paths = new Set<string>();
	for (const operation of operations) {
		paths.add(operation.path);
		if (operation.destination) paths.add(operation.destination);
	}
	return [...paths];
}

async function resolveTargets(
	cwd: string,
	operations: readonly PatchOperation[],
): Promise<{ root: string | undefined; targets: SnapshotTarget[]; diagnostics: SnapshotDiagnostic[] }> {
	let root: string;
	try {
		root = await realpath(cwd);
	} catch (error) {
		return {
			root: undefined,
			targets: [],
			diagnostics: [{
				code: "ROOT_UNAVAILABLE",
				path: cwd,
				phase: "setup",
				message: `apply_patch UI could not resolve cwd: ${errorMessage(error)}`,
				remediation: "Verify that the working directory exists and is readable.",
			}],
		};
	}

	const targets: SnapshotTarget[] = [];
	const diagnostics: SnapshotDiagnostic[] = [];
	for (const displayPath of operationPaths(operations)) {
		if (isAbsolute(displayPath)) {
			diagnostics.push({
				code: "INVALID_PATH",
				path: displayPath,
				phase: "setup",
				message: "apply_patch UI snapshots require workspace-relative paths.",
				remediation: "Use a path relative to the current workspace.",
			});
			continue;
		}
		const absolutePath = resolve(cwd, displayPath);
		if (!isWithin(resolve(cwd), absolutePath)) {
			diagnostics.push({
				code: "PATH_ESCAPE",
				path: displayPath,
				phase: "setup",
				message: "apply_patch UI snapshot path escapes the workspace lexically.",
				remediation: "Use a path inside the current workspace.",
			});
			continue;
		}

		let queuePath = absolutePath;
		try {
			const canonicalPath = await realpath(absolutePath);
			if (!isWithin(root, canonicalPath)) {
				diagnostics.push({
					code: "PATH_ESCAPE",
					path: displayPath,
					phase: "setup",
					message: "apply_patch UI snapshot path resolves outside the workspace.",
					remediation: "Remove the escaping symlink or target a workspace file.",
				});
				continue;
			}
			queuePath = canonicalPath;
		} catch (error) {
			if (!isMissing(error)) {
				diagnostics.push({
					code: "READ_FAILED",
					path: displayPath,
					phase: "setup",
					message: `apply_patch UI could not resolve snapshot path: ${errorMessage(error)}`,
					remediation: "Verify path permissions; the patch command will still run unchanged.",
				});
				continue;
			}
		}
		targets.push({ path: displayPath, absolutePath, queuePath });
	}
	return { root, targets, diagnostics };
}

async function readSnapshot(
	root: string,
	target: SnapshotTarget,
	phase: "before" | "after",
): Promise<Snapshot> {
	let canonicalPath: string;
	try {
		canonicalPath = await realpath(target.absolutePath);
	} catch (error) {
		if (isMissing(error)) return { state: "missing" };
		return {
			state: "unavailable",
			diagnostic: {
				code: "READ_FAILED",
				path: target.path,
				phase,
				message: `apply_patch UI could not resolve file snapshot: ${errorMessage(error)}`,
				remediation: "Verify file permissions; inspect the unchanged bash result for command status.",
			},
		};
	}
	if (!isWithin(root, canonicalPath)) {
		return {
			state: "unavailable",
			diagnostic: {
				code: "PATH_ESCAPE",
				path: target.path,
				phase,
				message: "apply_patch UI refused to read a snapshot outside the workspace.",
				remediation: "Remove the escaping symlink or inspect the unchanged bash result.",
			},
		};
	}
	try {
		return { state: "content", content: await readFile(canonicalPath, "utf8") };
	} catch (error) {
		return {
			state: "unavailable",
			diagnostic: {
				code: "READ_FAILED",
				path: target.path,
				phase,
				message: `apply_patch UI could not read file snapshot: ${errorMessage(error)}`,
				remediation: "Verify file permissions; inspect the unchanged bash result for command status.",
			},
		};
	}
}

async function captureSnapshots(
	root: string,
	targets: readonly SnapshotTarget[],
	phase: "before" | "after",
): Promise<Map<string, Snapshot>> {
	const snapshots = await Promise.all(targets.map((target) => readSnapshot(root, target, phase)));
	return new Map(targets.map((target, index) => [target.path, snapshots[index]!]));
}

function uniqueQueuePaths(targets: readonly SnapshotTarget[]): string[] {
	return [...new Set(targets.map((target) => target.queuePath))].sort();
}

async function withMutationQueues<T>(
	paths: readonly string[],
	run: () => Promise<T>,
	index = 0,
): Promise<T> {
	if (index >= paths.length) return run();
	return withFileMutationQueue(paths[index]!, () => withMutationQueues(paths, run, index + 1));
}

export class EphemeralPatchRuns {
	private readonly runs = new Map<string, EphemeralPatchRun>();

	async execute<T>(
		toolCallId: string,
		operations: readonly PatchOperation[],
		cwd: string,
		delegate: () => Promise<T>,
	): Promise<T> {
		const setup = await resolveTargets(cwd, operations);
		if (!setup.root) {
			this.runs.set(toolCallId, {
				operations: [...operations],
				before: new Map(),
				after: new Map(),
				diagnostics: setup.diagnostics,
			});
			return delegate();
		}

		let delegated = false;
		const run = async (): Promise<T> => {
			const before = await captureSnapshots(setup.root!, setup.targets, "before");
			let result: T | undefined;
			let failure: unknown;
			let failed = false;
			try {
				delegated = true;
				result = await delegate();
			} catch (error) {
				failed = true;
				failure = error;
			}
			const after = await captureSnapshots(setup.root!, setup.targets, "after");
			const snapshotDiagnostics = [...before.values(), ...after.values()]
				.filter((snapshot): snapshot is Extract<Snapshot, { state: "unavailable" }> => snapshot.state === "unavailable")
				.map((snapshot) => snapshot.diagnostic);
			this.runs.set(toolCallId, {
				operations: [...operations],
				before,
				after,
				diagnostics: [...setup.diagnostics, ...snapshotDiagnostics],
			});
			if (failed) throw failure;
			return result as T;
		};

		try {
			return await withMutationQueues(uniqueQueuePaths(setup.targets), run);
		} catch (error) {
			if (delegated) throw error;
			this.runs.set(toolCallId, {
				operations: [...operations],
				before: new Map(),
				after: new Map(),
				diagnostics: [...setup.diagnostics, {
					code: "QUEUE_UNAVAILABLE",
					path: cwd,
					phase: "setup",
					message: `apply_patch UI mutation queue unavailable: ${errorMessage(error)}`,
					remediation: "Inspect the unchanged bash result; retry after resolving path permissions.",
				}],
			});
			return delegate();
		}
	}

	take(toolCallId: string): EphemeralPatchRun | undefined {
		const run = this.runs.get(toolCallId);
		this.runs.delete(toolCallId);
		return run;
	}

	clear(): void {
		this.runs.clear();
	}
}

export function snapshotContent(
	run: EphemeralPatchRun,
	phase: "before" | "after",
	path: string,
): string | undefined {
	const snapshot = run[phase].get(path);
	if (!snapshot || snapshot.state === "unavailable") return undefined;
	return snapshot.state === "missing" ? "" : snapshot.content;
}
