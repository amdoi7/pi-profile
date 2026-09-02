/**
 * Mirasim provider extension for pi.
 *
 * Mirasim 桌面应用为每个 agent 会话拉起一个本地反代（http://127.0.0.1:<port>/<path>，
 * 随 run 生命周期，结束即销毁）。反代校验 claude CLI 的请求特征（user-agent、
 * anthropic-beta、body 里的官方 system 文本、会话路径 + x-api-key），通过后注入
 * 托管凭证转发到 relay。因此本扩展不保存任何凭据，每次请求时动态发现反代。
 *
 * 入口：`mirasim.ts` 位于 `~/.pi/agent/extensions/`，由 pi 自动发现（extension 工厂
 * 同步注册 provider；模型本地白名单构造，启动零网络）。
 */

// pi 扩展加载器把 @earendil-works/pi-ai 顶层别名到 dist/compat.js，
// compat 里 re-export 了 anthropicMessagesApi（来自 ./api/anthropic-messages.lazy）——
// 所以顶层导入即可，不必扫子路径。子路径 `./api/*` 未注册别名，jiti 会找成员文件而挂掉。
import { createProvider, anthropicMessagesApi } from "@earendil-works/pi-ai";
import type { ApiKeyCredential, AuthResult, Model, ProviderAuthInteraction, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// ---------------------------------------------------------------------------
// 本地反代请求特征（claude CLI 身份）
// ---------------------------------------------------------------------------

// 反代要求 body.system 含 Claude Code 官方身份文本（实测精确匹配，缺了/改了都 403）。
const CLAUDE_SYSTEM_TEXT = "You are Claude Code, Anthropic's official CLI for Claude.";
const CLAUDE_UA = "claude-cli/2.1.228 (external, sdk-cli)";
const CLAUDE_BETA =
  "claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13," +
  "context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07," +
  "effort-2025-11-24,fallback-credit-2026-06-01";

// 根路径（不带 /v1）：pi-ai 的 anthropicMessagesApi 内部用 Anthropic SDK，会在 baseUrl
// 后补 /v1/messages。若 baseUrl 带 /v1 会拼成 /v1/v1/messages。relay 只有 anthropic
// messages 一条模型通道（openai chat/completions 404）。
const RELAY_BASE = "https://mirasim-relay.mirofish.ai";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// 本地反代端口发现（不缓存；反代随 agent run 生命周期，run 结束即销毁）
// ---------------------------------------------------------------------------

interface ProxyTarget {
  base: string; // http://127.0.0.1:<port>
  pathPrefix?: string; // 会话路径前缀，如 /BUI4SBWo...；是鉴权的一部分
  key?: string; // 反代鉴权 token（x-api-key）
}

/** 用真实鉴权（路径前缀 + x-api-key）探测反代：/v1/models 返回模型列表即成功。 */
async function isProxyPort(base: string, pathPrefix: string, token: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${base}${pathPrefix}/v1/models`, {
        headers: { "anthropic-version": "2023-06-01", "x-api-key": token },
        signal: controller.signal,
      });
      const text = await res.text();
      return text.includes('"object":"model"');
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/** 从运行中的 claude 会话 argv 解析反代会话（端口 + 会话路径 + token 三件套）。 */
async function findMirasimSessions(): Promise<ProxyTarget[]> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "command="], { timeout: 5000 });
    const targets: ProxyTarget[] = [];
    for (const line of stdout.split("\n")) {
      const m = line.match(
        /ANTHROPIC_BASE_URL":\s*"http:\/\/127\.0\.0\.1:(\d+)\/([^"]+)"[^]*?ANTHROPIC_AUTH_TOKEN":\s*"([^"]+)"/,
      );
      if (m) targets.push({ base: `http://127.0.0.1:${m[1]}`, pathPrefix: `/${m[2]}`, key: m[3] });
    }
    return targets;
  } catch {
    return [];
  }
}

/** 运行 lsof 收集 Mirasim 监听端口（macOS）。 */
async function findMirasimPorts(): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
      timeout: 5000,
    });
    const ports = new Set<number>();
    for (const line of stdout.split("\n")) {
      if (!/^Mirasim/.test(line)) continue;
      const m = line.match(/:([0-9]+)\s+\(LISTEN\)/);
      if (m) ports.add(Number(m[1]));
    }
    return [...ports].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

