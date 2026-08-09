# Memory Work Control Plane

`memory` maintains project work as Markdown under `~/.pi/memory/<project>/`.

## Structure

- `issues/` — one Markdown file per deliverable, full lifecycle. The directory is the index; list it to see current work.
- `lessons.md` — canonical reusable workspace rules, one rule per concept.

No index files, no CLI, no graph state. Agents maintain files directly with normal `read`, `edit`, and `write` tools, guided by the `project-memory` skill.

## Deliverable Contract

Each `issues/<id>.md` file covers the full lifecycle of one deliverable:

```markdown
---
status: active            # active | closed
owner: unassigned         # session id, or unassigned
summary: one-line outcome
---
# <id> <Title>

## 目标
## 范围
## 约束
## 验收
## 结果
## 证据
## 遗留
```

Split sub-deliverables into separate files linked from the parent. Apply feedback directly to the file so it always presents one coherent current state.

## Lessons Contract

Keep one canonical current rule per concept. A lesson must change future behavior; facts specific to the current session stay in the session, not in lessons.md.

- `MUST`: hard workspace rule
- `SHOULD`: default workspace behavior that may yield to issue constraints
- `MAY`: optional technique or preference
- `OBSERVED`: verified workspace fact without normative force

## Runtime

- `index.ts` — session-scoped hooks and the single injection owner: scaffold on `session_start`, compact contract injection on `before_agent_start`; the memory prompt and the skill path live here.
- `scaffold.ts` — creates the memory directory, `issues/`, and `lessons.md` for Git projects.
- `memory-contract.ts` — owns the generated lessons template.
- `paths.ts` — project-root resolution and memory directory paths.
- Context statistics and HUD live in the separate `context-ui` extension.

The runtime stays inactive outside Git projects.
