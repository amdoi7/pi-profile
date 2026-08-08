/**
 * Provider subscription usage fetchers for the custom footer.
 *
 * Three providers, each with its own data source:
 * - Claude (Anthropic): `api.anthropic.com/api/oauth/usage` with the Claude
 *   OAuth token (pi auth.json `anthropic.access` -> macOS Keychain
 *   "Claude Code-credentials" -> ~/.claude/.credentials.json). Returns 5h and
 *   weekly utilization windows.
 * - Codex (OpenAI): `chatgpt.com/backend-api/wham/usage` with a ChatGPT OAuth
 *   token (pi auth.json `openai-codex.access` -> ~/.codex/auth.json
 *   `tokens.access_token`). Returns primary/secondary rate windows.
 * - Kimi (Moonshot): `api.moonshot.ai/v1/users/me/balance` with an API key
 *   (pi auth.json `kimi-coding.key`, or the kimi-code CLI credentials file).
 *   Kimi is prepaid; the API returns the remaining balance, not a window.
 *
 * All fetchers share the same cache/backoff policy: TTL of 60s, failures back
 * off for 5 minutes so the footer render loop never hammers the APIs.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type UsageWindowData = {
  label: string;
  usedPercent: number;
  resetsAt?: string;
};

export type UsageSnapshot =
  | { kind: "windows"; windows: UsageWindowData[] }
  | { kind: "balance"; balance: number; currency: string };

export type ProviderUsageFetcher = {
  /** Synchronous cached snapshot for render (null when unavailable). */
  getSnapshot(): UsageSnapshot | null;
  /**
   * Background refresh honoring TTL and failure backoff.
   * Resolves true when the snapshot was refetched (caller should re-render).
   */
  refresh(): Promise<boolean>;
};

export type UsageFetcherDeps = {
  getNowMs(): number;
  homedir(): string;
  fileExists(path: string): boolean;
  readFile(path: string): string | null;
  writeFile(path: string, content: string): void;
  execFileSync(cmd: string, args: string[], options: { encoding: string; stdio: string[] }): string;
  fetch(
    url: string,
    init: {
      headers: Record<string, string>;
      signal: AbortSignal;
      method?: string;
      body?: URLSearchParams;
    },
  ): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
};

export const USAGE_TTL_MS = 60_000;
export const OPENCODE_WARN_TTL_MS = 300_000;

/**
 * OpenCode (zen/go) billing failure tracker. Zen exposes no usage/balance
 * API, so the only额度 signal is a failing status code (401 CreditsError,
 * 402 payment required, 429 rate limited). Successful responses clear it.
 */
export type OpencodeWarnTracker = {
  record(code: number): void;
  clear(): void;
  get(): { code: number; atMs: number } | null;
};

export function createOpencodeWarnTracker(deps: Partial<UsageFetcherDeps> = {}): OpencodeWarnTracker {
  const getNowMs = deps.getNowMs ?? (() => Date.now());
  let warn: { code: number; atMs: number } | null = null;
  return {
    record(code) {
      warn = { code, atMs: getNowMs() };
    },
    clear() {
      warn = null;
    },
    get() {
      if (warn === null) return null;
      if (getNowMs() - warn.atMs > OPENCODE_WARN_TTL_MS) return null;
      return warn;
    },
  };
}
export const USAGE_FAIL_BACKOFF_MS = 300_000;
export const USAGE_FETCH_TIMEOUT_MS = 10_000;

function getDefaultDeps(): UsageFetcherDeps {
  return {
    getNowMs: () => Date.now(),
    homedir,
    fileExists: existsSync,
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    writeFile: (path, content) => {
      try {
        writeFileSync(path, content, "utf8");
      } catch {
        // Persistence is best effort.
      }
    },
    execFileSync: (cmd, args, options) => execFileSync(cmd, args, options),
    fetch: (url, init) => fetch(url, init as RequestInit),
  };
}

// ---------------------------------------------------------------------------
// Claude (Anthropic subscription)
// ---------------------------------------------------------------------------

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

