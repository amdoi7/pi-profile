/**
 * Custom Footer Extension - Enhanced status bar
 *
 * Displays: ctx used, ctx %, cost, elapsed, cwd, git branch, model
 * Color-coded context usage: green <50%, yellow 50-75%, red >75%
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { createGitStatusCache, type GitStatusSnapshot } from "./custom-footer-git.ts";

function formatGitStatusSegment(
	theme: { fg(name: string, text: string): string },
	status: GitStatusSnapshot | null,
): string {
	if (status === null) {
		return "";
	}

	const marker = status.dirtyCount > 0 ? theme.fg("warning", "*") : "";
	const extras: string[] = [];
	if (status.ahead > 0) {
		extras.push(theme.fg("thinkingText", `↑${status.ahead}`));
	}
	if (status.behind > 0) {
		extras.push(theme.fg("thinkingText", `↓${status.behind}`));
	}
	if (status.dirtyCount > 0) {
		extras.push(theme.fg("thinkingText", `!${status.dirtyCount}`));
	}

	const suffix = extras.length > 0 ? ` ${extras.join(" ")}` : "";
	return `${theme.fg("text", `⎇ ${status.branch}`)}${marker}${suffix}`;
}

export default function (pi: ExtensionAPI) {
	let sessionStart = Date.now();
	const readGitStatus = createGitStatusCache();

	function formatElapsed(ms: number): string {
		const s = Math.floor(ms / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		const rs = s % 60;
		if (m < 60) return `${m}m${rs > 0 ? rs + "s" : ""}`;
		const h = Math.floor(m / 60);
		const rm = m % 60;
		return `${h}h${rm > 0 ? rm + "m" : ""}`;
	}

	function fmt(n: number): string {
		if (n < 1000) return `${n}`;
		if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
		const millions = n / 1_000_000;
		return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}M`;
	}

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "startup" || event.reason === "new") {
			sessionStart = Date.now();
		}

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			const timer = setInterval(() => tui.requestRender(), 30000);

			return {
				dispose() {
					unsub();
					clearInterval(timer);
				},
				invalidate() {},
				render(width: number): string[] {
					let cost = 0;
					for (const e of ctx.sessionManager.getEntries()) {
						if (e.type === "message" && e.message.role === "assistant") {
							const m = e.message as AssistantMessage;
							cost += m.usage.cost.total;
						}
					}

					const usage = ctx.getContextUsage();
					const used = usage?.tokens;
					const pct = usage?.percent;
					const hasMeasuredPercent = typeof pct === "number";
					const hasMeasuredUsed = typeof used === "number";
					const pctColor = !hasMeasuredPercent && !hasMeasuredUsed
						? "muted"
						: (hasMeasuredPercent && pct >= 85) || (hasMeasuredUsed && used >= 400_000)
							? "error"
							: "success";
					const usedDisplay = hasMeasuredUsed
						? `ctx ${fmt(used)}`
						: "ctx ?";
					const percentDisplay = hasMeasuredPercent
						? `${pct.toFixed(0)}%`
						: "?";

					const tokenStats = [
						theme.fg("text", usedDisplay),
						theme.fg(pctColor, percentDisplay),
						theme.fg("warning", `$${cost.toFixed(2)}`),
					].join(" ");

					const elapsed = theme.fg("thinkingText", `⏱ ${formatElapsed(Date.now() - sessionStart)}`);

					const cwd = ctx.sessionManager.getCwd();
					const parts = cwd.split("/");
					const short = parts.length > 2 ? parts.slice(-2).join("/") : cwd;
					const cwdStr = theme.fg("thinkingText", `⌂ ${short}`);

					const gitStatus = readGitStatus(cwd);
					const branchStr = formatGitStatusSegment(theme, gitStatus);

					const thinking = pi.getThinkingLevel();
					const thinkColor =
						thinking === "high"
							? "warning"
							: thinking === "medium"
								? "text"
								: "thinkingText";
					const modelId = ctx.model?.id || "no-model";
					const modelStr = theme.fg(thinkColor, "◆") + " " + theme.fg("text", modelId);

					const sep = theme.fg("thinkingText", " | ");
					let leftParts = [modelStr, tokenStats, elapsed, cwdStr];
					if (branchStr) leftParts.push(branchStr);

					if (width < 100) {
						leftParts = [modelStr, tokenStats, cwdStr];
					}
					if (width < 72) {
						leftParts = [tokenStats, cwdStr];
					}
					if (width < 52) {
						leftParts = [tokenStats];
					}

					const left = leftParts.join(sep);
					return [truncateToWidth(left, width)];
				},
			};
		});
	});

}
