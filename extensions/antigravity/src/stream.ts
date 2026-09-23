// Streaming adapter: fetch the CCA endpoint and translate its SSE stream into
// pi assistant events. Endpoint failover + retry on rate limits; the wire
// chunk shape mirrors the verified live response.

import {
	calculateCost,
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type ToolCall,
} from "@earendil-works/pi-ai";
import { buildRequest, STREAM_PATH, type WireRequest } from "./wire.ts";
import { ENDPOINTS, PRIMARY, SANDBOX, UA } from "./types.ts";

interface ChunkPart {
	text?: string;
	thought?: boolean;
	thoughtSignature?: string;
	functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
}
interface Chunk {
	response?: {
		candidates?: Array<{
			content?: { role?: string; parts?: ChunkPart[] };
			finishReason?: string;
		}>;
		usageMetadata?: {
			promptTokenCount?: number;
			candidatesTokenCount?: number;
			thoughtsTokenCount?: number;
			totalTokenCount?: number;
			cachedContentTokenCount?: number;
		};
	};
}

const stopOf = (r: string): StopReason => (r === "STOP" ? "stop" : r === "MAX_TOKENS" ? "length" : "error");

const sleep = (ms: number, s?: AbortSignal) =>
	new Promise<void>((res, rej) => {
		if (s?.aborted) return rej(new Error("aborted"));
		const t = setTimeout(res, ms);
		s?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); }, { once: true });
	});

export interface StreamOptions extends SimpleStreamOptions {
	projectId: string;
	wireId: string;
	googleLevel: boolean;
}

