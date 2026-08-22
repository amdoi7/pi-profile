/**
 * apicursor-thinking — pi extension for the apicursor.com gateway.
 *
 * apicursor belongs to the cursoride2api family: an OpenAI-compatible façade
 * (Bearer auth, /v1/chat/completions, /v1/models) over the Cursor IDE agent
 * API. Every request is flattened into a single Cursor `userMessage` — the
 * whole conversation, system prompt included — and sent with an empty
 * `conversationState` under a fresh `conversationId`. Two consequences shape
 * this extension; a third one cannot be fixed from the client:
 *
 *  1. Chain of thought arrives inline in `content` as an XML `<think>` block
 *     (verified by curl; no reasoning_content / reasoning / reasoning_text
 *     field is ever sent), so pi's stock OpenAI adapter renders it as answer
 *     text. ThinkingSplitter splits it back out — see thinking-splitter.ts for
 *     the captured protocol. Whether a `<think>` block appears at all is
 *     model-dependent: claude-opus-5 emits one, claude-sonnet-4.6 does not.
 *  2. The reported `usage` is unusable as prompt accounting (100×-inflated
 *     below a size threshold, real above it) and carries no cache field, so it
 *     is replaced with a local estimate — see usage.ts.
 *  3. Prompt cache cannot be observed or influenced here. Upstream Cursor does
 *     report `cacheReadTokens`/`cacheWriteTokens` in its `turnEnded` frame, but
 *     the gateway drops those fields and starts a new conversation per request,
 *     so every turn is accounted as a full prompt no matter how stable the
 *     prefix is. Splitting thinking out of the replayed content keeps that
 *     prefix byte-stable, which is all a client can contribute; surfacing real
 *     cache numbers requires a gateway that forwards them.
 *
 * Implementation: register the `apicursor` provider (models, key and baseUrl
 * all live here, not in models.json) with a wrapping `streamSimple` that pipes
 * the stock OpenAI adapter's events through a ThinkingSplitter and re-emits
 * text/thinking/tool-call events against a self-owned content array. The final
 * assistant message carries the split content, so history replay renders
 * identically to the live stream.
 */

