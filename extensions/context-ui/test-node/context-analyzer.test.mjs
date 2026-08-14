import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import { visibleWidth } from "@earendil-works/pi-tui";
import os from "node:os";
import path from "node:path";
import { DEFAULT_COMPACTION_SETTINGS, estimateTokens as estimateMessageTokens } from "@earendil-works/pi-coding-agent";
import { analyzeContext, collectContextInputs } from "../src/context-analyzer.ts";
import {
  clearProviderToolPayloadSnapshot,
  updateProviderToolPayloadSnapshot,
} from "../src/provider-tool-payload.ts";
import { collectAnalyzedContext } from "../src/context-state.ts";
import { formatBranchSummaryLine } from "../src/context-branch-summary.ts";
import { getUsageCategoryLines } from "../src/context-categories.ts";
import { buildOverlayHeaderLines } from "../src/context-overlay-layout.ts";
import {
  formatCategoryColumns,
  measureCategoryColumns,
} from "../src/context-category-layout.ts";
import {
  formatContextWindowLabel,
  formatModelSummaryLine,
  formatUsageHeadline,
} from "../src/context-display.ts";
import {
  getMemoryFileDetailItems,
  getSkillDetailItems,
  getSystemToolDetailItems,
} from "../src/context-detail-sections.ts";
import { buildContextGridBlocks } from "../src/context-grid.ts";
import { formatSymbolCell } from "../src/context-symbols.ts";
import { renderContextHud } from "../src/context-hud.ts";
import {
  buildDetailColumns,
  formatDetailColumnsForWidth,
} from "../src/context-renderer.ts";

test("uses Pi's canonical token estimator", () => {
  const mixedText = "你好ab";
  const expectedTokens = estimateMessageTokens({
    role: "user",
    content: mixedText,
    timestamp: 0,
  });

  const breakdown = analyzeContext({
    usage: null,
    contextWindow: 200000,
    systemPrompt: mixedText,
    activeToolDefs: [],
    messages: [
      {
        role: "user",
        content: mixedText,
      },
    ],
  });

  assert.equal(breakdown.buckets.systemPrompt, expectedTokens);
  assert.equal(breakdown.buckets.userText, expectedTokens);
});

test("uses provider-visible tool payloads instead of local source metadata when estimating system tools", () => {
  const parameters = {
    type: "object",
    properties: {
      path: { type: "string" },
    },
    required: ["path"],
  };
  const expectedToolPayload = {
    type: "function",
    name: "read_file",
    description: "Read a file",
    parameters,
    strict: false,
  };

  const breakdown = analyzeContext({
    usage: null,
    contextWindow: 200000,
    systemPrompt: "",
    modelApi: "openai-responses",
    activeToolDefs: [
      {
        name: "read_file",
        description: "Read a file",
        parameters,
        sourceInfo: {
          path: "/very/long/path/" + "nested/".repeat(200),
          source: "extension",
          scope: "user",
          origin: "top-level",
        },
      },
    ],
    messages: [],
  });

  const expectedTokens = Math.ceil(JSON.stringify(expectedToolPayload).length / 4);
  assert.equal(breakdown.buckets.systemTools, expectedTokens);
  assert.equal(breakdown.details?.systemTools?.[0]?.tokens, expectedTokens);
});

test("uses the selected model context window when live usage is unavailable", async () => {
  const inputs = await collectContextInputs(
    {
      sessionManager: {
        buildSessionContext() {
          return { messages: [] };
        },
      },
      async getContextUsage() {
        return null;
      },
      getSystemPrompt() {
        return "Base prompt";
      },
      model: {
        api: "openai-responses",
        contextWindow: 123456,
      },
    },
    {
      getActiveTools() {
        return [];
      },
      getAllTools() {
        return [];
      },
    },
  );

  assert.equal(inputs.contextWindow, 123456);
});

