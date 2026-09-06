/**
 * 在场循环:每 tick 幂等收敛「本进程是否为该 sessionId 的收信方」。
 * - 未服务 → 尝试接管 socket。同 sessionId 撞车时的退让不是终态:对方退出后
 *   下个 tick 自动接管,会话不会永久失联;
 * - 退役门(shouldRetire,先于接管判定):终端已脱离的僵尸进程退出 peer 平面
 *   (释放 socket),resume 的真会话才能接管身份;退役即永久停机。
 * 错误不致命:tryServe 抛错走 onError,留待下 tick 重试。
 *
 * 挂起(cmd-Z)处理:不再靠被挂起进程自己报告(它无法执行代码),而是——
 * - 影子检测(amIServing)细分三态:ENOENT(路径被外部移除)→ 席位重建(置 serving=false,
 *   下 tick tryServe 重新接管);token 不匹配 → 他人接管身份,退役;mute → 留待下轮。
 * - 接管判定(transport.probeSocket)由观察者用 OS 进程真相(lsof/ss)裁决挂起,见 transport.ts。
 */

const DEFAULT_INTERVAL_MS = 60_000;

export interface ReconcilerDeps {
	/** 尝试成为收信方(接管 socket);true = 本进程已在服务。已服务后不再被调用。 */
	tryServe(): Promise<boolean>;
	/** 首次接管失败(同 sessionId 已有活进程在收信):通知一次,不逐 tick 骚扰。 */
	onYield?(): void;
	/** 退役判定(每 tick 先检,优先于接管):true 即永久停机。 */
	shouldRetire?(): boolean;
	/**
	 * 影子检测(每 tick,服务中):本进程是否仍是路径的监听方。
	 * 返回三态:
	 * - ok → 仍是我,继续在场;
	 * - gone(路径 ENOENT,被外部移除/接管后 rm)→ 席位重建:置 serving=false,下 tick 重新接管;
	 * - taken(应答 token ≠ 自己)→ 他人接管了身份,退役。
	 */
	amIServing?(): Promise<"ok" | "gone" | "taken">;
	/** 退役回调(恰一次):wasServing 告知调用方是否需释放 socket。 */
	onRetire?(wasServing: boolean): void;
	onError?(e: unknown): void;
	intervalMs?: number;
}

export interface Reconciler {
	serving(): boolean;
	/** 手动触发一轮(测试面;运行态由 interval 驱动)。在途时空转,不重入。 */
	tick(): Promise<void>;
	stop(): void;
}

/** 启动即完成首轮收敛(session_start 返回时已在场或已退让),随后周期驱动。 */
export async function startReconciler(deps: ReconcilerDeps): Promise<Reconciler> {
	let serving = false;
	let stopped = false;
	let yielded = false;
	let inFlight = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	const stop = (): void => {
		stopped = true;
		if (timer) clearInterval(timer);
	};
	const tick = async (): Promise<void> => {
		if (stopped || inFlight) return;
		inFlight = true;
		try {
			// 退役门(先于接管):终端脱离 → 永久停机
			if (deps.shouldRetire?.()) {
				stop();
				const wasServing = serving;
				serving = false;
				deps.onRetire?.(wasServing);
				return;
			}
			// 影子检测:已被他人接管 / 路径被外部移除
			if (deps.amIServing) {
				const verdict = await deps.amIServing();
				if (verdict === "taken") {
					stop();
					const wasServing = serving;
					serving = false;
					deps.onRetire?.(wasServing);
					return;
				}
				if (verdict === "gone") {
					// 席位被外部移除(挂起期间被接管方 rm+listen):重建——下 tick 重新接管
					serving = false;
				}
			}
			if (!serving) {
				serving = await deps.tryServe();
				if (!serving && !yielded) {
					yielded = true;
					deps.onYield?.();
				}
			}
		} catch (e) {
			deps.onError?.(e);
		} finally {
			inFlight = false;
		}
	};
	await tick();
	if (!stopped) {
		timer = setInterval(() => void tick(), deps.intervalMs ?? DEFAULT_INTERVAL_MS);
		timer.unref?.(); // 不阻进程退出:在场性随进程消亡本就该消亡
	}
	return { serving: () => serving, tick, stop };
}
