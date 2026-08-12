import type { Readable } from "node:stream";
import { SEND_MESSAGE_TOOL } from "./messaging.ts";
import type { RpcLike } from "./rpc-client.ts";

const STDERR_TAIL_MAX = 4096;

/**
 * 子进程事件流的领域翻译:watcher 唯一的产出。零政策——状态机迁移、
 * 呈报获取、投递、路由全在 manager.onWorkerEvent(单一反应者)。
 */
export type WorkerEvent =
	/** send_message 成功执行(start/end 关联,isError=false);to 缺省 parent;quiet=安静送达 */
	| { type: "message"; to: string; text: string; quiet: boolean }
	| { type: "settled" }
	| { type: "exited"; code: number | null; signal: string | null; stderrTail: string }
	| { type: "turnEnd" }
	/** 显示态:tool 活动(args 已截断 60 字符) */
	| { type: "toolStart"; toolName: string; args: string }
	| { type: "toolEnd"; toolName: string }
	/** 子 extension dialog:需回 cancelled 防子进程挂起 */
	| { type: "dialog"; id: unknown };

export interface WorkerStreams {
	/** RPC 事件源("event"/"exit" 订阅) */
	events: RpcLike;
	stderr: Readable;
}

/**
 * 工具参数摘要(纯翻译:字节流→可读事件,不涉业务政策):
 * 取 command/path/file/text 等常见键的值(40 字符),无键回退 JSON 壳(40 字符)。
 * 不产生破碎 JSON——下游 recent/activity/status 直接可读。
 */
const ARG_SUMMARY_MAX = 40;
const ARG_KEYS = ["command", "path", "file", "toolName", "text"] as const;
function summarizeToolArgs(raw: unknown): string {
	if (raw && typeof raw === "object") {
		const args = raw as Record<string, unknown>;
		for (const key of ARG_KEYS) {
			const v = args[key];
			if (typeof v === "string" && v) return v.slice(0, ARG_SUMMARY_MAX);
		}
	}
	return JSON.stringify(raw ?? {}).slice(0, ARG_SUMMARY_MAX);
}

/**
 * 反轮询本体的消费端:挂在子进程 stdout/stderr 的 data 事件上阻塞等待,
 * 字节流 → WorkerEvent,无定时器,无 get_state 轮询,不触碰任何记录。
 */
export function attachWatcher(
	streams: WorkerStreams,
	emit: (ev: WorkerEvent) => void,
): { dispose: () => void } {
	const { events, stderr } = streams;
	let stderrTail = "";
	// send_message 调用暂存:start 带 args,end(isError=false)才译为 message——
	// 工具未成功执行不产生消息(失败即未发送)。quiet 随 args 透传。
	const pendingMessages = new Map<string, { to: string; text: string; quiet: boolean }>();

	const onEvent = (ev: Record<string, unknown>): void => {
		if (ev.type === "extension_ui_request") {
			const method = String(ev.method ?? "");
			if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
				emit({ type: "dialog", id: ev.id });
			}
			return;
		}
		if (ev.type === "agent_settled") {
			emit({ type: "settled" });
			return;
		}
		if (ev.type === "message_update" || ev.type === "message_end") {
			// 消息事件不产生领域事件:增量(text_delta)粒度太细,终稿(message_end)
			// 的唯一消费者(turn 话语预览)已移除;呈报走 get_last_assistant_text RPC。
			return;
		}
		if (ev.type === "tool_execution_start") {
			const toolName = String(ev.toolName ?? "");
			// 参数摘要(显示数据):提取常见可读键,避免破碎 JSON 污染 recent/activity
			const args = summarizeToolArgs(ev.args);
			if (toolName === SEND_MESSAGE_TOOL && typeof ev.toolCallId === "string") {
				const a = ev.args as { to?: unknown; text?: unknown; quiet?: unknown } | undefined;
				if (a && typeof a.text === "string") {
					pendingMessages.set(ev.toolCallId, {
						to: typeof a.to === "string" ? a.to : "parent",
						text: a.text,
						quiet: a.quiet === true,
					});
				}
			}
			emit({ type: "toolStart", toolName, args });
			return;
		}
		if (ev.type === "tool_execution_end") {
			const toolName = String(ev.toolName ?? "");
			if (typeof ev.toolCallId === "string") {
				const pending = pendingMessages.get(ev.toolCallId);
				if (pending) {
					pendingMessages.delete(ev.toolCallId);
					if (!ev.isError) emit({ type: "message", to: pending.to, text: pending.text, quiet: pending.quiet });
				}
			}
			emit({ type: "toolEnd", toolName });
			return;
		}
		if (ev.type === "turn_end") {
			emit({ type: "turnEnd" });
		}
	};

	const onExit = (code: number | null, signal: string | null): void => {
		emit({ type: "exited", code, signal, stderrTail });
	};

	const onStderr = (chunk: Buffer | string): void => {
		stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_MAX);
	};

	const offEvent = events.on("event", onEvent);
	const offExit = events.on("exit", onExit);
	stderr.on("data", onStderr);

	return {
		dispose() {
			offEvent();
			offExit();
			stderr.off("data", onStderr);
		},
	};
}
