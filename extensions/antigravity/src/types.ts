// Shared types for the Antigravity provider extension.
import type { Api, Model } from "@earendil-works/pi-ai";

export const API = "google-gemini-cli" as Api;
export const PROVIDER = "google-antigravity";
export const NAME = "Antigravity";

export const PRIMARY = "https://daily-cloudcode-pa.googleapis.com";
export const SANDBOX = "https://daily-cloudcode-pa.sandbox.googleapis.com";
export const ENDPOINTS = [PRIMARY, SANDBOX] as const;

export const UA = "antigravity/hub/2.8.0 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)";

export const STREAM_PATH = "/v1internal:streamGenerateContent?alt=sse";
export const DISCOVERY_PATH = "/v1internal:fetchAvailableModels";

// Antigravity serves effort-tier wire ids (gemini-3.8-flash-low/medium/high).
// collapseWireModels groups them under a logical id and records, per thinking
// effort, which wire id to request. Carried in Model.samplingParams because
// pi-ai's Model has no dedicated requestModelId field.
export interface ModelRouting {
	wire: Record<string, string>; // effort ("off"|"minimal"|... ) -> wire model id
	googleLevel: boolean; // true: thinkingLevel; false: thinkingBudget
}

export function routingOf(model: Model<Api>): ModelRouting | undefined {
	return (model.samplingParams as { antigravity?: ModelRouting } | undefined)?.antigravity;
}
