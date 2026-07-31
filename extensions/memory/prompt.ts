import type { MemoryPromptTemplateValues } from "./scaffold.ts";

const MEMORY_SKILL_NAME = "project-memory";

const PROMPT_HEADER = `# Memory

Your project memory directory is \`{{memoryDir}}\`. Use the normal read/edit/write tools to maintain its Markdown files.`;

const CONTROL_PLANE_SECTION = `Control-plane rules:
- Core flow: Issue -> Task.
- Keep issue scope, constraints, acceptance, status, ownership, and task links in issues.md plus one issues/<issue-id>.md ledger.
- Keep each task in tasks/<task-id>.md as a self-contained final-state artifact with objective, scope, constraints, acceptance, result, and evidence.
- One active agent or session owns updates to an issue and its task links.
- Keep canonical reusable workspace rules in lessons.md.
- Store execution activity in the Pi session, not in issue, task, or lesson files.
- Verify memory against the current repo state before relying on it.`;

const SKILL_SECTION = `Skill guidance:
- Use \`${MEMORY_SKILL_NAME}\` when creating or updating issues, tasks, lessons, or handoff state.
- Keep this always-on prompt limited to the control-plane contract; load the skill for the full workflow.`;

const SEARCH_GUIDANCE_SECTION = `Search guidance:
- Start with issues.md, then open the relevant issue ledger and linked task files.
- Search memory files under \`{{memoryDir}}\` only after choosing the relevant surface.
- Search Pi sessions under \`{{sessionsDir}}\` only when execution evidence is required.`;

export function buildMemoryPromptText(values: MemoryPromptTemplateValues): string {
  return [
    PROMPT_HEADER,
    CONTROL_PLANE_SECTION,
    SKILL_SECTION,
    SEARCH_GUIDANCE_SECTION,
  ].join("\n\n")
    .replaceAll("{{memoryDir}}", values.memoryDir)
    .replaceAll("{{sessionsDir}}", values.sessionsDir);
}
