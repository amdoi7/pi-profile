---
name: project-memory
description: Project memory workflow reference for issues/ deliverables and lessons.md.
disable-model-invocation: true
---

# Project Memory

Project memory lives in the project memory directory: `issues/<id>.md` holds one deliverable per file across its full lifecycle; `lessons.md` holds one reusable rule per concept. One deliverable, one file.

## Workflow

1. **Read the relevant memory.** List `issues/`, then read the deliverable and lessons that bear on this task. Done when: the task's goal, the current state, and every applicable rule are known.
2. **Confirm the control-plane fields.** Status, owner, scope, constraints, and acceptance are present and valid, and no other active session owns the deliverable. Done when: the fields are complete and ownership is uncontested.
3. **Deliver against acceptance.** Produce and verify the deliverable (test-first). Done when: every acceptance criterion holds with evidence.
4. **Update the deliverable in place.** Record result, evidence, and status in the existing file. Done when: the file presents one coherent current state.
5. **Persist only reusable lessons.** A lesson belongs in `lessons.md` only when it applies to future sessions, generalizes beyond this deliverable, and changes future behavior. Done when: every candidate rule either passes all three checks or stays out; execution detail stays in the session.
6. **Reflect against recorded lessons.** While executing, check lessons against the current repo state; when they contradict, trust the measured state and update the record. Done when: `lessons.md` matches the repo.

## Deliverable Contract

Split sub-deliverables into separate files linked from the parent.

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

## Lessons Contract

Lesson strength:

- `MUST`: hard workspace rule; violating it is a bug.
- `SHOULD`: default workspace behavior that may yield to issue constraints.
- `MAY`: optional technique or preference.
- `OBSERVED`: verified workspace fact without normative force.
