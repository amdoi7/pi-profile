import path from "node:path";

const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
const SHELL_PREFIX_COMMANDS = new Set(["command", "env", "nice", "nohup", "sudo", "time", "timeout"]);

type ShellOperatorKind = "control" | "pipe";

type ShellPiece =
	| { readonly kind: "segment"; readonly text: string }
	| { readonly kind: "operator"; readonly text: string; readonly operatorKind: ShellOperatorKind };

type ShellWord = {
	readonly text: string;
	readonly start: number;
	readonly end: number;
};

type ProtectedRange = {
	readonly start: number;
	readonly end: number;
};

type ShellLine = {
	readonly text: string;
	readonly start: number;
	readonly contentEnd: number;
	readonly end: number;
};

export function getBlockedCommandMessage(command: string): string | null {
	const segmentStart = String.raw`(?:^|\n|[;|&]{1,2})\s*`;
	const commandPathPrefix = String.raw`(?:\S+/)?`;
	const pipCommandPattern = new RegExp(String.raw`${segmentStart}${commandPathPrefix}pip\s*(?:$|\s)`, "m");
	const pip3CommandPattern = new RegExp(String.raw`${segmentStart}${commandPathPrefix}pip3\s*(?:$|\s)`, "m");
	const poetryCommandPattern = new RegExp(String.raw`${segmentStart}${commandPathPrefix}poetry\s*(?:$|\s)`, "m");
	const pythonPrefix = String.raw`${segmentStart}${commandPathPrefix}python(?:3(?:\.\d+)?)?\b[^\n;|&]*`;
	const pythonPipPattern = new RegExp(`${pythonPrefix}(?:\\s-m\\s*pip\\b|\\s-mpip\\b)`, "m");
	const pythonVenvPattern = new RegExp(`${pythonPrefix}(?:\\s-m\\s*venv\\b|\\s-mvenv\\b)`, "m");
	const pythonPyCompilePattern = new RegExp(`${pythonPrefix}(?:\\s-m\\s*py_compile\\b|\\s-mpy_compile\\b)`, "m");

	if (pipCommandPattern.test(command)) {
		return [
			"Error: pip is disabled. Use uv instead:",
			"",
			"  To install a package for a script: uv run --with PACKAGE python script.py",
			"  To add a dependency to the project: uv add PACKAGE",
			"",
		].join("\n");
	}
	if (pip3CommandPattern.test(command)) {
		return [
			"Error: pip3 is disabled. Use uv instead:",
			"",
			"  To install a package for a script: uv run --with PACKAGE python script.py",
			"  To add a dependency to the project: uv add PACKAGE",
			"",
		].join("\n");
	}
	if (poetryCommandPattern.test(command)) {
		return [
			"Error: poetry is disabled. Use uv instead:",
			"",
			"  To initialize a project: uv init",
			"  To add a dependency: uv add PACKAGE",
			"  To sync dependencies: uv sync",
			"  To run commands: uv run COMMAND",
			"",
		].join("\n");
	}
	if (pythonPipPattern.test(command)) {
		return [
			"Error: 'python -m pip' is disabled. Use uv instead:",
			"",
			"  To install a package for a script: uv run --with PACKAGE python script.py",
			"  To add a dependency to the project: uv add PACKAGE",
			"",
		].join("\n");
	}
	if (pythonVenvPattern.test(command)) {
		return [
			"Error: 'python -m venv' is disabled. Use uv instead:",
			"",
			"  To create a virtual environment: uv venv",
			"",
		].join("\n");
	}
	if (pythonPyCompilePattern.test(command)) {
		return [
			"Error: 'python -m py_compile' is disabled because it writes .pyc files to __pycache__.",
			"",
			"  To verify syntax without bytecode output: uv run python -m ast path/to/file.py >/dev/null",
			"",
		].join("\n");
	}
	return null;
}

function splitCommandWords(command: string): ShellWord[] {
	const words: ShellWord[] = [];
	let index = 0;

	while (index < command.length) {
		while (index < command.length && /\s/.test(command[index] as string)) {
			index += 1;
		}
		if (index >= command.length) {
			break;
		}

		const start = index;
		let quote: "'" | '"' | "`" | null = null;
		let escaped = false;
		for (; index < command.length; index += 1) {
			const char = command[index] as string;
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
			if (/\s/.test(char)) {
				break;
			}
		}
		words.push({ text: command.slice(start, index), start, end: index });
	}

	return words;
}

