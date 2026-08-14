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

/** 一次 apply_patch invocation：自己的 cwd + patch + envelope 原文 + absolute-path identity。 */
export type ApplyPatchInvocation = {
	index: number;
	cwd: string;
	patch: ParsedPatch;
	/** heredoc body 原文（marker 行之间）：执行者架构用它重建执行命令，不经 shell 重解析。 */
	envelope: string;
	/** stdin redirect 形式（`apply_patch < file`）来源文件的 absolute path。 */
	stdinFilePath?: string;
	/**
	 * stdinFilePath 来源分类：缺省 = 同命令 `cat > file` 静态写入（执行时先 replay 写文件副作用
	 * 再 redirect 应用）；true = 外部文件（前序命令落盘，execute 侧 resolver 执行时读取）——
	 * 原命令无写文件副作用，原样 redirect，无 cat replay。
	 */
	stdinExternal?: boolean;
	operations: readonly PlannedPatchOperation[];
};

/**
 * 一次命令的权威解析结果（command 是经过所有 tool_call mutation 后的 final command）。
 * 只解析一次，capture/finalize/渲染全部消费它，不再到处重跑 parser。
 * trailingCommand 缺省表示 standalone 单引号形式（本就没有 trailing command）。
 */
export type ApplyPatchPlan = {
	kind: "apply-patch";
	command: string;
	invocations: readonly ApplyPatchInvocation[];
	/**
	 * invocation 之前的普通语句 verbatim 原文（前缀段：原生 shell 执行，起点 cwd = prefixCwd）。
	 * bash 语句原子拆分——前缀语句与 patch 识别互不影响，执行顺序 prefix → invocations → trailing。
	 * 缺省表示无前缀段。
	 */
	prefixCommand?: string;
	/** 前缀段执行起点 cwd（进入前缀段时经 cd 解析后的 cwd；段内 cd 由 shell 自处理）。 */
	prefixCwd?: string;
	/** 前缀段与第一个 invocation 之间的连接符为 && → 短路（bash 语义）；缺省/分号/换行 → 不短路。 */
	prefixShortCircuit?: boolean;
	trailingCommand?: string;
};

/** 一次 in-place 编辑：自己的 cwd + 目标文件（absolute 快照 identity + 展示用原文）。 */
export type InPlaceEdit = {
	index: number;
	cwd: string;
	/** 展示用命令头（`perl -pi -e` / `sed -i` 等，pending 行渲染）。 */
	displayCommand: string;
	files: readonly string[];
	displayFiles: readonly string[];
};

/**
 * in-place edit plan（perl -pi 形态）：执行是整条命令 verbatim（无 rebuild/replay），
 * plan 的唯一职责是声明快照目标（snapshotFiles）与展示数据——语义零改动由构造保证。
 */
export type InPlaceEditPlan = {
	kind: "in-place-edit";
	command: string;
	/** verbatim 执行的 cwd（命令内的 cd 由 shell 自己处理）。 */
	cwd: string;
	edits: readonly InPlaceEdit[];
	/** 快照目标：全部 edit 文件的 absolute 去重。 */
	snapshotFiles: readonly string[];
};

/** 单段命令的 plan：apply_patch 或 in-place edit，一段只属其一。 */
export type BashCommandPlan = ApplyPatchPlan | InPlaceEditPlan;

/**
 * 命令 pipeline：一段或多段 plan 按原文顺序组合；段与段执行互不共享（各自 executor /
 * 快照 bracket / VM），组合器只做顺序调度与 && 短路。单段 = 纯命令（纯 apply_patch /
 * 纯 in-place edit）；两段 = in-place 编辑区 + apply_patch 调用区。
 */
export type BashCommandPipeline = {
	plans: readonly BashCommandPlan[];
	/** 段间边界为 &&：前段失败则后段不执行（shell 短路语义）；单段恒 false。 */
	shortCircuit: boolean;
};

/** 解析域共享原语：CLI 文本行规范化（CRLF → LF，尾部换行不产生空行）。 */
export function normalizeLines(text: string): string[] {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}

/** 解析域共享原语：类型守卫（object 且非 null）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

const OPERATION_HEADER = /^\*\*\* (Add|Delete|Update) File: (.+)$/;
const OPERATION_HEADER_PREFIXES = ["*** Add File: ", "*** Delete File: ", "*** Update File: "] as const;

// ---------- 静态词法层 ----------
//
// shell 命令的静态可求值子集。第一性原理：识别的前提是 patch 内容能从命令文本
// 静态完备推出（语义零改动）；静态不可知的结构（$、`、glob、管道、后台、
// 子 shell、brace 展开）只标记不猜测，由装配层决定 delegate。
// 词法是 total function：任何输入都产出语句序列，不抛异常。

/** 静态文本：ok=false 表示含动态结构，值不可得。 */
type StaticText = { ok: true; text: string } | { ok: false };

type LexRedirect = {
	op: ">" | ">>" | "<" | "<<";
	target: StaticText;
	/** `<<` marker 带引号且非 `<<-`：body 无展开，文本即内容。 */
	quotedMarker?: boolean;
};

type LexSimpleCommand = {
	argv: StaticText[];
	redirects: LexRedirect[];
	/** `<<` 的 body（语句行结束后按 marker 声明顺序从后续行消费）。 */
	heredoc?: { body: string; literal: boolean };
	/** 原文（规范化后）起始 offset：pipeline 切分的 verbatim slice 边界。 */
	start: number;
	/** 管道参与者（`|` 优先级高于 `&&`：前后命令互为元素单位）；仅 `|` 标记，`||` 不算。 */
	piped?: boolean;
	/** 裸 `&` 后台化的命令：快照 bracket 会 race，编辑命令带此标记必须 bail。 */
	background?: boolean;
};

