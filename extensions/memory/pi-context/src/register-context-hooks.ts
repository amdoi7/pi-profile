import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  clearProviderToolPayloadSnapshot,
  updateProviderToolPayloadSnapshot,
} from "./provider-tool-payload.ts";

export function registerContextHooks(pi: ExtensionAPI): void {
  pi.on("session_start", async () => {
    clearProviderToolPayloadSnapshot();
  });

  pi.on("session_shutdown", async () => {
    clearProviderToolPayloadSnapshot();
  });

  pi.on("before_provider_request", (event) => {
    updateProviderToolPayloadSnapshot(event.payload);
  });
}
