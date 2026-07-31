---
name: project-memory
description: Maintain the Issue -> Task work control plane in project memory. Use when creating or updating issues, task artifacts, lessons, ownership, acceptance, evidence, or handoff state.
disable-model-invocation: true
---

# Project Memory

Use this skill for tracked work in the project memory workspace.

## Control Plane

- `issues.md` indexes current issues.
- `issues/<issue-id>.md` is the authoritative record for one deliverable.
- `tasks.md` indexes task artifacts.
- `tasks/<task-id>.md` contains one self-contained deliverable linked from an issue.
- `lessons.md` contains canonical reusable workspace rules.
- Pi sessions contain execution activity.

Core flow: `Issue -> Task`.

## Issue Contract

An issue owns:

- outcome
- scope
- constraints
- acceptance criteria
- status
- active owner
- task links

Use one issue ledger per deliverable. One active agent or session owns updates to an issue and its task links. Other agents may read the issue but must not mutate it until ownership changes.

## Task Contract

A task is a self-contained final-state artifact. Keep these fields complete and current:

- objective
- scope
- constraints
- acceptance criteria
- result
- evidence

Link every task from an issue. Keep implementation detail in the deliverable itself and execution activity in the Pi session. Apply user feedback directly to the current task content.

## Lessons Contract

Keep one canonical current rule per concept in `lessons.md`.

- `MUST`: hard workspace rule
- `SHOULD`: default workspace behavior that may yield to issue constraints
- `MAY`: optional technique or preference
- `OBSERVED`: verified workspace fact without normative force

## Workflow

1. Read `issues.md` and the relevant issue ledger.
2. Confirm the issue owner, scope, constraints, and acceptance criteria.
3. Create or update a linked task artifact.
4. Produce and verify the deliverable.
5. Record the task result and evidence.
6. Update current issue status and acceptance state.
7. Add a lesson only when the result establishes a reusable workspace rule.

Use normal `read`, `edit`, and `write` tools for issue, task, and lesson files. Fail fast when required control-plane fields are missing or ownership is held by another active agent or session.

## Maintenance

No CLI owns semantic decisions. Maintain issue and task files directly with normal `read`, `edit`, and `write` tools. Wiring is plain document file links: issue ledgers list `tasks/<task-id>.md` paths, and `issues.md` / `tasks.md` index those files. There is no graph state to validate.
