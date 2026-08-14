import { describe, test } from "vitest";
import assert from "node:assert/strict";

import { Markdown } from "@earendil-works/pi-tui";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";

import { tagUntaggedFences } from "../src/tagger.ts";

initTheme("dark");

/** 渲染路径测试:同一段无标签代码,transformer 前后渲染出的颜色数必须不同
 * (无标签 = 单色;补标签后 = 多色语法高亮)。 */
function distinctFgCodes(lines) {
	// 排除围栏边框行(``` 本身是 codeBlockBorder 色,与代码色无关)
	const codeLines = lines.filter((l) => {
		const visible = l.replace(/\u001b\[[0-9;]*m/g, "").trim();
		return !visible.startsWith("```");
	});
	const codes = new Set();
	for (const line of codeLines) {
		for (const m of line.matchAll(/38;2;(\d+);(\d+);(\d+)/g)) {
			codes.add(`${m[1]},${m[2]},${m[3]}`);
		}
	}
	return codes.size;
}

describe("render path", () => {
	test("untagged fence renders monochrome; tagged renders multi-color", () => {
		const code = "const count = 42;\nfunction greet(name) {\n  return `hi ${name}`;\n}\nlet total = count + 1;";
		const before = new Markdown(`\`\`\`\n${code}\n\`\`\``, 1, 1, getMarkdownTheme()).render(80);
		const after = new Markdown(tagUntaggedFences(`\`\`\`\n${code}\n\`\`\``), 1, 1, getMarkdownTheme()).render(80);

		assert.equal(distinctFgCodes(before), 1, "untagged must render a single color");
		assert.ok(distinctFgCodes(after) >= 3, `tagged must render >= 3 colors, got ${distinctFgCodes(after)}`);
	});
});