test("fails fast when neither live usage nor selected model provides a context window", async () => {
  await assert.rejects(
    () => collectContextInputs(
      {
        sessionManager: {
          buildSessionContext() {
            return { messages: [] };
          },
        },
        async getContextUsage() {
          return null;
        },
        getSystemPrompt() {
          return "Base prompt";
        },
      },
      {
        getActiveTools() {
          return [];
        },
        getAllTools() {
          return [];
        },
      },
    ),
    /Context window is unavailable/,
  );
});

test("prefers the latest provider request tool payload when it matches the active tools", async () => {
  clearProviderToolPayloadSnapshot();
  const providerToolPayload = {
    type: "function",
    name: "read_file",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
    strict: false,
    vendorMetadata: "x".repeat(400),
  };
  updateProviderToolPayloadSnapshot({
    tools: [providerToolPayload],
  });

  const inputs = await collectContextInputs(
    {
      sessionManager: {
        buildSessionContext() {
          return { messages: [] };
        },
      },
      async getContextUsage() {
        return { tokens: 100, contextWindow: 1000 };
      },
      getSystemPrompt() {
        return "Base prompt";
      },
      model: {
        api: "openai-responses",
      },
    },
    {
      getActiveTools() {
        return ["read_file"];
      },
      getAllTools() {
        return [
          {
            name: "read_file",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
              },
              required: ["path"],
            },
            sourceInfo: {
              path: "/tmp/read-file.ts",
              source: "extension",
              scope: "user",
              origin: "top-level",
            },
          },
        ];
      },
    },
  );

  const breakdown = analyzeContext(inputs);
  const expectedTokens = Math.ceil(JSON.stringify(providerToolPayload).length / 4);
  assert.equal(breakdown.buckets.systemTools, expectedTokens);
  clearProviderToolPayloadSnapshot();
});

test("anchors messages to pi usage and subtracts the full estimated total from available", () => {
  // pi 的 getContextUsage().tokens = estimateContextTokens(messages) = 仅消息
  // (数组分支不含 systemPrompt/tools)。它应作为消息锚点,prefix 叠加后
  // 再算 available——漏减 prefix 会让可用空间系统性偏大。
  const breakdown = analyzeContext({
    usage: { tokens: 800, contextWindow: 10000 },
    contextWindow: 10000,
    systemPrompt: "s".repeat(2000), // 500 tokens
    activeToolDefs: [],
    messages: [
      { role: "user", content: "m".repeat(400) }, // 100 tokens
    ],
  });

  assert.equal(breakdown.measuredTotal, 800);
  assert.equal(breakdown.estimatedTotal, 1300); // 800(消息)+ 500(system prompt)
  assert.equal(breakdown.available, 8700); // 10000 − 1300,不漏 prefix
  // 无锚点(消息无 usage):delta 不定义,无吸收
  assert.equal(breakdown.delta, null);
  assert.equal(breakdown.buckets.custom, 0);
  assert.equal(breakdown.confidence, "estimated"); // 无锚点参照,纯估算
});

test("with an assistant usage anchor, usage tokens are the full server total (no prefix double-count)", () => {
  // “hi” 会话实测:assistant 的 usage.totalTokens = 服务端全量输入
  // (system prompt/tools 已含在 input/cacheRead 里)。叠加 prefix 即双重计算。
  const breakdown = analyzeContext({
    usage: { tokens: 6000, contextWindow: 1000000 },
    contextWindow: 1000000,
    systemPrompt: "s".repeat(16000), // ~4000 tok
    activeToolDefs: [],
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "text", text: "你好" }],
        stopReason: "stop",
        usage: {
          input: 5000,
          output: 800,
          cacheRead: 200,
          cacheWrite: 0,
          totalTokens: 6000,
          cost: { total: 0 },
        },
      },
    ],
  });

  assert.equal(breakdown.estimatedTotal, 6000); // 服务端全量,不再叠加 prefix
  assert.equal(breakdown.available, 1000000 - 6000);
  // delta = 实测全量 − 自算全量(独立呈现,不吸收进任何桶)
  assert.equal(breakdown.delta, 6000 - (4000 + 2));
  // 桶 = 纯自算:消息桶显示真实消息量,差额由 delta 行承载
  assert.equal(breakdown.buckets.custom, 0);
  assert.equal(breakdown.categoryBreakdown.messages, 2);
  assert.equal(sumBuckets(breakdown.buckets), 4000 + 2);
});

