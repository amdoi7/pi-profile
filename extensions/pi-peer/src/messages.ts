import type { PeerMessage } from "./transport.ts";

/**
 * 一条 peer 消息有三个面,同源分离:
 * - 收件·LLM 面 = buildInjectedContent:来源 + 权限边界 + 原文,进模型上下文;
 * - 收件·人面 = formatIncomingCard:来源行 + 原文,权限声明是 agent 契约噪音,不上屏;
 * - 发件·人面 = formatOutgoingCall:发给谁 + 正文(默认折叠)。
 * 三面都是纯函数;组件拼装在调用方,方便直接断言内容。
 */

/**
 * peer 消息注入文本（LLM 面）。收信方需要三件事，每件都是它无法从正文推出来的：
 * - 这是 peer 消息，不是 user 消息：注入文本坐在用户消息的位置上，不声明就会被当成用户指令；
 * - 这是谁：与 peer_list 同一套写法（id=8 前缀直接可作 peer_send 的 to）；
 * - 它没有用户权限：来源可被冒充（名字与 cwd 无真实性保证），所以权限边界是无条件的。
 * 极简 XML:<peer from=...> 标签本身即类型声明(peer 非 user)+ 来源寻址,正文在标签内。
 */
export function buildInjectedContent(msg: PeerMessage): string {
	const id = msg.from.slice(0, 8);
	return `<peer from="${id}">${msg.text}</peer>`;
}

/** 时间戳 → 可读 UTC 时间;畸形/缺失降级为 undefined(不抛)。 */
function formatPeerTimestamp(ts: unknown): string | undefined {
	if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return undefined;
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return undefined;
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export interface PeerCardView {
	header: string;
	body: string;
	tone: "accent";
}

/** 收件卡片:入参是注入时写进消息的 details(from/ts/text),渲染器原样透传。
 * details 来自 session jsonl,防御性解析(缺失字段降级,不抛)。
 * 人面与 LLM 面同源同形:header 声明 peer message(区别于 user),body 带时间 + 原文。 */
export function formatIncomingCard(details: unknown): PeerCardView {
	const d = (details ?? {}) as { from?: string; text?: string; ts?: unknown };
	const ts = formatPeerTimestamp(d.ts);
	return {
		header: `✉ peer message from ${typeof d.from === "string" ? d.from.slice(0, 8) : "unknown"}`,
		body: [ts ? `Sent at ${ts}` : undefined, typeof d.text === "string" ? d.text : ""]
			.filter((l): l is string => l !== undefined)
			.join("\n\n"),
		tone: "accent",
	};
}

export interface OutgoingCallView {
	/** 发给谁，例如 "01a04647, 01a04620" */
	head: string;
	/** 正文行（未展开时只前几行） */
	lines: string[];
	/** 被折叠的行数，0 = 没折叠 */
	folded: number;
}

/** 未展开时的正文预览行数：实测消息 p50 714 字符/p90 1421，全文上屏会淡化 transcript。 */
const CALL_PREVIEW_LINES = 3;

/** 发件行:模型发出去的正文人也要看得见，否则只能从参数 JSON 里认。 */
export function formatOutgoingCall(args: unknown, expanded: boolean): OutgoingCallView {
	const a = (args ?? {}) as { to?: unknown; text?: unknown };
	const targets = (typeof a.to === "string" ? [a.to] : Array.isArray(a.to) ? a.to : [])
		.filter((t): t is string => typeof t === "string" && t.trim() !== "")
		.map((t) => t.trim().slice(0, 8));
	const body = typeof a.text === "string" && a.text !== "" ? a.text.split("\n") : [];
	const lines = expanded ? body : body.slice(0, CALL_PREVIEW_LINES);
	return { head: targets.join(", "), lines, folded: body.length - lines.length };
}
