# edit extension

本地 `edit` 扩展说明。

位置：`~/.pi/agent/extensions/edit`

## 契约

`edit` 是**单文件**严格编辑工具：**一次调用 = 一个文件的一个编辑脚本**。
像 Python 脚本一样，协议有叙事层与操作层：

- `note`（必填）：脚本 docstring——**为什么**改（意义与动机），
  **批次唯一意图**：一个意图驱动一批修改，不是每个修改点一个意图
- `path`（必填）：唯一目标文件。**一次调用只改一个文件**，其他文件另起调用
- `edits`（必填）：该文件的条目链，顺序执行；**条目不带 path**——文件在调用层只说一次

执行语义：

- 链式执行：每条目匹配当前内容（前一条目已生效的文本/行号），顺序推进
- 任一失败 → 该条目零写入并报错，其后条目 `skipped`，已成条目保留
- 任何 IO 之前完成校验（note/path/条目字段）；校验失败零写入

**严格模式（不向后兼容）**：schema 说死唯一形状，错误即时可见——未声明字段
（含 null）、顶层多余键、缺失必填全部即时拒绝，字段名与当前值随错误带回；
不做静默忽略，单一真相源才可能被纠正。

**一种形状，从模型到磁盘**：`match` 是唯一定位原语，无选择器。
`schema` 说的形状、校验后的形状、执行层吃的形状是同一个对象；校验只收窄类型、
不重组——输入即内部形状，无第二层映射。

## 输入

```json
{
  "note": "重命名结算域字段",
  "path": "a.py",
  "edits": [
    { "match": "amountOwed", "new_str": "amountDue" },
    { "match": "# old header", "new_str": "# generated" },
    { "match": "oldName", "new_str": "newName", "replace_all": true },
    { "match": "legacy", "new_str": "" }
  ]
}
```

条目语义（单一 `match` 原语；新建/整篇覆盖用 cat heredoc）：

- `match` + `new_str`：替换命中
- `match` 缺省 `new_str`：删除命中（替换为空）
- `replace_all: true`：替换**全部**命中（重命名等场景），跳过唯一性要求

无选择器：`match` 缺省必须在文件里**唯一命中**。多处命中即 `DUPLICATE_MATCH`
（带行号清单），两个出口：把 `match` 加长到唯一，或 `replace_all: true`
一次替换全部——选择器能表达的，更长的 `match` 都能表达，少一个原语少一类失败。

规则：

- **严格字段**：条目只用 `match`/`new_str`，顶层只用 `note`/`path`/`edits`，
  多余键（含 null）一律拒绝（`edits[0].stray must be removed`）；
  `match` 缺失或为 null 拒绝（`match must be a string, got null`）
- `note`/`path`/`match` 必须是非空字符串；`new_str` 缺省 = 删除
- `note` 缺失/空时报 `note is required: one line naming why this batch exists`；
  `path` 缺失时报 `path is required: the one file this call edits`
- `match` 按文件原文精确匹配，无任何隐式变体折叠
  （弯引号/全角半角标点/空白都算不同字符）——分歧一律显式回传，引擎不猜方言：
  - 未命中 → `NOT_FOUND` + 结构化 `closest`（逐字指认 + 可照抄的原文行）：
    - `closest.truncated=false`：窗口完整，照抄 `closest.text` 重发即可，无需重读
    - `closest.truncated=true`（needle 超 8 行或整窗超 1200 字符）：重读文件再
      重发——照抄半截窗口只会二次失败
  - 多处命中 → `DUPLICATE_MATCH` + 行号清单（最多 8 处），该条目零写入；
    把 `match` 加长到唯一，或 `replace_all: true` 后重发
  - 命中但替换归一化后无变化 → `NO_CHANGE`
- 同一脚本内的连续条目 = 该文件的连续编辑步骤（链式的合法形状）

## 错误通道

| 层 | 角色 | 报错文案 |
| --- | --- | --- |
| `parameters` schema | 指令通道——严格形状即生成约束 | generic TypeBox 文案（实际不可达，见下） |
| 入口校验（schema 闸门之前） | **rich 错误通道**——先跑 `parseEditRequest` | 字段名 + 当前值（`edits[0].match must be a string, got null`） |
| 执行入口 | 最终守卫——防绕过校验的直调路径，canonical 输入零成本复检 | 同入口校验 |

schema 闸门只见到合法形状（入口校验已先拒非法输入），generic 文案实际不可达。
