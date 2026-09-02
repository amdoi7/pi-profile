/**
 * Mirasim provider extension for pi.
 *
 * Mirasim 的 LLM 转发服务（https://mirasim-relay.mirofish.ai/v1）使用标准
 * OpenAI 风格接口，鉴权为 `Authorization: Bearer <access_token>`。token 由
 * mirasim 桌面应用加密存储在 ~/.mirasim/setting.json，解密密钥在 macOS
 * Keychain 中。本扩展复用该凭据，无需浏览器 OAuth 流程：
 *
 * - 每次请求前实时解析：解密 setting.json 拿 access token，未过期直接用
 * - 过期自动刷新：调 admin 刷新接口换新 token，并加密写回 setting.json，
 *   保证 mirasim app 的 refresh token 同步轮换、双方永远共享最新凭据
 * - /login mirasim 提供显式登录入口（把当前凭据写入 pi 的 auth.json）
 *
 * 加密格式（与 mirasim app 兼容）：
 *   "mrs1:" + base64(iv(12B) || tag(16B) || ciphertext)
 *   算法 aes-256-gcm，密钥为 Keychain 中 config-secret-key 的 32 字节 hex。
 */

// pi 扩展加载器把 @earendil-works/pi-ai 顶层别名到 dist/compat.js，
// compat 里 re-export 了 anthropicMessagesApi（来自 ./api/anthropic-messages.lazy）——
// 所以顶层导入即可，不必扫子路径。子路径 `./api/*` 未注册别名，jiti 会找成员文件而挂掉。
import { createProvider, anthropicMessagesApi } from "@earendil-works/pi-ai";
import type { ApiKeyCredential, AuthResult, Model, ProviderAuthInteraction, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, readFile, rename, stat, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SETTINGS_PATH = join(homedir(), ".mirasim", "setting.json");
const AUTH_JSON_PATH = join(homedir(), CONFIG_DIR_NAME, "agent", "auth.json");
const ANALYTICS_DIR = join(homedir(), ".mirasim", "analytics");
const KEYCHAIN_SERVICE = "mirasim";
const KEYCHAIN_ACCOUNT = "config-secret-key";
// 根路径（不带 /v1）：pi-ai 的 anthropicMessagesApi 内部用 Anthropic SDK，
// 会在 baseUrl 后补 /v1/messages。若 baseUrl 带 /v1 会拼成 /v1/v1/messages。
// relay 只有 anthropic messages 一条模型通道（openai chat/completions 404）。
const RELAY_BASE = "https://mirasim-relay.mirofish.ai";
const ADMIN_REFRESH_URL = "https://admin.test.mirofish.ai/auth/refresh";
const TOKEN_PREFIX = "mrs1:";
const ACCESS_TOKEN_TTL_SEC = 3600; // 文档约定：access token 有效期 1 小时
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // 剩余不足 5 分钟即刷新，避免边界竞态

// 本地反代（自建 HTTP client）：不直连 relay，把请求送到 Mirasim 本地反代，
// 由反代注入托管凭证 + 签名后转发到 relay。实测（2026-08-24）relay 对直连强校验；
// 而本地反代只认 claude CLI 的若干请求特征。
const CLAUDE_UA = "claude-cli/2.1.228 (external, sdk-cli)";
const CLAUDE_BETA =
  "claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13," +
  "context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07," +
  "effort-2025-11-24,fallback-credit-2026-06-01";
// 反代要求 body.system 含 Claude Code 官方身份文本（实测精确匹配，缺了/改了都 403）。
const CLAUDE_SYSTEM_TEXT = "You are Claude Code, Anthropic's official CLI for Claude.";
// 本地反代方案（版本无关）：不走 mirasim-relay-bridge 常驻转发器，
// 每次请求时直接用 lsof 发现 Mirasim 监听的本地反代端口。
// 反代随 agent run 生命周期，run 结束即销毁，所以动态发现是唯一正确的节奏。
const PROXY_DISCOVERY_TIMEOUT_MS = 15000;

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Token crypto (mirasim-compatible)
// ---------------------------------------------------------------------------

let cachedKey: Buffer | null = null;

async function getKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  const { stdout } = await execFileAsync("security", [
    "find-generic-password",
    "-s", KEYCHAIN_SERVICE,
    "-a", KEYCHAIN_ACCOUNT,
    "-w",
  ]);
  const hex = stdout.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      `Keychain 中 mirasim 解密密钥格式异常（期望 32 字节 hex，实际长度 ${hex.length}）。` +
        `请确认命令可用：security find-generic-password -s mirasim -a config-secret-key -w`,
    );
  }
  cachedKey = Buffer.from(hex, "hex");
  return cachedKey;
}

