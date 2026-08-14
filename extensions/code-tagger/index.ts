import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tagUntaggedFences } from "./src/tagger.ts";

/**
 * code-tagger:渲染前为无标签代码围栏自动补语言标签。
 *
 * pi 的 TUI 只对带合法语言标签的围栏做语法高亮;LLM 输出约六成围栏漏标签,
 * 整块单色。本扩展在渲染前为可识别的代码块补标签——只改显示,不污染会话
 * 文本。保守原则:识别不了(散文/未知结构)就不标。
 */
export default function codeTaggerExtension(pi: ExtensionAPI): void {
	pi.registerMarkdownTransformer((markdown, ctx) => {
		if (ctx.messageType !== "assistant") return markdown;
		return tagUntaggedFences(markdown);
	});
}
