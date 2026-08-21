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

// 运行时 note: pi 扩展加载器把 `@earendil-works/pi-ai` 顶层别名到 compat 入口
// （compat 是 core 的严格超集），且没有 `./api/*` 子路径映射——所以
// `anthropicMessagesApi` 必须从顶层取。
import { anthropicMessagesApi, createProvider } from "@earendil-works/pi-ai";
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
// relay 的 /v1/messages 用 x-mirasim-client 头识别“mirasim 客户端”，缺失则直接
// 401 client_outdated“this request must be signed”（实测：头只要存在即可，内容不校验）。
const CLIENT_HEADER = "x-mirasim-client";
const FALLBACK_CLIENT_VERSION = "pi-extension";

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

// 只暴露这三个模型（实测 relay 对其余模型不兼容）
const MIRASIM_MODEL_IDS = new Set(["gpt-5.6-sol", "claude-fable-5", "claude-opus-5"]);

// 只映射 high + max 两级；其余级别隐藏（null），off 不发送参数（模型默认行为）
const THINKING_LEVEL_MAP: ThinkingLevelMap = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: "high",
  xhigh: null,
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
    // 原生 anthropic API 自带 thinking 语义；temperature 关闭避免 opus 4.7+
    // 拒绝非默认值（relay 模型行为未逐项实测，保持最小配置）
    compat: { supportsTemperature: false },
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  }));
}

// ---------------------------------------------------------------------------
// Client version header（relay 客户端识别）
// ---------------------------------------------------------------------------

/**
 * 尽力读 app 心跳文件里的真实 appVersion 作为 x-mirasim-client 值；
 * 失败回退固定标识（实测 relay 只检查头存在，不校验内容）。
 * 同步实现：启动时一次解析，成本可忽略。
 */
function resolveClientVersion(): string {
  try {
    const entries = readdirSync(ANALYTICS_DIR);
    for (const name of entries.sort()) {
      const path = join(ANALYTICS_DIR, name);
      const text = readFileSync(path, "utf8");
      const m = text.match(/"appVersion":"([^"]+)"/);
      if (m) return m[1];
    }
  } catch {
    // 目录不存在/不可读：回退
  }
  return FALLBACK_CLIENT_VERSION;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // 模型列表由白名单本地构造，启动零网络；凭据在每次请求时由 resolve() 实时解析
  const models = buildLocalModels();
  // relay 的 anthropic /v1/messages 必须有 x-mirasim-client 头，缺失即 401
  const clientHeaders = { [CLIENT_HEADER]: resolveClientVersion() };

  // 后台尽力把凭据写入 pi 凭据（不阻塞启动；失败下次启动重试）
  void (async () => {
    try {
      const token = await getFreshAccessToken();
      if (token) {
        await syncPiCredential(token);
      }
    } catch {
      // 无凭据或刷新失败：resolve() 会在请求时重试
    }
  })();

  pi.registerProvider(
    createProvider({
      id: "mirasim",
      name: "Mirasim",
      baseUrl: RELAY_BASE,
      // 每个请求带客户端标识头：anthropic 端点的身份检查（缺失 → 401 client_outdated）
      headers: clientHeaders,
      // relay 只有 anthropic messages 一条模型通道（见 buildLocalModels 注释）
      api: anthropicMessagesApi(),
      models,
      auth: {
        apiKey: {
          name: "Mirasim（来自 ~/.mirasim/setting.json）",

          async login(interaction: ProviderAuthInteraction): Promise<ApiKeyCredential> {
            interaction.notify({ type: "progress", message: "正在读取 ~/.mirasim/setting.json 并解密 token…" });
            const tokens = await readTokens();
            return { type: "api_key", key: tokens.access };
          },

          // 每次请求前调用：解密本地凭据，过期则实时刷新并写回，永远返回最新 token
          async resolve({ signal }) {
            const token = await getFreshAccessToken(signal);
            if (!token) return undefined;
            return { auth: { apiKey: token }, source: "~/.mirasim/setting.json" };
          },
        },
      },
    }),
  );
}
