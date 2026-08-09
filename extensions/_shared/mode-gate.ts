import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionEvent,
	ExtensionHandler,
} from "@earendil-works/pi-coding-agent";

/**
 * 声明式 mode gate。
 *
 * pi 核心尚无按模式过滤注册的原生机制（工厂总执行、事件总派发），
 * 扩展侧用本模块包装注册 API：能力声明 modes，运行时按 ctx.mode 自动
 * 激活/丢弃，替代散落的 `if (ctx.mode !== "tui") return;`。
 *
 * 与 pi 核心 feature request（注册选项支持 modes）对齐；上游落地后
 * 迁移 = 去掉包装、内联声明，调用点不变。
 */

/** 与 pi 的 ExtensionMode 一致（该类型未从包导出，本地声明）。 */
export type Mode = "tui" | "rpc" | "json" | "print";

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1] & {
	modes?: Mode[];
};

function isAllowed(mode: ExtensionContext["mode"], modes: Mode[] | undefined): boolean {
	if (!modes || modes.length === 0) {
		return true;
	}
	return modes.includes(mode);
}

/** 注册命令并声明可用模式；其他模式自动拒绝并 notify（无 UI 时静默）。 */
export function registerCommand(
	pi: ExtensionAPI,
	name: string,
	options: CommandOptions,
): void {
	const modes = options.modes;
	pi.registerCommand(name, {
		...options,
		handler: async (args, ctx) => {
			if (isAllowed(ctx.mode, modes)) {
				return options.handler(args, ctx);
			}
			if (ctx.hasUI) {
				// 拒绝分支必有 modes（空/省略 = 全模式，不会走到这里）。
				ctx.ui.notify(`/${name} requires ${modes!.join("/")} mode.`, "warning");
			}
			return;
		},
	});
}

/**
 * 订阅事件并声明可用模式；其他模式不派发。
 * 事件名与 handler 类型绑定（Extract 自 ExtensionEvent），返回值透传
 * （如 tool_call 的 block 结果）。pi.on 是重载签名，内部以断言转发。
 */
export function on<E extends ExtensionEvent["type"], R = undefined>(
	pi: ExtensionAPI,
	event: E,
	handler: ExtensionHandler<Extract<ExtensionEvent, { type: E }>, R>,
	modes?: Mode[],
): void {
	pi.on(event as never, ((e: Extract<ExtensionEvent, { type: E }>, ctx: ExtensionContext) => {
		if (!isAllowed(ctx.mode, modes)) {
			return undefined;
		}
		return handler(e, ctx);
	}) as never);
}
