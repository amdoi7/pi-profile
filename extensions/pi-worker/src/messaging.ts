import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

/** 父 watcher 经 tool_execution 事件流原生识别此工具名(无信封、无 marker)。 */
export const SEND_MESSAGE_TOOL = "send_message";

/** 参数契约:to 缺省 parent;quiet=安静送达(不唤醒父轮次);唯一语义——异步消息(fire-and-forget,不等答复)。 */
export const sendMessageParams = Type.Object({
	to: Type.Optional(Type.String({ description: "目标:parent(默认)或其他 worker 的 name" })),
	quiet: Type.Optional(Type.Boolean({ description: "true=安静送达:父 session 只留痕不触发新轮(仅 to=parent 生效);缺省 false 唤醒" })),
	text: Type.String({ minLength: 1, description: "消息文本(具体、可行动)" }),
});

type SendParams = Static<typeof sendMessageParams>;

/**
 * 子进程专用(PI_WORKER_CHILD=1):向 parent 或其他 worker 发异步消息。
 * 传输:工具调用本身即信号——父 watcher 在子进程事件流上观察 tool_execution
 * (args 原生结构化),无需任何带外信封;RoomBus 统一路由,execute 只回执。
 */
export function registerWorkerMessagingTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: SEND_MESSAGE_TOOL,
		label: "Send Message",
		description:
			"发送异步消息(fire-and-forget,发出后继续当前工作,不等待答复)。to 缺省 parent;" +
			"发给其他 worker 用其 name。答复(若有)会以新消息或新轮次到达。",
		parameters: sendMessageParams,
		async execute(_toolCallId, p: SendParams) {
			const to = p.to ?? "parent";
			return {
				content: [{ type: "text", text: `消息已发送给「${to}」:「${p.text}」。` }],
				details: { to, text: p.text, quiet: p.quiet ?? false },
			};
		},
	});
}
