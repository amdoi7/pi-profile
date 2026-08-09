/**
 * Pure context analysis layer.
 * Collects working context with detailed segmentation:
 * - System prompt split into sections
 * - System tools separated from skills
 * - Memory files tracked individually
 * - Message types fine-grained
 */

import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens as estimateMessageTokens,
  type ExtensionAPI,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import type {
  ContextBreakdown,
  SystemPromptSectionDetail,
  MemoryFileDetail,
  SystemToolDetail,
  SkillDetail,
  MessageBreakdown,
  SummaryBreakdown,
} from "./types.ts";
import { getProviderToolPayloadSnapshot } from "./provider-tool-payload.ts";

const estimateTokens = (text: string): number => estimateMessageTokens({
  role: "user",
  content: text,
  timestamp: 0,
});

/** Extract plain text from message content. */
function extractText(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => ("text" in part && part.type === "text" ? (part as TextContent).text : ""))
      .join(" ")
      .trim();
  }
  return "";
}

/**
 * Split system prompt into named sections by markdown headers.
 */
function splitSystemPromptSections(prompt: string): SystemPromptSectionDetail[] {
  if (!prompt) return [];
  const sections: SystemPromptSectionDetail[] = [];
  const lines = prompt.split("\n");
  let currentName = "Preamble";
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join("\n");
    if (text.trim().length > 0) {
      sections.push({ name: currentName, tokens: estimateTokens(text) });
    }
    buffer = [];
  };

  for (const line of lines) {
    const m = line.match(/^#{1,2}\s+(.+?)\s*$/);
    if (m) {
      flush();
      currentName = m[1].trim();
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * Split memory content into per-file entries when the system prompt contains memory sections.
 */
function splitMemoryFiles(memory: string): MemoryFileDetail[] {
  if (!memory) return [];
  const files: MemoryFileDetail[] = [];
  const lines = memory.split("\n");
  let currentPath: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join("\n");
    if (currentPath !== null && text.trim().length > 0) {
      files.push({
        path: currentPath,
        type: currentPath.includes("TODO")
          ? "todo"
          : currentPath.includes("LESSONS")
            ? "lessons"
            : "memory",
        tokens: estimateTokens(text),
      });
    }
    buffer = [];
  };

  for (const line of lines) {
    const m = line.match(/^#{2,3}\s+(.+?)\s*$/);
    if (m) {
      flush();
      currentPath = m[1].trim();
      continue;
    }

    buffer.push(line);
  }
  flush();
  return files;
}

function splitSkillDetails(skillsContent: string): SkillDetail[] {
  if (!skillsContent) return [];

  const skills: SkillDetail[] = [];
  const skillMatches = skillsContent.matchAll(/<skill>([\s\S]*?)<\/skill>/g);

  for (const match of skillMatches) {
    const fullBlock = match[0];
    const inner = match[1] ?? "";
    const nameMatch = inner.match(/<name>([\s\S]*?)<\/name>/);
    skills.push({
      name: nameMatch ? nameMatch[1].trim() : "<skill>",
      tokens: estimateTokens(fullBlock),
    });
  }

  if (skills.length === 0) {
    return [{ name: "<available_skills>", tokens: estimateTokens(skillsContent) }];
  }

  return skills;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireToolString(value: unknown, fieldName: string, toolIndex: number): string {
  if (typeof value !== "string") {
    throw new Error(`System tool payload ${toolIndex} is missing string field "${fieldName}".`);
  }
  return value;
}

function requireToolDefinitionString(value: unknown, fieldName: string, toolName: string): string {
  if (typeof value !== "string") {
    throw new Error(`System tool definition "${toolName}" is missing string field "${fieldName}".`);
  }
  return value;
}

function extractPayloadToolName(toolPayload: unknown, toolIndex: number): string {
  if (!isRecord(toolPayload)) {
    throw new Error(`System tool payload ${toolIndex} must be an object.`);
  }
  if ("name" in toolPayload) {
    return requireToolString(toolPayload.name, "name", toolIndex);
  }
  if (!("function" in toolPayload)) {
    throw new Error(`System tool payload ${toolIndex} is missing a top-level name.`);
  }
  const fn = toolPayload.function;
  if (!isRecord(fn)) {
    throw new Error(`System tool payload ${toolIndex} has a non-object function wrapper.`);
  }
  if (!("name" in fn)) {
    throw new Error(`System tool payload ${toolIndex} is missing function.name.`);
  }
  return requireToolString(fn.name, "function.name", toolIndex);
}

function requireToolSchemaObject(parameters: unknown, toolName: string): Record<string, unknown> {
  if (!isRecord(parameters)) {
    throw new Error(`System tool definition "${toolName}" has a non-object parameter schema.`);
  }
  return parameters;
}

function buildAnthropicInputSchema(parameters: unknown, toolName: string) {
  const schema = requireToolSchemaObject(parameters, toolName);
  const propertiesValue = schema.properties;
  if (propertiesValue !== undefined && !isRecord(propertiesValue)) {
    throw new Error(`System tool definition "${toolName}" has a non-object properties schema.`);
  }
  const requiredValue = schema.required;
  if (requiredValue !== undefined && !Array.isArray(requiredValue)) {
    throw new Error(`System tool definition "${toolName}" has a non-array required schema.`);
  }

  return {
    type: "object",
    properties: propertiesValue === undefined ? {} : propertiesValue,
    required: requiredValue === undefined ? [] : requiredValue,
  };
}

function buildEstimatedToolPayload(tool: any, modelApi: string | undefined): unknown {
  const name = requireToolDefinitionString(tool.name, "name", String(tool.name));
  const description = requireToolDefinitionString(tool.description, "description", name);
  const parameters = tool.parameters;
  const normalizedApi = typeof modelApi === "string" ? modelApi.toLowerCase() : undefined;

  if (normalizedApi?.includes("anthropic")) {
    return {
      name,
      description,
      input_schema: buildAnthropicInputSchema(parameters, name),
    };
  }

  if (normalizedApi?.includes("openai") && normalizedApi.includes("responses")) {
    return {
      type: "function",
      name,
      description,
      parameters,
      strict: false,
    };
  }

  if (normalizedApi?.includes("openai")) {
    return {
      type: "function",
      function: {
        name,
        description,
        parameters,
        strict: false,
      },
    };
  }

  if (normalizedApi?.includes("google")) {
    return {
      name,
      description,
      parametersJsonSchema: parameters,
    };
  }

  return {
    name,
    description,
    parameters,
  };
}

const AVAILABLE_TOOLS_SECTION_START = "Available tools:\n";
const AVAILABLE_TOOLS_SECTION_END = "\n\nIn addition to the tools above";
const GUIDELINES_SECTION_START = "Guidelines:\n";
const GUIDELINES_SECTION_END = "\n\nPi documentation";

function normalizePromptSnippetForAttribution(text: string): string | undefined {
  const oneLine = text
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return oneLine.length > 0 ? oneLine : undefined;
}

function normalizePromptGuidelineForAttribution(text: string): string | undefined {
  const normalized = text.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function collectToolPromptAttributionFields(toolDef: any): { snippet?: string; guidelines: string[] } {
  const snippet = typeof toolDef.promptSnippet === "string"
    ? normalizePromptSnippetForAttribution(toolDef.promptSnippet)
    : undefined;

  const guidelineSet = new Set<string>();
  if (Array.isArray(toolDef.promptGuidelines)) {
    for (const guideline of toolDef.promptGuidelines) {
      if (typeof guideline !== "string") {
        continue;
      }
      const normalized = normalizePromptGuidelineForAttribution(guideline);
      if (normalized) {
        guidelineSet.add(normalized);
      }
    }
  }

  return {
    snippet,
    guidelines: Array.from(guidelineSet),
  };
}

function findSectionRange(text: string, startMarker: string, endMarker: string): { start: number; end: number } | null {
  const markerIndex = text.indexOf(startMarker);
  if (markerIndex < 0) {
    return null;
  }

  const start = markerIndex + startMarker.length;
  const end = text.indexOf(endMarker, start);
  if (end < 0 || end < start) {
    return null;
  }

  return { start, end };
}

function removeFirstSectionLine(sectionBody: string, targetLine: string): { nextBody: string; removedLineText: string | null } {
  const lines = sectionBody.split("\n");
  const index = lines.findIndex((line) => line === targetLine);
  if (index < 0) {
    return {
      nextBody: sectionBody,
      removedLineText: null,
    };
  }

  lines.splice(index, 1);
  const hadTrailingNewline = sectionBody.endsWith("\n");
  let nextBody = lines.join("\n");
  if (hadTrailingNewline && nextBody.length > 0) {
    nextBody += "\n";
  }

  return {
    nextBody,
    removedLineText: `${targetLine}\n`,
  };
}

function extractLineFromSection(
  text: string,
  startMarker: string,
  endMarker: string,
  targetLine: string,
): { remaining: string; removedLineText: string | null } {
  const range = findSectionRange(text, startMarker, endMarker);
  if (range === null) {
    return {
      remaining: text,
      removedLineText: null,
    };
  }

  const sectionBody = text.slice(range.start, range.end);
  const removed = removeFirstSectionLine(sectionBody, targetLine);
  if (removed.removedLineText === null) {
    return {
      remaining: text,
      removedLineText: null,
    };
  }

  return {
    remaining: text.slice(0, range.start) + removed.nextBody + text.slice(range.end),
    removedLineText: removed.removedLineText,
  };
}

function extractToolPromptAttribution(systemPrompt: string, activeToolDefs: any[]): {
  strippedPrompt: string;
  toolPromptTokensByName: Map<string, number>;
} {
  let strippedPrompt = systemPrompt;
  const toolPromptTokensByName = new Map<string, number>();
  let firstAttributedToolName: string | null = null;

  for (const toolDef of activeToolDefs) {
    if (!isRecord(toolDef) || typeof toolDef.name !== "string") {
      continue;
    }
    const toolName = toolDef.name;
    const fields = collectToolPromptAttributionFields(toolDef);

    if (fields.snippet) {
      const snippetLine = `- ${toolName}: ${fields.snippet}`;
      const extractedSnippet = extractLineFromSection(
        strippedPrompt,
        AVAILABLE_TOOLS_SECTION_START,
        AVAILABLE_TOOLS_SECTION_END,
        snippetLine,
      );
      if (extractedSnippet.removedLineText !== null) {
        strippedPrompt = extractedSnippet.remaining;
        const movedTokens = estimateTokens(extractedSnippet.removedLineText);
        if (firstAttributedToolName === null) {
          firstAttributedToolName = toolName;
        }
        toolPromptTokensByName.set(toolName, (toolPromptTokensByName.get(toolName) ?? 0) + movedTokens);
      }
    }

    for (const guideline of fields.guidelines) {
      const guidelineLine = `- ${guideline}`;
      const extractedGuideline = extractLineFromSection(
        strippedPrompt,
        GUIDELINES_SECTION_START,
        GUIDELINES_SECTION_END,
        guidelineLine,
      );
      if (extractedGuideline.removedLineText === null) {
        continue;
      }
      strippedPrompt = extractedGuideline.remaining;
      const movedTokens = estimateTokens(extractedGuideline.removedLineText);
      if (firstAttributedToolName === null) {
        firstAttributedToolName = toolName;
      }
      toolPromptTokensByName.set(toolName, (toolPromptTokensByName.get(toolName) ?? 0) + movedTokens);
    }
  }

  if (firstAttributedToolName !== null && toolPromptTokensByName.size > 0) {
    const movedByDelta = Math.max(0, estimateTokens(systemPrompt) - estimateTokens(strippedPrompt));
    let movedByLines = 0;
    for (const moved of toolPromptTokensByName.values()) {
      movedByLines += moved;
    }
    const delta = movedByDelta - movedByLines;
    if (delta !== 0) {
      const current = toolPromptTokensByName.get(firstAttributedToolName) ?? 0;
      const adjusted = Math.max(0, current + delta);
      toolPromptTokensByName.set(firstAttributedToolName, adjusted);
    }
  }

  return {
    strippedPrompt,
    toolPromptTokensByName,
  };
}

function buildSystemToolDetails(inputs: {
  activeToolDefs: any[];
  providerToolPayloads?: unknown[];
  modelApi?: string;
  toolPromptTokensByName?: Map<string, number>;
}): SystemToolDetail[] {
  const payloadDetails = Array.isArray(inputs.providerToolPayloads) && inputs.providerToolPayloads.length > 0
    ? inputs.providerToolPayloads.map((toolPayload, index) => ({
      name: extractPayloadToolName(toolPayload, index),
      tokens: estimateTokens(JSON.stringify(toolPayload)),
    }))
    : inputs.activeToolDefs.map((toolDef, index) => {
      const payload = buildEstimatedToolPayload(toolDef, inputs.modelApi);
      const name = extractPayloadToolName(payload, index);
      return {
        name,
        tokens: estimateTokens(JSON.stringify(payload)),
      };
    });

  if (!inputs.toolPromptTokensByName || inputs.toolPromptTokensByName.size === 0) {
    return payloadDetails;
  }

  const details = payloadDetails.map((item) => ({ ...item }));
  for (const [toolName, movedTokens] of inputs.toolPromptTokensByName.entries()) {
    if (movedTokens <= 0) {
      continue;
    }
    const existing = details.find((item) => item.name === toolName);
    if (existing) {
      existing.tokens += movedTokens;
      continue;
    }
    details.push({
      name: toolName,
      tokens: movedTokens,
    });
  }

  return details;
}

/**
 * Carve out named sub-sections of the full system prompt so they can be
 * attributed to the right bucket.
 *
 * Pi injects several overlapping things into the one `systemPrompt` blob:
 *  - the base agent prompt (tool registry, guidelines, ...)
 *  - `<available_skills>` XML block produced by formatSkillsForPrompt()
 *  - an optional `# Memory` section appended by the memory extension
 *    during `before_agent_start`
 *
 * We extract the skills and memory slices so they show up as their own
 * buckets, and the remainder is attributed to `systemPrompt`.
 */
function sliceSystemPrompt(systemPrompt: string): {
  base: string;
  skillsBlock: string;
  memoryBlock: string;
} {
  let base = systemPrompt;
  let memoryBlock = "";
  let skillsBlock = "";

  // Memory is appended at the tail by the memory extension as "# Memory\n...".
  // Keep the instructional preamble in the system prompt bucket, but split
  // out the actual injected file payload (## MEMORY.md, ## TODO.md, ...)
  // into the memory bucket.
  const memoryMarker = base.indexOf("\n# Memory\n");
  if (memoryMarker > -1) {
    const memorySection = base.substring(memoryMarker);
    const firstMemoryFileHeading = memorySection.search(/\n#{2,3}\s+/);
    if (firstMemoryFileHeading > -1) {
      memoryBlock = memorySection.substring(firstMemoryFileHeading + 1);
      base =
        base.substring(0, memoryMarker) +
        memorySection.substring(0, firstMemoryFileHeading + 1);
    }
  }

  // Skills are embedded as a <available_skills>...</available_skills>
  // block, preceded by a short preamble line introducing them. Keep the
  // prose preamble in the system prompt bucket and attribute only the XML
  // payload to the skills bucket.
  const skillsOpen = base.indexOf("<available_skills>");
  const skillsClose = base.indexOf("</available_skills>");
  if (skillsOpen > -1 && skillsClose > skillsOpen) {
    const end = skillsClose + "</available_skills>".length;
    skillsBlock = base.substring(skillsOpen, end);
    base = base.substring(0, skillsOpen) + base.substring(end);
  }

  return { base, skillsBlock, memoryBlock };
}

/**
 * Collect context inputs with detailed structure.
 */
function resolveContextWindow(ctx: { model?: { contextWindow?: unknown } }, usage: unknown): number {
  if (typeof usage === "object" && usage !== null && "contextWindow" in usage) {
    const usageContextWindow = (usage as { contextWindow?: unknown }).contextWindow;
    if (typeof usageContextWindow === "number") {
      return usageContextWindow;
    }
    throw new Error("Context usage reported a non-numeric contextWindow.");
  }

  if (ctx.model === undefined) {
    throw new Error("Context window is unavailable because no model is selected.");
  }
  if (typeof ctx.model.contextWindow !== "number") {
    throw new Error("Context window is unavailable because the selected model has no numeric contextWindow.");
  }
  return ctx.model.contextWindow;
}

export async function collectContextInputs(ctx: any, pi: ExtensionAPI) {
  const sm = ctx.sessionManager as SessionManager;
  const sessionContext = sm.buildSessionContext();
  const usage = await ctx.getContextUsage();
  const fullSystemPrompt: string = ctx.getSystemPrompt();
  const activeToolNames = pi.getActiveTools();
  const allToolDefs = pi.getAllTools();
  const activeToolDefs = allToolDefs.filter((t: any) =>
    activeToolNames.includes(t.name),
  );
  const providerToolPayloads = getProviderToolPayloadSnapshot(activeToolNames);

  const { base, skillsBlock, memoryBlock } = sliceSystemPrompt(fullSystemPrompt);

  return {
    usage,
    contextWindow: resolveContextWindow(ctx, usage),
    systemPrompt: base,
    memoryContent: memoryBlock,
    skillsContent: skillsBlock,
    activeToolDefs,
    providerToolPayloads: providerToolPayloads === null ? undefined : providerToolPayloads,
    modelApi: typeof ctx.model?.api === "string" ? ctx.model.api : undefined,
    messages: sessionContext.messages,
  };
}

/**
 * Analyze working context and produce unified breakdown.
 * Output has no UI-motivated corrections, no silent clamping.
 * delta can be negative (estimator overestimate).
 */
export function analyzeContext(inputs: {
  usage: any;
  contextWindow: number;
  systemPrompt: string;
  activeToolDefs: any[];
  providerToolPayloads?: unknown[];
  modelApi?: string;
  messages: any[];
  memoryContent?: string;
  skillsContent?: string;
}): ContextBreakdown {
  // --- System prompt (with section details) ---
  const toolPromptAttribution = extractToolPromptAttribution(inputs.systemPrompt, inputs.activeToolDefs);
  const systemPromptSections = splitSystemPromptSections(toolPromptAttribution.strippedPrompt);
  const systemPromptTokens = estimateTokens(toolPromptAttribution.strippedPrompt);

  // --- Tools ---
  // In Pi, "skills" are not registered tools — they're markdown resources
  // injected into the system prompt as an <available_skills> block (see
  // formatSkillsForPrompt in pi-coding-agent). So every active tool def
  // belongs in the systemTools bucket; the skills bucket is sourced from
  // the carved-out skillsContent slice instead.
  const systemToolsDetails = buildSystemToolDetails({
    ...inputs,
    toolPromptTokensByName: toolPromptAttribution.toolPromptTokensByName,
  });
  const systemToolsTokens = systemToolsDetails.reduce(
    (a, b) => a + b.tokens,
    0,
  );
  const skillsTokens = estimateTokens(inputs.skillsContent ?? "");
  const skillsDetails: SkillDetail[] = inputs.skillsContent
    ? splitSkillDetails(inputs.skillsContent)
    : [];

  // --- Memory (with file details) ---
  const memoryFiles = splitMemoryFiles(inputs.memoryContent ?? "");
  const memoryTokens = estimateTokens(inputs.memoryContent ?? "");

  // --- Message breakdown ---
  const msg: MessageBreakdown = {
    userText: 0,
    assistantText: 0,
    assistantThinking: 0,
    toolCalls: 0,
    toolResults: 0,
    images: 0,
    custom: 0,
  };
  const summaryBreakdown: SummaryBreakdown = {
    branchSummaries: 0,
    compactionSummaries: 0,
  };

  for (const m of inputs.messages) {
    if (m.role === "user") {
      if (typeof m.content === "string") {
        msg.userText += estimateTokens(m.content);
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          const p = part as any;
          if (p.type === "text") msg.userText += estimateTokens(p.text);
          else if (p.type === "image") msg.images += estimateTokens(JSON.stringify(p));
          else msg.custom += estimateTokens(JSON.stringify(p));
        }
      }
    } else if (m.role === "assistant") {
      if (typeof m.content === "string") {
        msg.assistantText += estimateTokens(m.content);
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          const p = part as any;
          if (p.type === "text") msg.assistantText += estimateTokens(p.text);
          else if (p.type === "thinking")
            msg.assistantThinking += estimateTokens(p.thinking ?? "");
          else if (p.type === "toolCall")
            msg.toolCalls += estimateTokens(JSON.stringify(p));
          else msg.custom += estimateTokens(JSON.stringify(p));
        }
      }
    } else if (m.role === "toolResult") {
      msg.toolResults += estimateTokens(extractText(m.content));
    } else if (m.role === "compactionSummary") {
      summaryBreakdown.compactionSummaries += estimateTokens(m.summary ?? "");
    } else if (m.role === "branchSummary") {
      summaryBreakdown.branchSummaries += estimateTokens(m.summary ?? "");
    } else if (m.role === "summary" || m.type === "summary") {
      summaryBreakdown.branchSummaries += estimateTokens(
        extractText(m.content ?? m.text ?? ""),
      );
    } else {
      msg.custom += estimateTokens(extractText(m.content ?? ""));
    }
  }

  const summariesTokens =
    summaryBreakdown.branchSummaries + summaryBreakdown.compactionSummaries;

  // --- Totals ---
  const messageTotal =
    msg.userText +
    msg.assistantText +
    msg.assistantThinking +
    msg.toolCalls +
    msg.toolResults +
    msg.images +
    msg.custom;

  const estimatedTotal =
    systemPromptTokens +
    systemToolsTokens +
    skillsTokens +
    memoryTokens +
    summariesTokens +
    messageTotal;

  // Treat a reported `tokens: 0` as "no measurement yet" — it shows up
  // on a fresh session before any turn has executed, and handing back
  // measuredTotal=0 leads the renderer to show Available=100% of window.
  const rawMeasured = inputs.usage?.tokens;
  const measuredTotal =
    typeof rawMeasured === "number" && rawMeasured > 0 ? rawMeasured : null;
  const contextWindow = inputs.contextWindow;
  // Available space should be shown even pre-measurement so the grid
  // always has a "free" slice. When we don't have a measurement we fall
  // back to the estimated total.
  const usedForAvailable =
    measuredTotal !== null ? measuredTotal : estimatedTotal;
  const available = Math.max(0, contextWindow - usedForAvailable);

  const delta = measuredTotal !== null ? measuredTotal - estimatedTotal : null;

  let confidence: "measured" | "mixed" | "estimated" = "estimated";
  if (measuredTotal !== null) {
    const absDelta = Math.abs(delta ?? 0);
    confidence = absDelta < 500 ? "measured" : "mixed";
  }

  // Displayed buckets preserve raw per-category estimates so callers can
  // trust that `assistantThinking`, `systemPrompt`, etc. reflect what we
  // actually counted. When a measured total is available, any positive
  // unattributed delta is absorbed into `custom` so the buckets sum to
  // the real session total. Negative deltas (estimator overshoot) are
  // left visible via `delta` without silently clamping the buckets.
  const displayBuckets = {
    systemPrompt: systemPromptTokens,
    systemTools: systemToolsTokens,
    skills: skillsTokens,
    memory: memoryTokens,
    userText: msg.userText,
    assistantText: msg.assistantText,
    assistantThinking: msg.assistantThinking,
    toolCalls: msg.toolCalls,
    toolResults: msg.toolResults,
    images: msg.images,
    summaries: summariesTokens,
    custom: msg.custom,
  };
  if (measuredTotal !== null) {
    const unattributed = measuredTotal - estimatedTotal;
    if (unattributed > 0) displayBuckets.custom += unattributed;
  }

  const displayMessageTotal =
    displayBuckets.userText +
    displayBuckets.assistantText +
    displayBuckets.assistantThinking +
    displayBuckets.toolCalls +
    displayBuckets.toolResults +
    displayBuckets.images +
    displayBuckets.custom;
  const autocompactBuffer = DEFAULT_COMPACTION_SETTINGS.enabled
    ? Math.min(DEFAULT_COMPACTION_SETTINGS.reserveTokens, contextWindow)
    : 0;
  const categoryFreeSpace = Math.max(0, available - autocompactBuffer);

  return {
    measuredTotal,
    contextWindow,
    available,
    estimatedTotal,
    buckets: displayBuckets,
    details: {
      systemPromptSections,
      memoryFiles,
      systemTools: systemToolsDetails,
      skills: skillsDetails,
      messageBreakdown: msg,
      summaryBreakdown,
    },
    categoryBreakdown: {
      systemPrompt: displayBuckets.systemPrompt,
      systemTools: displayBuckets.systemTools,
      memoryFiles: displayBuckets.memory,
      skills: displayBuckets.skills,
      messages: displayMessageTotal + displayBuckets.summaries,
      autocompactBuffer,
      freeSpace: categoryFreeSpace,
      extensionOverhead:
        displayBuckets.systemPrompt +
        displayBuckets.systemTools +
        displayBuckets.memory +
        displayBuckets.skills,
    },
    delta,
    confidence,
    metadata: {
      compactionDetected: inputs.usage?.compactionDetected ?? false,
      hasPostCompactionData: measuredTotal !== null,
      buildSessionContextMessageCount: inputs.messages.length,
    },
  };
}
