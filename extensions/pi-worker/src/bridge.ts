/**
 * 回调格式化(纯函数,可单测)。发送由 watcher 调用 pi.sendMessage。
 * 两种互斥消息类型:
 *   settled id= name= <报告全文>
 *   failed id= exit= stderr尾
 */
export type CallbackEvent =
	| {
			type: "settled";
			id: string;
			name: string;
			report: string;
			reportError?: string;
			/** 末条 assistant 的 stopReason(stop|length|toolUse|error|aborted;length 即截断) */
			stopReason?: string;
			stats?: unknown;
			/** 完成轮数(摘要行 ⎿ N turns) */
			turns?: number;
			/** 子会话 jsonl 路径(pi 原生 get_state;审计指针,握手未成则无) */
			sessionFile?: string;
	  }
	| {
			type: "failed";
			id: string;
			exitCode: number | null;
			exitSignal: string | null;
			stderrTail: string;
			/** 子会话 jsonl 路径(同上,握手未成则无) */
			sessionFile?: string;
	  };

export interface CallbackMessage {
	customType: string;
	content: string;
	details: Record<string, unknown>;
}

export const CALLBACK_TYPE = "pi-worker";

/** settled 报告注入父上下文(LLM 面)的长度上限;超限截断并标注,全文在
 * details.report(渲染层)与 session jsonl。无上限时失控长报告烧父上下文。 */
const SETTLED_REPORT_MAX = 8000;

/** XML 文本转义:report/name 是自由文本(用户与 LLM 可输入),防模板破坏。 */
function xmlEscape(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 数字字段(仅有限数字输出,与 present.ts 同判空风格)。 */
function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * settled 结构化注入(对标 Claude Code task-notification / opencode subagent):
 * 首行摘要保留既有契约,随后 XML 模板携带机器可断言的字段(status/turns/usage),
 * 报告全文进 <report>(渲染层仍读 details.report 纯文本,不受影响)。
 * 无 stats → 无 <usage>;字段缺省省略,模板始终可解析。
 */
function formatSettledContent(ev: Extract<CallbackEvent, { type: "settled" }>): string {
	const id = xmlEscape(ev.id);
	const name = xmlEscape(ev.name);
	let report =
		ev.report || (ev.reportError ? `(report unavailable: ${ev.reportError})` : "(no report)");
	if (report.length > SETTLED_REPORT_MAX) {
		report = `${report.slice(0, SETTLED_REPORT_MAX)}\n…(truncated ${report.length - SETTLED_REPORT_MAX} chars; full text in session jsonl and render layer)`;
	}
	const lines = [`settled id=${ev.id} name=${ev.name}${ev.sessionFile ? ` session=${ev.sessionFile}` : ""}`, "<worker-settled>"];
	lines.push(`<id>${id}</id>`, `<name>${name}</name>`);
	lines.push("<status>settled</status>");
	// 非正常收尾才输出:length(截断)/aborted/error 是父需要知道的诊断信号
	if (ev.stopReason && ev.stopReason !== "stop") lines.push(`<stop_reason>${xmlEscape(ev.stopReason)}</stop_reason>`);
	if (typeof ev.turns === "number") lines.push(`<turns>${ev.turns}</turns>`);
	const stats = (ev.stats ?? {}) as {
		tokens?: Record<string, unknown>;
		toolCalls?: unknown;
		cost?: unknown;
	};
	const usageBits: string[] = [];
	const toolCalls = num(stats.toolCalls);
	if (toolCalls !== undefined) usageBits.push(`<tool_calls>${toolCalls}</tool_calls>`);
	const tokens = stats.tokens ?? {};
	const tokBits: string[] = [];
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
		const v = num(tokens[key]);
		if (v !== undefined) tokBits.push(`<${key}>${v}</${key}>`);
	}
	if (tokBits.length > 0) usageBits.push(`<tokens>${tokBits.join("")}</tokens>`);
	const cost = num(stats.cost);
	if (cost !== undefined) usageBits.push(`<cost>${cost}</cost>`);
	if (usageBits.length > 0) lines.push("<usage>", ...usageBits, "</usage>");
	lines.push(`<report>\n${xmlEscape(report)}\n</report>`, "</worker-settled>");
	return lines.join("\n");
}

export function formatCallback(ev: CallbackEvent): CallbackMessage {
	if (ev.type === "settled") {
		return {
			customType: CALLBACK_TYPE,
			content: formatSettledContent(ev),
			details: {
				type: "settled",
				id: ev.id,
				name: ev.name,
				report: ev.report,
				reportError: ev.reportError,
				...(ev.stopReason !== undefined ? { stopReason: ev.stopReason } : {}),
				stats: ev.stats,
				turns: ev.turns,
				...(ev.sessionFile !== undefined ? { sessionFile: ev.sessionFile } : {}),
			},
		};
	}
	const stderr = ev.stderrTail ? ` stderr=${ev.stderrTail}` : "";
	const session = ev.sessionFile ? ` session=${ev.sessionFile}` : "";
	return {
		customType: CALLBACK_TYPE,
		content: `failed id=${ev.id} exit=${ev.exitCode ?? ev.exitSignal ?? "?"}${stderr}${session}`,
		details: {
			type: "failed",
			id: ev.id,
			exitCode: ev.exitCode,
			exitSignal: ev.exitSignal,
			stderrTail: ev.stderrTail,
			...(ev.sessionFile !== undefined ? { sessionFile: ev.sessionFile } : {}),
		},
	};
}
