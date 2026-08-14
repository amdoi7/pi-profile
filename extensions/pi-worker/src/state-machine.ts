import { WorkerError, TERMINAL_STATES, type WorkerRecord, type WorkerState } from "./types.ts";

export { WorkerError };

export interface ExitInfo {
	code: number | null;
	signal: string | null;
	stderrTail?: string;
}

/** exited 的唯一合法出路:collect(kill/steer/follow_up 非法,run 因非终态被拒)。
 * 提示文案与合法动作集同构——不得指名字典外动作。 */
const EXITED_HINT = "唯一出路 collect 清账;清账后可按原合约重派";

/**
 * 纯状态机:事件流 → 状态迁移 + action 合法性校验。无副作用,无进程知识。
 *
 *   ∅ ─run─► starting ─prompt accepted─► running ─settled─► idle ─collect─► done
 *              │                            │  ▲  │             │
 *              │启动失败                    │  │  │ stop        │ exit
 *              ▼                            │  │  ▼             ▼
 *            failed                         │  │ stopping ─settled→ idle
 *                                 steer ◄───┘  └─ follow_up ◄──┘  exited ─collect─► done
 *   starting|running|stopping|idle ─kill─► killing ─exit─► done
 *   starting|running|stopping ─exit─► failed(auto-reap,回调带诊断)
 *
 * - stop 约束worker 的当前轮(立即停止新工作、只收尾呈报),不约束父的未来决策:
 *   settled 后并入普通 idle,父仍可 collect 或 follow_up。线上传输 = 一条 canonical
 *   steer 指令,状态机只记录意图。
 * - 事件(settled/exit)在非法状态到达时静默忽略——异步竞态,kill 后子进程仍可能
 *   发来 settled,不是调用方错误。
 */
export class WorkerStateMachine {
	records = new Map<string, WorkerRecord>();

	/** run:∅→starting。id 未终结时拒绝(同合约同 id 的并发分发是调用方 bug)。
	 * 替换 terminal(failed/done)记录时继承上次失败诊断——status 可回溯;
	 * 回调已送达父、磁盘 jsonl 在,内存只留 last-known。 */
	run(input: { id: string; name: string }): WorkerRecord {
		const existing = this.records.get(input.id);
		if (existing && !TERMINAL_STATES.includes(existing.state)) {
			// exited 上 kill 非法,通用「先 collect 或 kill」会指到死路;按状态给真实出路
			const way = existing.state === "exited" ? EXITED_HINT : "先 collect 或 kill";
			throw new WorkerError(
				`id 已存在且未终结: ${input.id};${way},或修改合约生成新 id`,
			);
		}
		const now = Date.now();
		const rec: WorkerRecord = {
			id: input.id,
			name: input.name,
			state: "starting",
			processExited: false,
			createdAt: now,
			updatedAt: now,
			recent: [],
			turns: 0,
		};
		if (existing && (existing.exitCode != null || existing.stderrTail)) {
			rec.stderrTail = existing.stderrTail;
			rec.exitCode = existing.exitCode;
			rec.exitSignal = existing.exitSignal;
		}
		this.records.set(input.id, rec);
		return rec;
	}

	/**
	 * recover:persisted(stateless jsonl)→ live(stateful record),∅→exited
	 * (最后 live 状态未知,无进程句柄)。
	 * 显式状态组合:state=exited(合法集只剩 collect/status)× recovered provenance;
	 * 不新增 unknown 态——那会复制 exited 的合法动作集,一个概念裂成两个词。
	 * 幂等:在册 id 不覆盖(live 记录优先)。
	 */
	recover(input: { id: string; name: string; sessionFile: string; createdAt: number; updatedAt: number }): WorkerRecord {
		const existing = this.records.get(input.id);
		if (existing) return existing;
		const rec: WorkerRecord = {
			id: input.id,
			name: input.name,
			state: "exited",
			processExited: true,
			recovered: true,
			sessionFile: input.sessionFile,
			createdAt: input.createdAt,
			updatedAt: input.updatedAt,
			recent: [],
			turns: 0,
		};
		this.records.set(input.id, rec);
		return rec;
	}

	private getLive(id: string): WorkerRecord {
		const rec = this.records.get(id);
		if (!rec) {
			throw new WorkerError(`id 不存在: ${id};存活: ${this.liveIds().join(", ") || "(无)"}`);
		}
		return rec;
	}

	/**
	 * action 合法性检查。hints 按目标状态给替代建议;exited/terminal 用
	 * "已 <state>",其余非合法态用 "当前 <state>"。
	 */
	private requireState(
		id: string,
		legal: readonly WorkerState[],
		hints: { terminal: string } & Record<string, string>,
	): WorkerRecord {
		const rec = this.getLive(id);
		if (legal.includes(rec.state)) return rec;
		if (rec.state === "exited") {
			throw new WorkerError(`id 已 exited: ${id},${hints.exited}`);
		}
		if (TERMINAL_STATES.includes(rec.state)) {
			throw new WorkerError(`id 已 ${rec.state}: ${id},${hints.terminal}`);
		}
		throw new WorkerError(`id 当前 ${rec.state}: ${id},${hints[rec.state] ?? "无法执行"}`);
	}

