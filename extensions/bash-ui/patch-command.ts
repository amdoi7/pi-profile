import * as path from "node:path";

export type PatchLine = {
	prefix: " " | "+" | "-";
	text: string;
};

export type PatchChunk = {
	index: number;
	lines: PatchLine[];
};

export type PatchOperation = {
	index: number;
	kind: "add" | "delete" | "update";
	path: string;
	destination?: string;
	lines: PatchLine[];
	chunks?: PatchChunk[];
};

export type ParsedPatch = {
	operations: PatchOperation[];
};

/**
 * 计划中的一次操作：operation 保留 CLI 局部 index 与展示用 relative path，
 * absolute path 是 snapshot / aggregation / rewrite pairing 的唯一 identity。
 */
export type PlannedPatchOperation = {
	invocationIndex: number;
	operation: PatchOperation;
	sourceAbsolutePath: string;
	destinationAbsolutePath?: string;
};

/** 一次 apply_patch invocation：自己的 cwd + patch + absolute-path identity。 */
export type ApplyPatchInvocation = {
	index: number;
	cwd: string;
	patch: ParsedPatch;
	operations: readonly PlannedPatchOperation[];
};

/**
 * 一次命令的权威解析结果（command 是经过所有 tool_call mutation 后的 final command）。
 * 只解析一次，capture/finalize/渲染全部消费它，不再到处重跑 parser。
 * trailingCommand 缺省表示 standalone 单引号形式（本就没有 trailing command）。
 */
export type ApplyPatchPlan = {
	command: string;
	invocations: readonly ApplyPatchInvocation[];
	trailingCommand?: string;
};

const OPERATION_HEADER = /^\*\*\* (Add|Delete|Update) File: (.+)$/;
const OPERATION_HEADER_PREFIXES = ["*** Add File: ", "*** Delete File: ", "*** Update File: "] as const;
const APPLY_PATCH_HEREDOC =
	/(?:^[ \t]*apply_patch[ \t]+|[ \t]*&&[ \t]*apply_patch[ \t]+)<<'([A-Za-z_][A-Za-z0-9_]*)'[ \t]*$/;
const CD_PREFIX = /(?:^|&&)[ \t]*cd[ \t]+(\S+)/;

function isOperationHeader(line: string): boolean {
	return OPERATION_HEADER_PREFIXES.some((prefix) => line.startsWith(prefix));
}

function normalizeLines(text: string): string[] {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}

function extractSingleQuotedPatch(line: string): string | undefined {
	const normalized = line.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const prefix = normalized.match(/^[ \t]*apply_patch[ \t]+/);
	if (!prefix || normalized[prefix[0].length] !== "'") return undefined;

	let index = prefix[0].length;
	let patch = "";
	let quotedSegmentCount = 0;
	while (index < normalized.length) {
		if (normalized[index] === "'") {
			const close = normalized.indexOf("'", index + 1);
			if (close === -1) return undefined;
			patch += normalized.slice(index + 1, close);
			quotedSegmentCount += 1;
			index = close + 1;
			continue;
		}
		if (normalized[index] === "\\" && index + 1 < normalized.length) {
			patch += normalized[index + 1];
			index += 2;
			continue;
		}
		if (/\s/.test(normalized[index] ?? "")) {
			return normalized.slice(index).trim() === "" && quotedSegmentCount > 0 ? patch : undefined;
		}
		return undefined;
	}
	return quotedSegmentCount > 0 ? patch : undefined;
}

function parseOperationHeader(line: string): { kind: PatchOperation["kind"]; path: string } | undefined {
	const match = line.match(OPERATION_HEADER);
	if (!match || match[2] !== match[2].trim()) return undefined;
	const kind = match[1] === "Add" ? "add" : match[1] === "Delete" ? "delete" : "update";
	return match[2].length > 0 ? { kind, path: match[2] } : undefined;
}

function parseAddOperation(lines: string[], start: number, index: number, path: string) {
	const patchLines: PatchLine[] = [];
	let cursor = start;
	while (cursor < lines.length && lines[cursor] !== "*** End Patch" && !isOperationHeader(lines[cursor] ?? "")) {
		const line = lines[cursor] ?? "";
		if (line.startsWith("+")) patchLines.push({ prefix: "+", text: line.slice(1) });
		cursor += 1;
	}
	return { operation: { index, kind: "add" as const, path, lines: patchLines }, cursor };
}

function parseUpdateOperation(lines: string[], start: number, index: number, path: string) {
	const patchLines: PatchLine[] = [];
	const chunks: PatchChunk[] = [];
	let cursor = start;
	let chunkLines: PatchLine[] | undefined;
	let destination: string | undefined;
	if ((lines[cursor] ?? "").startsWith("*** Move to: ")) {
		const candidate = (lines[cursor] ?? "").slice("*** Move to: ".length);
		if (candidate.length > 0 && candidate === candidate.trim()) destination = candidate;
		cursor += 1;
	}
	while (cursor < lines.length && lines[cursor] !== "*** End Patch" && !isOperationHeader(lines[cursor] ?? "")) {
		const line = lines[cursor] ?? "";
		if (line === "@@" || line.startsWith("@@ ")) {
			if (chunkLines !== undefined) chunks.push({ index: chunks.length, lines: chunkLines });
			chunkLines = [];
			cursor += 1;
			continue;
		}
		if (line !== "*** End of File" && line.length > 0 && [" ", "+", "-"].includes(line[0] ?? "")) {
			const patchLine = { prefix: line[0] as PatchLine["prefix"], text: line.slice(1) };
			patchLines.push(patchLine);
			chunkLines ??= [];
			chunkLines.push(patchLine);
		}
		cursor += 1;
	}
	if (chunkLines !== undefined) chunks.push({ index: chunks.length, lines: chunkLines });
	return { operation: { index, kind: "update" as const, path, destination, lines: patchLines, chunks }, cursor };
}