async function discoverProxy(): Promise<ProxyTarget | null> {
  // 1. 会话级反代（首选）：路径前缀 + token 组合探测。
  for (const t of await findMirasimSessions()) {
    if (await isProxyPort(t.base, t.pathPrefix ?? "", t.key ?? "")) return t;
  }
  // 2. 兜底：裸端口 /v1/models（老版本/无路径鉴权时）。
  for (const p of await findMirasimPorts()) {
    if (await isProxyPort(`http://127.0.0.1:${p}`, "", "")) return { base: `http://127.0.0.1:${p}` };
  }
  return null;
}

/**
 * 自建 fetch：把 pi-ai/Anthropic SDK 的请求改送到本地反代，并注入反代校验的
 * claude CLI 特征。反代只认本机请求，鉴权是路径 + token 组合，缺任一都 401。
 */
async function ensureClaudeSystem(bodyText: string): Promise<string> {
  try {
    const body = JSON.parse(bodyText) as { system?: unknown };
    // system 可能是数组或字符串（Anthropic 协议都允许）；统一成数组处理。
    const existing =
      typeof body.system === "string"
        ? [{ type: "text" as const, text: body.system }]
        : Array.isArray(body.system)
          ? (body.system as { type?: unknown; text?: unknown }[])
          : [];
    if (
      existing.some(
        (b) => typeof b?.text === "string" && b.text.includes(CLAUDE_SYSTEM_TEXT),
      )
    ) {
      return bodyText;
    }
    body.system = [{ type: "text", text: CLAUDE_SYSTEM_TEXT }, ...existing];
    return JSON.stringify(body);
  } catch {
    return bodyText; // 非 JSON，原样透传
  }
}

function makeProxyFetch(getTarget: () => ProxyTarget | null) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = getTarget();
    if (!target) {
      throw new Error("Mirasim 反代未就绪：请在 Mirasim.app 里开一个 agent 会话（随便发一句），反代端口随会话拉起。");
    }
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    // 只接管发往 mirasim host 的请求；其它域名直通。
    if (!/mirasim|relay\.mirasim|mirofish/.test(url.host)) {
      return fetch(input, init);
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
    headers.set("user-agent", CLAUDE_UA);
    headers.set("anthropic-beta", CLAUDE_BETA);
    headers.set("anthropic-dangerous-direct-browser-access", "true");
    headers.set("x-app", "cli");
    // 反代鉴权认 x-api-key（会话 token，须配会话路径）；裸路径/缺 token 都 401。
    if (target.key) {
      headers.set("x-api-key", target.key);
      headers.delete("authorization");
    } else {
      headers.set("authorization", "Bearer managed-credential");
    }

    let body = init?.body;
    if (typeof body === "string" && body.length > 0) {
      body = await ensureClaudeSystem(body);
    }
    url.host = "127.0.0.1";
    url.port = new URL(target.base).port;
    url.protocol = "http:";
    if (target.pathPrefix) {
      url.pathname = `${target.pathPrefix}${url.pathname}`;
    }
    return fetch(new Request(url, { ...init, headers, body }));
  };
}

// ---------------------------------------------------------------------------
// Model definitions（白名单固定；relay 只有 anthropic messages 一条模型通道）
// ---------------------------------------------------------------------------

type PiModel = Model<"anthropic-messages">;

const MIRASIM_MODEL_IDS = [
  "gpt-5.6-sol",
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-opus-5",
];

// 映射 xhigh + max 两级（relay 实测）；其余级别隐藏（null）不出现。
// off 不发 thinking 参数，让模型走默认行为。
const THINKING_LEVEL_MAP: ThinkingLevelMap = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: "xhigh",
  max: "max",
};

