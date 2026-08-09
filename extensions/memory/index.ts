import { fileURLToPath } from "node:url";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  MISSING_GIT_ROOT_PREFIX,
  tryFindProjectRoot,
} from "./paths.ts";
import {
  type MemoryPromptTemplateValues,
  buildPromptTemplateValues,
  ensureMemoryDir,
} from "./scaffold.ts";

export { MISSING_GIT_ROOT_PREFIX };

const SKILL_PATH = fileURLToPath(new URL("./skills/project-memory/SKILL.md", import.meta.url));

const MEMORY_PROMPT = `# Memory

Project memory: \`{{memoryDir}}\` — \`issues/\` = one file per deliverable, \`lessons.md\` = reusable rules.

Before acting: read the relevant deliverable and lessons. While acting: reflect on whether they still hold. After finishing: update the deliverable; add a lesson only when it changes future behavior. Full workflow: \`{{skillPath}}\`. Execution evidence: sessions under \`{{sessionsDir}}\`.`;

function buildMemoryPromptText(values: MemoryPromptTemplateValues): string {
  return MEMORY_PROMPT
    .replaceAll("{{memoryDir}}", values.memoryDir)
    .replaceAll("{{sessionsDir}}", values.sessionsDir)
    .replaceAll("{{skillPath}}", SKILL_PATH);
}

export default function memoryExtension(pi: ExtensionAPI) {
  let memoryPromptText: string | undefined;

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
