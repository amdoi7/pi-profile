export type WorkerState =
	| "starting"
	| "running"
	| "stopping"
	| "idle"
	| "exited"
	| "killing"
	| "done"
	| "failed";
export interface WorkerRecord {
	id: string;
	name: string;
	state: WorkerState;
	/** 最近一轮的呈报全文(get_last_assistant_text) */
	report?: string;
	/** 最近一轮用量快照(turn_end 拉取并覆写,投影唯一读入口) */
	latestStats?: Record<string, unknown>;
	/** 进程已退出(idle 后崩溃等) */
	processExited: boolean;
	exitCode?: number | null;
	exitSignal?: string | null;
	stderrTail?: string;
	pid?: number;
	createdAt: number;
	updatedAt: number;
	/** 最近事件摘要(tool_execution/turn_end),供 status 展示,上限 10 */
	recent: string[];
	/** turn_end 计数(footer ▸t<n>) */
	turns: number;
	/** spawn 指定的模型/档位(run 合约参数) */
	model?: string;
	thinking?: string;
	/** 握手 get_state 的实际生效模型/档位(含默认),overlay 显示 */
	modelInfo?: { provider: string; id: string; thinkingLevel: string };
	/** 握手 get_state 返回的会话 jsonl 路径(pi 原生审计指针:事实核验第三层入口) */
	sessionFile?: string;
	/** 当前执行的非 thinking 活动(tool/text),overlay 显示;思考中为 undefined */
	currentActivity?: string;
	/** 启动恢复 provenance:jsonl 重建,最后状态未知(显式状态组合:state × recovered) */
	recovered?: boolean;
	/** 终审结论(collect 工具参数落记录,status 可审计) */
	verdict?: CollectVerdict;
	/** run 合约的归一化工具面(集合语义);缺省 = 全量白名单,不显 */
	tools?: string;
}

/** 非法 action/迁移时抛出,message 即 actionable 错误文案 */
export class WorkerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkerError";
	}
}

/** run 合约参数(contract.ts 校验与 id 生成输入) */
export interface RunInput {
	name: string;
	prompt: string;
	model?: string;
	thinking?: string;
	/** 工具白名单(逗号分隔,集合语义);缺省 = contract.WORKER_TOOL_ALLOWLIST */
	tools?: string;
}

export const TERMINAL_STATES: readonly WorkerState[] = ["done", "failed"] as const;

/** collect 终审结论枚举(工具参数面;打回 = message 重派,不经 collect) */
export const COLLECT_VERDICTS = ["通过", "丢弃", "强制放行"] as const;
export type CollectVerdict = (typeof COLLECT_VERDICTS)[number];