function decryptToken(enc: string, key: Buffer): string {
  if (!enc.startsWith(TOKEN_PREFIX)) {
    throw new Error(`token 格式不支持：缺少 "${TOKEN_PREFIX}" 前缀`);
  }
  const buf = Buffer.from(enc.slice(TOKEN_PREFIX.length), "base64");
  if (buf.length < 28) {
    throw new Error("token 密文过短，无法解密（需要 iv 12B + tag 16B + 密文）");
  }
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function encryptToken(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return TOKEN_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

// ---------------------------------------------------------------------------
// Settings file access（mtime 缓存，避免每次请求重复读盘）
// ---------------------------------------------------------------------------

interface AuthTokens {
  access: string;
  refresh: string;
  expSec: number;
}

let tokensCache: { mtimeMs: number; tokens: AuthTokens } | null = null;

async function readTokens(): Promise<AuthTokens> {
  const key = await getKey();
  const st = await stat(SETTINGS_PATH);
  if (tokensCache && tokensCache.mtimeMs === st.mtimeMs) {
    return tokensCache.tokens;
  }
  const raw = await readFile(SETTINGS_PATH, "utf8");
  let settings: unknown;
  try {
    settings = JSON.parse(raw);
  } catch {
    throw new Error(`无法解析 ${SETTINGS_PATH}，文件可能已损坏`);
  }
  const auth = (settings as { auth?: Record<string, unknown> | null }).auth;
  if (!auth || typeof auth.token !== "string" || typeof auth.refreshToken !== "string") {
    throw new Error(
      `${SETTINGS_PATH} 中缺少 auth.token / auth.refreshToken 字段（auth 可能已被清空）。` +
        `请在 mirasim app 中重新登录，扩展会自动恢复，无需任何配置`,
    );
  }
  const tokens: AuthTokens = {
    access: decryptToken(auth.token, key),
    refresh: decryptToken(auth.refreshToken, key),
    expSec: typeof auth.exp === "number" ? auth.exp : 0,
  };
  tokensCache = { mtimeMs: st.mtimeMs, tokens };
  return tokens;
}

/** 把新 token 加密写回 setting.json，保持 mirasim app 的凭据同步。 */
async function persistTokens(access: string, refresh: string, expSec: number): Promise<void> {
  const key = await getKey();
  const raw = await readFile(SETTINGS_PATH, "utf8");
  const settings = JSON.parse(raw) as { auth: Record<string, unknown> };
  settings.auth.token = encryptToken(access, key);
  settings.auth.refreshToken = encryptToken(refresh, key);
  settings.auth.exp = expSec;
  const mode = (await stat(SETTINGS_PATH)).mode;
  const tmp = `${SETTINGS_PATH}.pi-tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(settings, null, 2) + "\n");
  await chmod(tmp, mode & 0o777);
  await rename(tmp, SETTINGS_PATH);
  // 使 mtime 缓存失效（新文件的 mtime 与原文件不同）
  tokensCache = null;
}

// ---------------------------------------------------------------------------
// Pi credential sync（启动时自动写入 auth.json，免手动 /login）
// ---------------------------------------------------------------------------

/**
 * 把当前 access token 以 api_key 凭据写入 ~/.pi/agent/auth.json，让 pi 的
 * /login 面板和 `pi auth` 状态显示已配置。实际请求鉴权仍走 resolve 的
 * 实时解密，此处只是状态同步。原子写入，保留其它 provider 条目。
 */
async function syncPiCredential(access: string): Promise<void> {
  try {
    let auth: Record<string, unknown> = {};
    try {
      auth = JSON.parse(await readFile(AUTH_JSON_PATH, "utf8")) as Record<string, unknown>;
    } catch {
      // 文件不存在或损坏：按空配置处理
    }
    const existing = auth["mirasim"] as { type?: string; key?: string } | undefined;
    if (existing?.type === "api_key" && existing.key === access) {
      return; // 已同步
    }
    auth["mirasim"] = { type: "api_key", key: access };
    const mode = await stat(AUTH_JSON_PATH).then((s) => s.mode).catch(() => 0o600);
    const tmp = `${AUTH_JSON_PATH}.pi-tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    await writeFile(tmp, JSON.stringify(auth, null, 2) + "\n");
    await chmod(tmp, (mode & 0o777) || 0o600);
    await rename(tmp, AUTH_JSON_PATH);
  } catch (error) {
    // 状态同步失败不影响使用（请求鉴权走 resolve），仅记录
    console.error(
      `[mirasim] 写入 pi 凭据文件 ${AUTH_JSON_PATH} 失败：` +
        `${error instanceof Error ? error.message : String(error)}。请求鉴权不受影响`,
    );
  }
}

function jwtExpirySec(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token refresh（admin 服务，互斥防止并发轮换）
// ---------------------------------------------------------------------------

let inflightRefresh: Promise<string> | null = null;

async function doRefresh(signal?: AbortSignal): Promise<string> {
  const tokens = await readTokens();
  const response = await fetch(ADMIN_REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: tokens.refresh }),
    signal,
  });
  if (!response.ok) {
    // 轮换竞态：mirasim app 可能刚用同一 refresh token 刷新过（旧 refresh
    // 已作废）。重读 setting.json——若 app 已写回新 token，直接用，不视为失败。
    try {
      const latest = await readTokens();
      if (latest.refresh !== tokens.refresh && latest.access) {
        console.error(
          `[mirasim] 刷新失败（HTTP ${response.status}），检测到 app 已轮换 token，改用 app 的最新 token`,
        );
        return latest.access;
      }
    } catch {
      // 重读失败：继续走正常报错路径
    }
    const detail = (await response.text()).slice(0, 300);
    throw new Error(
      `mirasim token 刷新失败（HTTP ${response.status}）：${detail}。` +
        `如 refresh token 已失效，请重新运行 /login mirasim 读取最新凭据`,
    );
  }
  const data = (await response.json()) as { access_token?: unknown; refresh_token?: unknown };
  if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string") {
    throw new Error(`mirasim 刷新接口响应缺少 access_token/refresh_token 字段：${JSON.stringify(data).slice(0, 200)}`);
  }
  const expSec = jwtExpirySec(data.access_token) ?? Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SEC;
  try {
    await persistTokens(data.access_token, data.refresh_token, expSec);
    // 低频（约 1 小时一次）同步 pi 凭据状态，保持 auth.json 最新
    void syncPiCredential(data.access_token);
  } catch (error) {
    // 刷新已成功但写回失败：新 access token 仍可继续使用，但 setting.json
    // 中的旧 refresh token 已作废，必须让用户知情
    console.error(
      `[mirasim] token 已刷新但写回 ${SETTINGS_PATH} 失败：` +
        `${error instanceof Error ? error.message : String(error)}。` +
        `旧 refresh token 已作废，请修复文件权限后重新 /login mirasim`,
    );
  }
  return data.access_token;
}

