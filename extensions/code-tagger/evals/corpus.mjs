#!/usr/bin/env node
/**
 * code-tagger 语料 eval:用真实会话围栏测 detectLanguage 的覆盖率与误判率。
 *
 * 用法:npm run eval 或 node evals/corpus.mjs [sessionsDir](默认 ~/.pi/agent/sessions)
 *
 * 门禁(退出码 1,能暴露失败):
 * - 语料失效:围栏总数 < 50(目录错误或扫描逻辑 broken);
 * - 散文误判:PROSE_FIXTURES(人工标注的真实散文围栏)被判出任何语言,零容忍。
 *
 * 报告(不门禁,供人工排查):
 * - 无标签围栏的检出分布与未检出率(覆盖率信号);
 * - 带标签围栏中 detect 与模型原标签冲突的 top 对(附样本);
 * - 无标签但被判 yaml/bash 的短内容样本(散文误报高发区,巡检后可标注进
 *   PROSE_FIXTURES 转为门禁)。
 */
import { createReadStream, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { detectLanguage, parseFences } from "../src/tagger.ts";

const MIN_FENCES = 50;

// 人工标注的散文围栏(零容忍门禁)。新增:从报告 §3 样本中确认后标注到此。
const PROSE_FIXTURES = [
	"Note: do not run this in production",
	"Warning: experimental feature",
];

const sessionsDir = process.argv[2] ?? join(homedir(), ".pi/agent/sessions");

// 冲突比较前的标签归一化(ts≠typescript 是别名噪音,不是误判)。
const TAG_ALIASES = {
	ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
	js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
	sh: "bash", zsh: "bash", shell: "bash",
	yml: "yaml", py: "python", rb: "ruby", rs: "rust", md: "markdown",
	"c++": "cpp", "c#": "csharp", "f#": "fsharp", "obj-c": "objectivec",
};
const normTag = (tag) => TAG_ALIASES[tag.toLowerCase()] ?? tag.toLowerCase();

// 无类型标注的 TS 与 JS 不可区分,互判不算冲突(报了也是噪音)。
const FAMILY_EQUIV = new Set(["javascript>typescript", "typescript>javascript"]);

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) yield* walk(p);
		else if (name.endsWith(".jsonl")) yield p;
	}
}

async function* assistantTexts(file) {
	const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
	for await (const line of rl) {
		if (!line.includes('"role":"assistant"')) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // 截断行(在写会话)
		}
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		for (const part of entry.message.content ?? []) {
			if (part?.type === "text" && typeof part.text === "string") yield part.text;
		}
	}
}

const stats = {
	fences: 0,
	tagged: 0,
	untagged: 0,
	unclosed: 0,
	detected: new Map(), // lang -> count(无标签块的检出分布)
	undetected: 0,
	conflicts: new Map(), // "detect≠tag" -> {count, sample}
	suspicious: [], // 无标签短内容被判 yaml/bash(散文误报高发区)
};

for (const file of walk(sessionsDir)) {
	for await (const text of assistantTexts(file)) {
		for (const block of parseFences(text)) {
			stats.fences++;
			if (block.closeLine === -1) stats.unclosed++;
			const detected = detectLanguage(block.content.join("\n"));
			if (block.tag) {
				stats.tagged++;
				const norm = normTag(block.tag);
				if (detected && detected !== norm && !FAMILY_EQUIV.has(`${detected}>${norm}`)) {
					const key = `${detected}≠${norm}`;
					const prev = stats.conflicts.get(key) ?? { count: 0, sample: block.content.slice(0, 3).join("\n") };
					prev.count++;
					stats.conflicts.set(key, prev);
				}
			} else {
				stats.untagged++;
				if (detected) {
					stats.detected.set(detected, (stats.detected.get(detected) ?? 0) + 1);
					if ((detected === "yaml" || detected === "bash") && block.content.length <= 3 && stats.suspicious.length < 10) {
						stats.suspicious.push({ lang: detected, file, content: block.content.join("\n").slice(0, 200) });
					}
				} else {
					stats.undetected++;
				}
			}
		}
	}
}

let failed = false;

if (stats.fences < MIN_FENCES) {
	console.error(`FAIL corpus invalid: fences=${stats.fences} < ${MIN_FENCES} (dir=${sessionsDir})`);
	failed = true;
}
for (const prose of PROSE_FIXTURES) {
	const lang = detectLanguage(prose);
	if (lang !== undefined) {
		console.error(`FAIL prose mistagged as ${lang}: ${JSON.stringify(prose)}`);
		failed = true;
	}
}

const pct = (n, d) => (d === 0 ? "0" : ((n / d) * 100).toFixed(1));
console.log(`corpus: ${stats.fences} fences (tagged=${stats.tagged}, untagged=${stats.untagged}, unclosed=${stats.unclosed})`);
console.log(`§1 untagged coverage: detected=${stats.untagged - stats.undetected} (${pct(stats.untagged - stats.undetected, stats.untagged)}%), left-untagged=${stats.undetected}`);
console.log(`  detected histogram: ${[...stats.detected.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" ") || "(none)"}`);
const conflicts = [...stats.conflicts.entries()].sort((a, b) => b[1].count - a[1].count);
console.log(`§2 tag conflicts (detect≠model-tag): ${conflicts.reduce((s, [, v]) => s + v.count, 0)} in ${conflicts.length} pairs`);
for (const [key, v] of conflicts.slice(0, 10)) {
	console.log(`  ${key} ×${v.count}  sample: ${JSON.stringify(v.sample.slice(0, 120))}`);
}
console.log(`§3 suspicious short yaml/bash from untagged (inspect & label): ${stats.suspicious.length}`);
for (const s of stats.suspicious) {
	console.log(`  [${s.lang}] ${JSON.stringify(s.content)}  (${s.file.split("/").slice(-2).join("/")})`);
}

process.exit(failed ? 1 : 0);
