/**
 * Custom Footer Extension - Enhanced status bar
 *
 * Displays: ctx used, ctx %, cost, cwd, git branch, provider/model
 * Color semantics: meters fire signal colors only past healthy thresholds
 * (ctx: green <70 / amber 70-84 / red >=85; quota bars: green <50 / neutral
 * 50-69 / amber 70-89 / red >=90). The thinking level label echoes the
 * editor border's thinking* tokens; extension statuses use customMessageLabel.
 * Cost is hidden for subscription providers (claude/codex/kimi) where it is
 * always $0.00.
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
	formatSessionRow,
	formatUsageLine,
	layoutFooter,
} from "./custom-footer-format.ts";
import { computeCacheWaste } from "./custom-footer-cache.ts";
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
						providerOnly: formatModel(theme, providerName, undefined, thinking),
						cwd: formatCwd(theme, cwd, homedir()),
						branch: formatGitSegment(theme, readGitStatus(cwd)),
					};
					const usageProvider = detectUsageProvider(model?.provider, model?.id);
					const entries = ctx.sessionManager.getEntries();
					const cacheWaste = computeCacheWaste(entries, {
						find: (provider, modelId) => ctx.modelRegistry.find(provider, modelId),
					});
					const sessionRow = formatSessionRow(theme, {
						used: usage?.tokens,
						pct: usage?.percent,
						cost: usageProvider === null ? computeSessionCost(entries) : null,
						tps: readTps.getLast(cwd),
						flow: computeTokenFlow(entries),
						// 与成本同一规则：订阅制提供商隐藏金额，只留 token 数
						waste: cacheWaste.missCount > 0 ? cacheWaste : null,
						showMissCost: usageProvider === null,
					});

					const fetcher = ensureUsageFetcher(usageProvider);
					void fetcher?.refresh().then((updated) => {
						if (updated) tui.requestRender();
					});
					const snapshot = fetcher?.getSnapshot() ?? null;
					const usageLine = snapshot ? formatUsageLine(theme, snapshot, Date.now()) : null;

					const lines = layoutFooter(
						width,
						segments,
						sessionRow,
						usageLine,
						theme.fg("muted", " │ "),
					).map((line) => truncateToWidth(line, width));

					for (const line of extensionStatusLines(footerData.getExtensionStatuses())) {
						lines.push(truncateToWidth(theme.fg("customMessageLabel", line), width));
					}
					return lines;
				},
			};
		});
	});
}