function sumBuckets(buckets) {
  return Object.values(buckets).reduce((a, v) => a + v, 0);
}

test("counts compaction and branch summaries in the summaries bucket", () => {
  const compactionSummary = "x".repeat(200); // 50 tokens
  const branchSummary = "y".repeat(120); // 30 tokens

  const breakdown = analyzeContext({
    // usage 为 null:测纯估算分类路径(usage.tokens 已含 summaries,见锚点测试)
    usage: null,
    contextWindow: 200000,
    systemPrompt: "",
    activeToolDefs: [],
    messages: [
      {
        role: "compactionSummary",
        summary: compactionSummary,
        tokensBefore: 500,
      },
      {
        role: "branchSummary",
        summary: branchSummary,
        fromId: "tag-1",
      },
    ],
  });

  assert.equal(breakdown.buckets.summaries, 80);
  assert.equal(breakdown.estimatedTotal, 80);
  assert.deepEqual(breakdown.details?.summaryBreakdown, {
    branchSummaries: 30,
    compactionSummaries: 50,
  });
  assert.equal(
    breakdown.categoryBreakdown.autocompactBuffer,
    DEFAULT_COMPACTION_SETTINGS.reserveTokens,
  );

  const categoryLines = getUsageCategoryLines(breakdown);
  assert.equal(categoryLines[0]?.label, "System prompt");
  assert.equal(categoryLines[4]?.label, "Messages");
  assert.equal(categoryLines[5]?.label, "Free space");
  assert.equal(categoryLines[6]?.label, "Autocompact buffer");
  assert.equal(categoryLines[0]?.value, 0);
});


test("renders autocompact buffer as trailing tail blocks after free space", () => {
  const breakdown = analyzeContext({
    usage: null,
    contextWindow: 200000,
    systemPrompt: "s".repeat(80),
    activeToolDefs: [],
    messages: [
      { role: "user", content: "u".repeat(120) },
      {
        role: "compactionSummary",
        summary: "c".repeat(200),
        tokensBefore: 400,
      },
    ],
  });

  const blocks = buildContextGridBlocks(
    getUsageCategoryLines(breakdown),
    breakdown.contextWindow,
    10,
    10,
  );

  const tailBlockCount = Math.round(
    (DEFAULT_COMPACTION_SETTINGS.reserveTokens / breakdown.contextWindow) * 100,
  );
  assert.equal(blocks.at(-1)?.label, "Autocompact buffer");
  assert.equal(blocks.at(-tailBlockCount)?.label, "Autocompact buffer");
  assert.equal(blocks.at(-(tailBlockCount + 1))?.label, "Free space");
});

test("tracks fractional cell fullness for proportional grid rendering", () => {
  const breakdown = analyzeContext({
    usage: null,
    contextWindow: 100000,
    systemPrompt: "s".repeat(10000), // 2500 tokens => 2.5 cells in a 10x10 grid
    activeToolDefs: [],
    messages: [],
  });

  const blocks = buildContextGridBlocks(
    getUsageCategoryLines(breakdown),
    breakdown.contextWindow,
    10,
    10,
  );

  assert.equal(blocks[0]?.label, "System prompt");
  assert.equal(blocks[1]?.label, "System prompt");
  assert.equal(blocks[2]?.label, "System prompt");
  assert.equal(blocks[0]?.squareFullness, 1);
  assert.equal(blocks[1]?.squareFullness, 1);
  assert.equal(blocks[2]?.squareFullness, 0.5);
});

