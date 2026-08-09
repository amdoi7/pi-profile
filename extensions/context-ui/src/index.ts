import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerContextCommands } from "./register-context-commands.ts";
import { registerContextHooks } from "./register-context-hooks.ts";

export function registerMemoryContextFeatures(pi: ExtensionAPI) {
  registerContextCommands(pi);
  registerContextHooks(pi);
}

export default registerMemoryContextFeatures;