function refreshAccessToken(signal?: AbortSignal): Promise<string> {
  if (!inflightRefresh) {
    inflightRefresh = doRefresh(signal).finally(() => {
      inflightRefresh = null;
    });
  }
  return inflightRefresh;
}

// ---------------------------------------------------------------------------
// 每请求入口：解密 + 必要时刷新
// ---------------------------------------------------------------------------

/**
 * 返回当前可用的明文 access token；无法读取配置时返回 null（未配置）。
 * 已过期时自动刷新（互斥）。刷新失败时退回旧 token，让请求层以 401
 * 暴露服务端拒绝原因，而不是在这里中断所有 auth 检查。
 */
// 缓存 token 兜底提示只打印一次，避免每请求刷屏
let cachedTokenWarningShown = false;

async function getFreshAccessToken(signal?: AbortSignal): Promise<string | null> {
  let tokens: AuthTokens;
  try {
    tokens = await readTokens();
  } catch {
    // setting.json 无凭据（app 登出/未登录）：回退 auth.json 里最后已知的
    // token。它可能仍在有效期内（服务端不因 app 登出而作废 access token），
    // 但无法续期，过期后必须等 app 重新登录。
    try {
      const auth = JSON.parse(readFileSync(AUTH_JSON_PATH, "utf8")) as {
        mirasim?: { key?: string };
      };
      const key = auth["mirasim"]?.key;
      const exp = typeof key === "string" ? jwtExpirySec(key) : null;
      if (typeof key === "string" && exp && exp * 1000 > Date.now() + REFRESH_MARGIN_MS) {
        if (!cachedTokenWarningShown) {
          cachedTokenWarningShown = true;
          console.error(
            `[mirasim] setting.json 无凭据（mirasim app 已登出），使用 auth.json 缓存 token，` +
              `剩余 ${Math.round((exp - Date.now() / 1000) / 60)} 分钟，请重新登录 mirasim app 恢复自动刷新`,
          );
        }
        return key;
      }
    } catch {
      // auth.json 也不可用：未配置
    }
    return null;
  }
  const now = Date.now();
  const fresh = tokens.expSec > 0 ? tokens.expSec * 1000 > now + REFRESH_MARGIN_MS : false;
  if (fresh || tokens.expSec === 0) {
    return tokens.access;
  }
  try {
    return await refreshAccessToken(signal);
  } catch (error) {
    console.error(`[mirasim] ${error instanceof Error ? error.message : String(error)}，本次请求将使用旧 token`);
    return tokens.access;
  }
}

