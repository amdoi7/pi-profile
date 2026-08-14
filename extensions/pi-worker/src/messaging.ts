import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

/** 父 watcher 经 tool_execution 事件流原生识别此工具名(无信封、无 marker)。 */
export const SEND_MESSAGE_TOOL = "send_message";

/** 参数契约:to 缺省 parent;quiet=安静送达(不唤醒父轮次);唯一语义——异步消息(fire-and-forget,不等答复)。 */
export const sendMessageParams = Type.Object({
	to: Type.Optional(Type.String({ description: "target worker: name or full id; omit = parent" })),
	quiet: Type.Optional(Type.Boolean({ description: "true = quiet delivery (recorded in parent session, no turn triggered; only for to=parent); default false = wake parent" })),
	text: Type.String({ minLength: 1, description: "message text (specific, actionable)" }),
});

type SendParams = Static<typeof sendMessageParams>;

/** 工具描述(L2 机制权威):反问是常态——问父比独自死磕便宜;回合语义区分报告(继续推进)与阻塞提问(结束本轮等答复)。 */
export const SEND_MESSAGE_DESCRIPTION =
	"Send an async message to parent or a peer worker. Asking is expected, not exceptional: brief ambiguity, contradiction with repo evidence, and scope/trade-off decisions go to the parent immediately — do not deliberate alone. " +
	"Fire-and-forget: after a report keep working; after a blocking question end your turn (the reply arrives as a new turn). Routine progress belongs in your reply text.";

/**
 * 子进程专用(PI_WORKER_CHILD=1):向 parent 或其他 worker 发异步消息。
 * 传输:工具调用本身即信号——父 watcher 在子进程事件流上观察 tool_execution
 * (args 原生结构化),无需任何带外信封;RoomBus 统一路由,execute 只 ack。
 */
export function registerWorkerMessagingTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: SEND_MESSAGE_TOOL,
		label: "Send Message",
		description: SEND_MESSAGE_DESCRIPTION,
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
