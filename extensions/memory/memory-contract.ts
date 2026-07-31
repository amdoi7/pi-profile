export const ENTRYPOINT_NAME = "MEMORY.md";
export const ENTRYPOINT_HEADER = "# MEMORY";

export const MEMORY_SURFACES = {
  issues: {
    name: "issues.md",
    summary: "issue control plane and deliverable index",
  },
  tasks: {
    name: "tasks.md",
    summary: "self-contained task artifacts",
  },
  lessons: {
    name: "lessons.md",
    summary: "canonical reusable workspace rules",
  },
} as const;

export const ISSUE_DETAILS_DIR = "issues";
export const TASK_DETAILS_DIR = "tasks";

export const ISSUE_TASK_CONTRACT_LINES = [
  "- Issue -> Task: issue owns outcome, scope, constraints, and acceptance; task owns one deliverable.",
  "- A task is complete when its result and evidence satisfy its acceptance criteria.",
  "- An issue is complete when its linked tasks satisfy the issue acceptance criteria.",
];

export const OWNERSHIP_CONTRACT_LINES = [
  "- Use one issue ledger per deliverable under issues/.",
  "- One active agent or session owns updates to an issue and its task links.",
  "- Keep issues.md as a compact index of current issue state.",
  "- Store execution activity in the Pi session; keep only current control-plane state in issue and task files.",
];

export const LESSON_STRENGTH_LINES = [
  "- MUST: hard workspace rule; violating it is a bug.",
  "- SHOULD: default workspace behavior that may yield to issue constraints.",
  "- MAY: optional technique or preference.",
  "- OBSERVED: verified workspace fact without normative force.",
];

export function buildDefaultEntrypointContent(entrypointHeader: string): string {
  return `${entrypointHeader}\n\n- ${MEMORY_SURFACES.issues.name} — ${MEMORY_SURFACES.issues.summary}\n- ${MEMORY_SURFACES.tasks.name} — ${MEMORY_SURFACES.tasks.summary}\n- ${MEMORY_SURFACES.lessons.name} — ${MEMORY_SURFACES.lessons.summary}\n`;
}

export function buildDefaultIssueIndexContent(): string {
  return [
    "# Issues",
    "",
    "Issue control plane. Core flow: Issue -> Task.",
    "",
    "## Flow contract",
    "",
    ...ISSUE_TASK_CONTRACT_LINES,
    "",
    "## Ownership contract",
    "",
    ...OWNERSHIP_CONTRACT_LINES,
    "",
    "## Issues",
    "",
    "- none",
    "",
  ].join("\n");
}

export function buildDefaultTaskIndexContent(): string {
  return [
    "# Tasks",
    "",
    "Each task is a self-contained final-state artifact linked from an issue.",
    "",
    "Keep each task current and complete: objective, scope, constraints, acceptance, result, and evidence.",
    "",
  ].join("\n");
}

export function buildDefaultLessonsContent(): string {
  return [
    "# Lessons",
    "",
    "Canonical reusable rules for this workspace. Keep one current rule per concept.",
    "",
    "## Lesson strength",
    "",
    ...LESSON_STRENGTH_LINES,
    "",
  ].join("\n");
}