function nextOperationHeader(lines: string[], start: number): number {
	for (let cursor = start; cursor < lines.length; cursor += 1) {
		if (lines[cursor] === "*** End Patch" || isOperationHeader(lines[cursor] ?? "")) return cursor;
	}
	return lines.length;
}

function parsePatchEnvelope(source: string): ParsedPatch | undefined {
	const lines = normalizeLines(source);
	if (lines[0] !== "*** Begin Patch") return undefined;
	const operations: PatchOperation[] = [];
	let cursor = 1;
	let operationIndex = 0;
	while (cursor < lines.length && lines[cursor] !== "*** End Patch") {
		const index = operationIndex;
		operationIndex += 1;
		const header = parseOperationHeader(lines[cursor] ?? "");
		if (!header) {
			cursor = nextOperationHeader(lines, cursor + 1);
			continue;
		}
		if (header.kind === "delete") {
			operations.push({ index, kind: "delete", path: header.path, lines: [] });
			cursor += 1;
			continue;
		}
		const parsed = header.kind === "add"
			? parseAddOperation(lines, cursor + 1, index, header.path)
			: parseUpdateOperation(lines, cursor + 1, index, header.path);
		operations.push(parsed.operation);
		cursor = parsed.cursor;
	}
	return operations.length > 0 ? { operations } : undefined;
}

export function operationByIndex(patch: ParsedPatch, index: number): PatchOperation | undefined {
	return patch.operations.find((operation) => operation.index === index);
}

function planOperations(invocationIndex: number, cwd: string, patch: ParsedPatch): PlannedPatchOperation[] {
	return patch.operations.map((operation) => ({
		invocationIndex,
		operation,
		sourceAbsolutePath: path.resolve(cwd, operation.path),
		destinationAbsolutePath: operation.destination === undefined ? undefined : path.resolve(cwd, operation.destination),
	}));
}

/**
 * 权威 plan 构建：顺序扫描命令，为每个 invocation 解析独立 cwd。
 * - cd 只在 heredoc 之外的命令行生效（heredoc body 是 shell 输入，不是命令）；
 * - 同一行的 `cd X && apply_patch <<'P'` 前缀先应用再记录；
 * - trailing command 是最后一个 invocation 的 marker 之后的所有行。
 * 无 heredoc 时回退 canonical 单引号 standalone 形式（仅第一行，与既有识别范围一致）。
 */
export function buildApplyPatchPlan(command: string, initialCwd: string): ApplyPatchPlan | undefined {
	const lines = normalizeLines(command);
	const invocations: ApplyPatchInvocation[] = [];
	let cwd = initialCwd;
	let lastEndLine = -1;
	let cursor = 0;
	while (cursor < lines.length) {
		const line = lines[cursor] ?? "";
		const header = line.match(APPLY_PATCH_HEREDOC);
		if (!header) {
			const cd = line.match(CD_PREFIX);
			if (cd) cwd = path.resolve(cwd, cd[1]!);
			cursor += 1;
			continue;
		}
		const cd = line.match(CD_PREFIX);
		if (cd) cwd = path.resolve(cwd, cd[1]!);
		const marker = header[1]!;
		let end = -1;
		for (let i = cursor + 1; i < lines.length; i += 1) {
			if (lines[i] === marker) {
				end = i;
				break;
			}
		}
		if (end === -1) {
			cursor += 1;
			continue;
		}
		const envelope = lines.slice(cursor + 1, end).join("\n");
		const patch = parsePatchEnvelope(envelope);
		if (patch) {
			invocations.push({
				index: invocations.length,
				cwd,
				patch,
				operations: planOperations(invocations.length, cwd, patch),
			});
			lastEndLine = end;
		}
		// heredoc body 已被 shell 消费：无论 envelope 是否有效都跳过，body 内的 cd 不算命令。
		cursor = end + 1;
	}
	if (invocations.length === 0) {
		// 回退 canonical 单引号 standalone 形式（引号可跨行；整条命令匹配，与既有识别范围一致）。
		const source = extractSingleQuotedPatch(command);
		if (source !== undefined) {
			const patch = parsePatchEnvelope(source);
			if (patch) {
				return {
					command,
					invocations: [{
						index: 0,
						cwd: initialCwd,
						patch,
						operations: planOperations(0, initialCwd, patch),
					}],
				};
			}
		}
		return undefined;
	}
	const trailing = lines.slice(lastEndLine + 1).join("\n").trim();
	return { command, invocations, trailingCommand: trailing || undefined };
}
