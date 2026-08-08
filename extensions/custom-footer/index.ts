/**
 * Custom Footer Extension - Enhanced status bar
 *
 * Displays: ctx used, ctx %, cost, cwd, git branch, provider/model
 * Color-coded context usage: green <50%, yellow 50-75%, red >75%
 *
 * Ownership: lifecycle + data access live here; presentation (formatting,
 * layout) lives in custom-footer-format.ts and is unit-tested there.
 */

import { homedir } from "node:os";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { createGitStatusCache } from "./custom-footer-git.ts";
import { createTpsTracker } from "./custom-footer-tps.ts";
import {
	computeSessionCost,
	computeTokenFlow,
	extensionStatusLines,
	formatCwd,
	formatGitSegment,
	formatModel,
	formatProviderOnly,
	formatTokenStats,
	formatUsageLine,
	layoutFooter,
} from "./custom-footer-format.ts";
import {
	createUsageFetcher,
	detectUsageProvider,
	type ProviderUsageFetcher,
	type UsageProviderName,
} from "./custom-footer-usage.ts";

export default function (pi: ExtensionAPI) {
	let sessionStart = Date.now();
	let footerTui: TUI | null = null;
	const readGitStatus = createGitStatusCache();
	const readTps = createTpsTracker();

	pi.on("thinking_level_select", () => footerTui?.requestRender());

	pi.on("message_start", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		readTps.onMessageStart(ctx.sessionManager.getCwd());
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const m = event.message as AssistantMessage;
		readTps.onMessageEnd(ctx.sessionManager.getCwd(), m.usage?.output ?? 0);
		footerTui?.requestRender();
	});

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "startup" || event.reason === "new") {
			sessionStart = Date.now();
		}

		ctx.ui.setFooter((tui, theme, footerData) => {
			footerTui = tui;
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			const timer = setInterval(() => tui.requestRender(), 30000);
			let usageProvider: UsageProviderName = null;
			let usageFetcher: ProviderUsageFetcher | null = null;
			// The usage line follows the current model's provider: only subscription
			// providers (claude/codex/kimi) show it; pay-as-you-go providers (e.g.
			// deepseek) hide it even when other accounts have credentials.
			const ensureUsageFetcher = (provider: UsageProviderName): ProviderUsageFetcher | null => {
				if (provider !== usageProvider) {
					usageProvider = provider;
					usageFetcher = createUsageFetcher(provider);
				}
				return usageFetcher;
			};

			return {
				dispose() {
					footerTui = null;
					unsub();
					clearInterval(timer);
				},
				invalidate() {},
				render(width: number): string[] {
					const cwd = ctx.sessionManager.getCwd();
					const usage = ctx.getContextUsage();
					const model = ctx.model;
					const providerName = model
						? ctx.modelRegistry?.getProviderDisplayName(model.provider) ?? model.id
						: "no-model";
					const thinking = pi.getThinkingLevel();
					const segments = {
						model: formatModel(theme, providerName, model?.id, thinking),
						providerOnly: formatProviderOnly(theme, providerName, thinking),
						cwd: formatCwd(theme, cwd, homedir()),
						branch: formatGitSegment(theme, readGitStatus(cwd)),
					};
					const entries = ctx.sessionManager.getEntries();
					const tokenStats = formatTokenStats(theme, {
						used: usage?.tokens,
						pct: usage?.percent,
						cost: computeSessionCost(entries),
						tps: readTps.getLast(cwd),
						flow: computeTokenFlow(entries),
					});

					const fetcher = ensureUsageFetcher(detectUsageProvider(model?.provider, model?.id));
					void fetcher?.refresh().then((updated) => {
						if (updated) tui.requestRender();
					});
					const snapshot = fetcher?.getSnapshot() ?? null;
					const usageLine = snapshot ? formatUsageLine(theme, snapshot, Date.now()) : null;

					const lines = layoutFooter(
						width,
						segments,
						tokenStats,
						usageLine,
						theme.fg("muted", " │ "),
					).map((line) => truncateToWidth(line, width));

					for (const line of extensionStatusLines(footerData.getExtensionStatuses())) {
						lines.push(truncateToWidth(theme.fg("accent", line), width));
					}
					return lines;
				},
			};
		});
	});
}
