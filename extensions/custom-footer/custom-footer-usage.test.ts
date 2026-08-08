import { describe, expect, test } from "vitest";
import {
	createUsageFetcher,
	detectUsageProvider,
	type UsageFetcherDeps,
	type UsageSnapshot,
} from "./custom-footer-usage.ts";

// Minimal JWT with a client_id claim (base64url payload).
function makeJwt(clientId: string): string {
	const header = btoa(JSON.stringify({ alg: "ES256", typ: "JWT" }));
	const payload = btoa(JSON.stringify({ client_id: clientId, scope: "kimi-code", exp: 9999999999 }));
	return `${header}.${payload}.sig`;
}

function makeAuthJson(kimi: Record<string, unknown>): string {
	return JSON.stringify({ "kimi-coding": kimi, deepseek: { type: "api_key", key: "sk-d" } });
}

function makeDeps(overrides: Partial<UsageFetcherDeps> = {}): UsageFetcherDeps & { writes: string[] } {
	const writes: string[] = [];
	let nowMs = 1_000_000;
	return {
		getNowMs: () => nowMs,
		now: (ms: number) => {
			nowMs = ms;
		},
		homedir: () => "/home/test",
		fileExists: () => true,
		readFile: () => makeAuthJson({
			type: "oauth",
			access: makeJwt("client-1"),
			refresh: "refresh-1",
			expires: nowMs + 900_000,
		}),
		writeFile: (path, content) => {
			writes.push(content);
		},
		execFileSync: () => "",
		fetch: async () => {
			throw new Error("unexpected fetch");
		},
		writes,
		...overrides,
	} as UsageFetcherDeps & { writes: string[]; now: (ms: number) => void };
}

describe("detectUsageProvider", () => {
	test("detects claude, codex and kimi by provider or model id", () => {
		expect(detectUsageProvider("anthropic", "claude-sonnet")).toBe("claude");
		expect(detectUsageProvider("local", "claude-opus")).toBe("claude");
		expect(detectUsageProvider("openai", "codex-mini")).toBe("codex");
		expect(detectUsageProvider("chatgpt", "gpt-5")).toBe("codex");
		expect(detectUsageProvider("kimi-coding", "kimi-k2")).toBe("kimi");
		expect(detectUsageProvider("moonshot", "kimi-k2")).toBe("kimi");
		expect(detectUsageProvider("deepseek", "deepseek-v4")).toBeNull();
	});
});

describe("kimi usage fetcher", () => {
	const usagesPayload = {
		user: { userId: "u1", membership: { level: "LEVEL_ADVANCED" } },
		usage: { limit: "100", remaining: "60", resetTime: "2026-08-14T03:58:32Z" },
		limits: [
			{
				window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
				detail: { limit: "100", remaining: "80", resetTime: "2026-08-08T15:58:32Z" },
			},
		],
		parallel: { limit: "30" },
	};

	test("parses the 5h window and weekly quota into usage windows", async () => {
		const deps = makeDeps({
			fetch: async () => ({ ok: true, status: 200, json: async () => usagesPayload }),
		});
		const fetcher = createUsageFetcher("kimi", deps);
		await fetcher.refresh();
		const snapshot = fetcher.getSnapshot() as UsageSnapshot;
		expect(snapshot.kind).toBe("windows");
		if (snapshot.kind !== "windows") return;
		expect(snapshot.windows).toEqual([
			{ label: "5h", usedPercent: 20, resetsAt: "2026-08-08T15:58:32Z" },
			{ label: "Weekly", usedPercent: 40, resetsAt: "2026-08-14T03:58:32Z" },
		]);
	});

	test("refreshes an expired access token before fetching usage", async () => {
		let nowMs = 1_000_000;
		const calls: string[] = [];
		const deps = makeDeps({
			getNowMs: () => nowMs,
			readFile: () => makeAuthJson({
				type: "oauth",
				access: makeJwt("client-1"),
				refresh: "refresh-1",
				expires: nowMs - 1, // expired
			}),
			fetch: async (url) => {
				calls.push(url);
				if (url.includes("auth.kimi.com/api/oauth/token")) {
					return { ok: true, status: 200, json: async () => ({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 900 }) };
				}
				return { ok: true, status: 200, json: async () => usagesPayload };
			},
		});
		const fetcher = createUsageFetcher("kimi", deps);
		await fetcher.refresh();
		expect(calls[0]).toContain("auth.kimi.com/api/oauth/token");
		expect(calls[1]).toContain("api.kimi.com/coding/v1/usages");
		// New credentials persisted back to auth.json.
		const written = JSON.parse(deps.writes[0]!) as Record<string, Record<string, unknown>>;
		expect(written["kimi-coding"].access).toBe("new-access");
		expect(written["kimi-coding"].refresh).toBe("new-refresh");
	});

	test("returns null for api-key credentials (no subscription usage)", async () => {
		const deps = makeDeps({
			readFile: () => makeAuthJson({ type: "api_key", key: "sk-kimi-test" }),
		});
		const fetcher = createUsageFetcher("kimi", deps);
		await fetcher.refresh();
		expect(fetcher.getSnapshot()).toBeNull();
	});

	test("caches within TTL and backs off after failure", async () => {
		let nowMs = 1_000_000;
		let fetchCount = 0;
		const deps = makeDeps({
			getNowMs: () => nowMs,
			fetch: async () => {
				fetchCount += 1;
				if (fetchCount === 1) return { ok: true, status: 200, json: async () => usagesPayload };
				throw new Error("network down");
			},
		});
		const fetcher = createUsageFetcher("kimi", deps);
		await fetcher.refresh();
		expect(fetchCount).toBe(1);

		// Within TTL: no second fetch.
		nowMs += 30_000;
		await fetcher.refresh();
		expect(fetchCount).toBe(1);

		// Past TTL: refetch fails, snapshot stays stale, next attempt backs off.
		nowMs += 60_000;
		await fetcher.refresh();
		expect(fetchCount).toBe(2);
		expect(fetcher.getSnapshot()).not.toBeNull();

		nowMs += 10_000; // within backoff window
		await fetcher.refresh();
		expect(fetchCount).toBe(2);

		nowMs += 300_000; // backoff expired
		await fetcher.refresh();
		expect(fetchCount).toBe(3);
	});
});
