/**
 * highlight.ts — bash 命令 fish 式语义高亮
 *
 * 供 bash-ui 的 bash renderCall 回退路径使用：
 * 非 apply_patch 命令按原样交给内置渲染，这里负责给命令上色。
 *
 * 着色规则（沿用主题 syntax* token）：
 *   - 命令存在（PATH 可执行 / shell 内建）→ success（绿）
 *   - 命令不存在                          → error（红）
 *   - 关键字（if/for/while/do/...）      → syntaxKeyword
 *   - 选项（-x / --long）                → syntaxType
 *   - 字符串（'...' / "..." / `...`）    → syntaxString
 *   - 变量（$VAR / ${...} / $(...)）     → syntaxVariable
 *   - 数字                               → syntaxNumber
 *   - 操作符（| && || > ; = ...）        → syntaxOperator
 *   - 注释（# ...）                      → syntaxComment
 */

import { accessSync, constants as fsConstants } from "node:fs";
import { resolve } from "node:path";

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// --- 命令存在性检查（fish 语义核心） ------------------------------------

const BUILTINS = new Set([
	"alias", "bg", "bind", "break", "builtin", "caller", "cd", "command", "compgen",
	"complete", "compopt", "continue", "declare", "dirs", "disown", "echo", "enable",
	"eval", "exec", "exit", "export", "false", "fc", "fg", "getopts", "hash", "help",
	"history", "jobs", "kill", "let", "local", "logout", "mapfile", "popd", "printf",
	"pushd", "pwd", "read", "readarray", "readonly", "return", "set", "shift", "shopt",
	"source", "suspend", "test", "times", "trap", "true", "type", "typeset", "ulimit",
	"umask", "unalias", "unset", "wait",
]);

const KEYWORDS = new Set([
	"if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done",
	"case", "esac", "function", "in", "select", "time", "coproc",
]);

// 后面紧跟命令的关键字（if cond / while cond / then cmd / do cmd ...）
const CMD_FOLLOWS = new Set(["if", "while", "until", "then", "do", "else", "elif", "time"]);
// 包装命令：下一个词仍是命令（sudo cmd / env FOO=1 cmd / xargs cmd）
const WRAPPERS = new Set(["sudo", "doas", "env", "xargs", "nice", "nohup", "timeout", "command", "exec", "builtin", "watch", "strace", "ltrace", "setsid"]);

const execCache = new Map<string, boolean>();

/**
 * 命令存在性检查（fish 语义核心）。
 * cache key 含 cwd + PATH + command：相对可执行文件按命令执行目录解析，
 * PATH 变化后不返回陈旧结果。
 */
export function isExecutable(cmd: string, cwd: string): boolean {
	if (BUILTINS.has(cmd)) return true;
	const pathEntries = process.env.PATH ?? "";
	const key = `${cwd}|${pathEntries}|${cmd}`;
	const cached = execCache.get(key);
	if (cached !== undefined) return cached;

	let found = false;
	if (cmd.includes("/")) {
		try {
			accessSync(resolve(cwd, cmd), fsConstants.X_OK);
			found = true;
		} catch {
			found = false;
		}
	} else {
		for (const dir of pathEntries.split(":")) {
			if (!dir) continue;
			try {
				accessSync(resolve(dir, cmd), fsConstants.X_OK);
				found = true;
				break;
			} catch {
				// 继续下一个 PATH 目录
			}
		}
	}
	execCache.set(key, found);
	return found;
}

// --- 词法分析 ------------------------------------------------------------

interface Seg {
	text: string;
	color: ThemeColor | null; // theme token 名；null = 默认前景色
}

