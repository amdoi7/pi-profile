/**
 * 在场循环:每 tick 幂等收敛「本进程是否为该 sessionId 的收信方」。
 * - 未服务 → 尝试接管 socket。同 sessionId 撞车时的退让不是终态:对方退出后
 *   下个 tick 自动接管,会话不会永久失联;
 * - 退役门(shouldRetire,先于接管判定):终端已脱离的僵尸进程退出 peer 平面
 *   (释放 socket),resume 的真会话才能接管身份;退役即永久停机。
 * 错误不致命:tryServe 抛错走 onError,留待下 tick 重试。
 */

const DEFAULT_INTERVAL_MS = 60_000;

export interface ReconcilerDeps {
	/** 尝试成为收信方(接管 socket);true = 本进程已在服务。已服务后不再被调用。 */
	tryServe(): Promise<boolean>;
	/** 首次接管失败(同 sessionId 已有活进程在收信):通知一次,不逐 tick 骚扰。 */
	onYield?(): void;
	/** 退役判定(每 tick 先检,优先于接管):true 即永久停机。 */
	shouldRetire?(): boolean;
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
			if (deps.shouldRetire?.()) {
				stop();
				const wasServing = serving;
				serving = false;
				deps.onRetire?.(wasServing);
				return;
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