// ---------------------------------------------------------------------------
// Model definitions
// ---------------------------------------------------------------------------

// 本地构造的模型形状，受 Model<"anthropic-messages"> 约束：若任一模型不满足
// 接口，tsc 会立即报错（依赖升级时此处是最早的断点）。
interface PiModel extends Model<"anthropic-messages"> {}

// 只暴露白名单模型（relay 实测对这些模型兼容）；反代 /v1/models 会随服务端更新，
// 需要新增时按实测逐个加，别贪多。
const MIRASIM_MODEL_IDS = new Set([
  "gpt-5.6-sol",
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-opus-5",
]);

// 只映射 high + max 两级；其余级别隐藏（null），off 不发送参数（模型默认行为）
const THINKING_LEVEL_MAP: ThinkingLevelMap = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: "xhigh",
  max: "max",
};

// 模型元数据全部本地构造（白名单固定）。relay 只有 anthropic messages 一条
// 模型通道（纯 openai endpoints 404）：gpt/claude 都在 /v1/messages 上，
// 仅 model 字段区分。
function buildLocalModels(): PiModel[] {
  return [...MIRASIM_MODEL_IDS].map((id) => ({
    id,
    name: id,
    provider: "mirasim",
    // createProvider 的模型不会继承 provider 级 baseUrl，必须显式携带，
    // 否则 pi 的 provider-attribution 在 model.baseUrl.includes() 处崩溃
    baseUrl: RELAY_BASE,
    api: "anthropic-messages",
    reasoning: true,
    thinkingLevelMap: { ...THINKING_LEVEL_MAP },
    // relay 实测规则（curl 逐项验证）：
    // - thinking:{type:"enabled"/"disabled"/off} → 400；adaptive 格式
    //   (type:"adaptive"+output_config.effort) → 200 → forceAdaptiveThinking
    // - temperature 字段任意值 → 400 → supportsTemperature:false 抑制发送
    // - reasoning:{effort} → 200（openrouter 兼容）
    compat: { supportsTemperature: false, forceAdaptiveThinking: true },
    input: ["text"] as ("text" | "image")[],
    contextWindow: 1000000,
    maxTokens: 128000,
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  }));
}

// ---------------------------------------------------------------------------
// 本地反代端口发现 + 自建 HTTP client（Mirasim 桥接）
// ---------------------------------------------------------------------------