// 解析 $ 开头的一段：${...} / $(...) / $NAME / $? $! $$ $# $0...
function readVariable(s: string, i: number): { text: string; end: number } {
	const j = i + 1;
	const c = s[j];
	if (c === "{") {
		let depth = 1;
		let k = j + 1;
		while (k < s.length && depth > 0) {
			if (s[k] === "{") depth++;
			else if (s[k] === "}") depth--;
			k++;
		}
		return { text: s.slice(i, k), end: k };
	}
	if (c === "(") {
		let depth = 1;
		let k = j + 1;
		while (k < s.length && depth > 0) {
			if (s[k] === "(") depth++;
			else if (s[k] === ")") depth--;
			k++;
		}
		return { text: s.slice(i, k), end: k };
	}
	if (/[0-9?!#$*@]/.test(c ?? "")) return { text: s.slice(i, j + 1), end: j + 1 };
	let k = j;
	while (k < s.length && /[A-Za-z0-9_]/.test(s[k])) k++;
	if (k === j) return { text: "$", end: j }; // 孤立 $，原样
	return { text: s.slice(i, k), end: k };
}

export function tokenize(cmd: string, cwd = process.cwd()): Seg[] {
	const segs: Seg[] = [];
	const n = cmd.length;
	let i = 0;
	let atCmd = true; // 下一个词处于命令位置

	const push = (text: string, color: string | null) => {
		if (!text) return;
		segs.push({ text, color });
	};

	while (i < n) {
		const c = cmd[i];

		// 空白（含换行；换行后是新命令位置）
		if (/\s/.test(c)) {
			let j = i;
			let hasNl = false;
			while (j < n && /\s/.test(cmd[j])) {
				if (cmd[j] === "\n") hasNl = true;
				j++;
			}
			push(cmd.slice(i, j), null);
			if (hasNl) atCmd = true;
			i = j;
			continue;
		}

		// 注释只到当前行结尾（不吞后续行的命令）
		if (c === "#") {
			const newline = cmd.indexOf("\n", i);
			const end = newline === -1 ? n : newline;
			push(cmd.slice(i, end), "syntaxComment");
			i = end;
			continue;
		}

		// 单引号字符串（无转义）
		if (c === "'") {
			const end = cmd.indexOf("'", i + 1);
			const j = end === -1 ? n : end + 1;
			push(cmd.slice(i, j), "syntaxString");
			i = j;
			continue;
		}

		// 双引号字符串（内嵌 $var 单独着色）
		if (c === '"') {
			let j = i + 1;
			let buf = '"';
			while (j < n) {
				const ch = cmd[j];
				if (ch === "\\" && j + 1 < n) {
					buf += ch + cmd[j + 1];
					j += 2;
					continue;
				}
				if (ch === '"') {
					buf += '"';
					j++;
					break;
				}
				if (ch === "$" && /[$A-Za-z0-9_{?!#*@(]/.test(cmd[j + 1] ?? "")) {
					push(buf, "syntaxString");
					buf = "";
					const v = readVariable(cmd, j);
					push(v.text, "syntaxVariable");
					j = v.end;
					continue;
				}
				buf += ch;
				j++;
			}
			push(buf, "syntaxString");
			i = j;
			continue;
		}

		// 反引号命令替换（视为字符串）
		if (c === "`") {
			const end = cmd.indexOf("`", i + 1);
			const j = end === -1 ? n : end + 1;
			push(cmd.slice(i, j), "syntaxString");
			i = j;
			continue;
		}

		// 变量
		if (c === "$" && /[$A-Za-z0-9_{?!#*@(]/.test(cmd[i + 1] ?? "")) {
			const v = readVariable(cmd, i);
			push(v.text, "syntaxVariable");
			i = v.end;
			continue;
		}

		// `$` followed by a non-variable character is literal shell text. Consume
		// it here because the ordinary-word scanner treats `$` as a delimiter.
		if (c === "$") {
			push(c, null);
			i += 1;
			continue;
		}

		// 双字符操作符（最长匹配优先：<<< / 2>> / 1>> 先于 << / 2> / 1>）
		const three = cmd.slice(i, i + 3);
		if (["<<<", "2>>", "1>>"].includes(three)) {
			push(three, "syntaxOperator");
			i += 3;
			continue;
		}
		const two = cmd.slice(i, i + 2);
		if (["&&", "||", ";;", "|&", "&>", ">>", "<<", ">&", "<&", "2>", "1>", "<(", ">("].includes(two)) {
			push(two, "syntaxOperator");
			i += 2;
			if (two === "&&" || two === "||" || two === "|&") atCmd = true;
			continue;
		}

		// 单字符操作符 / 标点
		if ("|&;><(){}[]=!".includes(c)) {
			push(c, "syntaxOperator");
			i += 1;
			if (c === "|" || c === ";" || c === "(" || c === "{" || c === "!") atCmd = true;
			continue;
		}

		// 选项：-x / --long / --opt=val（选项后不再是命令位置）
		if (c === "-" && /[-A-Za-z0-9]/.test(cmd[i + 1] ?? "")) {
			let j = i + 1;
			while (j < n && !/[\s|&;<>(){}'"`$#=]/.test(cmd[j])) j++;
			push(cmd.slice(i, j), "syntaxType");
			atCmd = false;
			i = j;
			continue;
		}

		// 普通词
		let j = i;
		while (j < n && !/[\s|&;<>(){}'"`$#]/.test(cmd[j])) j++;
		const word = cmd.slice(i, j);

		// 赋值：NAME=value（值可能跨后续 token）
		const assign = /^([A-Za-z_][A-Za-z0-9_]*)(=)(.*)$/.exec(word);
		if (assign) {
			push(assign[1], "syntaxVariable");
			push(assign[2], "syntaxOperator");
			push(assign[3], null);
			i = j; // atCmd 保持不变：赋值后下一个词仍是命令
			continue;
		}

		if (atCmd) {
			if (KEYWORDS.has(word)) {
				push(word, "syntaxKeyword");
				atCmd = CMD_FOLLOWS.has(word);
			} else {
				// fish 语义：命令存在则绿，不存在则红
				push(word, isExecutable(word, cwd) ? "success" : "error");
				atCmd = WRAPPERS.has(word);
			}
		} else if (word === "in") {
			// for f in ... / case $x in — in 出现在非命令位置，仍按关键字着色
			push(word, "syntaxKeyword");
		} else if (/^\d+$/.test(word)) {
			push(word, "syntaxNumber");
		} else {
			push(word, null);
		}
		i = j;
	}

	return segs;
}

// 按原始字符预算组装着色字符串（避免把 ANSI 转义截断）
function assemble(segs: Seg[], theme: Theme, maxRaw: number): string {
	let out = "";
	let raw = 0;
	for (const s of segs) {
		if (raw + s.text.length > maxRaw) {
			const take = Math.max(0, maxRaw - raw);
			if (take > 0) {
				const clipped = s.text.slice(0, take);
				out += s.color ? theme.fg(s.color, clipped) : clipped;
			}
			out += theme.fg("dim", "…");
			return out;
		}
		out += s.color ? theme.fg(s.color, s.text) : s.text;
		raw += s.text.length;
	}
	return out;
}

// --- 渲染入口 ------------------------------------------------------------

interface BashCallArgs {
	command?: string;
	timeout?: number;
}

interface RenderContext {
	argsComplete: boolean;
}

type FallbackRenderCall = (args: BashCallArgs, theme: Theme, context: RenderContext) => unknown;

export function highlightBashCall(
	args: BashCallArgs,
	theme: Theme,
	context: RenderContext,
	fallback: FallbackRenderCall,
) {
	// 参数未完整（流式）时沿用原渲染，避免高亮半截命令
	if (!context.argsComplete) return fallback(args, theme, context);

	const cmd = args.command ?? "";
	let text = theme.fg("toolTitle", theme.bold("$ "));
	text += assemble(tokenize(cmd), theme, 500);
	if (args.timeout) {
		text += theme.fg("dim", ` (timeout: ${args.timeout}s)`);
	}
	return new Text(text, 0, 0);
}
