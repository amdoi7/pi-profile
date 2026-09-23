// Antigravity wire protocol: pi messages/tools -> Cloud Code Assist request,
// and SSE response -> pi assistant events. All host contracts verified against
// the live daily-cloudcode-pa endpoint (see project notes).

import type { Api, Context, ImageContent, Message, Model, TextContent, Tool } from "@earendil-works/pi-ai";
import { toolParameters } from "./schema.ts";
import { STREAM_PATH, UA } from "./types.ts";

// ---------------------------------------------------------------------------
// Request shaping
// ---------------------------------------------------------------------------

export interface WireRequest {
	project: string;
	model: string;
	request: {
		contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
		systemInstruction?: { role?: string; parts: Array<{ text: string }> };
		generationConfig?: Record<string, unknown>;
		tools?: Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
		toolConfig?: { functionCallingConfig: { mode: string } };
		labels?: Record<string, string>;
	};
	requestType: string;
	userAgent: string;
	requestId: string;
}

const sanitize = (t: string) => t.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
const needId = (id: string) => id.startsWith("claude-") || id.startsWith("gpt-oss-");

interface MessageLite {
	role: string; provider?: string; model?: string;
	content?: string | (TextContent | ImageContent)[];
	toolName?: string; toolCallId?: string; isError?: boolean;
}

export function convertContents(model: Model<Api>, messages: Message[]): Array<{ role: string; parts: Array<Record<string, unknown>> }> {
	const out: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];
	const mm = model.input.includes("image");
	const sameModel = (m: MessageLite) => m.provider === model.provider && m.model === model.id;

	for (const msg of messages as MessageLite[]) {
		if (msg.role === "user") {
			const parts: Array<Record<string, unknown>> = [];
			if (typeof msg.content === "string") parts.push({ text: sanitize(msg.content) });
			else for (const it of (msg.content ?? []) as (TextContent | ImageContent)[])
				if (it.type === "text") parts.push({ text: sanitize(it.text) });
				else if (it.type === "image" && mm) parts.push({ inlineData: { mimeType: it.mimeType, data: it.data } });
			if (parts.length) out.push({ role: "user", parts });
		} else if (msg.role === "assistant") {
			const same = sameModel(msg);
			const parts: Array<Record<string, unknown>> = [];
			let firstToolCall = true;
			const assistantContent = (msg as unknown as { content: Array<Record<string, unknown> & { type: string; text?: string; thinking?: string; name?: string; id?: string; arguments?: Record<string, unknown>; thoughtSignature?: string; textSignature?: string; thinkingSignature?: string }> }).content;
			for (const b of assistantContent) {
				if (b.type === "text" && b.text?.trim()) {
					const sig = same && b.textSignature;
					parts.push({ text: sanitize(b.text), ...(sig ? { thoughtSignature: sig } : {}) });
				} else if (b.type === "thinking" && b.thinking?.trim()) {
					const sig = same && b.thinkingSignature;
					parts.push(same
						? { thought: true, text: sanitize(b.thinking), ...(sig ? { thoughtSignature: sig } : {}) }
						: { text: sanitize(b.thinking) });
				} else if (b.type === "toolCall") {
					// Gemini 3 requires a thought signature on function calls. When the
					// call has none, the first unsigned call of the turn carries the
					// skip_thought_signature_validator sentinel (CCA host contract).
					const sig = same && b.thoughtSignature;
					const effective = sig || (firstToolCall ? "skip_thought_signature_validator" : undefined);
					firstToolCall = false;
					parts.push({
						functionCall: { name: b.name, args: b.arguments ?? {}, ...(needId(model.id) && b.id ? { id: b.id } : {}) },
						...(effective ? { thoughtSignature: effective } : {}),
					});
				}
			}
			if (parts.length) out.push({ role: "model", parts });
		} else if (msg.role === "toolResult") {
			const text = (msg.content as TextContent[]).filter((c) => c.type === "text").map((c) => c.text).join("\n");
			const images = mm ? (msg.content as (TextContent | ImageContent)[]).filter((c): c is ImageContent => c.type === "image") : [];
			const part: Record<string, unknown> = {
				functionResponse: {
					name: msg.toolName,
					response: msg.isError ? { error: text } : { output: text },
					...(images.length ? { parts: images.map((im) => ({ inlineData: { mimeType: im.mimeType, data: im.data } })) } : {}),
					...(needId(model.id) && msg.toolCallId ? { id: msg.toolCallId } : {}),
				},
			};
			const last = out[out.length - 1];
			if (last?.role === "user" && last.parts.some((p) => p.functionResponse)) last.parts.push(part);
			else out.push({ role: "user", parts: [part] });
		}
	}
	return out;
}

