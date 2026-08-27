/**
 * 拦截「inline 脚本读回文件 → 字面/正则替换 → 写回同一文件」这一种形状。
 *
 * 依据(语料 2026-08-21..26):这个形状出现 562 次,全部是 edit 能表达的改动,
 * 但落盘时没有 diff、没有 mutation lock、没有跨文件回滚。选择拦而不是提示,
 * 是因为一次性提示打不过会话内自我 priming:48 个已触发提示的会话此后仍产生
 * 934 次同形状调用。
 *
 * 拦的是形状不是 bash 写文件:遍历目录/glob 的机械改写(edit 无法表达)、
 * /tmp 草稿、纯分析脚本、`cat > file` 都放行。
 */

/** 行内脚本入口:python/node 的 heredoc、-c、-e。 */
const INLINE_SCRIPT = /(?:python(?:3(?:\.\d+)?)?|node|[\w./-]*\/bin\/python(?:3)?)\s+(?:-\s*)?(?:<<|-c\b|-e\b)/;
const READS_A_FILE = /\.read\s*\(\s*\)|read_text\s*\(|readFileSync\s*\(/;
const WRITES_A_FILE = /write_text\s*\(|\.write\s*\(|open\s*\([^)]*['"][wa]\+?['"]|writeFileSync\s*\(/;
const REPLACES_TEXT = /\.replace\s*\(|\.replaceAll\s*\(|re\.sub\s*\(/;
/** 遍历目录 = edit 无法枚举的机械改写,放行。 */
const ITERATES_A_TREE = /glob\s*\(|rglob\s*\(|iterdir\s*\(|listdir\s*\(|os\.walk\s*\(|readdirSync\s*\(/;

const PATH_LITERAL = /["']([^"']*\.(?:ts|tsx|mjs|cjs|js|jsx|py|md|json|jsonc|go|rs|toml|yaml|yml|sh|txt))["']/g;

/** 只碰 /tmp 的草稿脚本不在契约范围内。 */
function touchesOnlyScratch(command: string): boolean {
	const paths = [...command.matchAll(PATH_LITERAL)].map((match) => match[1]!);
	return paths.length > 0 && paths.every((filePath) => filePath.startsWith("/tmp/"));
}

const BLOCK_MESSAGE = [
	"Error: rewriting a file in place from an inline python/node script is disabled.",
	"That change lands with no diff, no mutation lock, and no rollback.",
	"",
	"  anchored replacement   edit        one intent = one atomic batch over files[], multi-hunk included",
	"  whole-file rewrite     write",
	"  mechanical sweep       perl -pi -e '...'",
	"",
	"Still allowed: scripts that walk a glob/directory, /tmp scratch files, and read-only analysis.",
	"",
].join("\n");

/** 返回拦截消息;不匹配这一形状时返回 null。 */
export function getFileMutationBlock(command: string): string | null {
	if (!INLINE_SCRIPT.test(command)) return null;
	if (!READS_A_FILE.test(command) || !WRITES_A_FILE.test(command) || !REPLACES_TEXT.test(command)) return null;
	if (ITERATES_A_TREE.test(command)) return null;
	if (touchesOnlyScratch(command)) return null;
	return BLOCK_MESSAGE;
}