function loadClaudeToken(deps: UsageFetcherDeps): string | undefined {
  const piAuthPath = join(deps.homedir(), ".pi", "agent", "auth.json");
  if (deps.fileExists(piAuthPath)) {
    try {
      const data = JSON.parse(deps.readFile(piAuthPath) ?? "{}") as Record<string, unknown>;
      const access = (data.anthropic as Record<string, unknown> | undefined)?.access;
      if (typeof access === "string" && access.length > 0) return access;
    } catch {
      // Ignore malformed auth.json
    }
  }
  try {
    const keychainData = deps
      .execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
      .trim();
    if (keychainData) {
      const parsed = JSON.parse(keychainData) as {
        claudeAiOauth?: { scopes?: string[]; accessToken?: string };
      };
      const oauth = parsed.claudeAiOauth;
      if (oauth?.scopes?.includes("user:profile") && oauth.accessToken) {
        return oauth.accessToken;
      }
    }
  } catch {
    // Keychain access failed
  }
  const claudeCredsPath = join(deps.homedir(), ".claude", ".credentials.json");
  if (deps.fileExists(claudeCredsPath)) {
    try {
      const data = JSON.parse(deps.readFile(claudeCredsPath) ?? "{}") as {
        claudeAiOauth?: { scopes?: string[]; accessToken?: string };
      };
      if (data.claudeAiOauth?.scopes?.includes("user:profile") && data.claudeAiOauth.accessToken) {
        return data.claudeAiOauth.accessToken;
      }
    } catch {
      // Ignore malformed credentials
    }
  }
  return undefined;
}

