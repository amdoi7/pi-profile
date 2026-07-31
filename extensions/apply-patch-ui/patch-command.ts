import * as path from "node:path";

export type PatchLine = {
	prefix: " " | "+" | "-";
	text: string;
};

export type PatchOperation = {
	index: number;
	kind: "add" | "delete" | "update";
	path: string;
	destination?: string;
	lines: PatchLine[];
};

export type ParsedPatch = {
	operations: PatchOperation[];
};

const OPERATION_HEADER = /^\*\*\* (Add|Delete|Update) File: (.+)$/;

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
	while (cursor < lines.length - 1 && !OPERATION_HEADER.test(lines[cursor] ?? "")) {
		const line = lines[cursor] ?? "";
		if (!line.startsWith("+")) return undefined;
		patchLines.push({ prefix: "+", text: line.slice(1) });
		cursor += 1;
	}
	if (patchLines.length === 0) return undefined;
	return { operation: { index, kind: "add" as const, path, lines: patchLines }, cursor };
}

function parseUpdateOperation(lines: string[], start: number, index: number, path: string) {
	const patchLines: PatchLine[] = [];
	let cursor = start;
	let destination: string | undefined;
	if ((lines[cursor] ?? "").startsWith("*** Move to: ")) {
		destination = (lines[cursor] ?? "").slice("*** Move to: ".length);
		if (destination.length === 0 || destination !== destination.trim()) return undefined;
		cursor += 1;
	}
	while (cursor < lines.length - 1 && !OPERATION_HEADER.test(lines[cursor] ?? "")) {
		const line = lines[cursor] ?? "";
		if (line === "@@" || line.startsWith("@@ ") || line === "*** End of File") {
			cursor += 1;
			continue;
		}
		if (line.length === 0 || ![" ", "+", "-"].includes(line[0] ?? "")) return undefined;
		patchLines.push({ prefix: line[0] as PatchLine["prefix"], text: line.slice(1) });
		cursor += 1;
	}
	if (!destination && !patchLines.some((line) => line.prefix !== " ")) return undefined;
	return { operation: { index, kind: "update" as const, path, destination, lines: patchLines }, cursor };
}

function parsePatchEnvelope(source: string): ParsedPatch | undefined {
	const lines = normalizeLines(source);
	if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") return undefined;
	const operations: PatchOperation[] = [];
	let cursor = 1;
	while (cursor < lines.length - 1) {
		const header = parseOperationHeader(lines[cursor] ?? "");
		if (!header) return undefined;
		if (header.kind === "delete") {
			operations.push({ index: operations.length, kind: "delete", path: header.path, lines: [] });
			cursor += 1;
			continue;
		}
		const parsed = header.kind === "add"
			? parseAddOperation(lines, cursor + 1, operations.length, header.path)
			: parseUpdateOperation(lines, cursor + 1, operations.length, header.path);
		if (!parsed) return undefined;
		operations.push(parsed.operation);
		cursor = parsed.cursor;
	}
	return operations.length > 0 ? { operations } : undefined;
}

function resolveWorkingDirectory(command: string, initialCwd: string): string {
	const lines = normalizeLines(command);
	for (const line of lines) {
		const match = line.match(/^[ \t]*cd[ \t]+(\S+)[ \t]*&&/);
		if (match) return path.resolve(initialCwd, match[1]);
	}
	return initialCwd;
}

export function parseApplyPatches(command: string, initialCwd: string): { patch: ParsedPatch; cwd: string }[] {
	const cwd = resolveWorkingDirectory(command, initialCwd);
	const lines = normalizeLines(command);
	const patches: { patch: ParsedPatch; cwd: string }[] = [];
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
			patches.push({ patch, cwd });
			cursor = end + 1;
		} else {
			cursor++;
		}
	}
	return patches;
}

export function parseStandaloneApplyPatch(command: string): ParsedPatch | undefined {
	const patches = parseApplyPatches(command, process.cwd());
	if (patches.length === 1) return patches[0]?.patch;
	if (patches.length > 1) return undefined;
	const source = extractSingleQuotedPatch(command);
	return source === undefined ? undefined : parsePatchEnvelope(source);
}
