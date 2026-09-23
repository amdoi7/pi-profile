// Google OAuth for Antigravity (Cloud Code Assist). Credentials, scopes and
// callback port come from the omp fork's google-antigravity auth rule; project
// discovery mirrors the real antigravity/hub client (ideType ANTIGRAVITY).

import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { PRIMARY, UA } from "./types.ts";

const CLIENT_ID = atob("MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==");
const CLIENT_SECRET = atob("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");
const REDIRECT_URI = "http://127.0.0.1:51121/oauth-callback";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];

export interface LoginCallbacks {
	onAuth(i: { url: string; instructions?: string }): void;
	onProgress?(m: string): void;
	signal?: AbortSignal;
}

const b64url = (b: Uint8Array) =>
	btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function pkce() {
	const v = new Uint8Array(32);
	crypto.getRandomValues(v);
	const verifier = b64url(v);
	const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: b64url(new Uint8Array(h)) };
}

async function userEmail(access: string): Promise<string | undefined> {
	try {
		const r = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
			headers: { Authorization: `Bearer ${access}` },
		});
		return r.ok ? ((await r.json()) as { email?: string }).email : undefined;
	} catch {
		return undefined;
	}
}

const sleep = (ms: number, s?: AbortSignal) =>
	new Promise<void>((res, rej) => {
		if (s?.aborted) return rej(new Error("aborted"));
		const t = setTimeout(res, ms);
		s?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); }, { once: true });
	});

/**
 * Resolve the Cloud Code Assist companion project: probe loadCodeAssist, then
 * provision the free tier (a long-running operation) when the account has no
 * project yet. Uses the Antigravity metadata the real client sends.
 */
async function discoverProject(access: string, progress?: (m: string) => void, signal?: AbortSignal): Promise<string> {
	const env = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
	const h = { Authorization: `Bearer ${access}`, "Content-Type": "application/json", "User-Agent": UA };
	const meta = { ideType: "ANTIGRAVITY" };

	progress?.("Checking for an existing Cloud Code Assist project...");
	const load = await fetch(`${PRIMARY}/v1internal:loadCodeAssist`, {
		method: "POST", headers: h, body: JSON.stringify({ metadata: meta }), signal,
	});
	const data = load.ok
		? ((await load.json()) as { cloudaicompanionProject?: string; allowedTiers?: Array<{ id?: string }> })
		: {};
	if (data.cloudaicompanionProject) return data.cloudaicompanionProject;
	if (env) return env;

	progress?.("Provisioning a Cloud Code Assist project...");
	const onboard = await fetch(`${PRIMARY}/v1internal:onboardUser`, {
		method: "POST", headers: h, body: JSON.stringify({ tierId: "free-tier", metadata: meta }), signal,
	});
	if (!onboard.ok) throw new Error(`onboardUser failed: ${onboard.status}`);
	let op = (await onboard.json()) as { name?: string; done?: boolean; response?: { cloudaicompanionProject?: { id?: string } } };
	while (op && !op.done && op.name) {
		await sleep(5000, signal);
		op = (await (await fetch(`${PRIMARY}/v1internal/${op.name}`, { headers: h, signal })).json()) as typeof op;
	}
	const projectId = op?.response?.cloudaicompanionProject?.id;
	if (!projectId) throw new Error("Could not provision a Google Cloud project");
	return projectId;
}

/** Browser PKCE login: local callback server receives the authorization code. */
export async function login(callbacks: LoginCallbacks): Promise<OAuthCredentials> {
	const { verifier, challenge } = await pkce();
	const { createServer } = await import("node:http");
	let settle: ((v: string | null) => void) | null = null;
	const codePromise = new Promise<string | null>((resolve) => { settle = resolve; });

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", REDIRECT_URI);
		if (url.pathname === "/oauth-callback") {
			const code = url.searchParams.get("code");
			res.writeHead(code ? 200 : 400, { "Content-Type": "text/html" });
			res.end(code ? "<h2>Login complete. Close this window.</h2>" : "<h2>Login failed</h2>");
			settle?.(code);
		} else res.writeHead(404).end();
	});
	await new Promise<void>((res, rej) => { server.once("error", rej); server.listen(51121, "127.0.0.1", res); });

	try {
		const params = new URLSearchParams({
			client_id: CLIENT_ID, response_type: "code", redirect_uri: REDIRECT_URI, scope: SCOPES.join(" "),
			code_challenge: challenge, code_challenge_method: "S256", state: verifier, access_type: "offline", prompt: "consent",
		});
		callbacks.onAuth({ url: `${AUTH_URL}?${params}`, instructions: "Complete the sign-in in your browser." });
		callbacks.onProgress?.("Waiting for OAuth callback...");
		const code = await codePromise;
		if (!code) throw new Error("No authorization code received");

		callbacks.onProgress?.("Exchanging code for tokens...");
		const tr = await fetch(TOKEN_URL, {
			method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code,
				grant_type: "authorization_code", redirect_uri: REDIRECT_URI, code_verifier: verifier,
			}),
		});
		if (!tr.ok) throw new Error(`Token exchange failed: ${await tr.text()}`);
		const tok = (await tr.json()) as { access_token: string; refresh_token?: string; expires_in: number };
		if (!tok.refresh_token) throw new Error("No refresh token received");

		const projectId = await discoverProject(tok.access_token, callbacks.onProgress, callbacks.signal);
		const email = await userEmail(tok.access_token);
		return {
			refresh: tok.refresh_token, access: tok.access_token,
			expires: Date.now() + tok.expires_in * 1000 - 5 * 60 * 1000,
			projectId, ...(email ? { email } : {}),
		} as OAuthCredentials;
	} finally {
		server.close();
	}
}

/** Rotate the access token; keep projectId/email across refreshes. */
export async function refresh(cred: OAuthCredentials): Promise<OAuthCredentials> {
	const projectId = (cred as OAuthCredentials & { projectId?: string }).projectId;
	if (!projectId) throw new Error("Antigravity credentials missing projectId");
	const r = await fetch(TOKEN_URL, {
		method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
			refresh_token: cred.refresh, grant_type: "refresh_token",
		}),
	});
	if (!r.ok) throw new Error(`Token refresh failed: ${await r.text()}`);
	const d = (await r.json()) as { access_token: string; expires_in: number; refresh_token?: string };
	return {
		refresh: d.refresh_token || cred.refresh, access: d.access_token,
		expires: Date.now() + d.expires_in * 1000 - 5 * 60 * 1000,
		projectId, ...(cred.email ? { email: cred.email } : {}),
	} as OAuthCredentials;
}

/** The stream encoder and discovery read `{ token, projectId }`. */
export const apiKey = (c: OAuthCredentials) =>
	JSON.stringify({ token: c.access, projectId: (c as OAuthCredentials & { projectId?: string }).projectId });
