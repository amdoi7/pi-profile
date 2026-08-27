/**
 * Evidence-backed hint rule table for runtime-hints.
 *
 * Entry discipline (all three required, see transcript-mining-optimization):
 * 1. every rule cites transcript mining counts as evidence;
 * 2. hints are one line, structured as `[hint:<name>] <cause> — <action>`;
 * 3. firing is once per session per rule (enforced by the wiring in index.ts).
 *
 * match() returns the hint text or undefined. Rules only inspect the normalized
 * event; they never mutate anything.
 */

export type HintEvent = {
	toolName: string;
	isError: boolean;
	command?: string;
	text: string;
};

export type HintRule = {
	name: string;
	evidence: string;
	match(event: HintEvent): string | undefined;
};

/** Strip leading env assignments and `cd <dir> &&` prefixes to reach the effective command. */
function effectiveCommand(command: string): string {
	let s = command.trimStart();
	for (;;) {
		const env = /^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/.exec(s);
		if (env) {
			s = s.slice(env[0].length);
			continue;
		}
		const cd = /^cd\s+\S+\s*&&\s*/.exec(s);
		if (cd) {
			s = s.slice(cd[0].length);
			continue;
		}
		return s;
	}
}

const SEARCH_VERB = /^(rg|grep)\s/;
const SHELL_OPERATORS = /&&|\|\||[;|]/;
const EMPTY_EXIT_ONE = /^Command exited with code 1\s*$/;

function isBareNoMatchSearch(event: HintEvent): boolean {
	if (event.toolName !== "bash" || !event.isError || event.command === undefined) return false;
	const command = effectiveCommand(event.command);
	if (!SEARCH_VERB.test(command) || SHELL_OPERATORS.test(command)) return false;
	return EMPTY_EXIT_ONE.test(event.text.trim());
}

const APPLY_PATCH_VERB = /^apply_patch(\s|$)/;

function applyPatchFailureCode(event: HintEvent): string | undefined {
	if (event.toolName !== "bash" || !event.isError || event.command === undefined) return undefined;
	if (!APPLY_PATCH_VERB.test(effectiveCommand(event.command))) return undefined;
	return /"code":"(INVALID_PATCH|PARTIAL_APPLY)"/.exec(event.text)?.[1];
}

// File-mutation shapes routed through bash instead of the auditable edit
// contract. `cat <<EOF` without a redirect (git commit -m "$(cat ...)") is
// not a mutation; perl -pi is a sanctioned path and intentionally absent.
// python/node 行内脚本的原地改写也不在这里：它已由 command-policy 拦下，
// 拒绝消息里就带了替代方案，提示再说一遍只是噪声。
const BASH_MUTATION =
	/(?:^|&&|\|\||[;|])\s*(?:cat\s+(?:>>?\s*\S+\s*<<|<<\s*\S+\s*>+\s*\S)|tee\s+-?[a-z]*\s*\S+\s*<<|sed\s+-[^\s|;&]*i)/;

/** 临时区:草稿脚本没有 reviewer,可审计 diff 的契约对它不成立。 */
const SCRATCH_PATH = /^(?:\/tmp\/|\/private\/tmp\/|\/var\/folders\/|\$TMPDIR\b|\$\{TMPDIR\})/;
const SED_IN_PLACE = /\bsed\s+-[^\s|;&]*i/;

/**
 * 改写目标：重定向/tee 的那个文件；sed -i 取子句末尾的文件参数。
 * 只看命令首行——heredoc 正文里的路径是数据,不是目标。
 * 认不出目标就返回空:宁可多提示一次,不可漏掉真的源文件改写。
 */
function mutationTargets(command: string): string[] {
	const newline = command.indexOf("\n");
	const head = newline === -1 ? command : command.slice(0, newline);
	const tokens = head.split(/\s+/).filter((token) => token !== "");
	const targets: string[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (token === ">" || token === ">>" || token === "tee") {
			const next = tokens[index + 1];
			if (next !== undefined && !next.startsWith("-") && !next.startsWith("<")) targets.push(next);
			continue;
		}
		if (token.startsWith(">")) {
			const inlineTarget = token.replace(/^>+/, "");
			if (inlineTarget !== "") targets.push(inlineTarget);
		}
	}
	if (SED_IN_PLACE.test(head) && tokens.length > 0) targets.push(tokens[tokens.length - 1]!);
	return targets;
}

function mutatesOnlyScratch(command: string): boolean {
	const targets = mutationTargets(command);
	return targets.length > 0 && targets.every((target) => SCRATCH_PATH.test(target));
}

export const rules: HintRule[] = [
	{
		name: "rg-grep-exit-1",
		evidence: "fail-mining 2026-08-13: 155 例 bash 搜索无命中 exit≠0 污染错误信号面",
		match(event) {
			if (!isBareNoMatchSearch(event)) return undefined;
			return "[hint:rg-grep-exit-1] exit 1 with empty output = no matches, not a command failure — continue with an adjusted pattern or path instead of diagnosing an error.";
		},
	},
	{
		name: "apply-patch-invalid",
		evidence: "fail-mining 2026-08-13: 36+ 例 apply_patch INVALID_PATCH(模型自产 patch 不合法)",
		match(event) {
			if (applyPatchFailureCode(event) !== "INVALID_PATCH") return undefined;
			return "[hint:apply-patch-invalid] INVALID_PATCH = malformed envelope — re-author per ~/.pi/agent/cli/apply-patch/patch-authoring.md: Begin/End Patch wrapper, one operation header per file, every line prefixed +/-/space.";
		},
	},
	{
		name: "apply-patch-partial",
		evidence: "fail-mining 2026-08-13: 32+ 例 apply_patch PARTIAL_APPLY(context 不匹配)",
		match(event) {
			if (applyPatchFailureCode(event) !== "PARTIAL_APPLY") return undefined;
			return "[hint:apply-patch-partial] PARTIAL_APPLY = stale or misquoted context — re-read the target file, copy context lines verbatim, and resubmit only the failed hunks.";
		},
	},
	{
		name: "bash-file-mutation",
		evidence:
			"chain-mining 2026-08-13: 626 例 cat>heredoc 写文件 + 123 例 sed -i；" +
			"2026-08-21..26 重测：cat>/tee 整文件写 341 例、追加 65 例、sed -i 23 例；" +
			"2026-08-27 全量：229 个触发 session 中 88 个(38%)的首次命中是 /tmp 草稿脚本," +
			"once-per-session 的额度被误报吃掉 → 临时区目标不再触发",
		match(event) {
			if (event.toolName !== "bash" || event.command === undefined) return undefined;
			if (!BASH_MUTATION.test(event.command)) return undefined;
			if (mutatesOnlyScratch(event.command)) return undefined;
			return "[hint:bash-file-mutation] file mutation via bash (cat>/sed -i/python heredoc) bypasses the auditable edit contract — use edit, apply_patch, or perl so the change stays reviewable as a diff (AGENTS.md Mechanics).";
		},
	},
];