export function convertTools(tools: Tool[]): Array<{ functionDeclarations: Array<Record<string, unknown>> }> | undefined {
	if (!tools.length) return undefined;
	return [{ functionDeclarations: tools.map((t) => ({
		name: t.name,
		description: t.description,
		parameters: toolParameters(t.parameters),
	})) }];
}

// Google wire thinking levels (mapEffortToGoogleThinkingLevel): pro routes
// minimal to LOW (merged effort routing); flash keeps MINIMAL.
export function effortToLevel(effort: string, isPro: boolean): "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" {
	switch (effort) {
		case "minimal": return isPro ? "LOW" : "MINIMAL";
		case "low": return "LOW";
		case "medium": return "MEDIUM";
		case "high": case "xhigh": case "max": return "HIGH";
		default: return "MEDIUM";
	}
}

export const BUDGETS: Record<string, number> = {
	minimal: 1024, low: 4096, medium: 8192, high: 16384, xhigh: 24575, max: 32768,
};

export interface BuildOptions {
	maxTokens?: number;
	thinkingBudgets?: Record<string, number>;
	reasoning?: string;
}

/**
 * Build the CCA request. `wireId` is the effort-routed model id; `googleLevel`
 * picks thinkingLevel (Gemini 3) vs thinkingBudget (Claude / 2.x). Budget
 * models always send maxOutputTokens > budget (Claude 400s otherwise).
 */
export function buildRequest(
	model: Model<Api>,
	context: Context,
	projectId: string,
	wireId: string,
	googleLevel: boolean,
	o: BuildOptions,
): WireRequest {
	const gen: Record<string, unknown> = {};
	if (o.maxTokens !== undefined) gen.maxOutputTokens = o.maxTokens;

	const effort = o.reasoning === "off" ? "off" : o.reasoning ?? "medium";
	if (model.reasoning && effort !== "off") {
		if (googleLevel) {
			gen.thinkingConfig = { includeThoughts: true, thinkingLevel: effortToLevel(effort, /pro/.test(model.id)) };
		} else {
			const clamped = effort === "xhigh" || effort === "max" ? "high" : effort;
			let budget = o.thinkingBudgets?.[clamped] ?? BUDGETS[clamped] ?? 8192;
			const callerMax = o.maxTokens ?? 64_000;
			let maxTokens = Math.min(callerMax + budget, model.maxTokens);
			if (maxTokens <= budget) budget = Math.max(0, maxTokens - 1024);
			gen.thinkingConfig = { includeThoughts: true, thinkingBudget: budget };
			gen.maxOutputTokens = maxTokens;
		}
	} else if (model.reasoning) {
		gen.thinkingConfig = googleLevel ? { includeThoughts: false, thinkingLevel: "MINIMAL" } : { thinkingBudget: 0 };
	}

	const request: WireRequest["request"] = { contents: convertContents(model, context.messages) };
	if (context.systemPrompt?.trim()) {
		request.systemInstruction = { role: "user", parts: [{ text: sanitize(context.systemPrompt) }] };
	}
	if (Object.keys(gen).length) request.generationConfig = gen;
	const tools = convertTools(context.tools ?? []);
	if (tools) request.tools = tools;

	// Antigravity agent envelope. request.sessionId is a cloudcode-pa field the
	// agent endpoint rejects; requestType/userAgent/requestId/labels are required.
	const requestId = `agent/${crypto.randomUUID()}/${Date.now()}/${crypto.randomUUID()}/1`;
	request.labels = {
		last_step_index: "0",
		trajectory_id: crypto.randomUUID(),
		used_claude: model.id.startsWith("claude-") ? "true" : "false",
		used_claude_conservative: model.id.startsWith("claude-") ? "true" : "false",
	};
	return { project: projectId, model: wireId, request, requestType: "agent", userAgent: "antigravity", requestId };
}

export { STREAM_PATH, UA };