// 模型元数据全部本地构造。relay 实测规则（curl 逐项验证）：
// - thinking:{type:"enabled"/"disabled"/off} → 400；adaptive 格式
//   (type:"adaptive"+output_config.effort) → 200 → forceAdaptiveThinking
// - temperature 字段任意值 → 400 → supportsTemperature:false 抑制发送
// - reasoning:{effort} → 200（openrouter 兼容）
function buildLocalModels(): PiModel[] {
  return MIRASIM_MODEL_IDS.map((id) => ({
    id,
    name: id,
    provider: "mirasim",
    // createProvider 的模型不会继承 provider 级 baseUrl，必须显式携带，
    // 否则 pi 的 provider-attribution 在 model.baseUrl.includes() 处崩溃。
    baseUrl: RELAY_BASE,
    api: "anthropic-messages",
    reasoning: true,
    thinkingLevelMap: { ...THINKING_LEVEL_MAP },
    compat: { supportsTemperature: false, forceAdaptiveThinking: true },
    input: ["text"],
    contextWindow: 1000000,
    maxTokens: 128000,
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  }));
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const models = buildLocalModels();

  let proxyTarget: ProxyTarget | null = null;
  let discovery: Promise<ProxyTarget | null> | null = null;

  // 反代发现互斥：并发首请求共享同一 discovery（不用 boolean 防抖，避免并发拿 null）。
  // 失败不缓存：下次请求重试。
  async function getTarget(): Promise<ProxyTarget | null> {
    if (proxyTarget) return proxyTarget;
    if (!discovery) {
      discovery = discoverProxy().finally(() => {
        discovery = null;
      });
    }
    return discovery;
  }

  // 同步快照给 makeProxyFetch；失效后由 retryableFetch 清空重发现。
  const relayFetch = makeProxyFetch(() => proxyTarget);

  const retryableFetch: typeof fetch = async (input, init) => {
    try {
      const res = await relayFetch(input, init);
      // 反代会话失效（stale token/会话销毁但端口被复用）：清缓存重新发现后重试一次。
      if (res.status === 401 || res.status === 403) {
        proxyTarget = null;
        const retargeted = await getTarget();
        if (retargeted) return relayFetch(input, init);
      }
      return res;
    } catch (err) {
      const isNetwork =
        err instanceof Error && /ECONNREFUSED|socket hang up|fetch failed/i.test(err.message);
      if (!isNetwork) throw err;
      proxyTarget = null;
      const retargeted = await getTarget();
      if (retargeted) return relayFetch(input, init);
      throw err;
    }
  };

  const baseApi = anthropicMessagesApi();
  const api = {
    ...baseApi,
    stream: (model: Parameters<typeof baseApi.stream>[0], context: Parameters<typeof baseApi.stream>[1], options: Parameters<typeof baseApi.stream>[2]) =>
      baseApi.stream(model, context, { ...options, fetch: retryableFetch }),
    streamSimple: (model: Parameters<typeof baseApi.streamSimple>[0], context: Parameters<typeof baseApi.streamSimple>[1], options: Parameters<typeof baseApi.streamSimple>[2]) =>
      baseApi.streamSimple(model, context, { ...options, fetch: retryableFetch }),
  };

  pi.registerProvider(
    createProvider({
      id: "mirasim",
      name: "Mirasim（本地反代直连）",
      baseUrl: RELAY_BASE,
      api,
      models,
      auth: {
        apiKey: {
          name: "Mirasim（本地反代，无需凭证）",

          // /login mirasim：探测反代，把会话 token 存为 api_key 凭据（仅状态展示；
          // 请求鉴权仍走每请求 resolve 的实时发现）。
          async login(interaction: ProviderAuthInteraction): Promise<ApiKeyCredential> {
            interaction.notify({ type: "progress", message: "正在探测 Mirasim 本地反代…" });
            const target = await getTarget();
            if (!target) {
              throw new Error("Mirasim 反代未就绪：请在 Mirasim.app 里开一个 agent 会话（随便发一句），反代端口随会话拉起。");
            }
            return { type: "api_key", key: target.key ?? "managed-credential" };
          },

          // 请求层鉴权：优先实时反代会话 token；无反代时回退存储凭据，
          // 保证 provider 始终处于已配置状态（模型列表可见）。
          // 请求实际鉴权由 retryableFetch 注入反代头，此返回值仅作状态。
          async resolve(input: {
            credential?: ApiKeyCredential;
          }): Promise<AuthResult | undefined> {
            const target = await getTarget().catch(() => null);
            const key = target?.key ?? input.credential?.key;
            if (!key && !target) return undefined;
            return { auth: { apiKey: key ?? "managed-credential" }, source: "Mirasim 本地反代" };
          },
        },
      },
    }),
  );
}