	/** starting→running:初始 prompt 被接受。 */
	onStarted(id: string): void {
		const rec = this.records.get(id);
		if (!rec || rec.state !== "starting") return;
		rec.state = "running";
		this.touch(id);
	}

	/** steer:running→running(运行中干预)。 */
	steer(id: string): void {
		this.requireState(id, ["running"], {
			idle: "用 message 或 collect",
			stopping: "已 stop,steer 无意义;等 settled 或 kill",
			starting: "等待启动完成",
			terminal: "无法 steer;重新 run",
			exited: EXITED_HINT,
		});
		this.touch(id);
	}

	/** stop:running→stopping(立即停止新工作、只收尾呈报)。 */
	stop(id: string): void {
		const rec = this.requireState(id, ["running"], {
			stopping: "已 stop,等 settled 或 kill",
			idle: "无需 stop;用 message 或 collect",
			starting: "等待启动完成",
			terminal: "无需 stop",
			exited: EXITED_HINT,
		});
		rec.state = "stopping";
		this.touch(id);
	}

	/** follow_up:idle→running(追加轮次)。 */
	followUp(id: string): void {
		const rec = this.requireState(id, ["idle"], {
			running: "用 message(steer 投递)或等 settled",
			stopping: "已 stop,等 settled",
			starting: "等待启动完成",
			terminal: "无法 follow_up;重新 run",
			exited: EXITED_HINT,
		});
		rec.state = "running";
		this.touch(id);
	}

	/**
	 * 乐观迁移的补偿:效果(RPC)未落地时把状态放回去。
	 *
	 * CAS 语义——仅当状态仍是本次迁移写入的 `from` 才回退。await 期间到达的
	 * 异步事件(onExit/onSettled/kill)是比补偿更新的事实,已改写状态则让位。
	 * 无迁移可补偿(记录已消失)时静默返回:补偿路径不产生新的失败。
	 */
	rollback(id: string, from: WorkerState, to: WorkerState): void {
		const rec = this.records.get(id);
		if (!rec || rec.state !== from) return;
		rec.state = to;
		this.touch(id);
	}

	/** collect:idle|exited|failed→done(父验收后收尾;failed = 终态清理,清账后重派)。 */
	collect(id: string): void {
		const rec = this.requireState(id, ["idle", "exited", "failed"], {
			running: "先 kill 或等 settled",
			stopping: "已 stop,等 settled",
			starting: "先 kill 或等 settled",
			terminal: "无需 collect",
		});
		rec.state = "done";
		this.touch(id);
	}

	/** kill:starting|running|stopping|idle→killing(撤换;进程退出后经 onExit → done)。 */
	kill(id: string): void {
		const rec = this.requireState(id, ["starting", "running", "stopping", "idle"], {
			terminal: "无法 kill",
			exited: EXITED_HINT,
		});
		rec.state = "killing";
		this.touch(id);
	}

	/** status:任意状态(含 terminal 的 last known)。 */
	status(id?: string): WorkerRecord | WorkerRecord[] {
		if (id === undefined) return [...this.records.values()];
		return this.getLive(id);
	}

	/** agent_settled:running|stopping→idle。 */
	onSettled(id: string): void {
		const rec = this.records.get(id);
		if (!rec || (rec.state !== "running" && rec.state !== "stopping")) return;
		rec.state = "idle";
		this.touch(id);
	}

	/**
	 * 进程退出。starting|running|stopping→failed(带诊断,auto-reap);
	 * killing→done(reap 完成);idle→exited(进程没了,合法集合只剩 collect/status);
	 * done/failed/exited→忽略。
	 */
	onExit(id: string, info: ExitInfo): void {
		const rec = this.records.get(id);
		if (!rec) return;
		rec.exitCode = info.code;
		rec.exitSignal = info.signal;
		// 先到者优先:启动失败的诊断由 manager 先行写入,watcher 的 stderr 尾不覆盖
		if (!rec.stderrTail && info.stderrTail) rec.stderrTail = info.stderrTail;
		rec.processExited = true;
		if (rec.state === "starting" || rec.state === "running" || rec.state === "stopping") {
			rec.state = "failed";
		} else if (rec.state === "killing") {
			rec.state = "done";
		} else if (rec.state === "idle") {
			rec.state = "exited";
		} else {
			return; // done/failed/exited 已终态或已处理
		}
		this.touch(id);
	}

	liveIds(): string[] {
		return [...this.records.values()]
			.filter((r) => !TERMINAL_STATES.includes(r.state))
			.map((r) => r.id);
	}

	private touch(id: string): void {
		const rec = this.records.get(id);
		if (rec) rec.updatedAt = Date.now();
	}
}