function unquoteWord(word: string): string {
	return word.replace(/^(?:["'`])|(?:["'`])$/g, "");
}

function normalizeCommandWord(word: string): string {
	const unquoted = unquoteWord(word);
	return path.basename(unquoted).toLowerCase();
}

function hasPathSeparator(word: string): boolean {
	return unquoteWord(word).includes("/");
}

function isPythonInterpreterWord(word: string): boolean {
	if (hasPathSeparator(word)) {
		return false;
	}
	const normalized = normalizeCommandWord(word);
	return normalized === "python" || /^python3(?:\.\d+)?$/.test(normalized);
}

function findCommandWord(words: ShellWord[]): ShellWord | undefined {
	for (const word of words) {
		const normalized = normalizeCommandWord(word.text);

		if (ENV_ASSIGNMENT_PATTERN.test(word.text)) {
			continue;
		}
		if (SHELL_PREFIX_COMMANDS.has(normalized)) {
			continue;
		}
		if (word.text.startsWith("-")) {
			continue;
		}

		return word;
	}
	return undefined;
}

function isRedirectAmpersand(command: string, index: number): boolean {
	return command[index - 1] === ">" || command[index - 1] === "<" || command[index + 1] === ">";
}

function topLevelOperatorAt(command: string, index: number): { text: string; kind: ShellOperatorKind } | null {
	const char = command[index] as string;
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
	if (char === "\n") {
		return { text: "\n", kind: "control" };
	}
	return null;
}

function splitLinesWithOffsets(command: string): ShellLine[] {
	const lines: ShellLine[] = [];
	let start = 0;
	while (start < command.length) {
		const newlineIndex = command.indexOf("\n", start);
		if (newlineIndex === -1) {
			lines.push({ text: command.slice(start), start, contentEnd: command.length, end: command.length });
			break;
		}
		lines.push({ text: command.slice(start, newlineIndex), start, contentEnd: newlineIndex, end: newlineIndex + 1 });
		start = newlineIndex + 1;
	}
	if (command.length === 0) {
		return [];
	}
	return lines;
}

function readHeredocMarkers(line: string): string[] {
	const markers: string[] = [];
	const pattern = /<<-?\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))/g;
	let match = pattern.exec(line);
	while (match) {
		markers.push(match[1] ?? match[2] ?? match[3] as string);
		match = pattern.exec(line);
	}
	return markers;
}

function isHeredocEnd(line: string, marker: string): boolean {
	return line.trim() === marker;
}

function findProtectedHeredocRanges(command: string): ProtectedRange[] {
	const lines = splitLinesWithOffsets(command);
	const ranges: ProtectedRange[] = [];

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const line = lines[lineIndex] as ShellLine;
		const markers = readHeredocMarkers(line.text);
		if (markers.length === 0) {
			continue;
		}

		let bodyLineIndex = lineIndex + 1;
		for (const marker of markers) {
			const bodyStart = line.contentEnd;
			let bodyEnd = command.length;
			for (; bodyLineIndex < lines.length; bodyLineIndex += 1) {
				const bodyLine = lines[bodyLineIndex] as ShellLine;
				if (isHeredocEnd(bodyLine.text, marker)) {
					bodyEnd = bodyLine.contentEnd;
					bodyLineIndex += 1;
					break;
				}
			}
			ranges.push({ start: bodyStart, end: bodyEnd });
		}
		lineIndex = Math.max(lineIndex, bodyLineIndex - 1);
	}

	return ranges;
}

function splitTopLevelOperators(command: string): ShellPiece[] {
	const pieces: ShellPiece[] = [];
	const protectedRanges = findProtectedHeredocRanges(command);
	let protectedRangeIndex = 0;
	let segmentStart = 0;
	let quote: "'" | '"' | "`" | null = null;
	let escaped = false;
	let depth = 0;

	for (let index = 0; index < command.length; index += 1) {
		const protectedRange = protectedRanges[protectedRangeIndex];
		if (protectedRange && index >= protectedRange.start && index < protectedRange.end) {
			index = protectedRange.end - 1;
			protectedRangeIndex += 1;
			continue;
		}

		const char = command[index] as string;

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

function rewriteSimpleCommandPreservingWhitespace(command: string): { text: string; changed: boolean } {
	const match = command.match(/^(\s*)([\s\S]*?)(\s*)$/);
	if (!match) {
		throw new Error("Expected command whitespace match");
	}

	const leading = match[1] as string;
	const body = match[2] as string;
	const trailing = match[3] as string;
	if (!body) {
		return { text: command, changed: false };
	}

	const words = splitCommandWords(body);
	const commandWord = findCommandWord(words);
	if (!commandWord || !isPythonInterpreterWord(commandWord.text)) {
		return { text: command, changed: false };
	}

	const rewrittenBody = `${body.slice(0, commandWord.start)}uv run python${body.slice(commandWord.end)}`;
	return { text: `${leading}${rewrittenBody}${trailing}`, changed: true };
}

export function computeUvRewriteDecision(command: string): string | null {
	if (!command.trim()) {
		return null;
	}

	let changed = false;
	const rewritten = splitTopLevelOperators(command).map((piece) => {
		if (piece.kind === "operator") {
			return piece.text;
		}
		const result = rewriteSimpleCommandPreservingWhitespace(piece.text);
		changed ||= result.changed;
		return result.text;
	}).join("");

	return changed ? rewritten : null;
}
