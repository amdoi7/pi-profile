import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerContextCommands } from "./src/register-context-commands.ts";
import { registerContextHooks } from "./src/register-context-hooks.ts";

export default function contextUiExtension(pi: ExtensionAPI) {
  registerContextCommands(pi);
  registerContextHooks(pi);
}
