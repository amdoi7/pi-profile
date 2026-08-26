/**
 * 滑动窗配额 + 同文重复抑制:pi_peer 发送配额的判定内核。
 * quiet 旁路在调用方(不占额),本类只管计数与判定;verdict 只带 kind,文案归调用方。
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

	/**
	 * 只判定,不记账。记账归 commit——成功才消耗额度:
	 * 失败的尝试(offline/被拒/超时)不烧配额、不刷新同文基线,重试不被 repeat 误伤。
	 */
	check(key: string, text: string, now: number): QuotaVerdict {
		const last = this.lastText.get(key);
		if (last && last.text === text && now - last.ts < this.opts.repeatWindowMs) {
			return { ok: false, kind: "repeat" };
		}
		const log = (this.log.get(key) ?? []).filter((t) => now - t < this.opts.windowMs);
		if (log.length >= this.opts.max) {
			return { ok: false, kind: "quota" };
		}
		return { ok: true };
	}

	/** 成功投递后记账:窗口计数 + 同文基线(仅成功刷新基线,防绕窗)。 */
	commit(key: string, text: string, now: number): void {
		const log = (this.log.get(key) ?? []).filter((t) => now - t < this.opts.windowMs);
		log.push(now);
		this.log.set(key, log);
		this.lastText.set(key, { text, ts: now });
	}
}
