/**
 * 滑动窗配额 + 同文重复抑制:pi-peer(发送配额)与 pi-worker RoomBus(唤醒配额)
 * 的同构内核——两端语义一致:quiet 旁路在调用方(不占额),本类只管计数与判定。
 *  verdict 只带 kind,文案归调用方(两端的回执/错误话语不同,策略壳不共享)。
 * 判定语义(repeat 与 quota 都不计数——丢弃/降级不算一次成功发送):
 * - repeat:同 key 同文本在 repeatWindowMs 内重发 = loop 信号;
 * - quota:窗口内成功发送数达 max。
 */

export type QuotaVerdict = { ok: true } | { ok: false; kind: "repeat" | "quota" };

export class WindowQuota {
	private readonly log = new Map<string, number[]>();
	private readonly lastText = new Map<string, { text: string; ts: number }>();

	constructor(
		private readonly opts: { max: number; windowMs: number; repeatWindowMs: number },
	) {}

	/** 只计成功(ok)的发送;repeat/quota 拒绝不消耗额度。 */
	check(key: string, text: string, now: number): QuotaVerdict {
		const last = this.lastText.get(key);
		if (last && last.text === text && now - last.ts < this.opts.repeatWindowMs) {
			return { ok: false, kind: "repeat" };
		}
		const log = (this.log.get(key) ?? []).filter((t) => now - t < this.opts.windowMs);
		if (log.length >= this.opts.max) {
			return { ok: false, kind: "quota" };
		}
		log.push(now);
		this.log.set(key, log);
		this.lastText.set(key, { text, ts: now });
		return { ok: true };
	}
}