test("collects analyzed context once for both breakdown and history consumers", async () => {
  const result = await collectAnalyzedContext(
    {
      sessionManager: {
        buildSessionContext() {
          return {
            messages: [{ role: "user", content: "hello world" }],
          };
        },
        getBranch() {
          return [
            { id: "root", type: "message", message: { role: "user", content: "start" } },
            { id: "tagged", type: "message", message: { role: "assistant", content: "ok" } },
            { id: "head", type: "message", message: { role: "user", content: "hello world" } },
          ];
        },
        getLabel(id) {
          return id === "tagged" ? "checkpoint" : undefined;
        },
      },
      async getContextUsage() {
        return { tokens: 200, contextWindow: 1000 };
      },
      getSystemPrompt() {
        return "Base prompt";
      },
    },
    {
      getActiveTools() {
        return [];
      },
      getAllTools() {
        return [];
      },
    },
  );

  assert.equal(result.breakdown.measuredTotal, 200);
  assert.equal(result.history.nearestTag, "checkpoint");
  assert.equal(result.history.tagDistance, 1);
});

test("normalizes ambiguous-width symbol cells for aligned output", () => {
  assert.equal(formatSymbolCell("⛁", true), "⛁ ");
  assert.equal(formatSymbolCell("⛀", true), "⛀ ");
  assert.equal(formatSymbolCell("⛶", true), "⛶");
  assert.equal(formatSymbolCell("⛝", true), "⛝");
  assert.equal(formatSymbolCell("⛝", false), "⛝ ");
});

test("places branch summary directly under the model header", () => {
  const breakdown = {
    measuredTotal: 8900,
    contextWindow: 500000,
    available: 0,
    estimatedTotal: 8900,
    buckets: {
      systemPrompt: 0,
      systemTools: 0,
      skills: 0,
      memory: 0,
      userText: 0,
      assistantText: 0,
      assistantThinking: 0,
      toolCalls: 0,
      toolResults: 0,
      images: 0,
      summaries: 0,
      custom: 0,
    },
    categoryBreakdown: {
      systemPrompt: 0,
      systemTools: 0,
      skills: 0,
      memoryFiles: 0,
      messages: 0,
      autocompactBuffer: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
      freeSpace: 0,
      extensionOverhead: 0,
    },
    delta: 0,
    confidence: "measured",
    metadata: {
      compactionDetected: false,
      hasPostCompactionData: true,
      buildSessionContextMessageCount: 0,
    },
  };

  assert.deepEqual(
    buildOverlayHeaderLines(
      "GPT-5.4",
      breakdown,
      {
        branchDepth: 3,
        tagDistance: 2,
        nearestTag: "root",
        summaryCount: 0,
        compactionCount: 0,
      },
    ),
    [
      "GPT-5.4 (500k context)  8.9k/500k tokens (1.8%)",
      "Branch: Messages 0 · Segment 2 steps since 'root'",
    ],
  );
});

test("formats branch metrics into a single summary line for the upper sidebar", () => {
  assert.equal(
    formatBranchSummaryLine(
      {
        branchDepth: 3,
        tagDistance: 2,
        nearestTag: "root",
        summaryCount: 0,
        compactionCount: 1,
      },
      0,
    ),
    "Branch: Messages 0 · Segment 2 steps since 'root' · Compactions 1",
  );
});

test("aligns category token and percent columns using shared widths", () => {
  const categories = [
    {
      label: "System prompt",
      value: 3000,
      percent: 0.5,
      color: "dim",
      icon: "⛁",
    },
    {
      label: "Autocompact buffer",
      value: 16384,
      percent: 3.3,
      color: "mdQuote",
      icon: "⛝",
    },
    {
      label: "Free space",
      value: 474000,
      percent: 94.8,
      color: "borderMuted",
      icon: "⛶",
    },
  ];

  const widths = measureCategoryColumns(categories);
  const rows = categories.map((category) =>
    formatCategoryColumns(category, widths),
  );

  assert.deepEqual(rows.map((row) => row.label.length), [19, 19, 19]);
  assert.deepEqual(rows.map((row) => row.value.length), [4, 4, 4]);
  assert.deepEqual(rows.map((row) => row.percent.length), [5, 5, 5]);
  assert.equal(rows[0]?.value, "  3k");
  assert.equal(rows[1]?.value, " 16k");
  assert.equal(rows[2]?.value, "474k");
});

