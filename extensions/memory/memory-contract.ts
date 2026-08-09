export const ISSUE_DETAILS_DIR = "issues";
export const LESSONS_FILE_NAME = "lessons.md";

export const LESSON_STRENGTH_LINES = [
  "- MUST: hard workspace rule; violating it is a bug.",
  "- SHOULD: default workspace behavior that may yield to issue constraints.",
  "- MAY: optional technique or preference.",
  "- OBSERVED: verified workspace fact without normative force.",
];

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
