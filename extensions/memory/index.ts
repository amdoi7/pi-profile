import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMemoryContextFeatures } from "./pi-context/src/index.ts";
import {
  MISSING_GIT_ROOT_PREFIX,
  tryFindProjectRoot,
} from "./paths.ts";
import {
  buildPromptTemplateValues,
  ensureMemoryDir,
} from "./scaffold.ts";
import { buildMemoryPromptText } from "./prompt.ts";

export { MISSING_GIT_ROOT_PREFIX };

export default function memoryExtension(pi: ExtensionAPI) {
  let memoryPromptText: string | undefined;

  registerMemoryContextFeatures(pi);

  pi.on("session_start", async (_event, ctx) => {
    if (tryFindProjectRoot(ctx.cwd) === undefined) {
      memoryPromptText = undefined;
      return;
    }
    await ensureMemoryDir(ctx.cwd);
    memoryPromptText = buildMemoryPromptText(buildPromptTemplateValues(ctx));
  });

  pi.on("before_agent_start", (event) => {
    if (memoryPromptText === undefined) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${memoryPromptText}`,
    };
  });
}