test("formats model context labels and usage headlines for the overlay header", () => {
  const breakdown = {
    measuredTotal: 104800,
    contextWindow: 1000000,
    available: 0,
    estimatedTotal: 100000,
    buckets: {
      systemPrompt: 0,
      systemTools: 0,
      skills: 0,
      memory: 0,
      userText: 0,
      assistantText: 0,
      assistantThinking: 0,
      toolCalls: 0,
      toolResults: 0,
      images: 0,
      summaries: 0,
      custom: 0,
    },
    categoryBreakdown: {
      systemPrompt: 0,
      systemTools: 0,
      skills: 0,
      memoryFiles: 0,
      messages: 0,
      autocompactBuffer: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
      freeSpace: 0,
      extensionOverhead: 0,
    },
    delta: 0,
    confidence: "measured",
    metadata: {
      compactionDetected: false,
      hasPostCompactionData: true,
      buildSessionContextMessageCount: 0,
    },
  };

  assert.equal(formatContextWindowLabel(1000000), "1M context");
  assert.equal(
    formatUsageHeadline(breakdown),
    "104.8k/1M tokens (10.5%)",
  );
  assert.equal(
    formatModelSummaryLine("GPT-5.4", breakdown),
    "GPT-5.4 (1M context)  104.8k/1M tokens (10.5%)",
  );
});

test("shows unknown headline plus estimation notes after compaction", () => {
  const breakdown = {
    measuredTotal: null,
    contextWindow: 200000,
    available: 199820,
    estimatedTotal: 180,
    buckets: {
      systemPrompt: 40,
      systemTools: 20,
      skills: 30,
      memory: 10,
      userText: 50,
      assistantText: 20,
      assistantThinking: 10,
      toolCalls: 0,
      toolResults: 0,
      images: 0,
      summaries: 0,
      custom: 0,
    },
    categoryBreakdown: {
      systemPrompt: 40,
      systemTools: 20,
      skills: 30,
      memoryFiles: 10,
      messages: 80,
      autocompactBuffer: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
      freeSpace: 199820 - DEFAULT_COMPACTION_SETTINGS.reserveTokens,
      extensionOverhead: 100,
    },
    delta: null,
    confidence: "estimated",
    metadata: {
      compactionDetected: true,
      hasPostCompactionData: false,
      buildSessionContextMessageCount: 2,
    },
  };

  assert.equal(formatUsageHeadline(breakdown), "?/200k tokens");
  assert.deepEqual(
    buildOverlayHeaderLines(
      "GPT-5.4",
      breakdown,
      {
        branchDepth: 2,
        tagDistance: 1,
        nearestTag: "checkpoint",
        summaryCount: 1,
        compactionCount: 1,
      },
    ),
    [
      "GPT-5.4 (200k context)  ?/200k tokens",
      "Estimated split 180/200k tokens (0.1%)",
      "Exact usage is unknown after compaction until the next response. Footer and /context show ?; section totals below are estimated.",
      "Branch: Messages 2 · Segment 1 steps since 'checkpoint' · Summaries 1 · Compactions 1",
    ],
  );

  const hud = renderContextHud(breakdown, {
    branchDepth: 2,
    tagDistance: 1,
    nearestTag: "checkpoint",
    summaryCount: 1,
    compactionCount: 1,
  });

  assert.match(hud, /• Usage:\s+\? \(200k window\)/);
  assert.match(hud, /• Estimated split:\s+180\/200k tokens \(0.1%\)/);
  assert.match(hud, /Exact usage is unknown after compaction until the next response/);
});

