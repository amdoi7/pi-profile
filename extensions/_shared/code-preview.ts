import { spawnSync } from "node:child_process";
import { highlightCode } from "@earendil-works/pi-coding-agent";

export const CODE_PREVIEW = {
	readCollapsedLines: 10,
	editCollapsedLines: 80,
	statusCommandChars: 72,
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

export function summarizeDiffText(diffText: string): {
	additions: number;
	deletions: number;
	changedLines: number;
} {
	let additions = 0;
	let deletions = 0;
	for (const line of diffText.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
		else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
	}
	return { additions, deletions, changedLines: additions + deletions };
}

export function renderDiffSummary(
	stats: { additions?: number; deletions?: number; changedLines?: number } | undefined,
	theme: PreviewTheme,
): string {
	if (!stats) return "";
	const additions = Number.isFinite(stats.additions) ? stats.additions : 0;
	const deletions = Number.isFinite(stats.deletions) ? stats.deletions : 0;
	const changedLines = Number.isFinite(stats.changedLines) ? stats.changedLines : additions + deletions;
	return [
		theme.fg("muted", `${changedLines} changed`),
		theme.fg("success", `+${additions}`),
		theme.fg("error", `-${deletions}`),
	].join(theme.fg("muted", " · "));
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

const FISH_SYNTAX_COLOR_NAMES = new Set([
	"fish_color_command",
	"fish_color_keyword",
	"fish_color_quote",
	"fish_color_redirection",
	"fish_color_end",
	"fish_color_error",
	"fish_color_param",
	"fish_color_valid_path",
	"fish_color_option",
	"fish_color_comment",
	"fish_color_operator",
	"fish_color_escape",
]);
const FISH_DEFAULT_SYNTAX_ENV: Record<string, string> = {
	fish_color_command: "blue",
	fish_color_keyword: "blue",
	fish_color_quote: "yellow",
	fish_color_redirection: "cyan --bold",
	fish_color_end: "green",
	fish_color_error: "brred",
	fish_color_param: "cyan",
	fish_color_valid_path: "cyan",
	fish_color_option: "cyan",
	fish_color_comment: "red",
	fish_color_operator: "brcyan",
	fish_color_escape: "brcyan",
};
const ANSI_SEQUENCE_PATTERN = /\x1b\[[0-9;]*m/;
const ANSI_SEQUENCE_GLOBAL_PATTERN = /\x1b\[[0-9;]*m/g;
const SHELL_HIGHLIGHT_CACHE_LIMIT = 200;

let cachedFishSyntaxEnv: Record<string, string> | undefined;
const shellHighlightCache = new Map<string, string>();

function renderShellSyntax(command: string): string {
	const cached = shellHighlightCache.get(command);
	if (cached !== undefined) return cached;

	const rendered = renderWithEmbeddedHeredocs(command) ?? renderWithFishIndent(command) ?? escapeControlChars(command);
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
	const rendered = renderWithFishIndent(line);
	if (!rendered) return escapeControlChars(line);
	if (line.includes("<<") && !stripAnsi(rendered).includes("<<")) return escapeControlChars(line);
	return rendered;
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

function inferHeredocLanguage(header: string, marker: string): string | undefined {
	const markerName = marker.toLowerCase();
	const command = header.toLowerCase();
	if (/\bpython(?:3(?:\.\d+)?)?\b/.test(command) || markerName === "py" || markerName === "python") return "python";
	if (/\bnode\b|\bbun\b/.test(command) || markerName === "js" || markerName === "javascript" || markerName === "node") return "javascript";
	if (markerName === "ts" || markerName === "typescript") return "typescript";
	return undefined;
}

function stripAnsi(text: string): string {
	return text.replace(ANSI_SEQUENCE_GLOBAL_PATTERN, "");
}

function renderWithFishIndent(command: string): string | undefined {
	const result = spawnSync("fish_indent", ["--ansi", "--no-indent"], {
		encoding: "utf8",
		env: { ...process.env, ...getFishSyntaxEnv() },
		input: command.endsWith("\n") ? command : `${command}\n`,
		maxBuffer: 1024 * 1024,
		timeout: 500,
	});
	if (result.error || result.status !== 0 || typeof result.stdout !== "string") return undefined;
	if (!ANSI_SEQUENCE_PATTERN.test(result.stdout)) return undefined;
	return result.stdout.trimEnd().replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+/g, " ");
}

function getFishSyntaxEnv(): Record<string, string> {
	cachedFishSyntaxEnv ??= loadFishSyntaxEnv();
	return cachedFishSyntaxEnv;
}

function loadFishSyntaxEnv(): Record<string, string> {
	const result = spawnSync("fish", ["-ic", "fish_config theme dump"], {
		encoding: "utf8",
		maxBuffer: 128 * 1024,
		timeout: 1000,
	});
	if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
		return { ...FISH_DEFAULT_SYNTAX_ENV };
	}

	const env = parseFishThemeDump(result.stdout);
	return Object.keys(env).length > 0 ? env : { ...FISH_DEFAULT_SYNTAX_ENV };
}

function parseFishThemeDump(output: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const rawLine of output.split("\n")) {
		const line = rawLine.trim().replace(/\s+--theme=[^\s]+$/, "");
		const firstSpace = line.search(/\s/);
		if (firstSpace <= 0) continue;
		const name = line.slice(0, firstSpace);
		if (!FISH_SYNTAX_COLOR_NAMES.has(name)) continue;
		const value = line.slice(firstSpace).trim();
		if (value.length === 0) continue;
		env[name] = value;
	}
	return env;
}

export function summarizeCommandRewrite(original: string, rewritten: string): string {
	const prefix = "rewrite ";
	const body = `${truncateMiddle(original, CODE_PREVIEW.statusCommandChars)} → ${truncateMiddle(rewritten, CODE_PREVIEW.statusCommandChars)}`;
	return `${prefix}${body}`;
}

export function truncateMiddle(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	const head = Math.max(1, Math.floor((maxChars - 1) / 2));
	const tail = Math.max(1, maxChars - head - 1);
	return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
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
