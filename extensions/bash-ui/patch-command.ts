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

const OPERATION_HEADER = /^\*\*\* (Add|Delete|Update) File: (.+)$/;
const OPERATION_HEADER_PREFIXES = ["*** Add File: ", "*** Delete File: ", "*** Update File: "] as const;

function isOperationHeader(line: string): boolean {
	return OPERATION_HEADER_PREFIXES.some((prefix) => line.startsWith(prefix));
}

function normalizeLines(text: string): string[] {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}

function extractSingleQuotedPatch(command: string): string | undefined {
	const normalized = command.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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

function resolveWorkingDirectory(command: string, initialCwd: string): string {
	// 取第一个 apply_patch 调用行之前的最后一个 cd（支持行首与 && 链中的 cd）。
	// 例：`rm -rf X && printf ... && cd Y && apply_patch <<'PATCH'` → Y。
	let resolved = initialCwd;
	for (const line of normalizeLines(command)) {
		const cd = line.match(/(?:^|&&)[ \t]*cd[ \t]+(\S+)/);
		if (cd) resolved = path.resolve(resolved, cd[1]);
		if (/(?:^[ \t]*apply_patch[ \t]+|[ \t]*&&[ \t]*apply_patch[ \t]+)<</.test(line)) break;
	}
	return resolved;
}

export function parseApplyPatches(command: string, initialCwd: string): { patch: ParsedPatch; cwd: string; endLine: number }[] {
	const cwd = resolveWorkingDirectory(command, initialCwd);
	const lines = normalizeLines(command);
	const patches: { patch: ParsedPatch; cwd: string; endLine: number }[] = [];
	let cursor = 0;
	while (cursor < lines.length) {
		const line = lines[cursor] ?? "";
		const header = line.match(/(?:^[ \t]*apply_patch[ \t]+|[ \t]*&&[ \t]*apply_patch[ \t]+)<<'([A-Za-z_][A-Za-z0-9_]*)'[ \t]*$/);
		if (!header) {
			cursor++;
			continue;
		}
		const marker = header[1];
		let end = -1;
		for (let i = cursor + 1; i < lines.length; i++) {
			if (lines[i] === marker) {
				end = i;
				break;
			}
		}
		if (end === -1) {
			cursor++;
			continue;
		}
		const envelope = lines.slice(cursor + 1, end).join("\n");
		const patch = parsePatchEnvelope(envelope);
		if (patch) {
			patches.push({ patch, cwd, endLine: end });
			cursor = end + 1;
		} else {
			cursor++;
		}
	}
	return patches;
}

export function trailingCommandAfterApplyPatches(command: string): string {
	const patches = parseApplyPatches(command, process.cwd());
	if (patches.length === 0) return "";
	const lastEndLine = Math.max(...patches.map((entry) => entry.endLine));
	return normalizeLines(command).slice(lastEndLine + 1).join("\n").trim();
}

export function parseStandaloneApplyPatch(command: string): ParsedPatch | undefined {
	const patches = parseApplyPatches(command, process.cwd());
	if (patches.length === 1) return patches[0]?.patch;
	if (patches.length > 1) return undefined;
	const source = extractSingleQuotedPatch(command);
	return source === undefined ? undefined : parsePatchEnvelope(source);
}