test("builds memory-file and skill detail items for the overlay sections", () => {
  const breakdown = analyzeContext({
    usage: null,
    contextWindow: 200000,
    systemPrompt: "base prompt",
    activeToolDefs: [],
    memoryContent: [
      "## MEMORY.md",
      "",
      "- TODO.md — current plan",
      "",
      "## TODO.md",
      "",
      "- ship context overlay",
    ].join("\n"),
    skillsContent: [
      "<available_skills>",
      "  <skill><name>team</name><description>Parallel work</description></skill>",
      "  <skill><name>ascii-diagram</name><description>Render diagrams</description></skill>",
      "</available_skills>",
    ].join("\n"),
    messages: [],
  });

  assert.deepEqual(getMemoryFileDetailItems(breakdown), [
    { label: "MEMORY.md", tokens: 7 },
    { label: "TODO.md", tokens: 6 },
    {
      label: "Prompt wrapper",
      tokens: breakdown.buckets.memory - 13,
    },
  ]);
  assert.deepEqual(getSkillDetailItems(breakdown), [
    { label: "team", tokens: 18 },
    { label: "ascii-diagram", tokens: 21 },
    {
      label: "Prompt wrapper",
      tokens: breakdown.buckets.skills - 39,
    },
  ]);
});

test("uses spare horizontal space to widen the right detail column", () => {
  const columns = {
    left: ["System tools", "  └ read: 28 tokens"],
    right: [
      "Memory files",
      "  └ autoresearch-finalize: 105 tokens",
      "",
      "Skills",
      "  └ pi-diff-review/src/index.ts: 123 tokens",
    ],
  };

  const formatted = formatDetailColumnsForWidth(columns, 72);
  assert.equal(formatted.leftWidth, 19);
  assert.equal(formatted.rightWidth, 49);
});

