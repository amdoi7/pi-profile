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
const BASH_MUTATION =
	/(?:^|&&|\|\||[;|])\s*(?:cat\s+(?:>>?\s*\S+\s*<<|<<\s*\S+\s*>+\s*\S)|sed\s+-[^\s|;&]*i|python3?\s+(?:-\s+)?<<)/;

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
		evidence: "chain-mining 2026-08-13: 626 例 cat>heredoc 写文件 + 123 例 sed -i",
		match(event) {
			if (event.toolName !== "bash" || event.command === undefined) return undefined;
			if (!BASH_MUTATION.test(event.command)) return undefined;
			return "[hint:bash-file-mutation] file mutation via bash (cat>/sed -i/python heredoc) bypasses the auditable edit contract — use edit, apply_patch, or perl so the change stays reviewable as a diff (AGENTS.md Mechanics).";
		},
	},
];
