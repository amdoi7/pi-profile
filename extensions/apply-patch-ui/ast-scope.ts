import { spawn } from "node:child_process";
import { extname } from "node:path";

export type AstScope = {
	startLine: number;
	endLine: number;
	label: string;
};

export type AstScopeAnalysis = {
	scopes: AstScope[];
	diagnostic?: string;
};

type AstGrepMatch = {
	text: string;
	range: {
		start: { line: number };
		end: { line: number };
	};
};

type LanguageConfig = {
	language: string;
	kinds: string;
};

type AstGrepResult = { matches: AstGrepMatch[] } | { diagnostic: string };

const LANGUAGE_BY_EXTENSION: Record<string, LanguageConfig> = {
	".js": javascriptConfig("js"),
	".jsx": javascriptConfig("jsx"),
	".ts": javascriptConfig("ts"),
	".tsx": javascriptConfig("tsx"),
	".py": {
		language: "python",
		kinds: "if_statement,for_statement,while_statement,try_statement,with_statement,match_statement,function_definition,class_definition",
	},
	".go": {
		language: "go",
		kinds: "if_statement,for_statement,expression_switch_statement,type_switch_statement,select_statement,function_declaration,method_declaration",
	},
	".rs": {
		language: "rust",
		kinds: "if_expression,for_expression,while_expression,loop_expression,match_expression,function_item,impl_item",
	},
};

function javascriptConfig(language: string): LanguageConfig {
	return {
		language,
		kinds: "if_statement,for_statement,for_in_statement,while_statement,do_statement,switch_statement,try_statement,function_declaration,function_expression,arrow_function,method_definition",
	};
}

export async function analyzeAstScopes(
	path: string,
	source: string,
	changedLines: number[],
): Promise<AstScopeAnalysis> {
	const config = LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()];
	if (!config || changedLines.length === 0) return { scopes: [] };
	const parsed = await runAstGrep(config, source, path);
	if ("diagnostic" in parsed) return { scopes: [], diagnostic: parsed.diagnostic };
	return { scopes: selectSmallestEnclosingScopes(parsed.matches, changedLines) };
}

async function runAstGrep(
	config: LanguageConfig,
	source: string,
	path: string,
): Promise<AstGrepResult> {
	return new Promise((resolve) => {
		const child = spawn("ast-grep", [
			"run",
			"--kind",
			config.kinds,
			"--lang",
			config.language,
			"--json=compact",
			"--stdin",
		]);
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.on("data", (chunk: string) => { stderr += chunk; });
		child.on("error", (error) => resolve({
			diagnostic: `ast_scope_failed code=spawn_error path=${JSON.stringify(path)} reason=${JSON.stringify(error.message)} remediation="install ast-grep or remove AST scope rendering"`,
		}));
		child.on("close", (code) => resolve(parseAstGrepResult(code, stdout, stderr, path)));
		child.stdin.end(source);
	});
}

function parseAstGrepResult(code: number | null, stdout: string, stderr: string, path: string): AstGrepResult {
	if (code !== 0 && stdout.trim().length === 0) {
		return {
			diagnostic: `ast_scope_failed code=${code ?? "unknown"} path=${JSON.stringify(path)} reason=${JSON.stringify(stderr.trim())} remediation="run ast-grep manually for this file"`,
		};
	}
	let value: unknown;
	try {
		value = JSON.parse(stdout || "[]");
	} catch (error) {
		return {
			diagnostic: `ast_scope_failed code=invalid_json path=${JSON.stringify(path)} reason=${JSON.stringify(error instanceof Error ? error.message : String(error))} remediation="run ast-grep manually for this file"`,
		};
	}
	return Array.isArray(value) && value.every(isAstGrepMatch)
		? { matches: value }
		: { diagnostic: `ast_scope_failed code=invalid_json_shape path=${JSON.stringify(path)} remediation="upgrade ast-grep"` };
}

function isAstGrepMatch(value: unknown): value is AstGrepMatch {
	if (!isRecord(value) || typeof value.text !== "string" || !isRecord(value.range)) return false;
	return isRecord(value.range.start) &&
		isRecord(value.range.end) &&
		typeof value.range.start.line === "number" &&
		typeof value.range.end.line === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function selectSmallestEnclosingScopes(matches: AstGrepMatch[], changedLines: number[]): AstScope[] {
	const scopes = new Map<string, AstScope>();
	for (const changedLine of changedLines) {
		const enclosing = matches
			.map(toAstScope)
			.filter((scope) => scope.startLine <= changedLine && changedLine <= scope.endLine)
			.sort((left, right) => scopeSize(left) - scopeSize(right))[0];
		if (!enclosing) continue;
		scopes.set(`${enclosing.startLine}:${enclosing.endLine}`, enclosing);
	}
	return [...scopes.values()].sort((left, right) => left.startLine - right.startLine);
}

function toAstScope(match: AstGrepMatch): AstScope {
	return {
		startLine: match.range.start.line + 1,
		endLine: match.range.end.line + 1,
		label: match.text.split("\n", 1)[0]!.trim(),
	};
}

function scopeSize(scope: AstScope): number {
	return scope.endLine - scope.startLine;
}
