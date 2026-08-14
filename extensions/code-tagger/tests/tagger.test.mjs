import { describe, test } from "vitest";
import assert from "node:assert/strict";

import { detectLanguage, tagUntaggedFences } from "../src/tagger.ts";

describe("detectLanguage", () => {
	const cases = [
		["python", 'print("hello")\nfor i in range(3):\n    print(i)'],
		["python", "import os\nfrom pathlib import Path\ndef main():\n    pass"],
		["javascript", "const x = 42;\nfunction greet(name) {\n  return `hi ${name}`;\n}"],
		["typescript", "interface User {\n  id: number;\n}\nconst u: User = { id: 1 };"],
		["bash", "#!/bin/bash\nfor f in *.txt; do\n  echo \"$f\"\ndone"],
		["bash", "export PATH=\"$HOME/bin:$PATH\"\nls -la"],
		["json", '{\n  "name": "pi",\n  "version": "1.0"\n}'],
		["yaml", "name: pi\nversion: 1.0\nservices:\n  - web"],
		["go", "package main\nfunc main() {\n  x := 1\n}"],
		["rust", "fn main() {\n  let x = 1;\n  println!(\"{}\", x);\n}"],
		["c", "#include <stdio.h>\nint main() {\n  return 0;\n}"],
		["cpp", "#include <vector>\nusing std::vector;\nint main() {\n  vector<int> v;\n}"],
		["sql", "SELECT id, name FROM users WHERE age > 18;"],
		["html", "<!doctype html>\n<html>\n<body>\n<p>hi</p>\n</body>\n</html>"],
		["css", ".card {\n  color: red;\n  margin: 0 auto;\n}"],
	] ;

	for (const [lang, code] of cases) {
		test(`detects ${lang}`, () => {
			assert.equal(detectLanguage(code), lang);
		});
	}

	test("returns undefined for prose (English paragraph)", () => {
		const prose = "This is a plain paragraph about the weather today. It is sunny and warm outside, and the birds are singing in the trees. We should go for a walk.";
		assert.equal(detectLanguage(prose), undefined);
	});

	test("returns undefined for empty content", () => {
		assert.equal(detectLanguage(""), undefined);
		assert.equal(detectLanguage("   "), undefined);
	});

	// 回归:单行 `key: 散文` 不是 YAML——签名要求 ≥2 个 key 结构行。
	test("single-line colon prose is not yaml", () => {
		assert.equal(detectLanguage("Note: do not run this in production"), undefined);
		assert.equal(detectLanguage("Warning: experimental feature"), undefined);
	});

	// 回归(语料 eval 发现):单行 JS 语句带对象字面量不是 CSS。
	test("single-line return with object literal is not css", () => {
		assert.equal(detectLanguage("return { details: viewModel };"), undefined);
	});

	// 回归(语料 eval 发现):if (...) + 模板字符串 ${} 不是 bash——
	// bash 的控制关键字后不跟括号(if [ ... ]; then 才是 bash)。
	test("if-with-parens and template literal is not bash", () => {
		const ts = "if (actions.length === 0) {\n  log(`[${s.state}] none`);\n}";
		assert.equal(detectLanguage(ts), "javascript");
	});

	// 回归(语料 eval 发现):export const 是 JS/TS,不是 bash 的 export——
	// bash export 的形态是 export VAR=value。
	test("export const is javascript, not bash", () => {
		const js = "export const tabs = [\n  { key: 'all', label: 'all' },\n]";
		assert.equal(detectLanguage(js), "javascript");
	});
});

describe("tagUntaggedFences", () => {
	test("tags an untagged python fence", () => {
		const md = "Here is code:\n\n```\nprint('hi')\n```\n\nDone.";
		const out = tagUntaggedFences(md);
		assert.ok(out.includes("```python"), out);
		assert.ok(!out.includes("```\nprint"), "opening fence must carry the tag");
	});

	test("keeps existing language tags untouched", () => {
		const md = "```typescript\nconst x: number = 1;\n```";
		assert.equal(tagUntaggedFences(md), md);
	});

	test("does not tag prose fences", () => {
		const md = "```\nThe quick brown fox jumps over the lazy dog.\n```";
		assert.equal(tagUntaggedFences(md), md);
	});

	test("preserves indentation (list-nested fences)", () => {
		const md = "- item:\n\n    ```\n    const x = 1;\n    ```";
		const out = tagUntaggedFences(md);
		assert.ok(out.includes("    ```javascript"), out);
	});

	test("tags multiple fences independently", () => {
		const md = "```\nconst a = 1;\n```\n\ntext\n\n```\nprint('b')\n```";
		const out = tagUntaggedFences(md);
		assert.ok(out.includes("```javascript"));
		assert.ok(out.includes("```python"));
	});

	test("is idempotent", () => {
		const md = "```\nconst a = 1;\n```";
		assert.equal(tagUntaggedFences(tagUntaggedFences(md)), tagUntaggedFences(md));
	});

	test("handles trailing spaces on the fence line", () => {
		const md = "```  \nconst a = 1;\n```";
		const out = tagUntaggedFences(md);
		assert.ok(out.includes("```javascript"), out);
	});

	test("leaves unclosed fences alone", () => {
		const md = "```\nconst a = 1;";
		assert.equal(tagUntaggedFences(md), md);
	});

	// 回归:已带标签的围栏必须整体跳过——闭合围栏不是新的无标签开头。
	// 否则两个 tagged 块之间一行命令词开头的散文会把前一块的闭合围栏
	// 改写成带标签围栏,renderer 判定闭合失效,后续内容被吞进代码块。
	test("tagged fence bodies are skipped (closing fence is not re-scanned)", () => {
		const md =
			"```bash\nnpm install\n```\ncd into the project and run:\n```bash\nnpm start\n```";
		assert.equal(tagUntaggedFences(md), md);
	});

	// 回归:4 反引号块内的无标签示例围栏是块内容,不是可标记的顶层围栏。
	test("nested untagged fence inside a 4-backtick tagged block stays untouched", () => {
		const md = "````markdown\n## Example\n\n```\nconst x = 1;\n```\n````";
		assert.equal(tagUntaggedFences(md), md);
	});
});