type LexStatement = {
	commands: LexSimpleCommand[];
	/** 管道 / 后台 / here-string / 动态 heredoc marker 等静态不可知控制结构。 */
	dynamic: boolean;
	/** 非管道动态（`||`、后台 `&`、here-string）：prefix 切片无法忠实重放连接语义。 */
	nonPipeDynamic: boolean;
	/** 动态 heredoc marker：body 边界不可知，其后的语句划分不可信。 */
	unreliable: boolean;
	/** 行首 `&&`（跨行 continuation）：与前一语句的 && 语义连接。 */
	leadingAndAnd: boolean;
	/** 原文（CRLF 规范化后）起始 offset：trailing 取 verbatim slice，不经重建。 */
	start: number;
};

const WORD_DELIMITERS = new Set([" ", "\t", "\n", ";", "&", "|", ">", "<"]);

/** 跳过展开结构：`$(...)`（可嵌套）、`${...}`、`$VAR`/`$?` 等。返回结束 offset。 */
function skipExpansion(text: string, start: number): number {
	const open = text[start + 1];
	if (open === "(") {
		let depth = 1;
		let i = start + 2;
		while (i < text.length && depth > 0) {
			const c = text[i]!;
			if (c === "(") depth += 1;
			else if (c === ")") depth -= 1;
			else if (c === "'") {
				const close = text.indexOf("'", i + 1);
				i = close === -1 ? text.length : close;
			}
			i += 1;
		}
		return i;
	}
	if (open === "{") {
		const close = text.indexOf("}", start + 2);
		return close === -1 ? text.length : close + 1;
	}
	let i = start + 1;
	while (i < text.length && /[A-Za-z0-9_?#$!@*]/.test(text[i]!)) i += 1;
	return i;
}

/**
 * 词法一个词：引号段拼接（单引号字面、双引号在无展开时字面）、反斜杠转义、
 * 相邻段无空格合并（`'a'\''b'` = `a'b`）。动态结构标记 ok:false，内容不再可信。
 */
function parseWordAt(text: string, start: number): { word: StaticText; quoted: boolean; next: number } {
	let i = start;
	let value = "";
	let ok = true;
	let quoted = false;
	while (i < text.length && !WORD_DELIMITERS.has(text[i]!)) {
		const c = text[i]!;
		if (c === "'") {
			quoted = true;
			const close = text.indexOf("'", i + 1);
			if (close === -1) return { word: { ok: false }, quoted, next: text.length };
			value += text.slice(i + 1, close);
			i = close + 1;
			continue;
		}
		if (c === '"') {
			quoted = true;
			let j = i + 1;
			let closed = false;
			while (j < text.length) {
				const d = text[j]!;
				if (d === "\\" && j + 1 < text.length && ["\"", "\\", "$", "`"].includes(text[j + 1]!)) {
					value += text[j + 1];
					j += 2;
					continue;
				}
				if (d === '"') {
					closed = true;
					j += 1;
					break;
				}
				if (d === "$") {
					ok = false;
					j = skipExpansion(text, j);
					continue;
				}
				if (d === "`") {
					ok = false;
					const close = text.indexOf("`", j + 1);
					j = close === -1 ? text.length : close + 1;
					continue;
				}
				value += d;
				j += 1;
			}
			if (!closed) return { word: { ok: false }, quoted, next: text.length };
			i = j;
			continue;
		}
		if (c === "\\") {
			if (text[i + 1] === "\n") {
				i += 2; // 续行
				continue;
			}
			if (i + 1 < text.length) value += text[i + 1];
			i += 2;
			continue;
		}
		if (c === "$") {
			ok = false;
			i = skipExpansion(text, i);
			continue;
		}
		if (c === "`") {
			ok = false;
			const close = text.indexOf("`", i + 1);
			i = close === -1 ? text.length : close + 1;
			continue;
		}
		if (["*", "?", "[", "{", "}", "(", ")"].includes(c)) {
			ok = false; // glob / brace / 子 shell：静态不可知
		} else if (c === "~" && value === "") {
			ok = false; // 主目录展开
		}
		value += c;
		i += 1;
	}
	return { word: ok ? { ok: true, text: value } : { ok: false }, quoted, next: i };
}

/** 词法整条命令为语句序列（含规范化后原文，trailing slice 用）。 */
function lexStatements(command: string): { statements: LexStatement[]; text: string } {
	const text = command.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const n = text.length;
	const statements: LexStatement[] = [];
	let statement: LexStatement | undefined;
	let current: LexSimpleCommand | undefined;
	let pendingHeredocs: { command: LexSimpleCommand; marker: string; literal: boolean }[] = [];
	let pipeNext = false;

	const ensureStatement = (at: number): LexStatement =>
		(statement ??= { commands: [], dynamic: false, nonPipeDynamic: false, unreliable: false, leadingAndAnd: false, start: at });
	const ensureCommand = (at: number): LexSimpleCommand => (current ??= { argv: [], redirects: [], start: at });
	const closeCommand = () => {
		if (!current) return;
		if (current.argv.length > 0 || current.redirects.length > 0) statement?.commands.push(current);
		current = undefined;
	};
	const closeStatement = () => {
		closeCommand();
		if (!statement) return;
		if (statement.commands.length > 0 || statement.dynamic) statements.push(statement);
		statement = undefined;
	};
	/** heredoc body 从行末换行之后按声明顺序消费；未闭合则 body = 剩余文本。 */
	const flushHeredocs = (from: number): number => {
		let cursor = from;
		for (const entry of pendingHeredocs) {
			const bodyLines: string[] = [];
			while (cursor < n) {
				const lineEnd = text.indexOf("\n", cursor);
				const line = lineEnd === -1 ? text.slice(cursor) : text.slice(cursor, lineEnd);
				const next = lineEnd === -1 ? n : lineEnd + 1;
				if (line === entry.marker) {
					cursor = next;
					break;
				}
				bodyLines.push(line);
				cursor = next;
			}
			entry.command.heredoc = { body: bodyLines.join("\n"), literal: entry.literal };
		}
		pendingHeredocs = [];
		return cursor;
	};

	let i = 0;
	while (i < n) {
		const c = text[i]!;
		if (c === " " || c === "\t") {
			i += 1;
			continue;
		}
		if (c === "\n") {
			closeStatement();
			i = flushHeredocs(i + 1);
			continue;
		}
		if (c === ";") {
			closeStatement();
			i += 1;
			continue;
		}
		if (c === "&") {
			if (text[i + 1] === "&") {
				const stmt = ensureStatement(i);
				if (stmt.commands.length === 0 && current === undefined) stmt.leadingAndAnd = true;
				closeCommand();
				i += 2;
				continue;
			}
			const stmt = ensureStatement(i);
			stmt.dynamic = true; // 后台 &
			stmt.nonPipeDynamic = true;
			if (current) current.background = true;
			closeCommand();
			i += 1;
			continue;
		}
		if (c === "|") {
			const stmt = ensureStatement(i);
			stmt.dynamic = true; // 管道 / ||：语句级仍标动态（静态不可知控制结构）
			if (text[i + 1] === "|") {
				stmt.nonPipeDynamic = true; // ||：prefix 切片会断掉连接语义
			} else {
				// 管道优先级高于 &&：前后命令互为 pipeline 参与者（元素分割的单位）。
				if (current) current.piped = true;
				pipeNext = true;
			}
			closeCommand();
			i += text[i + 1] === "|" ? 2 : 1;
			continue;
		}
		if (c === "#") {
			// 注释只在词首出现（词内的 # 由 parseWordAt 消费）。
			const next = text.indexOf("\n", i);
			i = next === -1 ? n : next;
			continue;
		}
		if (c === ">" || c === "<") {
			let op: LexRedirect["op"];
			let j: number;
			if (c === ">") {
				op = text[i + 1] === ">" ? ">>" : ">";
				j = i + op.length;
			} else if (text[i + 1] === "<") {
				if (text[i + 2] === "<") {
					const stmt = ensureStatement(i);
					stmt.dynamic = true; // <<< here-string：静态不可知
					stmt.nonPipeDynamic = true;
					i += 3;
					continue;
				}
				op = "<<";
				j = i + 2;
			} else {
				op = "<";
				j = i + 1;
			}
		// fd 复制（`>&N` / `>&-` / `<&N`，heredoc `<<` 除外）：一个 redirect 单元——
		// 不把 & 误标后台、不把 N 拆成幽灵命令；fd target 静态不追踪，保守记动态 target。
		if (op !== "<<" && text[j] === "&" && /[0-9-]/.test(text[j + 1] ?? "")) {
			j += 1;
			while (/[0-9]/.test(text[j] ?? "")) j += 1;
			ensureStatement(i);
			ensureCommand(i).redirects.push({ op, target: { ok: false } });
			i = j;
			continue;
		}
		while (text[j] === " " || text[j] === "\t") j += 1;
		const { word, quoted, next } = parseWordAt(text, j);
		const target: StaticText = word.ok && word.text.length > 0 ? word : { ok: false };
		const redirect: LexRedirect = { op, target };
		const stmt = ensureStatement(i);
		if (op === "<<") {
			const tabStripped = text[i + 2] === "-"; // <<- 剥离前导 tab：body 非原文
			const literal = quoted && !tabStripped && target.ok;
			if (!target.ok) stmt.unreliable = true; // 动态 marker：body 边界不可知
			redirect.quotedMarker = literal;
			pendingHeredocs.push({
				command: ensureCommand(i),
				marker: target.ok ? target.text : "\0",
				literal,
			});
		}
		ensureCommand(i).redirects.push(redirect);
		i = next;
		continue;
		}
		const { word, next } = parseWordAt(text, i);
		if (next === i) {
			i += 1; // 防御：无进展
			continue;
		}
		ensureStatement(i);
		const cmd = ensureCommand(i);
		if (pipeNext) {
			cmd.piped = true;
			pipeNext = false;
		}
		cmd.argv.push(word);
		i = next;
	}
	closeStatement();
	return { statements, text };
}

// ---------- 形态层 ----------
//
// CLI usage（readPatch）：patch = argv[1] XOR stdin，多一个参数即 usage error。
// 形态表由该契约 × shell 静态供给方式导出，封闭完备：
//   arg      apply_patch <static-string>   —— quoted literal（可跨行、可拼接段）
//   heredoc  apply_patch <<'M' … M         —— quoted marker，body 无展开
//   redirect apply_patch < file            —— file 由同命令 `cat > file <<'M'` 静态写入；
//                                            execute 侧 options.externalStdinBody 可读前序命令
//                                            已落盘的文件（原样 redirect，无 replay）
// 其余（管道、额外 argv、stdout redirect、动态词、unquoted heredoc）→ 不识别。

/** 命令名匹配：bare 或绝对路径；相对路径调用不识别（既有契约）。 */
function matchCommandName(word: StaticText | undefined, name: string): boolean {
	if (!word || !word.ok) return false;
	return word.text === name || (word.text.startsWith("/") && word.text.endsWith(`/${name}`));
}

/** `cd <static-dir>`：新 cwd；动态/无参数/多参数 → invalid（cd 的目錄影响后续 resolve）。 */
function matchCd(command: LexSimpleCommand, cwd: string): { kind: "cd"; cwd: string } | { kind: "invalid" } | { kind: "other" } {
	if (!matchCommandName(command.argv[0], "cd")) return { kind: "other" };
	const args = command.argv.slice(1);
	if (args.length !== 1 || !args[0]!.ok || command.redirects.length > 0) return { kind: "invalid" };
	return { kind: "cd", cwd: path.resolve(cwd, args[0]!.text) };
}

/** `cat > <static-file> <<'M'` 纯写：写文件事实；其他任何 cat 形态 → undefined。 */
function matchCatWrite(command: LexSimpleCommand): { target: string; body: string } | undefined {
	if (!matchCommandName(command.argv[0], "cat")) return undefined;
	if (command.argv.length !== 1 || command.redirects.length !== 2) return undefined;
	const write = command.redirects.find((r) => r.op === ">");
	const heredoc = command.redirects.find((r) => r.op === "<<");
	if (!write?.target.ok || !heredoc?.quotedMarker || command.heredoc?.literal !== true) return undefined;
	return { target: write.target.text, body: command.heredoc.body };
}

/** `perl (-pi|-ni) -e <static-prog> <static-files…>`：封闭子集（session 证据：~97% perl 用法收敛于此）。 */
function matchPerlInPlace(command: LexSimpleCommand): { displayCommand: string; displayFiles: string[] } | undefined {
	if (!matchCommandName(command.argv[0], "perl")) return undefined;
	if (command.redirects.length > 0) return undefined;
	const args = command.argv.slice(1);
	if (args.length < 4) return undefined;
	const [flags, dashE, prog, ...files] = args;
	if (!flags?.ok || (flags.text !== "-pi" && flags.text !== "-ni")) return undefined;
	if (!dashE?.ok || dashE.text !== "-e") return undefined;
	if (!prog?.ok || files.length === 0 || !files.every((file) => file.ok)) return undefined;
	return {
		displayCommand: "perl edit",
		displayFiles: files.map((file) => (file as { ok: true; text: string }).text),
	};
}

/**
 * `sed -i [''|""] [(-e|-E) <static-script>] <static-files…>`：封闭子集（~96% sed 语料）。
 * BSD 非空 backup 后缀与 GNU bare 形式 argv 形状相同，但 verbatim 执行语义始终忠实，
 * 误判的多余快照目标内容不变会被 VM 丢弃（优雅降级），故接受 bare 形式。
 */
function matchSedInPlace(command: LexSimpleCommand): { displayCommand: string; displayFiles: string[] } | undefined {
	if (!matchCommandName(command.argv[0], "sed")) return undefined;
	if (command.redirects.length > 0) return undefined;
	const args = command.argv.slice(1);
	if (!args[0]?.ok || args[0].text !== "-i") return undefined;
	let rest = args.slice(1);
	// BSD 空 backup 后缀（仅 ''/""；非空后缀 0 语料，不识别）。
	if (rest[0]?.ok && rest[0].text === "") rest = rest.slice(1);
	let script: StaticText | undefined;
	let files: StaticText[];
	if (rest[0]?.ok && (rest[0].text === "-e" || rest[0].text === "-E")) {
		[, script, ...files] = rest;
	} else {
		[script, ...files] = rest;
	}
	if (!script?.ok || files.length === 0 || !files.every((file) => file.ok)) return undefined;
	return {
		displayCommand: "sed edit",
		displayFiles: files.map((file) => (file as { ok: true; text: string }).text),
	};
}

/** in-place edit 工具形态表：perl 优先，其后 sed；一个 simple command 只属其一。 */
function matchInPlaceEdit(command: LexSimpleCommand): { displayCommand: string; displayFiles: string[] } | undefined {
	return matchPerlInPlace(command) ?? matchSedInPlace(command);
}

type InvocationSource = { envelope: string; stdinFilePath?: string; external?: boolean };

/** apply_patch simple command → invocation 来源；undefined = 形态不符（装配层 bail）。 */
function matchApplyPatch(
	command: LexSimpleCommand,
	cwd: string,
	factBody: (absolutePath: string) => string | undefined,
	externalBody?: (absolutePath: string) => string | undefined,
): InvocationSource | undefined {
	const args = command.argv.slice(1);
	const heredocs = command.redirects.filter((r) => r.op === "<<");
	const stdinFiles = command.redirects.filter((r) => r.op === "<");
	const outputs = command.redirects.filter((r) => r.op === ">" || r.op === ">>");
	if (outputs.length > 0 || heredocs.length + stdinFiles.length !== (args.length === 0 ? 1 : 0)) return undefined;
	if (heredocs.length === 1) {
		if (!heredocs[0]!.quotedMarker || command.heredoc?.literal !== true) return undefined;
		return { envelope: command.heredoc.body };
	}
	if (stdinFiles.length === 1) {
		const target = stdinFiles[0]!.target;
		if (!target.ok) return undefined;
		const sourceAbsolutePath = path.resolve(cwd, target.text);
		// 同命令 cat 事实优先；缺失时 execute 侧 resolver 读前序命令已落盘的外部文件。
		const fact = factBody(sourceAbsolutePath);
		if (fact !== undefined) return { envelope: fact, stdinFilePath: sourceAbsolutePath };
		const external = externalBody?.(sourceAbsolutePath);
		return external === undefined ? undefined : { envelope: external, stdinFilePath: sourceAbsolutePath, external: true };
	}
	if (args.length === 1 && args[0]!.ok) return { envelope: args[0]!.text };
	return undefined;
}

function isOperationHeader(line: string): boolean {
	const trimmed = line.trimStart();
	return OPERATION_HEADER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function parseOperationHeader(line: string): { kind: PatchOperation["kind"]; path: string } | undefined {
	const match = line.trimStart().match(OPERATION_HEADER);
	if (!match || match[2] !== match[2].trim()) return undefined;
	const kind = match[1] === "Add" ? "add" : match[1] === "Delete" ? "delete" : "update";
	return match[2].length > 0 ? { kind, path: match[2] } : undefined;
}

function parseAddOperation(lines: string[], start: number, index: number, path: string) {
	const patchLines: PatchLine[] = [];
	let cursor = start;
	while (cursor < lines.length && lines[cursor]?.trimStart() !== "*** End Patch" && !isOperationHeader(lines[cursor] ?? "")) {
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
	const head = (lines[cursor] ?? "").trimStart();
	if (head.startsWith("*** Move to: ")) {
		const candidate = head.slice("*** Move to: ".length);
		if (candidate.length > 0 && candidate === candidate.trim()) destination = candidate;
		cursor += 1;
	}
	while (cursor < lines.length && lines[cursor]?.trimStart() !== "*** End Patch" && !isOperationHeader(lines[cursor] ?? "")) {
		const line = lines[cursor] ?? "";
		const trimmed = line.trimStart();
		if (trimmed === "@@" || trimmed.startsWith("@@ ")) {
			if (chunkLines !== undefined) chunks.push({ index: chunks.length, lines: chunkLines });
			chunkLines = [];
			cursor += 1;
			continue;
		}
		if (trimmed !== "*** End of File" && line.length > 0 && [" ", "+", "-"].includes(line[0] ?? "")) {
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

/** 统一 heredoc 缩进量：指令行（trim 后以 *** 或 @@ 开头）前导空白的最小值；顶格/非 patch 为 0。 */
function patchIndent(lines: string[]): number {
	let n = -1;
	for (const line of lines) {
		const trimmed = line.trimStart();
		if (!trimmed.startsWith("***") && !trimmed.startsWith("@@")) continue;
		const indent = line.length - trimmed.length;
		if (n === -1 || indent < n) n = indent;
	}
	return n < 0 ? 0 : n;
}

/** 每行剥去至多 n 个前导空白字符（统一 heredoc 缩进；不足 n 的行剥到 0）。与 CLI parser 同算法。 */
function stripIndent(lines: string[], n: number): string[] {
	if (n <= 0) return lines;
	return lines.map((line) => {
		let strip = 0;
		while (strip < n && strip < line.length && (line[strip] === " " || line[strip] === "\t")) strip += 1;
		return line.slice(strip);
	});
}

function parsePatchEnvelope(source: string): ParsedPatch | undefined {
	const lines = stripIndent(normalizeLines(source), patchIndent(normalizeLines(source)));
	if (lines[0]?.trimStart() !== "*** Begin Patch") return undefined;
	const operations: PatchOperation[] = [];
	let cursor = 1;
	let operationIndex = 0;
	while (cursor < lines.length && lines[cursor]?.trimStart() !== "*** End Patch") {
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
 * 权威 plan 构建（匹配方案的总装）：词法语句序列 × 形态表 × cwd/事实状态机。
 * bail 不变式（第一性原理）：任何无法静态完备重放的成分 → 整条 delegate：
 * - apply_patch 形态不符或 envelope 不可解析（真实 shell 会运行它，识别即丢命令）；
 * - redirect 来源不在事实表且无 externalStdinBody resolver（或 resolver 读不到/不可解析）；
 *   写文件事实未被消费（副作用无法重放）；
 * - 前缀段与 cat 写事实互斥混排（cat replay 与 prefix 混杂，执行顺序无法静态重放）；
 * - trailing 之后再出现 apply_patch；语句内 invocation 与普通命令混合；
 * - 管道/后台/动态 heredoc marker 等静态不可知结构触及识别范围。
 * prefix = 第一个 invocation 之前的普通语句 verbatim 原文（原生 shell 执行，起点 cwd 解析记录，
 * 段内 cd 由 shell 自处理）；trailing = 最后一个 invocation 之后的语句 verbatim 原文。
 * 只解析一次，capture/finalize/渲染全部消费它，不再到处重跑 parser。
 *
 * options.externalStdinBody：execute 侧专属（同步读文件，render 路径零 I/O 永不传入）。
 * 读到的 envelope 即 CLI 将拿到的 stdin；执行后输出与 plan 不匹配（文件竞态被改）时
 * 既有 match guard 丢 VM 回退原文渲染，诚实降级。
 */
export function buildApplyPatchPlan(
	command: string,
	initialCwd: string,
	options?: { externalStdinBody?: (absolutePath: string) => string | undefined },
): ApplyPatchPlan | undefined {
	const { statements, text } = lexStatements(command);
	const invocations: ApplyPatchInvocation[] = [];
	/** 同命令静态写文件事实表：absolute path → { body, consumed }（redirect 来源唯一依据）。 */
	const facts = new Map<string, { body: string; consumed: boolean }>();
	let cwd = initialCwd;
	let trailingStart: number | undefined;
	let bail = false;
	/** 前缀段：首个普通命令起点 / 起点 cwd / 是否已开始。 */
	let prefixStarted = false;
	let prefixStart = 0;
	let prefixCwdAtStart = initialCwd;
	/** 第一个 invocation 命令起点（prefix 切片终点）。 */
	let firstInvocationCmdStart = 0;
	/** 已消费但尚未被 invocation 消费的 cat 写事实：其后夹普通语句 → bail（顺序不可重放）。 */
	let catSeenSinceInvocation = false;

	for (const [statementIndex, statement] of statements.entries()) {
		if (trailingStart !== undefined) {
			// trailing 之后再出现 apply_patch：真实 shell 会运行它 → bail。
			if (statement.commands.some((cmd) => matchCommandName(cmd.argv[0], "apply_patch"))) bail = true;
			continue;
		}
		if (statement.unreliable) {
			bail = true; // 动态 heredoc marker：其后语句划分不可信
			break;
		}
		if (statement.leadingAndAnd && statementIndex === 0) {
			bail = true; // 行首 && 开头：bash 语法错误，整条不运行
			break;
		}
		if (statement.nonPipeDynamic && statement.commands.some((cmd) => matchCommandName(cmd.argv[0], "apply_patch"))) {
			bail = true; // ||/后台/here-string 与 apply_patch 同语句：prefix 切片无法忠实重放连接语义
			break;
		}
		let hasOrdinary = false;
		for (const cmd of statement.commands) {			const cd = matchCd(cmd, cwd);
			if (cd.kind === "invalid") {
				bail = true;
				break;
			}
			if (cd.kind === "cd") {
				cwd = cd.cwd;
				continue;
			}
			const catWrite = matchCatWrite(cmd);
			if (catWrite) {
				// 前缀段内夹 cat：cat replay 与 prefix 混杂，执行顺序无法静态重放 → bail。
				if (prefixStarted) {
					bail = true;
					break;
				}
				catSeenSinceInvocation = true;
				const key = path.resolve(cwd, catWrite.target);
				const prior = facts.get(key);
				if (prior) prior.consumed = true; // 覆写：前次写入副作用被后者吸收
				facts.set(key, { body: catWrite.body, consumed: false });
				continue;
			}
			if (matchCommandName(cmd.argv[0], "apply_patch")) {
				// apply_patch 自身是管道/后台参与者：输出与执行语义不可重放 → bail。
				// （同语句内其他命令的管道不阻塞：prefix verbatim 交原生 shell，语义零改动。）
				if (cmd.piped === true || cmd.background === true) {
					bail = true;
					break;
				}
				// trailing 区再出现 apply_patch：真实 shell 会运行它 → bail。
				if (trailingStart !== undefined) {
					bail = true;
					break;
				}
				if (invocations.length === 0) firstInvocationCmdStart = cmd.start;
				catSeenSinceInvocation = false; // invocation 可消费 cat（消费与否由事实表兜底）
				const source = matchApplyPatch(
					cmd,
					cwd,
					(absolutePath) => facts.get(absolutePath)?.body,
					options?.externalStdinBody,
				);
				// 形态（bash 语法层）不符 → bail；内容（apply_patch 格式层）解析失败 →
				// 空 operations 照常识别（渲染提示、执行交 CLI 诚实裁决，不创造格式条件）。
				if (!source) {
					bail = true;
					break;
				}
				const patch = parsePatchEnvelope(source.envelope) ?? { operations: [] };
				const fact = source.stdinFilePath === undefined ? undefined : facts.get(source.stdinFilePath);
				if (fact) fact.consumed = true;
				invocations.push({
					index: invocations.length,
					cwd,
					patch,
					envelope: source.envelope,
					stdinFilePath: source.stdinFilePath,
					stdinExternal: source.external === true ? true : undefined,
					operations: planOperations(invocations.length, cwd, patch),
				});
				continue;
			}
			const inPlaceEdit = matchInPlaceEdit(cmd);
			if (inPlaceEdit && invocations.length === 0) {
				// 前缀段内出现 in-place edit：归属 mixed 编辑区（专门 VM + 快照 bracket），
				// 不能让 prefix 吞并——否则分号/&& 的短路语义与编辑区 VM 都会丢。
				bail = true;
				break;
			}
			// 普通命令：bash 语句原子拆分，按位置归属 prefix（第一个 invocation 前）或 trailing（之后）。
			if (invocations.length === 0) {
				// 已消费 cat 之后夹普通语句：cat replay 与 prefix 的顺序不可静态重放 → bail。
				if (catSeenSinceInvocation) {
					bail = true;
					break;
				}
				if (!prefixStarted) {
					prefixStarted = true;
					prefixStart = cmd.start;
					prefixCwdAtStart = cwd;
				}
			} else if (trailingStart === undefined) {
				trailingStart = cmd.start;
			}
			hasOrdinary = true;
		}
		if (bail) break;
	}
	// 未被消费的写文件事实：副作用无法重放 → bail。
	if (!bail && [...facts.values()].some((fact) => !fact.consumed)) bail = true;
	if (bail || invocations.length === 0) return undefined;
	// prefix = 首个前缀命令起点 → 第一个 invocation 命令起点 verbatim 切片（段内 cd/管道/&& 由 shell 自处理）。
	// 尾部连接符剥除并判定短路：&&（同行或行尾 continuation）→ 短路；`;`/换行 → 不短路。
	let prefixCommand: string | undefined;
	let prefixShortCircuit = false;
	if (prefixStarted) {
		let slice = text.slice(prefixStart, firstInvocationCmdStart).trim();
		if (slice.endsWith("&&")) {
			prefixShortCircuit = true;
			slice = slice.slice(0, -2).trimEnd();
		} else if (slice.endsWith(";")) {
			slice = slice.slice(0, -1).trimEnd();
		}
		prefixCommand = slice || undefined;
	}
	const trailing = trailingStart === undefined ? "" : text.slice(trailingStart).trim();
	return {
		kind: "apply-patch",
		command,
		invocations,
		prefixCommand,
		prefixCwd: prefixCommand ? prefixCwdAtStart : undefined,
		prefixShortCircuit: prefixCommand ? prefixShortCircuit : undefined,
		trailingCommand: trailing || undefined,
	};
}

/**
 * in-place edit plan 装配：语句序列必须从起就是 {cd, perl -pi -e} 纯序列。
 * bail 不变式：执行是整条 verbatim，识别只是解释层——但快照之外的文件变更会让
 * VM 说谎（渲染集 ⊊ 实际变更集），所以 perl 编辑区之前/之中出现未跟踪语句
 * （mv/rm 等）→ 整条 delegate；trailing（编辑区之后）原生命运行，
 * 其后再出现 perl 同样 bail（中间隔着未跟踪语句）。
 * 管道/后台按命令粒度判定（`|` 优先级高于 `&&`）：编辑命令本身是管道/后台参与者
 * （`perl f | cat`、`perl f &`）→ bail（快照 bracket 会 race / 输出归属不可保证）；
 * 管道/后台只触及编辑区之后的命令（`… && pytest 2>&1 | tail -2`）→ 既有 trailing，
 * verbatim 执行语义零改动。
 */
export function buildInPlaceEditPlan(command: string, initialCwd: string): InPlaceEditPlan | undefined {
	const { statements } = lexStatements(command);
	const edits: InPlaceEdit[] = [];
	const snapshotFiles: string[] = [];
	let cwd = initialCwd;
	let trailingSeen = false;
	for (const [statementIndex, statement] of statements.entries()) {
		if (trailingSeen) {
			// trailing 之后再出现 in-place 工具：与前一编辑隔着未跟踪语句 → bail。
			if (statement.commands.some((cmd) => matchInPlaceEdit(cmd))) return undefined;
			continue;
		}
		if (statement.unreliable) return undefined;
		if (statement.leadingAndAnd && statementIndex === 0) {
			return undefined; // 行首 && 开头：bash 语法错误，整条不运行
		}
		const statementEdits: { cwd: string; displayCommand: string; displayFiles: string[] }[] = [];
		let statementCwd = cwd;
		/** 语句内已进入 trailing 区（ordinary 命令之后）；其后出现编辑 → bail。 */
		let statementTrailing = false;
		let bail = false;
		for (const cmd of statement.commands) {
			const cd = matchCd(cmd, statementCwd);
			if (cd.kind === "invalid") {
				bail = true;
				break;
			}
			if (cd.kind === "cd") {
				statementCwd = cd.cwd;
				continue;
			}
			const edit = matchInPlaceEdit(cmd);
			if (edit) {
				if (statementTrailing || cmd.piped === true || cmd.background === true) {
					// 编辑与前一编辑隔着未跟踪命令，或编辑本身是管道/后台参与者
					bail = true;
					break;
				}
				statementEdits.push({ cwd: statementCwd, ...edit });
				continue;
			}
			if (edits.length === 0 && statementEdits.length === 0) {
				bail = true; // 编辑区之前的未跟踪语句
				break;
			}
			statementTrailing = true;
		}
		if (bail) return undefined;
		cwd = statementCwd;
		for (const edit of statementEdits) {
			const files = edit.displayFiles.map((file) => path.resolve(edit.cwd, file));
			for (const file of files) {
				if (!snapshotFiles.includes(file)) snapshotFiles.push(file);
			}
			edits.push({ index: edits.length, cwd: edit.cwd, displayCommand: edit.displayCommand, files, displayFiles: edit.displayFiles });
		}
		if (statementTrailing) trailingSeen = true;
	}
	if (edits.length === 0) return undefined;
	return { kind: "in-place-edit", command, cwd: initialCwd, edits, snapshotFiles };
}

/**
 * 两段切分（混合命令）：词法流上前缀 {cd, in-place edit} 纯序列是编辑区（verbatim 执行），
 * 首个其他命令起是调用区（交 buildApplyPatchPlan 全规则：cat 事实 / external stdin /
 * trailing / bail）。编辑区与调用区可在同一语句（`perl … && apply_patch …`），边界按
 * command offset 切 verbatim 原文；段间连接符 && 记为 shortCircuit。
 * 反向顺序（patch 在前 perl 在后）不切分：buildApplyPatchPlan 已将 perl 归入 trailing。
 */
function buildMixedPipeline(
	command: string,
	initialCwd: string,
	options?: { externalStdinBody?: (absolutePath: string) => string | undefined },
): BashCommandPipeline | undefined {
	const { statements, text } = lexStatements(command);
	let cwd = initialCwd;
	let hasEdits = false;
	let boundary: number | undefined;
	const walk = () => {
		for (const [statementIndex, statement] of statements.entries()) {
			if (statement.unreliable) return false;
			if (statement.leadingAndAnd && statementIndex === 0) return false;
			if (statement.dynamic) {
				// 管道/后台中的 in-place 工具：语义不可跟踪 → 不识别；其余 dynamic 语句无法属于
				// 编辑区，作边界处理（调用区含 dynamic + apply_patch 时 buildApplyPatchPlan 会 bail）。
				if (statement.commands.some((cmd) => matchInPlaceEdit(cmd))) return false;
				boundary = statement.start;
				return true;
			}
			for (const cmd of statement.commands) {
				const cd = matchCd(cmd, cwd);
				if (cd.kind === "invalid") return false;
				if (cd.kind === "cd") {
					cwd = cd.cwd;
					continue;
				}
				if (matchInPlaceEdit(cmd)) {
					hasEdits = true;
					continue;
				}
				boundary = cmd.start;
				return true;
			}
		}
		return true;
	};
	if (!walk() || !hasEdits || boundary === undefined) return undefined;
	// 编辑区 verbatim 原文（剥掉与调用区之间的连接符）：&& 短路，;/换行不短路。
	const head = text.slice(0, boundary).replace(/[ \t\n]+$/u, "");
	let editText = head;
	let shortCircuit = false;
	if (head.endsWith("&&")) {
		editText = head.slice(0, -2);
		shortCircuit = true;
	} else if (head.endsWith(";")) {
		editText = head.slice(0, -1);
	}
	const editPlan = buildInPlaceEditPlan(editText, initialCwd);
	if (!editPlan) return undefined;
	const applyPlan = buildApplyPatchPlan(text.slice(boundary), cwd, options);
	if (!applyPlan) return undefined;
	return { plans: [editPlan, applyPlan], shortCircuit };
}

/**
 * pipeline 识别唯一入口：apply_patch 形态优先（含 patch 在前 perl 在后的 trailing 归属），
 * 其后混合两段切分，最后纯 in-place edit；形态互不重叠。
 */
export function buildBashPipeline(
	command: string,
	initialCwd: string,
	options?: { externalStdinBody?: (absolutePath: string) => string | undefined },
): BashCommandPipeline | undefined {
	const applyPatch = buildApplyPatchPlan(command, initialCwd, options);
	if (applyPatch) return { plans: [applyPatch], shortCircuit: false };
	const mixed = buildMixedPipeline(command, initialCwd, options);
	if (mixed) return mixed;
	const inPlace = buildInPlaceEditPlan(command, initialCwd);
	return inPlace ? { plans: [inPlace], shortCircuit: false } : undefined;
}

/** 形状探针 envelope：可解析即可（operations 只用于 bail 判定，probe plan 随即丢弃）。 */
const EXTERNAL_SHAPE_PROBE_ENVELOPE = "*** Begin Patch\n*** Delete File: __pi_bash_ui_probe__\n*** End Patch";

/**
 * 命令识别的判别式结果：execute 与 renderCall 共用同一识别阶梯，每级至多解析一次。
 * 阶梯：patchish 静态 plan（apply_patch / 混合两段）→ redirect 外部来源重试（execute 侧传
 * resolver 真读文件；render 侧零 I/O 用探针，命中只报 external-shape）→ 纯 in-place edit
 * fallback → delegate。patchish 必须先于 in-place fallback 与重试联动：in-place 会把
 * trailing 的 apply_patch 吞成无快照原生命令，external stdin 的混合形态不能被它抢先认领。
 */
export type BashCommandRecognition =
	| { kind: "plan"; pipeline: BashCommandPipeline }
	/** 形状合法、唯一缺口是外部 redirect 来源：execute 侧 resolver 可接管；render 侧据此清空 call 槽。 */
	| { kind: "external-shape" }
	| { kind: "delegate" };

export function recognizeBashCommand(
	command: string,
	initialCwd: string,
	externalStdinBody?: (absolutePath: string) => string | undefined,
): BashCommandRecognition {
	const patchish = (options?: { externalStdinBody?: (absolutePath: string) => string | undefined }): BashCommandPipeline | undefined => {
		const applyPatch = buildApplyPatchPlan(command, initialCwd, options);
		if (applyPatch) return { plans: [applyPatch], shortCircuit: false };
		return buildMixedPipeline(command, initialCwd, options);
	};
	const pipeline = patchish();
	if (pipeline) return { kind: "plan", pipeline };
	const resolved = patchish({ externalStdinBody: externalStdinBody ?? (() => EXTERNAL_SHAPE_PROBE_ENVELOPE) });
	if (resolved) {
		// resolver 缺省（render 路径）：probe 命中只能说明形状，envelope 执行时才知道。
		return externalStdinBody ? { kind: "plan", pipeline: resolved } : { kind: "external-shape" };
	}
	const inPlace = buildInPlaceEditPlan(command, initialCwd);
	return inPlace ? { kind: "plan", pipeline: { plans: [inPlace], shortCircuit: false } } : { kind: "delegate" };
}