test("formats detail columns within the available width without wrapping token suffixes", () => {
  const toolDef = {
    name: "pi-diff-review/src/index.ts",
    description: "Read file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  };

  const breakdown = analyzeContext({
    usage: null,
    contextWindow: 200000,
    systemPrompt: "base prompt",
    modelApi: "openai-responses",
    activeToolDefs: [toolDef],
    memoryContent: "## MEMORY.md\n\n- TODO.md — current plan",
    skillsContent: "<available_skills><skill><name>autoresearch-finalize</name></skill></available_skills>",
    messages: [],
  });

  const columns = buildDetailColumns(breakdown, 80);
  const formatted = formatDetailColumnsForWidth(columns, 72);

  for (const line of formatted.left) {
    assert.ok(visibleWidth(line) <= formatted.leftWidth);
  }
  for (const line of formatted.right) {
    assert.ok(visibleWidth(line) <= formatted.rightWidth);
  }
  assert.match(formatted.right.at(-1) ?? "", /tokens$/);
  assert.doesNotMatch(
    formatted.right[1] ?? "",
    /\s{2,}: \d+ tokens$/,
  );
});

test("arranges detail sections into a dual-column layout with system tools on the left", () => {
  const toolDef = {
    name: "read",
    description: "Read file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  };

  const breakdown = analyzeContext({
    usage: null,
    contextWindow: 200000,
    systemPrompt: "base prompt",
    modelApi: "openai-responses",
    activeToolDefs: [toolDef],
    memoryContent: "## MEMORY.md\n\n- TODO.md — current plan",
    skillsContent: "<available_skills><skill><name>team</name></skill></available_skills>",
    messages: [],
  });

  const columns = buildDetailColumns(breakdown, 56);
  assert.equal(columns.left[0], "System tools");
  assert.match(columns.left[1], /^  └ read:/);
  assert.equal(columns.right[0], "Memory files");
  assert.match(columns.right[1], /^  └ MEMORY\.md:/);
  assert.ok(columns.right.includes("Skills"));
});

test("builds system-tool detail items for the overlay sections", () => {
  const toolDef = {
    name: "read",
    description: "Read file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  };

  const breakdown = analyzeContext({
    usage: null,
    contextWindow: 200000,
    systemPrompt: "base prompt",
    modelApi: "openai-responses",
    activeToolDefs: [toolDef],
    messages: [],
  });

  assert.deepEqual(getSystemToolDetailItems(breakdown), [
    {
      label: "read",
      tokens: Math.ceil(
        JSON.stringify({
          type: "function",
          name: "read",
          description: "Read file",
          parameters: toolDef.parameters,
          strict: false,
        }).length / 4,
      ),
    },
  ]);
});

test("shows shared memory and free space even before the first message", () => {
  const breakdown = analyzeContext({
    usage: null,
    contextWindow: 200000,
    systemPrompt: "s".repeat(80),
    activeToolDefs: [{ name: "read", description: "Read file", parameters: { type: "object" } }],
    memoryContent: "## MEMORY.md\n\n- TODO.md — current plan",
    skillsContent: "<available_skills><skill><name>team</name></skill></available_skills>",
    messages: [],
  });

  assert.deepEqual(
    getUsageCategoryLines(breakdown).map((line) => line.label),
    [
      "System prompt",
      "System tools",
      "Skills",
      "Memory files",
      "Messages",
      "Free space",
      "Autocompact buffer",
    ],
  );
  assert.equal(getUsageCategoryLines(breakdown)[4]?.value, 0);
});

test("explains attribution drift when measured total exceeds the estimated split", () => {
  const breakdown = {
    measuredTotal: 400,
    contextWindow: 1000,
    available: 600,
    estimatedTotal: 250,
    buckets: {
      systemPrompt: 60,
      systemTools: 40,
      skills: 10,
      memory: 20,
      userText: 80,
      assistantText: 90,
      assistantThinking: 50,
      toolCalls: 20,
      toolResults: 30,
      images: 0,
      summaries: 0,
      custom: 0,
    },
    categoryBreakdown: {
      systemPrompt: 60,
      systemTools: 40,
      skills: 10,
      memoryFiles: 20,
      messages: 270,
      autocompactBuffer: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
      freeSpace: 600 - DEFAULT_COMPACTION_SETTINGS.reserveTokens,
      extensionOverhead: 130,
    },
    delta: 150,
    confidence: "mixed",
    metadata: {
      compactionDetected: false,
      hasPostCompactionData: true,
      buildSessionContextMessageCount: 3,
    },
  };

  const hud = renderContextHud(breakdown, {
    branchDepth: 1,
    tagDistance: 0,
    nearestTag: null,
    summaryCount: 0,
    compactionCount: 0,
  });

  assert.match(hud, /Attribution:/);
  assert.match(hud, /Delta:/);
  assert.match(hud, /150/);
  assert.match(hud, /unattributed/);
});

test("builds screenshot-style usage categories and exposes them in the HUD", () => {
  const systemPrompt = "s".repeat(80); // 20 tokens
  const toolDef = {
    name: "read",
    description: "Read file",
    parameters: { type: "object" },
  };
  const memoryContent = "# Memory\n" + "m".repeat(40); // 13 tokens
  const skillsContent = "<available_skills>skill</available_skills>"; // 11 tokens
  const userText = "u".repeat(120); // 30 tokens
  const compactionSummary = "c".repeat(200); // 50 tokens

  const breakdown = analyzeContext({
    usage: null,
    contextWindow: 200000,
    systemPrompt,
    activeToolDefs: [toolDef],
    memoryContent,
    skillsContent,
    messages: [
      { role: "user", content: userText },
      {
        role: "compactionSummary",
        summary: compactionSummary,
        tokensBefore: 400,
      },
    ],
  });

  const categoryLines = getUsageCategoryLines(breakdown);
  assert.deepEqual(
    categoryLines.map((line) => [line.label, line.value]),
    [
      ["System prompt", 20],
      ["System tools", Math.ceil(JSON.stringify(toolDef).length / 4)],
      ["Skills", 11],
      ["Memory files", 13],
      ["Messages", 80],
      [
        "Free space",
        200000 - breakdown.estimatedTotal - DEFAULT_COMPACTION_SETTINGS.reserveTokens,
      ],
      ["Autocompact buffer", DEFAULT_COMPACTION_SETTINGS.reserveTokens],
    ],
  );

  const hud = renderContextHud(breakdown, {
    branchDepth: 1,
    tagDistance: 0,
    nearestTag: null,
    summaryCount: 0,
    compactionCount: 1,
  });

  for (const label of categoryLines.map((line) => line.label)) {
    assert.match(hud, new RegExp(`${label}:`));
  }
});
