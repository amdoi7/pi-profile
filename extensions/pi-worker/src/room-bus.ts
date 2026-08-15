import { CALLBACK_TYPE, type CallbackMessage } from "./bridge.ts";
import { WindowQuota } from "../../_shared/window-quota.ts";

/**
 * RoomBus:room(parent + live workers 协作空间)的 message plane,单一管道。
 * 不变式:一种语义——异步 fire-and-forget(无阻塞/gateway 变体);
 * 地址 = name / id / "parent";传输由目标类型与 delivery primitive 决定,发送方不关心。
 * 成员目录不在此维护(派生自 manager registry 活记录);本模块只拥有消息语义:
 * resolve、deliver、audit fan-out、failure receipt。生命周期事件(settled/failed)不是消息,不走本管道。
 */

export interface RoomBusDeps {
	/** parent session 出口:quiet=true → 安静 display;false/缺省 → 唤醒(triggerTurn)。 */
	deliver: (msg: CallbackMessage, opts?: { quiet?: boolean }) => void;
	/** name/id → live worker id;未命中(不存在或歧义)undefined。 */
	resolve: (to: string) => string | undefined;
	/** worker delivery primitive:FSM 按状态选 steer(running)/ prompt(idle);非法状态抛错。 */
	transport: (id: string, text: string) => Promise<"steer" | "prompt">;
	/** id → 显示名(审计文本用)。 */
	displayNameOf: (id: string) => string;
}

export type PostResult =
	| { ok: true; via: "steer" | "prompt" | "display" }
	| { ok: false; reason: string };

const PARENT = "parent";

/** 唤醒配额:worker→parent 非 quiet 消息每窗上限。唤醒 = 烧父轮次(LLM 成本+注意),
 * 无上限时失控 worker 可无限烧父;超限安静降级(消息仍留痕)并回执发送方自我修正。
 * quiet 消息不占配额(本来就不烧轮次)。 */
const WAKE_QUOTA_MAX = 6;
const WAKE_QUOTA_WINDOW_MS = 120_000;
/** 同文重复抑制窗:相同文本短窗内重发 = loop 信号,整体丢弃 + 回执(对齐 Claude
 * cross-session 的 identical-repeat 丢弃;降级不够,loop 会无限刷安静留痕)。 */
const REPEAT_WINDOW_MS = 60_000;

export class RoomBus {
	/** 唤醒配额内核:与 pi-peer 发送配额同构(_shared/window-quota);key = sender。
	 * 判定语义:repeat/quota 拒绝均不计数(丢弃/降级不算一次成功唤醒)。 */
	private readonly wakeQuota = new WindowQuota({
		max: WAKE_QUOTA_MAX,
		windowMs: WAKE_QUOTA_WINDOW_MS,
		repeatWindowMs: REPEAT_WINDOW_MS,
	});

	constructor(private readonly deps: RoomBusDeps) {}

	/** 唯一入口:任何节点 → 任何节点的异步消息。quiet 仅 parent 目标生效(安静留痕,不烧父轮次)。 */
	async post(from: string, to: string, text: string, quiet = false): Promise<PostResult> {
		if (to === PARENT) {
			if (from === PARENT) return { ok: false, reason: "parent cannot message itself" };
			let effectiveQuiet = quiet;
			if (!quiet) {
				const verdict = this.wakeQuota.check(from, text, Date.now());
				if (!verdict.ok && verdict.kind === "repeat") {
					// 重复抑制:同 sender 同文本短窗内 → 整体丢弃(loop 断),不算一次唤醒
					const reason = `duplicate message (same text within ${REPEAT_WINDOW_MS / 1000}s), dropped`;
					await this.notifySender(from, `delivery failed:${reason}; text: ${text}`);
					return { ok: false, reason };
				}
				if (!verdict.ok) {
					// 唤醒配额超限 → quiet 降级(消息仍留痕,不烧父轮次)+ 回执
					effectiveQuiet = true;
					await this.notifySender(
						from,
						`wake quota exceeded (${WAKE_QUOTA_MAX}/${WAKE_QUOTA_WINDOW_MS / 60000}min): this message stayed quiet (recorded, no wake); for parent attention wait or resend later`,
					);
				}
			}
			// worker → parent:消息卡;quiet=true 安静留痕(display 不 triggerTurn),缺省唤醒——
			// 消息即请求注意,想要安静就带 quiet
			this.deps.deliver(
				{
					customType: CALLBACK_TYPE,
					content: `msg ${this.deps.displayNameOf(from)} → parent:${text}`,
					details: { type: "message", id: from, text },
				},
				{ quiet: effectiveQuiet },
			);
			return { ok: true, via: "display" };
		}
		const target = this.deps.resolve(to);
		if (target === undefined) {
			const reason = `target “${to}” missing or ambiguous (could not uniquely resolve among live workers)`;
			await this.notifySender(from, `delivery failed:${reason}; text: ${text}`);
			return { ok: false, reason };
		}
		const fromName = from === PARENT ? "parent" : this.deps.displayNameOf(from);
		try {
			const via = await this.deps.transport(target, `message from “${fromName}”: ${text}`);
			if (from !== PARENT) {
				// peer 流量 audit fan-out:父 session 安静留痕(不烧父轮次),世界模型不瞎
				this.deps.deliver(
					{
						customType: CALLBACK_TYPE,
						content: `msg ${fromName} → ${this.deps.displayNameOf(target)}:${text}`,
						details: { type: "action-done", id: from },
					},
					{ quiet: true },
				);
			}
			return { ok: true, via };
		} catch (e) {
			const reason = e instanceof Error ? e.message : String(e);
			await this.notifySender(from, `delivery failed: target “${to}” cannot receive (${reason}); text: ${text}`);
			return { ok: false, reason };
		}
	}

	/** failure receipt 到发送方(worker 能自我修正);发送方是 parent 由调用方拿 PostResult;
	 * receipt 自身也失败(发送方已死)→ 安静审计到 parent session,不静默吞没。 */
	private async notifySender(from: string, notice: string): Promise<void> {
		if (from === PARENT) return;
		try {
			await this.deps.transport(from, notice);
		} catch {
			this.deps.deliver(
				{ customType: CALLBACK_TYPE, content: notice, details: { type: "action-done", id: from } },
				{ quiet: true },
			);
		}
	}
}
