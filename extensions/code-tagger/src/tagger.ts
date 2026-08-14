/**
 * 无标签代码围栏自动补语言标签。
 *
 * 背景:pi 的 TUI 只对带合法语言标签的围栏做语法高亮,无标签围栏整块单色
 * (AGENTS.md Output Style 已要求模型带标签,本模块兜底 LLM 漏打的情形)。
 *
 * 保守原则:拿不准就不标——错误语言会把代码染成错误的语义色,比不标更糟。
 * 语言识别用复合结构签名(非单词出现),散文段落不匹配任何签名 → 原样保留。
 */

const FENCE_RE = /^(\s*)(`{3,})(.*)$/;

/** 从代码内容识别语言;识别不了返回 undefined(不标)。 */
export function detectLanguage(code: string): string | undefined {
	const lines = code
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	if (lines.length === 0) return undefined;
	const joined = lines.join("\n");

	// JSON:首非空行以 { 或 [ 开头,且含 "key": 模式
	if (/^[{\[]/.test(lines[0]) && /"[^"]+"\s*:/.test(joined)) return "json";

	// YAML:≥2 个 key 结构行,且无代码强信号。单键过弱:"Note: do not ..."
	// 这类散文首行即命中,必须要求多键结构。
	const yamlKeyLines = lines.filter((l) => /^[A-Za-z_][\w.-]*:(\s+\S|$)/.test(l));
	if (yamlKeyLines.length >= 2 && !/[;{}()=<>]/.test(joined)) return "yaml";

	// Bash:shebang / 控制关键字 + 变量 / 命令开头
	if (
		/^#!\s*\/bin\/(ba|z|k)?sh\b/.test(lines[0]) ||
		// 控制关键字后不跟括号:if (x) 是 JS/TS,if [ ... ]; then 才是 bash
		(/^\s*(if|then|elif|else|fi|for|while|do|done|case|esac)\b(?!\s*\()/.test(joined) && /\$[A-Za-z_{]/.test(joined)) ||
		// bash 的 export 形态是 export VAR=value;export const/function 是 JS/TS
		/^export\s+[A-Za-z_]\w*=/.test(lines[0]) ||
		/^\s*(sudo|apt|apt-get|npm|pnpm|pip|pip3|git|curl|wget|source|cd|ls|rm|cp|mv|mkdir|grep|sed|awk|echo|cat|chmod|brew)\s+/.test(lines[0])
	) {
		return "bash";
	}

	// Python:def/class:/import/from/__name__/print/self
	if (
		/^(def|async def)\s+\w+\s*\(/m.test(joined) ||
		/^class\s+\w+\s*:/m.test(joined) ||
		/^if __name__/m.test(joined) ||
		/^print\(/m.test(joined) ||
		/^import\s+\w+(\s*,\s*\w+)*\s*$/m.test(joined) ||
		/^from\s+\w+\s+import\b/m.test(joined) ||
		/^(for|while)\b.*:\s*$/m.test(joined) ||
		/\bself\./.test(joined)
	) {
		return "python";
	}

	// Go:package / func / :=
	if (/^package\s+\w+/.test(joined) || /^func\s+\w+/.test(joined) || /:=/.test(joined)) return "go";

	// Rust:fn / let mut / use ::
	if (/^fn\s+\w+/.test(joined) || /^let\s+mut\s+\w+/.test(joined) || /^use\s+\w+::/.test(joined)) return "rust";

	// C/C++:#include(std:: → cpp)
	if (/^#include\s*[<"]/.test(joined)) return /\bstd::/.test(joined) ? "cpp" : "c";
	if (/^int\s+main\s*\(/.test(joined)) return "c";

	// SQL:语句关键字成对出现
	if (
		/^\s*(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|WITH)\b/i.test(joined) &&
		/\b(FROM|WHERE|JOIN|VALUES|SET|GROUP BY|ORDER BY)\b/i.test(joined)
	) {
		return "sql";
	}

	// HTML
	if (/^<!doctype html>/i.test(joined) || /^<(html|body|head|div|script|style|table|ul|ol|li|a|p|span|h[1-6])\b/.test(joined)) {
		return "html";
	}

	// CSS:selector { prop: value };排除 return { a: b } 这类单行 JS 语句
	// (语料 eval 实测误判:return { details: viewModel }; → css)。
	if (
		!/^(return|const|let|var|function|if|for|while|switch|throw|import|export)\b/.test(joined) &&
		/^[.#]?[\w-]+\s*\{[^}]*:[^}]*\}/.test(joined)
	) {
		return "css";
	}

	// JS/TS(最后查:签名最通用)。TS 信号:类型标注/interface/type/enum/泛型
	if (
		/^(const|let|var)\s+\w+\s*=/.test(joined) ||
		/^function\s+\w+\s*\(/.test(joined) ||
		/^export\s+(default\s+)?(function|class|const|async)/.test(joined) ||
		/^import\s+.+from\s+['"]/.test(joined) ||
		/=>/.test(joined) ||
		/^\s*(if|for|while|switch)\s*\(/.test(joined) ||
		/^interface\s+\w+/.test(joined) ||
		/^type\s+\w+\s*=/.test(joined) ||
		/^enum\s+\w+/.test(joined) ||
		/^namespace\s+\w+/.test(joined)
	) {
		if (
			/\b(interface|type|enum|namespace)\s+\w+/.test(joined) ||
			/:\s*(string|number|boolean|any|unknown|void|Record<|Promise<)\b/.test(joined) ||
			/<[A-Z]\w+>/.test(joined)
		) {
			return "typescript";
		}
		return "javascript";
	}

	return undefined;
}

export interface FenceBlock {
	/** 开头围栏所在行号 */
	openLine: number;
	/** 闭合围栏所在行号;-1 = 未闭合(CommonMark:吞掉余下文档,必为最后一块) */
	closeLine: number;
	indent: string;
	fence: string;
	/** 信息串(已 trim);空串 = 无标签 */
	tag: string;
	content: string[];
}

/**
 * 解析顶层围栏块。闭合规则:同字符、长度 ≥ 开头、仅空白尾随。
 * 所有围栏(含已带标签)都跳过块体:块内行不得参与顶层解析,
 * 否则闭合围栏/嵌套示例围栏会被当作新开头围栏误改写(显示损坏)。
 * 围栏语义的唯一 owner——transformer 与语料 eval 共用,禁止另写解析副本。
 */
export function parseFences(markdown: string): FenceBlock[] {
	const lines = markdown.split("\n");
	const blocks: FenceBlock[] = [];
	for (let i = 0; i < lines.length; i++) {
		const open = FENCE_RE.exec(lines[i]);
		if (!open) continue;
		const content: string[] = [];
		let j = i + 1;
		for (; j < lines.length; j++) {
			const close = FENCE_RE.exec(lines[j]);
			if (close && close[2][0] === open[2][0] && close[2].length >= open[2].length && !close[3].trim()) break;
			content.push(lines[j]);
		}
		blocks.push({
			openLine: i,
			closeLine: j < lines.length ? j : -1,
			indent: open[1],
			fence: open[2],
			tag: open[3].trim(),
			content,
		});
		if (j >= lines.length) break; // 未闭合:余下都是块内容
		i = j;
	}
	return blocks;
}

/** 为无标签代码围栏补语言标签;已带标签/散文/未闭合围栏原样保留。 */
export function tagUntaggedFences(markdown: string): string {
	const lines = markdown.split("\n");
	for (const block of parseFences(markdown)) {
		if (block.closeLine === -1 || block.tag) continue;
		const lang = detectLanguage(block.content.join("\n"));
		if (lang) lines[block.openLine] = `${block.indent}${block.fence}${lang}`;
	}
	return lines.join("\n");
}
