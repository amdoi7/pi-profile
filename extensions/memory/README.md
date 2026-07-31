# Memory Work Control Plane

`memory` maintains project work as Markdown under `~/.pi/memory/<project>/`.

Core flow: `Issue -> Task`.

## Data Ownership

- `MEMORY.md` points to the control-plane surfaces. Its body is read on demand, not injected into every model request.
- `issues.md` indexes current issues.
- `issues/<issue-id>.md` is the authoritative record for one deliverable.
- `tasks.md` indexes task artifacts.
- `tasks/<task-id>.md` contains one self-contained deliverable linked from an issue.
- `lessons.md` contains canonical reusable workspace rules.
- The repo contains implementation artifacts and their current behavior.
- Pi sessions contain execution activity.

## Issue Contract

An issue owns its outcome, scope, constraints, acceptance criteria, status, active owner, and task links.

```markdown
# ISS-101

status，open
owner，unassigned
summary，Implement the requested behavior

## Intent

- issue intent，current product requirement

## Tasks

- tasks/ISS-101-api.md
- tasks/ISS-101-docs.md

## Acceptance

- observable acceptance criterion
```

One active agent or session owns updates to an issue and its task links. Agents read the `owner` field before mutation and use normal `edit` or `write` operations to keep the record current.

## Task Contract

Each task is a self-contained final-state artifact. Its content covers objective, scope, constraints, acceptance, result, and evidence.

```markdown
---
taskId: ISS-101-api
---

# Implement the API

## Objective

Current objective.

## Scope

Files and behavior owned by this task.

## Constraints

Applicable contracts and boundaries.

## Acceptance

Observable completion criteria.

## Result

Current delivered behavior.

## Evidence

Tests, commands, paths, commits, or PRs that establish the result.
```

Apply feedback directly to the task content so the file always presents one coherent current state. Keep execution activity in the Pi session.

## Lessons Contract

Keep one canonical current rule per concept.

- `MUST`: hard workspace rule
- `SHOULD`: default workspace behavior that may yield to issue constraints
- `MAY`: optional technique or preference
- `OBSERVED`: verified workspace fact without normative force

## Runtime

- `index.ts` registers session-scoped scaffold/prompt hooks and context features.
- `scaffold.ts` creates missing control-plane files for Git projects.
- `memory-contract.ts` owns generated Markdown contracts.
- `prompt.ts` injects only the compact control-plane contract and resolved memory/session paths.
- `pi-context/` owns context statistics and UI.

The runtime stays inactive outside Git projects.

## Maintenance

There is no `/memory` command and no graph state. Agents maintain issues, tasks, and lessons directly with normal `read`, `edit`, and `write` tools, guided by the `project-memory` skill. Wiring between records is plain document file links: an issue ledger lists `tasks/<task-id>.md` paths, and `issues.md` / `tasks.md` stay compact indexes pointing at those files.
