import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { renderShellCommandCall } from "../_shared/code-preview.ts";

/**
 * bash-fish-render:bash 工具调用命令行的 fish 式语义高亮。
 *
 * 只覆写 bash 的 renderCall:先走内置 renderCall(计时/状态推进/lastComponent
 * 语义与内置完全一致),再把命令文本替换为 fish 式着色——用真实
 * `fish_indent --ansi` + fish 主题 dump 上色(命令存在→主题命令色、缺失→红,
 * 选项/字符串/变量/操作符各按其语义),实现见 _shared/code-preview.ts 的
 * renderShellCommandCall。
 *
 * 边界:execute/renderResult 原样委托内置,不含任何 apply_patch/perl 识别或
 * diff VM——那是已移除的 bash-ui 的职责;本扩展只负责"渲染那行命令"。
 */
export default function bashFishRenderExtension(pi: ExtensionAPI): void {
	const baseBash = createBashToolDefinition(process.cwd());
	const baseRenderCall = baseBash.renderCall;
	if (!baseRenderCall || !baseBash.renderResult) {
		throw new Error("bash-fish-render requires built-in bash renderCall/renderResult; upgrade pi");
	}

	pi.registerTool({
		...baseBash,
		renderCall(args, theme, context) {
			const component = baseRenderCall(args, theme, context);
			if (component instanceof Text) {
				component.setText(renderShellCommandCall(args, theme));
			}
			return component;
		},
	});
}
