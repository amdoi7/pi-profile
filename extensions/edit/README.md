# edit extension

本地 `edit` 扩展说明。

位置：`~/.pi/agent/extensions/edit`

## Contract

`edit` 是文件作用域化的严格编辑工具：**一次调用 = 一个编辑脚本**。像 Python
脚本一样，协议有叙事层与操作层：

- `note`（必填）：顶层字段，脚本的 docstring——**为什么**改（意义与动机），
  **批次唯一意图**：一个意图驱动一批修改，不是每个修改点一个意图
- `files[path]`：脚本的 what——每个文件的条目链（顺序执行，同文件多步修改
  表达为同一 path 的连续条目）
- 条目 = `match` + 可选 `new_str`：`path` 在 `files` 键上，条目内不重复

执行语义：

- 链式执行：每条目匹配当前内容（前一条目已生效的字节/行号），顺序推进
- 任一失败 → 该条目零写入并报错，其后条目 `skipped`，已成条目保留
- 任何 IO 之前完成校验（note/条目字段）；校验失败零写入

**严格模式（不向后兼容）**：schema 说死唯一形状，错误即时可见——未声明字段
（含 null）、顶层多余键、缺失必填全部在 `parseEditRequest` 即时拒绝，字段名与
当前值随错误带回；不做静默忽略，单一真相源才可能被纠正。

**一种形状，从模型到磁盘**：条目是扁平的——`match` 是定位原语，选择器与它平级。
`schema` 说的形状、校验后的形状、执行层吃的形状是同一个对象；校验只收窄类型、
把 `files` 确定性投影成内部条目序列（条目带 path），不重组。

## Input

```json
{
  "note": "重命名结算域字段",
  "files": {
    "a.py": [
      { "match": "amountOwed", "new_str": "amountDue" },
      { "match": "# old header", "new_str": "# generated" },
      { "match": "dead_code()", "occurrence": 2 }
    ],
    "b.py": [{ "match": "legacy", "new_str": "" }]
  }
}
```

条目语义（单一 `match` 原语；新建/整篇覆盖用 cat heredoc）：

- `match` + `new_str`：替换命中（默认全部；选择器收窄）
- `match` 缺省 `new_str`：删除命中（替换为空）

选择器（可选，正交组合）：

| 选择器 | 类型 | 语义 |
| --- | --- | --- |
| `occurrence` | int | 只替换第 N 次出现（1-based）；与 `limit` 互斥 |
| `limit` | int | 只替换前 M 个匹配（缺省 = 全部） |
| `after` | str | 锚点：只匹配该文本**之后**的区域 |
| `before` | str | 锚点：只匹配该文本**之前**的区域 |
| `regex` | bool | `match` 按正则解释（默认 false） |

规则：

- **严格字段**：条目只用 `match`/`new_str`/选择器，多余键（含 null）一律拒绝
  （`files["a.py"].stray must be removed`）；`match` 缺失或为 null 拒绝
  （`match must be a string, got null`）
- `match`/`new_str` 必须是字符串；`occurrence`/`limit` 是正整数，`occurrence` 与
  `limit` 互斥
- `note` 必填非空：一行 why，批次唯一意图；缺失/空时报
  `note is required: one line naming why this batch exists`
- `files` 必填非空对象：path → 条目链（每条目 `match` 必填）；顶层多余键拒绝
- `match` 匹配发生在**字节**上（精确或 fuzzy 等价类）；`after`/`before` 锚点
  不存在时报错带锚点文本
- 同一 `path` 的连续条目 = 该文件的连续编辑步骤（链式的合法形状）
