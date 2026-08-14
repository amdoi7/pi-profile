import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { on } from "../../_shared/mode-gate.ts";
import {
  clearProviderToolPayloadSnapshot,
  updateProviderToolPayloadSnapshot,
} from "./provider-tool-payload.ts";

export function registerContextHooks(pi: ExtensionAPI): void {
  on(pi, "session_start", async () => {
    clearProviderToolPayloadSnapshot();
  }, ["tui"]);

  on(pi, "session_shutdown", async () => {
    clearProviderToolPayloadSnapshot();
  }, ["tui"]);

  on(pi, "before_provider_request", (event) => {
    updateProviderToolPayloadSnapshot(event.payload);
  }, ["tui"]);
}
