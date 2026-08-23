import { createBashToolDefinition, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";

import { renderShellCommandCall } from "../_shared/code-preview.ts";
import { appendFileMutationBatch } from "../_shared/file-mutation-view.ts";
import { fileResultItem } from "../_shared/file-result.ts";
import { APPLY_PATCH_RE, parseGuardedPatchFiles } from "./guarded-diff.ts";
import { executeApplyPatchGuarded } from "./execute.ts";

/**
 * bash-fish-render:bash 工具调用的 fish 式语义高亮 + apply_patch 展示 diff 守卫。
 *
 * 只覆写 bash 的 renderCall:先走内置 renderCall(计时/状态推进/lastComponent
 * 语义与内置完全一致),再把命令文本替换为 fish 式着色——用真实
 * `fish_indent --ansi` + fish 主题 dump 上色(命令存在→主题命令色、缺失→红,
 * 选项/字符串/变量/操作符各按其语义),实现见 _shared/code-preview.ts 的
 * renderShellCommandCall。
 *
 * execute:apply_patch 命令走 execute.ts 的守卫执行(worker-backed diff,
 * 250ms Myers tripwire / 5s batch watchdog / O(N) fast path,防大 buffer
 * 卡死);其余命令原样委托内置 bash execute。
 *
 * renderResult:先委托内置(输出预览/truncation/计时与内置完全一致;内置
 * 每次 clear+rebuild,append 无重复累积),再把 details.patchFiles(结构化
 * DisplayDiff)用与 edit 同源的 fileResultItem/DiffPreviewComponent 追加为
 * 双列行号 + 词级高亮的文件 diff。旧 session 的 details.diffs(单列字符串)
 * 仍由内置渲染,向后兼容;契约破坏响亮报告,不静默吞。
 */
export default function bashFishRenderExtension(pi: ExtensionAPI): void {
	// 注册时固定 cwd（与内置 createBashToolDefinition(cwd) 闭包同一时刻），
	// execute 时复用同一值，避免 process.cwd() 在调用期变化造成与内置委托漂移。
	const registeredCwd = process.cwd();
	const baseBash = createBashToolDefinition(registeredCwd);
	const baseRenderCall = baseBash.renderCall;
	const baseRenderResult = baseBash.renderResult;
	const baseExecute = baseBash.execute;
	if (!baseRenderCall || !baseRenderResult || !baseExecute) {
		throw new Error("bash-fish-render requires built-in bash renderCall/renderResult/execute; upgrade pi");
	}

	pi.registerTool({
		...baseBash,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!APPLY_PATCH_RE.test(params.command)) {
				return baseExecute(toolCallId, params, signal, onUpdate, ctx);
			}
			return executeApplyPatchGuarded(params.command, registeredCwd, {
				signal,
				onUpdate,
				timeout: params.timeout,
				ctx,
			});
		},
		renderCall(args, theme, context) {
			const component = baseRenderCall(args, theme, context);
			if (component instanceof Text) {
				component.setText(renderShellCommandCall(args, theme));
			}
			return component;
		},
		renderResult(result, options, theme, context) {
			const component = baseRenderResult(result, options, theme, context);
			const parsed = parseGuardedPatchFiles((result as { details?: unknown }).details);
			if (parsed.kind === "absent" || !(component instanceof Container)) {
				return component;
			}
			if (parsed.kind === "invalid") {
				component.addChild(new Text(
					`\n${(theme as Theme).fg("error", 'apply_patch_diff_contract_invalid expected="details.patchFiles: structured file diffs" action="report the bash-fish-render result payload"')}`,
					0,
					0,
				));
				return component;
			}
			component.addChild(new Spacer(1));
			appendFileMutationBatch(
				component,
				parsed.files.map((file) => fileResultItem({ label: "apply_patch", ...file }, theme, context.cwd)),
				theme,
			);
			return component;
		},
	});
}
