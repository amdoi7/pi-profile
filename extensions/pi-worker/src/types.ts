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
	/** 一次性任务:report 回调送达后自动 collect */
	oneshot: boolean;
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
	/** 角色标注(自由文本,注入子 prompt;不进显示层),run 合约参数 */
	role?: string;
	/** 握手 get_state 的实际生效模型/档位(含默认),overlay 显示 */
	modelInfo?: { provider: string; id: string; thinkingLevel: string };
	/** 当前执行的非 thinking 活动(tool/text),overlay 显示;思考中为 undefined */
	currentActivity?: string;
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
	task: string;
	role?: string;
	acceptance?: string;
	contextRefs?: string;
	model?: string;
	thinking?: string;
	oneshot?: boolean;
}

export const TERMINAL_STATES: readonly WorkerState[] = ["done", "failed"] as const;
