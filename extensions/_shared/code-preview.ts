import { highlightCode } from "@earendil-works/pi-coding-agent";

export const CODE_PREVIEW = {
	readCollapsedLines: 10,
	editCollapsedLines: 80,
	secretScanChars: 200_000,
	secretLabels: [
		{ label: "API key", pattern: /\b(?:api[_-]?key|token|secret|password)\b\s*[:=]\s*['\"]?[^\s'\"]{8,}/i },
		{ label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
		{ label: "OpenAI key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
		{ label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
	],
} as const;

type PreviewTheme = {
	fg(color: string, text: string): string;
	bold?(text: string): string;
};

export function renderLinePreview(
	text: string,
	options: {
		expanded: boolean;
		firstLine?: number;
		limit: number;
		theme: PreviewTheme;
	},
): string {
	const lines = splitLines(text);
	const limit = options.expanded ? lines.length : options.limit;
	const shown = Math.min(lines.length, Math.max(0, limit));
	const lineNumberWidth = String((options.firstLine ?? 1) + Math.max(0, shown - 1)).length;
	const rendered = lines.slice(0, shown).map((line, index) => {
		const lineNumber = String((options.firstLine ?? 1) + index).padStart(lineNumberWidth, " ");
		return `${options.theme.fg("dim", `${lineNumber} │ `)}${options.theme.fg("toolOutput", escapeControlChars(line))}`;
	});
	const hidden = lines.length - shown;
	if (hidden > 0) rendered.push(renderHiddenFooter(hidden, "lines", options.theme));
	return withSecretWarning(text, rendered.join("\n"), options.theme);
}

export function renderHiddenFooter(hidden: number, unit: string, theme: PreviewTheme): string {
	return theme.fg("muted", `... ${hidden} more ${unit}, expand to view`);
}

export function renderDiffSummary(
	stats: { additions?: number; deletions?: number; changedLines?: number } | undefined,
	theme: PreviewTheme,
): string {
	if (!stats) return "";
	const additions = typeof stats.additions === "number" && Number.isFinite(stats.additions) ? stats.additions : 0;
	const deletions = typeof stats.deletions === "number" && Number.isFinite(stats.deletions) ? stats.deletions : 0;
	// 紧凑摘要：changedLines 恒等于 additions+deletions（isChangeStats 强制），
	// 总数是冗余；只显示非零项（git 惯例）。
	const parts: string[] = [];
	if (additions > 0) parts.push(theme.fg("success", `+${additions}`));
	if (deletions > 0) parts.push(theme.fg("error", `-${deletions}`));
	return parts.join(" ");
}

export function renderShellCommandCall(
	args: unknown,
	theme: PreviewTheme,
): string {
	const input = args && typeof args === "object" ? args as { command?: unknown; timeout?: unknown } : {};
	const command = typeof input.command === "string" && input.command.length > 0 ? input.command : "...";
	const title = theme.bold ? theme.bold("$") : "$";
	const timeout = typeof input.timeout === "number" ? theme.fg("muted", ` (timeout ${input.timeout}s)`) : "";
	const commandText = command === "..." ? theme.fg("toolOutput", command) : renderShellSyntax(command);
	return `${theme.fg("toolTitle", title)} ${commandText}${timeout}`;
}

const SHELL_HIGHLIGHT_CACHE_LIMIT = 200;
const shellHighlightCache = new Map<string, string>();

function renderShellSyntax(command: string): string {
	const cached = shellHighlightCache.get(command);
	if (cached !== undefined) return cached;

	// 复用 pi 原生高亮：shell 行用 bash 语言，heredoc 内嵌块按推断语言走 highlightCode。
	const rendered = renderWithEmbeddedHeredocs(command) ?? renderShellWithNativeHighlight(command);
	if (shellHighlightCache.size >= SHELL_HIGHLIGHT_CACHE_LIMIT) {
		shellHighlightCache.clear();
	}
	shellHighlightCache.set(command, rendered);
	return rendered;
}

type HeredocBlock = {
	startLine: number;
	endLine: number;
	marker: string;
	language: string | undefined;
};

function renderWithEmbeddedHeredocs(command: string): string | undefined {
	const lines = splitLines(command);
	const blocks = findHeredocBlocks(lines);
	if (blocks.length === 0) return undefined;

	const rendered: string[] = [];
	let cursor = 0;
	for (const block of blocks) {
		for (; cursor < block.startLine; cursor++) {
			rendered.push(renderShellLine(lines[cursor] ?? ""));
		}
		rendered.push(renderShellLine(lines[block.startLine] ?? ""));
		const body = lines.slice(block.startLine + 1, block.endLine);
		rendered.push(...renderEmbeddedCodeLines(body, block.language));
		rendered.push(renderShellLine(lines[block.endLine] ?? block.marker));
		cursor = block.endLine + 1;
	}
	for (; cursor < lines.length; cursor++) {
		rendered.push(renderShellLine(lines[cursor] ?? ""));
	}
	return rendered.join("\n");
}

function renderShellLine(line: string): string {
	// 单行走 pi 原生 highlightCode(bash);失败降级为纯转义。
	try {
		return highlightCode(escapeControlChars(line), "bash").join("\n");
	} catch {
		return escapeControlChars(line);
	}
}

function renderEmbeddedCodeLines(lines: string[], language: string | undefined): string[] {
	if (!language) return lines.map(escapeControlChars);
	try {
		return highlightCode(escapeControlChars(lines.join("\n")), language);
	} catch {
		return lines.map(escapeControlChars);
	}
}

function findHeredocBlocks(lines: string[]): HeredocBlock[] {
	const blocks: HeredocBlock[] = [];
	for (let index = 0; index < lines.length; index++) {
		const marker = readHeredocMarker(lines[index] ?? "");
		if (!marker) continue;
		const endLine = findHeredocEnd(lines, marker, index + 1);
		if (endLine === undefined) continue;
		blocks.push({
			startLine: index,
			endLine,
			marker,
			language: inferHeredocLanguage(lines[index] ?? "", marker),
		});
		index = endLine;
	}
	return blocks;
}

function readHeredocMarker(line: string): string | undefined {
	const match = line.match(/<<-?\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))/);
	return match?.[1] ?? match?.[2] ?? match?.[3];
}

function findHeredocEnd(lines: string[], marker: string, startLine: number): number | undefined {
	for (let index = startLine; index < lines.length; index++) {
		if ((lines[index] ?? "").trim() === marker) return index;
	}
	return undefined;
}

const HEREDOC_LANGUAGE_BY_MARKER: Record<string, string> = {
	py: "python", python: "python",
	js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", node: "javascript", javascript: "javascript",
	ts: "typescript", tsx: "typescript", typescript: "typescript",
	json: "json", bash: "bash", sh: "bash", shell: "bash", zsh: "bash",
	yaml: "yaml", yml: "yaml",
	sql: "sql", go: "go", rs: "rust", rust: "rust", c: "c", cpp: "cpp", h: "c", hpp: "cpp",
	java: "java", rb: "ruby", ruby: "ruby", php: "php", swift: "swift", kt: "kotlin",
	md: "markdown", markdown: "markdown", html: "html", css: "css", xml: "xml", diff: "diff",
};

function inferHeredocLanguage(header: string, marker: string): string | undefined {
	const markerName = marker.toLowerCase();
	const command = header.toLowerCase();
	// 命令里显式写的语言（python3/node …）优先；否则按 heredoc 标记名推断。
	for (const [key, lang] of Object.entries(HEREDOC_LANGUAGE_BY_MARKER)) {
		if (markerName === key || command.includes(key)) return lang;
	}
	// 常见扩展名直接映射到语言
	const extMatch = /[^\s]+(?:\.(\w+))\s*$/.exec(command);
	if (extMatch) {
		const ext = extMatch[1]!.toLowerCase();
		return HEREDOC_LANGUAGE_BY_MARKER[ext];
	}
	return undefined;
}

/** shell 行高亮:复用 pi 原生 highlightCode(bash);异常/无高亮降级为纯转义。 */
function renderShellWithNativeHighlight(command: string): string {
	try {
		return highlightCode(escapeControlChars(command), "bash").join("\n");
	} catch {
		return escapeControlChars(command);
	}
}

function withSecretWarning(source: string, preview: string, theme: PreviewTheme): string {
	const warnings = findSecretWarnings(source);
	if (warnings.length === 0) return preview;
	return `${theme.fg("warning", `⚠ Preview warning: possible ${warnings.join(", ")}`)}\n${preview}`;
}

function findSecretWarnings(source: string): string[] {
	const sample = secretScanSample(source);
	return CODE_PREVIEW.secretLabels
		.filter((entry) => entry.pattern.test(sample))
		.map((entry) => entry.label);
}

function secretScanSample(source: string): string {
	if (source.length <= CODE_PREVIEW.secretScanChars) return source;
	const half = Math.floor(CODE_PREVIEW.secretScanChars / 2);
	return `${source.slice(0, half)}\n${source.slice(-half)}`;
}

function splitLines(text: string): string[] {
	if (text.length === 0) return [];
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}

function escapeControlChars(text: string): string {
	return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, (char) => {
		const code = char.charCodeAt(0).toString(16).padStart(2, "0");
		return `\\x${code}`;
	});
}
