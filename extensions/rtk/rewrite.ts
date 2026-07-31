import { spawnSync } from "node:child_process";
import path from "node:path";

const REWRITE_TIMEOUT_MS = 5000;
const UV_OWNED_COMMANDS = new Set(["uv", "pip", "pip3", "poetry"]);
const RAW_SHELL_COMMANDS = new Set(["false", "true"]);
const SHELL_PREFIX_COMMANDS = new Set(["command", "env", "nice", "nohup", "sudo", "time", "timeout"]);
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
const COMMAND_WORD_PATTERN = /"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|[^\s]+/g;

type ShellOperatorKind = "control" | "pipe";

type ShellPiece =
	| { readonly kind: "segment"; readonly text: string }
	| { readonly kind: "operator"; readonly text: string; readonly operatorKind: ShellOperatorKind };

function splitCommandWords(command: string): string[] {
	return command.match(COMMAND_WORD_PATTERN) ?? [];
}

function unquoteWord(word: string): string {
	return word.replace(/^(?:["'`])|(?:["'`])$/g, "");
}

function normalizeCommandWord(word: string): string {
	const unquoted = unquoteWord(word);
	return path.basename(unquoted).toLowerCase();
}

function findBaseCommand(command: string): string {
	const words = splitCommandWords(command.trim());
	for (let index = 0; index < words.length; index += 1) {
		const word = words[index] ?? "";
		const normalized = normalizeCommandWord(word);

		if (ENV_ASSIGNMENT_PATTERN.test(word)) {
			continue;
		}
		if (normalized === "env") {
			continue;
		}
		if (SHELL_PREFIX_COMMANDS.has(normalized)) {
			continue;
		}
		if (word.startsWith("-")) {
			continue;
		}

		return normalized;
	}
	return "";
}

function isPythonInterpreterCommand(baseCommand: string): boolean {
	return baseCommand === "python" || /^python3(?:\.\d+)?$/.test(baseCommand);
}

function isUvOwnedCommand(command: string): boolean {
	const baseCommand = findBaseCommand(command);
	return UV_OWNED_COMMANDS.has(baseCommand) || isPythonInterpreterCommand(baseCommand);
}

function isRawShellCommand(command: string): boolean {
	return RAW_SHELL_COMMANDS.has(findBaseCommand(command));
}

function isUnsupportedRtkFindCommand(command: string): boolean {
	if (findBaseCommand(command) !== "find") {
		return false;
	}

	const unsupportedFindTokens = new Set([
		"(",
		")",
		"\\(",
		"\\)",
		"!",
		"-not",
		"-a",
		"-and",
		"-o",
		"-or",
		",",
		"-delete",
		"-exec",
		"-execdir",
		"-ok",
		"-okdir",
		"-print",
		"-print0",
		"-printf",
		"-fprintf",
		"-ls",
		"-fls",
		"-prune",
		"-quit",
	]);
	return splitCommandWords(command).map(unquoteWord).some((word) => unsupportedFindTokens.has(word));
}

function isRedirectAmpersand(command: string, index: number): boolean {
	return command[index - 1] === ">" || command[index - 1] === "<" || command[index + 1] === ">";
}

function topLevelOperatorAt(command: string, index: number): { text: string; kind: ShellOperatorKind } | null {
	const char = command[index] ?? "";
	const next = command[index + 1] ?? "";

	if (char === "&" && next === "&") {
		return { text: "&&", kind: "control" };
	}
	if (char === "|" && next === "|") {
		return { text: "||", kind: "control" };
	}
	if (char === "|" && next === "&") {
		return { text: "|&", kind: "pipe" };
	}
	if (char === "|") {
		return { text: "|", kind: "pipe" };
	}
	if (char === ";") {
		return { text: ";", kind: "control" };
	}
	if (char === "&" && !isRedirectAmpersand(command, index)) {
		return { text: "&", kind: "control" };
	}
	return null;
}

function splitTopLevelOperators(command: string): ShellPiece[] {
	const pieces: ShellPiece[] = [];
	let segmentStart = 0;
	let quote: "'" | '"' | "`" | null = null;
	let escaped = false;
	let depth = 0;

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index] ?? "";

		if (escaped) {
			escaped = false;
			continue;
		}
		if (quote) {
			if (char === "\\" && quote !== "'") {
				escaped = true;
				continue;
			}
			if (char === quote) {
				quote = null;
			}
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char;
			continue;
		}
		if (char === "(") {
			depth += 1;
			continue;
		}
		if (char === ")") {
			depth = Math.max(0, depth - 1);
			continue;
		}
		if (depth !== 0) {
			continue;
		}

		const operator = topLevelOperatorAt(command, index);
		if (!operator) {
			continue;
		}

		pieces.push({ kind: "segment", text: command.slice(segmentStart, index) });
		pieces.push({ kind: "operator", text: operator.text, operatorKind: operator.kind });
		segmentStart = index + operator.text.length;
		index += operator.text.length - 1;
	}

	pieces.push({ kind: "segment", text: command.slice(segmentStart) });
	return pieces;
}

function splitOnTopLevelOperators(command: string, operatorKind: ShellOperatorKind): ShellPiece[] {
	const rawPieces = splitTopLevelOperators(command);
	const pieces: ShellPiece[] = [];
	let segment = "";

	for (const piece of rawPieces) {
		if (piece.kind === "segment") {
			segment += piece.text;
			continue;
		}

		if (piece.operatorKind === operatorKind) {
			pieces.push({ kind: "segment", text: segment });
			pieces.push(piece);
			segment = "";
			continue;
		}

		segment += piece.text;
	}

	pieces.push({ kind: "segment", text: segment });
	return pieces;
}

function splitTopLevelPipeSegments(shellGroup: string): string[] {
	return splitOnTopLevelOperators(shellGroup, "pipe")
		.filter((piece): piece is Extract<ShellPiece, { kind: "segment" }> => piece.kind === "segment")
		.map((piece) => piece.text);
}

function hasUvOwnedCommand(shellGroup: string): boolean {
	return splitTopLevelPipeSegments(shellGroup).some((segment) => isUvOwnedCommand(segment));
}

function rewritePipeGroupPreservingWhitespace(group: string): { text: string; changed: boolean } {
	const pipePieces = splitOnTopLevelOperators(group, "pipe");
	let lastSegmentIndex = -1;
	for (let index = pipePieces.length - 1; index >= 0; index -= 1) {
		if (pipePieces[index]?.kind === "segment") {
			lastSegmentIndex = index;
			break;
		}
	}
	if (lastSegmentIndex < 0) {
		throw new Error("Expected pipe group to contain a command segment");
	}

	let changed = false;
	const rewritten = pipePieces.map((piece, index) => {
		if (piece.kind === "operator") {
			return piece.text;
		}
		if (index !== lastSegmentIndex) {
			return piece.text;
		}
		const result = rewriteSimpleCommandPreservingWhitespace(piece.text);
		changed ||= result.changed;
		return result.text;
	}).join("");

	return { text: changed ? rewritten : group, changed };
}

function rtkRewrite(command: string): string | null {
	const result = spawnSync("rtk", ["rewrite", command], {
		encoding: "utf-8",
		timeout: REWRITE_TIMEOUT_MS,
	});

	if (result.status !== 0 && result.status !== 3) {
		return null;
	}

	const rewritten = result.stdout.trimEnd();
	if (!rewritten || rewritten === command) {
		return null;
	}
	return rewritten;
}

function rewriteSimpleCommandPreservingWhitespace(command: string): { text: string; changed: boolean } {
	const match = command.match(/^(\s*)([\s\S]*?)(\s*)$/);
	if (!match) {
		throw new Error("Expected command whitespace match");
	}

	const leading = match[1] ?? "";
	const body = match[2] ?? "";
	const trailing = match[3] ?? "";
	if (!body || isUvOwnedCommand(body) || isRawShellCommand(body) || isUnsupportedRtkFindCommand(body)) {
		return { text: command, changed: false };
	}

	const rewritten = rtkRewrite(body);
	if (!rewritten) {
		return { text: command, changed: false };
	}
	return { text: `${leading}${rewritten}${trailing}`, changed: true };
}

function rewriteGroupPreservingWhitespace(group: string): { text: string; changed: boolean } {
	return splitOnTopLevelOperators(group, "pipe").some((piece) => piece.kind === "operator")
		? rewritePipeGroupPreservingWhitespace(group)
		: rewriteSimpleCommandPreservingWhitespace(group);
}

export function computeRewriteDecision(command: string): string | null {
	if (!command.trim()) {
		return null;
	}

	const controlPieces = splitOnTopLevelOperators(command, "control");
	const hasControlOperator = controlPieces.some((piece) => piece.kind === "operator");
	const hasPipeOperator = splitOnTopLevelOperators(command, "pipe").some((piece) => piece.kind === "operator");
	const hasUvOwnedGroup = controlPieces.some((piece) => piece.kind === "segment" && hasUvOwnedCommand(piece.text));
	if (!hasControlOperator && !hasPipeOperator && !hasUvOwnedGroup) {
		const result = rewriteSimpleCommandPreservingWhitespace(command);
		return result.changed ? result.text : null;
	}

	let changed = false;
	const rewritten = controlPieces.map((piece) => {
		if (piece.kind === "operator") {
			return piece.text;
		}
		const result = rewriteGroupPreservingWhitespace(piece.text);
		changed ||= result.changed;
		return result.text;
	}).join("");

	return changed ? rewritten : null;
}