async function fetchClaudeUsage(deps: UsageFetcherDeps): Promise<UsageSnapshot | null> {
  const token = loadClaudeToken(deps);
  if (!token) return null;
  try {
    const res = await deps.fetch(ANTHROPIC_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      five_hour?: { utilization?: number; resets_at?: string };
      seven_day?: { utilization?: number; resets_at?: string };
    };
    const windows: UsageWindowData[] = [];
    if (typeof data.five_hour?.utilization === "number") {
      windows.push({ label: "5h", usedPercent: data.five_hour.utilization, resetsAt: data.five_hour.resets_at });
    }
    if (typeof data.seven_day?.utilization === "number") {
      windows.push({ label: "Weekly", usedPercent: data.seven_day.utilization, resetsAt: data.seven_day.resets_at });
    }
    return windows.length > 0 ? { kind: "windows", windows } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Codex (OpenAI ChatGPT subscription)
// ---------------------------------------------------------------------------

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function loadCodexCredentials(deps: UsageFetcherDeps): { accessToken?: string; accountId?: string } {
  const piAuthPath = join(deps.homedir(), ".pi", "agent", "auth.json");
  if (deps.fileExists(piAuthPath)) {
    try {
      const data = JSON.parse(deps.readFile(piAuthPath) ?? "{}") as Record<string, unknown>;
      const codex = data["openai-codex"] as Record<string, unknown> | undefined;
      if (typeof codex?.access === "string" && codex.access.length > 0) {
        return {
          accessToken: codex.access,
          accountId: typeof codex.accountId === "string" ? codex.accountId : undefined,
        };
      }
    } catch {
      // Ignore malformed auth.json
    }
  }
  const codexAuthPath = join(deps.homedir(), ".codex", "auth.json");
  if (deps.fileExists(codexAuthPath)) {
    try {
      const data = JSON.parse(deps.readFile(codexAuthPath) ?? "{}") as Record<string, unknown>;
      if (typeof data.OPENAI_API_KEY === "string") {
        return { accessToken: data.OPENAI_API_KEY };
      }
      const tokens = data.tokens as Record<string, unknown> | undefined;
      if (typeof tokens?.access_token === "string") {
        return {
          accessToken: tokens.access_token,
          accountId: typeof tokens.account_id === "string" ? tokens.account_id : undefined,
        };
      }
    } catch {
      // Ignore malformed auth.json
    }
  }
  return {};
}

async function fetchCodexUsage(deps: UsageFetcherDeps): Promise<UsageSnapshot | null> {
  const { accessToken, accountId } = loadCodexCredentials(deps);
  if (!accessToken) return null;
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    };
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;
    const res = await deps.fetch(CODEX_USAGE_URL, {
      headers,
      signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      rate_limit?: {
        primary_window?: { reset_at?: number; limit_window_seconds?: number; used_percent?: number };
        secondary_window?: { reset_at?: number; limit_window_seconds?: number; used_percent?: number };
      };
    };
    const windows: UsageWindowData[] = [];
    const push = (w: { reset_at?: number; limit_window_seconds?: number; used_percent?: number } | undefined) => {
      if (!w || typeof w.used_percent !== "number") return;
      const windowHours = Math.round((w.limit_window_seconds || 10800) / 3600);
      windows.push({
        label: `${windowHours}h`,
        usedPercent: w.used_percent,
        resetsAt: typeof w.reset_at === "number" ? new Date(w.reset_at * 1000).toISOString() : undefined,
      });
    };
    push(data.rate_limit?.primary_window);
    push(data.rate_limit?.secondary_window);
    return windows.length > 0 ? { kind: "windows", windows } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Kimi (Kimi For Coding subscription windows)
// ---------------------------------------------------------------------------

const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const KIMI_OAUTH_TOKEN_URL = "https://auth.kimi.com/api/oauth/token";
const KIMI_CREDENTIALS_PATH = [".pi", "agent", "auth.json"];
const KIMI_REFRESH_LEAD_MS = 60_000;

type KimiOAuthCredentials = {
  access: string;
  refresh: string;
  /** Expiry of the access token as epoch ms. */
  expires: number;
};

function kimiAuthPath(deps: UsageFetcherDeps): string {
  return join(deps.homedir(), ...KIMI_CREDENTIALS_PATH);
}

function loadKimiCredentials(deps: UsageFetcherDeps): KimiOAuthCredentials | null {
  const path = kimiAuthPath(deps);
  if (!deps.fileExists(path)) return null;
  try {
    const data = JSON.parse(deps.readFile(path) ?? "{}") as Record<string, unknown>;
    const kimi = data["kimi-coding"] as Record<string, unknown> | undefined;
    if (kimi?.type !== "oauth") {
      // API-key style credentials cannot query subscription usage.
      if (typeof kimi?.key === "string" && kimi.key.length > 0) {
        return null;
      }
      return null;
    }
    if (typeof kimi.access !== "string" || typeof kimi.refresh !== "string") return null;
    const expires = Number(kimi.expires);
    if (!Number.isFinite(expires)) return null;
    return { access: kimi.access, refresh: kimi.refresh, expires };
  } catch {
    return null;
  }
}

function persistKimiCredentials(deps: UsageFetcherDeps, creds: KimiOAuthCredentials): void {
  try {
    const path = kimiAuthPath(deps);
    const data = JSON.parse(deps.readFile(path) ?? "{}") as Record<string, unknown>;
    const kimi = data["kimi-coding"] as Record<string, unknown> | undefined;
    data["kimi-coding"] = { ...(kimi ?? {}), type: "oauth", ...creds };
    deps.writeFile(path, JSON.stringify(data, null, 2));
  } catch {
    // Refresh succeeded in memory; persistence is best effort.
  }
}

/** client_id from the JWT payload (required by the refresh endpoint). */
function jwtClientId(accessToken: string): string | undefined {
  try {
    const payload = accessToken.split(".")[1];
    const padded = payload + "=".repeat((-payload.length % 4 + 4) % 4);
    const decoded = JSON.parse(Buffer.from(padded, "base64url").toString("utf8")) as {
      client_id?: string;
    };
    return decoded.client_id;
  } catch {
    return undefined;
  }
}

async function refreshKimiToken(deps: UsageFetcherDeps, creds: KimiOAuthCredentials): Promise<KimiOAuthCredentials | null> {
  const clientId = jwtClientId(creds.access);
  if (!clientId) return null;
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: creds.refresh,
  });
  try {
    const res = await deps.fetch(KIMI_OAUTH_TOKEN_URL, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
      method: "POST",
      body,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string") {
      return null;
    }
    const refreshed: KimiOAuthCredentials = {
      access: data.access_token,
      refresh: data.refresh_token,
      expires: deps.getNowMs() + (typeof data.expires_in === "number" ? data.expires_in * 1000 : 0),
    };
    persistKimiCredentials(deps, refreshed);
    return refreshed;
  } catch {
    return null;
  }
}

/**
 * Fetch Kimi For Coding usage. Requires OAuth credentials (kimi-code login
 * writes them to auth.json); API-key credentials have no subscription usage.
 */
async function fetchKimiUsage(deps: UsageFetcherDeps): Promise<UsageSnapshot | null> {
  let creds = loadKimiCredentials(deps);
  if (!creds) return null;
  if (deps.getNowMs() + KIMI_REFRESH_LEAD_MS >= creds.expires) {
    const refreshed = await refreshKimiToken(deps, creds);
    if (!refreshed) return null;
    creds = refreshed;
  }
  try {
    const res = await deps.fetch(KIMI_USAGE_URL, {
      headers: { Authorization: `Bearer ${creds.access}` },
      signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      usage?: { limit?: string; remaining?: string; resetTime?: string };
      limits?: Array<{
        window?: { duration?: number; timeUnit?: string };
        detail?: { limit?: string; remaining?: string; resetTime?: string };
      }>;
    };
    const windows: UsageWindowData[] = [];
    const pushWindow = (limit: string | undefined, remaining: string | undefined, resetAt: string | undefined, label: string) => {
      const l = Number(limit);
      const r = Number(remaining);
      if (!Number.isFinite(l) || !Number.isFinite(r) || l <= 0) return;
      windows.push({
        label,
        usedPercent: ((l - r) / l) * 100,
        resetsAt: resetAt,
      });
    };
    // Windowed limits: 300 minutes -> 5h, 1440 -> 24h, etc.
    for (const entry of data.limits ?? []) {
      const durationMinutes = entry.window?.duration;
      if (typeof durationMinutes !== "number") continue;
      const label = durationMinutes % 1440 === 0 ? `${durationMinutes / 1440}d` : `${durationMinutes / 60}h`;
      pushWindow(entry.detail?.limit, entry.detail?.remaining, entry.detail?.resetTime, label);
    }
    // Overall quota (weekly reset in the observed payload).
    pushWindow(data.usage?.limit, data.usage?.remaining, data.usage?.resetTime, "Weekly");
    return windows.length > 0 ? { kind: "windows", windows } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Provider detection + shared cache wrapper
// ---------------------------------------------------------------------------

export type UsageProviderName = "claude" | "codex" | "kimi" | null;

/**
 * Detect which usage provider applies to the current model.
 * Provider name and model id are both considered; unknown providers map to null.
 */
export function detectUsageProvider(providerName: string | undefined, modelId: string | undefined): UsageProviderName {
  const haystack = `${providerName ?? ""} ${modelId ?? ""}`.toLowerCase();
  if (haystack.includes("anthropic") || haystack.includes("claude")) return "claude";
  if (haystack.includes("codex") || haystack.includes("chatgpt")) return "codex";
  if (haystack.includes("kimi") || haystack.includes("moonshot")) return "kimi";
  return null;
}

export function createUsageFetcher(
  provider: UsageProviderName,
  deps: Partial<UsageFetcherDeps> = {},
): ProviderUsageFetcher | null {
  if (provider === null) return null;
  const fullDeps: UsageFetcherDeps = { ...getDefaultDeps(), ...deps };
  const fetchFn =
    provider === "claude" ? fetchClaudeUsage : provider === "codex" ? fetchCodexUsage : fetchKimiUsage;

  let cached: UsageSnapshot | null = null;
  let cacheExpiresAt = 0;
  let nextAllowedAt = 0;

  return {
    getSnapshot() {
      return cached;
    },
    async refresh(): Promise<boolean> {
      const now = fullDeps.getNowMs();
      if (now < nextAllowedAt) return false;
      if (now < cacheExpiresAt && cached !== null) return false;
      const snapshot = await fetchFn(fullDeps);
      if (snapshot !== null) {
        cached = snapshot;
        cacheExpiresAt = fullDeps.getNowMs() + USAGE_TTL_MS;
        return true;
      }
      nextAllowedAt = fullDeps.getNowMs() + USAGE_FAIL_BACKOFF_MS;
      if (cached === null) cacheExpiresAt = 0;
      return false;
    },
  };
}
