// Antigravity (Google Cloud Code Assist) provider extension for pi.
//
// Restores the `google-antigravity` provider (Gemini 3 / Claude via Google's
// daily-cloudcode-pa endpoint) on upstream pi builds that no longer ship it.
// OAuth credentials/scopes and project provisioning come from the omp fork's
// google-antigravity auth rule; wire behavior was verified against the live
// endpoint (see wire.ts / catalog.ts notes).

import type { OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchCatalog, FALLBACK_MODELS } from "./catalog.ts";
import { apiKey, login, refresh } from "./oauth.ts";
import { streamSimple } from "./stream.ts";
import { NAME, PRIMARY, PROVIDER } from "./types.ts";

export default function antigravityExtension(pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER, {
		name: NAME,
		baseUrl: PRIMARY,
		api: "google-gemini-cli",
		streamSimple,
		oauth: {
			name: NAME,
			login: async (callbacks) => login(callbacks),
			refreshToken: async (credentials, _signal) => refresh(credentials as OAuthCredentials),
			getApiKey: (credentials) => apiKey(credentials as OAuthCredentials),
		},
		async refreshModels(context) {
			const cred = context.credential as OAuthCredentials | undefined;
			if (!cred?.access) return FALLBACK_MODELS;
			const catalog = await fetchCatalog(cred.access, context.signal);
			return catalog ?? FALLBACK_MODELS;
		},
	});
}