export function stream(model: Model<Api>, context: Context, options?: StreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	(async () => {
		const output: AssistantMessage = {
			role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop", timestamp: Date.now(),
		};
		const fail = (err: unknown) => {
			const reason: "aborted" | "error" = options?.signal?.aborted ? "aborted" : "error";
			output.stopReason = reason;
			output.errorMessage = err instanceof Error ? err.message : String(err);
			stream.push({ type: "error", reason, error: output });
			stream.end(output);
		};

		try {
			if (!options?.apiKey) throw new Error("Antigravity requires OAuth. Use /login.");
			const { token, projectId } = JSON.parse(options.apiKey) as { token: string; projectId: string };
			if (!token || !projectId) throw new Error("Missing token or projectId. Login again.");

			const wire = buildRequest(model, context, projectId, options.wireId, options.googleLevel, {
				maxTokens: options.maxTokens,
				thinkingBudgets: options.thinkingBudgets as Record<string, number> | undefined,
				reasoning: options.reasoning,
			});
			const body = JSON.stringify(wire);
			if (process.env.ANTIGRAVITY_DEBUG) console.error("[antigravity] POST", body.slice(0, 4000));

			const headers: Record<string, string> = {
				Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "text/event-stream", "User-Agent": UA,
				...(model.id.startsWith("claude-") ? { "anthropic-beta": "interleaved-thinking-2025-05-14" } : {}),
				...(options?.headers ?? {}),
			};

			const base = model.baseUrl?.trim();
			const endpoints = base && ![PRIMARY, SANDBOX].includes(base) ? [base] : [...ENDPOINTS];

			let resp: Response | undefined;
			for (let attempt = 0; attempt <= 3; attempt++) {
				resp = await fetch(`${endpoints[Math.min(attempt, 1)]}${STREAM_PATH}`, { method: "POST", headers, body, signal: options?.signal });
				if (resp.ok) break;
				const text = await resp.text();
				if (attempt < 3 && (resp.status === 429 || (resp.status >= 500 && resp.status <= 504) || /rate.?limit|resource.?exhausted/i.test(text))) {
					await sleep(1000 * 2 ** attempt, options?.signal);
					continue;
				}
				throw new Error(`Cloud Code Assist API error (${resp.status}): ${text}`);
			}
			if (!resp?.ok || !resp.body) throw new Error("Failed to get a response");

			const reader = resp.body.getReader();
			const decoder = new TextDecoder();
			let buf = "";
			let started = false;
			let current: { type: "text" | "thinking"; text?: string; thinking?: string; signature?: string } | null = null;
			let currentIndex = -1;
			const ensureStart = () => { if (!started) { stream.push({ type: "start", partial: output }); started = true; } };
			const closeBlock = () => {
				if (!current) return;
				if (current.type === "text") {
					const b = output.content[currentIndex];
					if (b?.type === "text" && current.signature) (b as { textSignature?: string }).textSignature = current.signature;
					stream.push({ type: "text_end", contentIndex: currentIndex, content: current.text ?? "", partial: output });
				} else {
					const b = output.content[currentIndex];
					if (b?.type === "thinking" && current.signature) (b as { thinkingSignature?: string }).thinkingSignature = current.signature;
					stream.push({ type: "thinking_end", contentIndex: currentIndex, content: current.thinking ?? "", partial: output });
				}
				current = null;
			};

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				const lines = buf.split("\n");
				buf = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.startsWith("data:")) continue;
					const json = line.slice(5).trim();
					if (!json) continue;
					let chunk: Chunk;
					try { chunk = JSON.parse(json) as Chunk; } catch { continue; }
					const r = chunk.response;
					if (!r) continue;
					const cand = r.candidates?.[0];
					for (const part of cand?.content?.parts ?? []) {
						if (part.text !== undefined) {
							const isT = part.thought === true;
							const want = isT ? "thinking" : "text";
							if (!current || current.type !== want) {
								closeBlock();
								current = isT ? { type: "thinking", thinking: "" } : { type: "text", text: "" };
								output.content.push(current as never);
								currentIndex = output.content.length - 1;
								ensureStart();
								stream.push({ type: isT ? "thinking_start" : "text_start", contentIndex: currentIndex, partial: output });
							}
							if (current.type === "thinking") current.thinking += part.text;
							else current.text += part.text;
							if (part.thoughtSignature) current.signature = part.thoughtSignature;
							stream.push({ type: isT ? "thinking_delta" : "text_delta", contentIndex: currentIndex, delta: part.text, partial: output });
						}
						if (part.functionCall) {
							closeBlock();
							const tc: ToolCall = {
								type: "toolCall", id: part.functionCall.id ?? `${part.functionCall.name}_${Date.now()}`,
								name: part.functionCall.name, arguments: part.functionCall.args ?? {},
								...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
							};
							output.content.push(tc);
							ensureStart();
							const ci = output.content.length - 1;
							stream.push({ type: "toolcall_start", contentIndex: ci, partial: output });
							stream.push({ type: "toolcall_delta", contentIndex: ci, delta: JSON.stringify(tc.arguments), partial: output });
							stream.push({ type: "toolcall_end", contentIndex: ci, toolCall: tc, partial: output });
						}
					}
					if (cand?.finishReason) {
						output.stopReason = stopOf(cand.finishReason);
						if (output.content.some((b) => b.type === "toolCall")) output.stopReason = "toolUse";
					}
					if (r.usageMetadata) {
						const u = r.usageMetadata;
						const cacheRead = u.cachedContentTokenCount ?? 0;
						output.usage = {
							input: (u.promptTokenCount ?? 0) - cacheRead,
							output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
							cacheRead, cacheWrite: 0, totalTokens: u.totalTokenCount ?? 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						};
						output.usage.cost = calculateCost(model, output.usage);
					}
				}
			}
			closeBlock();
			if (output.stopReason === "error") throw new Error("An unknown error occurred");
			const done = output.stopReason === "pending" || output.stopReason === "aborted" ? "stop" : output.stopReason;
			stream.push({ type: "done", reason: done, message: output });
			stream.end(output);
		} catch (err) {
			fail(err);
		}
	})();
	return stream;
}

export const streamSimple = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	if (!options?.apiKey) throw new Error("Antigravity requires OAuth. Use /login.");
	const routing = (model.samplingParams as { antigravity?: { wire: Record<string, string>; googleLevel: boolean } } | undefined)?.antigravity;
	const googleLevel = routing?.googleLevel ?? /^gemini-3/.test(model.id);
	const effort = options.reasoning ?? "medium";
	const wireId = routing?.wire[effort] ?? routing?.wire["medium"] ?? model.id;
	const { projectId } = JSON.parse(options.apiKey) as { token: string; projectId: string };
	return stream(model, context, { ...options, projectId, wireId, googleLevel });
};

export type { WireRequest };