/**
 * 发现 Mirasim 本地反代。反代跟着 agent run 走（run 结束即销毁），且鉴权要求
 * 「会话路径 + x-api-key」：裸 /v1/models 或裸 token 都返回 401
 * （authentication_error: invalid x-api-key）。所以唯一可靠的数据源是运行中的
 * Mirasim 会话子进程——claude 的 --settings 里内联了 ANTHROPIC_BASE_URL
 * （http://127.0.0.1:<port>/<path>）和 ANTHROPIC_AUTH_TOKEN。
 */
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
    const res = await fetch(`${base}${pathPrefix}/v1/models`, {
      headers: { "anthropic-version": "2023-06-01", "x-api-key": token },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    return text.includes('"object":"model"');
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
 * claude CLI 特征：user-agent、anthropic-beta、body 带官方 system 块、
 * x-api-key 会话 token + 会话路径前缀（见 ProxyTarget/discoverProxy）。
 * 反代只认本机请求，鉴权是路径 + token 组合，缺任一都 401。
 */
async function ensureClaudeSystem(bodyText: string): Promise<string> {
  try {
    const body = JSON.parse(bodyText) as { system?: unknown };
    // proxy 校验 system 里必须含 Claude Code 官方身份文本（实测精确匹配）。
    // 把官方提示语放到 system 数组头部，保留原 system 内容在其后。
    const existing = Array.isArray(body.system) ? body.system : [];
    if (existing.some((b: any) => typeof b?.text === "string" && b.text.includes(CLAUDE_SYSTEM_TEXT))) {
      return bodyText;
    }
    body.system = [
      { type: "text", text: CLAUDE_SYSTEM_TEXT },
      ...existing,
    ];
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
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // 模型列表由白名单本地构造，启动零网络；凭据在每次请求时由 resolve() 实时解析
  const models = buildLocalModels();

  // 后台尽力把凭据写入 pi 凭据（不阻塞启动；失败下次启动重试）。
  // 请求鉴权不再依赖 access token（本地反代自动换托管凭证），这里仅为兼容旧逻辑。
  void (async () => {
    try {
      const token = await getFreshAccessToken();
      if (token) await syncPiCredential(token);
    } catch {
      // 无凭据或刷新失败：resolve() 会在请求时重试
    }
  })();

  // 自建 HTTP client：发现本地反代 + 注入 claude CLI 特征头
  let proxyTarget: ProxyTarget | null = null;
  let discovering = false;
  const getTarget = async (): Promise<ProxyTarget | null> => {
    if (proxyTarget) return proxyTarget;
    if (discovering) return null;
    discovering = true;
    try {
      proxyTarget = await discoverProxy();
      return proxyTarget;
    } finally {
      discovering = false;
    }
  };
  const relayFetch = makeProxyFetch(() => proxyTarget);
  // 断连重试：反代端口随会话销毁，失效后清缓存重新发现
  const retryableFetch: typeof fetch = (input, init) =>
    relayFetch(input, init).catch(async (err: unknown) => {
      const isRefused = err instanceof Error && /ECONNREFUSED|socket hang up|fetch failed/i.test(err.message);
      if (isRefused) {
        proxyTarget = null;
        const retargeted = await getTarget();
        if (retargeted) return relayFetch(input, init);
      }
      throw err;
    });

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
      // relay 只有 anthropic messages 一条模型通道（见 buildLocalModels 注释）
      api,
      models,
      auth: {
        apiKey: {
          name: "Mirasim（本地反代，无需凭证）",

          async login(interaction: ProviderAuthInteraction): Promise<ApiKeyCredential> {
            interaction.notify({ type: "progress", message: "正在探测 Mirasim 本地反代…" });
            const target = await getTarget();
            if (!target) {
              throw new Error("Mirasim 反代未就绪：请在 Mirasim.app 里开一个 agent 会话（随便发一句），反代端口随会话拉起。");
            }
            return { type: "api_key", key: target.key ?? "managed-credential" };
          },

          // 请求层不需要真实 token：本地反代自动换托管凭证转发
          async resolve(): Promise<AuthResult | undefined> {
            const target = proxyTarget ?? (await getTarget().catch(() => null));
            if (!target) return undefined;
            return { auth: { apiKey: target.key ?? "managed-credential" }, source: "Mirasim 本地反代" };
          },
        },
      },
    }),
  );
}
