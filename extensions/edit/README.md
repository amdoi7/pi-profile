# edit extension

本地 `edit` 扩展说明。

位置：`~/.pi/agent/extensions/edit`

## 现状

此目录今仅提供一项工具：

- `edit`：按文件分组之精确替换工具

原则：

- 先验证，再落盘
- 单文件原子，多文件隔离
- 结果按文件分组返回
- 每文件完成后生成一次最终 preview
- UI 按文件分块展示

## 目录结构

- `index.ts`：tool 注册入口
- `pipeline.ts`：输入校验、单文件执行、agent payload 与 UI details 组装
- `edit-engine.ts`：单文件匹配、替换、落盘
- `preview.ts`：preview window、行级 diff 与 summary
- `ui.ts`：call/result render
- 行级 diff 由 `generateDiffString()` 生成，显示着色直接使用 Pi 原生 `renderDiff()`
- `*.test.mjs`：按模块分之行为测试

## 输入格式

标准格式：

```json
{
  "path": "src/a.ts",
  "edits": [
    { "oldText": "foo", "newText": "bar" },
    { "oldText": "oldName", "newText": "newName", "expectedOccurrences": 3 }
  ]
}
```

规则：

- 标准格式为 `{ path, edits }`（与 pi 内置 edit 一致）；一次调用只编辑一个文件
- 多文件编辑：每个文件发一次调用，pi 并行执行
- `edits` 为 JSON 字符串的输入会自动解析（与 pi 内置 edit 行为一致）
- `oldText` / `newText` 必须成对出现
- `expectedOccurrences` 可选，默认为 `1`；若显式设置，必须为正整数

## 执行语义

- 每个文件组先解析成 canonical path
- 若两个 entry 指向同一物理文件，会合并为一个原子 file group
- 单文件组要么整组成功，要么整组失败
- 多文件彼此隔离，不互相回滚
- 单文件内所有 `edits[].oldText` 皆相对于原始文件内容匹配，不按顺序增量匹配
- 未设置 `expectedOccurrences` 时，`oldText` 必须唯一，多处命中仍报 `DUPLICATE_MATCH`
- 设置 `expectedOccurrences` 时，实际命中数必须正好等于期望值，并替换全部命中
- 不允许重叠、嵌套或依赖前一个替换结果之 edits
- 引号差异仅保留一窄兜底。直引号与弯引号不一致时，可定位真实命中块并尽量保持原风格
- 不做广义 fuzzy 归一化。破折号、尾随空格等不精确命中时直接失败

## 失败恢复

- 若 `NOT_FOUND`、`DUPLICATE_MATCH`、`OCCURRENCE_MISMATCH` 或 `NO_CHANGE`
- 优先刷新或扩展当前块附近之 `oldText`；若本意是替换全部命中，则显式设置 `expectedOccurrences`
- 若为 `NO_CHANGE`，先重读当前文件，确认补丁是否已应用，再决定是否继续提交
- 仅在确需新区域时，以 `bash` / `rg` / `read` 做局部定位与局部重读
- 不默认整文件重读

## 返回给 LLM

`edit.execute()` 仅返回 compact JSON `content`。

顶层：

- `counts.applied`
- `counts.failed`
- `applied[]`
- `failed[]`

成功组：

- `path`
- `changes`
- `firstChangedLine`

失败组：

- `path`
- `error.kind`
- `error.message`

说明：

- `canonicalPath`、`summary`、UI block state 不进入 agent payload
- agent 直接按 `applied[]` 与 `failed[]` 消费结果即可

## UI 语义

- pending 阶段只显示 compact file headers，不读取文件、不计算 diff
- result 阶段清除 pending headers，按文件分块展示唯一的 final diff
- 成功文件单独展示其 summary 与 diff
- 失败文件单独展示其错误
- 不把整批结果混成一段大 diff

## 设计取向

- 对外给 LLM 之 payload 保持 compact，typed，decision-oriented
- 不把 UI 渲染所需富状态泄漏回 execute 阶段
- planner 负责 canonical path、去重、顺序与并发计划
- executor 负责真实文件系统修改与结果事实
- render 只消费结果 view model，不反向决定执行策略