import {
  createAssistantMessageEventStream,
  openAICompletionsApi,
  calculateCost,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { ThinkingSplitter, type Segment } from "./thinking-splitter.ts";
import { dropThinkingFromHistory } from "./replay.ts";
import { normalizeUsage } from "./usage.ts";

type ContentBlock = {
  type: "text";
  text: string;
} | {
  type: "thinking";
  thinking: string;
  thinkingSignature: string;
} | ToolCall;

function streamApicursor(model: Model<Api>, rawContext: Context, options?: SimpleStreamOptions) {
  // Chain of thought never goes back on the wire: it cannot be consumed upstream
  // and, with no cache on this link, every replayed token is paid again per turn.
  const context = dropThinkingFromHistory(rawContext);
  const inner = openAICompletionsApi().streamSimple(model, context, options);
  const outer = createAssistantMessageEventStream();
  const splitter = new ThinkingSplitter();

  queueMicrotask(async () => {
    let partial: AssistantMessage | undefined;
    // The stock adapter captures its content array once and keeps pushing into
    // it; tool-call events index into that array, so the reference must be kept
    // before `partial.content` is swapped for our own.
    let innerBlocks: AssistantMessage["content"] = [];
    const blocks: ContentBlock[] = [];
    // Generated chars (thinking + text), used when the gateway reports no output.
    let producedChars = 0;
    let textIdx = -1;
    let thinkingIdx = -1;

    const closeText = (): void => {
      if (textIdx < 0) return;
      const b = blocks[textIdx] as Extract<ContentBlock, { type: "text" }>;
      outer.push({ type: "text_end", contentIndex: textIdx, content: b.text, partial: partial! });
      textIdx = -1;
    };
    const closeThinking = (): void => {
      if (thinkingIdx < 0) return;
      const b = blocks[thinkingIdx] as Extract<ContentBlock, { type: "thinking" }>;
      outer.push({ type: "thinking_end", contentIndex: thinkingIdx, content: b.thinking, partial: partial! });
      thinkingIdx = -1;
    };

    const emitSegment = (kind: Segment["kind"], text: string): void => {
      if (text.length === 0) return;
      producedChars += text.length;
      if (kind === "text") {
        if (thinkingIdx >= 0) closeThinking();
        if (textIdx < 0) {
          textIdx = blocks.length;
          blocks.push({ type: "text", text: "" } satisfies ContentBlock);
          outer.push({ type: "text_start", contentIndex: textIdx, partial: partial! });
        }
        const b = blocks[textIdx] as Extract<ContentBlock, { type: "text" }>;
        b.text += text;
        outer.push({ type: "text_delta", contentIndex: textIdx, delta: text, partial: partial! });
      } else {
        if (textIdx >= 0) closeText();
        if (thinkingIdx < 0) {
          thinkingIdx = blocks.length;
          blocks.push({ type: "thinking", thinking: "", thinkingSignature: "" } satisfies ContentBlock);
          outer.push({ type: "thinking_start", contentIndex: thinkingIdx, partial: partial! });
        }
        const b = blocks[thinkingIdx] as Extract<ContentBlock, { type: "thinking" }>;
        b.thinking += text;
        outer.push({ type: "thinking_delta", contentIndex: thinkingIdx, delta: text, partial: partial! });
      }
    };

    /** Split content and honest usage, applied to whichever terminal event fires. */
    const finalize = (): void => {
      for (const seg of splitter.end()) emitSegment(seg.kind, seg.text);
      closeText();
      closeThinking();
      const message = partial!;
      message.content = blocks as AssistantMessage["content"];
      const usage = normalizeUsage(context, message.usage, producedChars);
      usage.cost = calculateCost(model, usage);
      message.usage = usage;
    };

    try {
      for await (const ev of inner) {
        if (ev.type === "start") {
          partial = ev.partial as AssistantMessage;
          innerBlocks = (partial as AssistantMessage).content;
          (partial as AssistantMessage).content = [];
          outer.push(ev);
          continue;
        }
        if (!partial) {
          // Not reached in practice (start always precedes content events).
          outer.push(ev as never);
          continue;
        }
        switch (ev.type) {
          case "start":
            continue;
          case "text_start":
          case "text_end": {
            // The inner adapter manages its own text block; ours is rebuilt
            // from splitter segments, so the inner text lifecycle is ignored.
            break;
          }
          case "text_delta": {
            for (const seg of splitter.feed(ev.delta)) emitSegment(seg.kind, seg.text);
            break;
          }
          case "toolcall_start": {
            const tool = innerBlocks[ev.contentIndex] as ToolCall | undefined;
            if (tool && tool.type === "toolCall") {
              closeText();
              closeThinking();
              blocks.push(tool);
              const idx = blocks.length - 1;
              outer.push({ type: "toolcall_start", contentIndex: idx, partial });
            }
            break;
          }
          case "toolcall_delta": {
            const tool = innerBlocks[ev.contentIndex] as ToolCall | undefined;
            const myIdx = tool ? blocks.indexOf(tool as never) : -1;
            if (myIdx >= 0) outer.push({ type: "toolcall_delta", contentIndex: myIdx, delta: ev.delta, partial });
            break;
          }
          case "toolcall_end": {
            closeText();
            closeThinking();
            const myIdx = blocks.indexOf(ev.toolCall as never);
            outer.push({ type: "toolcall_end", contentIndex: myIdx >= 0 ? myIdx : blocks.push(ev.toolCall as never) - 1, toolCall: ev.toolCall, partial });
            break;
          }
          case "done": {
            finalize();
            outer.push({ type: "done", reason: ev.reason, message: partial });
            outer.end(partial);
            break;
          }
          case "error": {
            finalize();
            outer.push({ type: "error", reason: ev.reason, error: partial });
            outer.end(partial);
            break;
          }
        }
      }
      outer.end();
    } catch (error) {
      const message: AssistantMessage = {
        role: "assistant",
        content: blocks as never,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "error",
        timestamp: Date.now(),
        errorMessage: error instanceof Error ? error.message : String(error),
      };
      outer.push({ type: "error", reason: "error", error: message });
      outer.end(message);
    }
  });

  return outer;
}

/** apicursor 模型目录。provider 完全由本扩展自包含,models.json 不再持有它。
 *  claude-opus-5 会输出 `<think>` 块(reasoning:true);claude-sonnet-4.6 实测
 *  不输出思考,作为低成本档用于调试与验证。价格按 Anthropic 官方表填,仅用于
 *  成本估算显示 —— 网关按 Cursor 配额计费,不按 token。 */
const APICURSOR_MODELS: ProviderModelConfig[] = [
  {
    id: "claude-opus-5",
    name: "Claude Opus 5 (Global)",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    // The gateway wraps `role: "system"` in `<system>…</system>` for the Cursor
    // prompt and has no branch for `developer`, which pi would otherwise use on
    // reasoning models.
    compat: { supportsDeveloperRole: false },
  },
  {
    id: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6 (cheap)",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    compat: { supportsDeveloperRole: false },
  },
];

export default function (pi: ExtensionAPI): void {
  pi.registerProvider("apicursor", {
    name: "Apicursor",
    baseUrl: "https://apicursor.com/v1",
    apiKey: "sk-nlkapi-beQj0q0ls7pG8S53NQR4zBqVuzo1DzZD",
    api: "openai-completions",
    models: APICURSOR_MODELS,
    streamSimple: (model, context, options) => streamApicursor(model, context, options),
  });
}
