import {
	getMarkdownTheme,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { registerWorkerMessagingTool } from "./src/messaging.ts";
import { registerLifecycleRenderer } from "./src/lifecycle-block.ts";
import { WorkerManager } from "./src/manager.ts";
import { registerWorkerPaneCommand } from "./src/pane.ts";
import { formatCallbackView, formatFooter, formatLeftoverHint, toastFor } from "./src/present.ts";
import { registerPiWorkerTool } from "./src/tool.ts";
import type { WorkerRecord } from "./src/types.ts";

interface UiLike {
	setStatus: (key: string, text: string | undefined) => void;
	notify: (message: string, type?: "info" | "warning" | "error") => void;
}

interface ThemeLike {
	fg: (color: "accent" | "warning" | "error" | "dim", text: string) => string;
}

export default function (pi: ExtensionAPI): void {
	if (process.env.PI_WORKER_CHILD === "1") {
		// 子进程:只注册 send_message 通信工具,不注册 dispatch 工具(防递归分发)。
		// 父自身可能是 tui 或 rpc,只能靠环境标记区分。
		registerWorkerMessagingTool(pi);
		return;
	}

	// ui 在 session_start 捕获(setStatus/notify 是 fire-and-forget,不需要事件点 ctx);
	// 状态变化由 manager 的 onChange 钩子推出,不嗅探消息流。
	let ui: UiLike | undefined;
	let theme: ThemeLike | undefined;
	// elapsed/活动心跳需要秒级重绘:有工作态 worker 时开 1s tick,全静即停。
	let liveTick: ReturnType<typeof setInterval> | undefined;

	const refreshFooter = (): void => {
		if (!ui) return;
		const records = manager.status() as WorkerRecord[];
		ui.setStatus(
			"pi-worker",
			formatFooter(records, { now: Date.now(), fg: (c, t) => (theme ? theme.fg(c, t) : t) }),
		);
		const anyWorking = records.some(
			(r) => r.state === "starting" || r.state === "running" || r.state === "stopping",
		);
		if (anyWorking && !liveTick) {
			liveTick = setInterval(refreshFooter, 1000);
		} else if (!anyWorking && liveTick) {
			clearInterval(liveTick);
			liveTick = undefined;
		}
	};

	const manager = new WorkerManager({
		deliver: (msg, opts) => {
			// quiet = peer 流量审计等安静留痕(不烧父轮次);缺省唤醒(回调/parent-bound 消息)
			if (opts?.quiet) {
				pi.sendMessage({ ...msg, display: true });
			} else {
				pi.sendMessage({ ...msg, display: true }, { deliverAs: "followUp", triggerTurn: true });
			}
			const toast = toastFor(msg);
			if (toast && ui) ui.notify(toast.text, toast.level);
			refreshFooter();
		},
		onChange: () => refreshFooter(),
	});
	registerPiWorkerTool(pi, manager);
	registerWorkerPaneCommand(pi, manager);
	// transcript 生命周期 block(grok scrollback block 对等物):entry renderer 注册,
	// append 在 tool.ts run 成功路径
	registerLifecycleRenderer(pi, manager);

	// 回调 renderer:呈报即验收界面。settled 报告全文(核验证据段)不折叠;
	// failed 诊断 + stderr 尾;action 审计(路由/机械动作)dim。
	pi.registerMessageRenderer("pi-worker", (message, { outputPad }, theme) => {
		const view = formatCallbackView(message as never);
		const headColor = view.kind === "failed" ? "error" : view.kind === "recovery" ? "warning" : view.kind === "action" ? "dim" : "accent";
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(theme.fg(headColor, theme.bold(view.header)), 0, 0));
		// ⎿ 续行摘要:紧随 header(Claude 保真:回执先于详情,长报告不埋卡底)
		if (view.summary) box.addChild(new Text(theme.fg("dim", `  ${view.summary}`), 0, 0));
		if (view.body) {
			if (view.bodyIsMarkdown) {
				box.addChild(new Markdown(view.body, 0, 0, getMarkdownTheme()));
			} else {
				box.addChild(new Text(theme.fg(view.kind === "failed" ? "error" : view.kind === "action" ? "dim" : "warning", view.body), 0, 0));
			}
		}
		return box;
	});

	pi.on("session_start", async (_event, ctx) => {
		ui = ctx.ui;
		theme = ctx.ui.theme as unknown as ThemeLike;
		// 启动只检测遗留并提示(显示但不自动认领);认领是显式动作 pi_worker action=recover
		const scan = await manager.scanLeftovers(ctx.cwd);
		const branchText = JSON.stringify(ctx.sessionManager.getBranch());
		const hint = formatLeftoverHint(scan, branchText);
		if (hint) {
			pi.sendMessage({
				customType: "pi-worker",
				content: hint,
				display: true,
				details: { type: "recovery", id: "recovery" },
			});
		}
		refreshFooter();
	});
	pi.on("session_shutdown", () => {
		ui = undefined;
		theme = undefined;
		if (liveTick) {
			clearInterval(liveTick);
			liveTick = undefined;
		}
		manager.killAll();
	});
}
