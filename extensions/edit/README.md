# edit extension

本地 `edit` 扩展说明。

位置：`~/.pi/agent/extensions/edit`

## Contract

`edit` 是条目式精确编辑工具：**一次调用 = 一个编辑脚本**。像 Python 脚本一样，
协议有叙事层与操作层：

- `note`（必填）：顶层字段，`comment` 已废弃：脚本的 docstring——**为什么**改
  （意义与动机），不是操作摘要
- `edits[]`：脚本的 what——每条目一个原子修改（一个 `op` 作用于一个 `path`）
- 每条目只需 `path` + `op` 组合：字段即可选；条目级 `note` 已移除（行注释只有一个面，
  脚本级 `note` 是唯一写 why 的位置）

执行语义：

- 链式执行：每条目匹配当前内容（前一条目已生效的字节/行号），顺序推进
- 任一失败 → 该条目零写入并报错，其后条目 `skipped`，已成条目保留
- 任何 IO 之前完成校验（note/op/字段）；校验失败零写入

**一种形状，从模型到磁盘**：条目是扁平的——`op` 是判别符，它的字段与它平级。
schema 说的形状、校验后的形状、执行层吃的形状是同一个对象；校验只收窄类型，
不重组。

## Input

```json
{
  "note": "跨结算域重命名:amountOwed/amountDue 对齐新结算模型",
  "edits": [
    { "path": "a.py", "op": "replaceAll", "old_str": "amountOwed", "new_str": "amountDue" },
    { "path": "a.py", "op": "insert", "insert_line": 3, "new_str": "# generated\n" },
    { "path": "b.py", "op": "delete", "old_str": "dead_code()" },
    { "path": "c.py", "op": "create", "file_text": "# generated module\n\nVERSION = 1\n" }
  ]
}
```

op 类型（词表与 str_replace_editor 家族一致：`old_str`/`new_str`/`insert_line`/`file_text`）：

| op | 字段 | 语义 |
| --- | --- | --- |
| `replace` | `old_str` + `new_str` | `old_str` 唯一命中 → 替换为 `new_str` |
| `replaceAll` | `old_str` + `new_str` | 替换该文件全部精确命中（不进修复面） |
| `insert` | `insert_line` + `new_str` | 在 `insert_line`（1-based 行号，0 = 文件顶，N = 行数 = 文件尾）之后插入 `new_str` |
| `delete` | `old_str` | 删除 `old_str` 唯一命中 |
| `create` | `file_text`（+ `overwrite`） | 不存在 → 新建；存在且 `overwrite:true` → 整篇替换；存在而不声明 → 拒绝 |

规则：

- **未用参数一律不读**（str_replace_editor 语义）：op 只取自己该用的字段，多余键（含
  null 与非 null）原样忽略；op 必填字段缺失或为 null 仍拒绝
  （`old_str must be a string, got null`）
- `old_str`/`new_str`/`file_text` 必须是字符串；`insert_line` 是整数且落在
  0..文件行数；`op` 在 schema 里是裸 `{ type: "string", enum: [...] }`（Google 的 API
  不接受 anyOf/const）
- `comment` 必填：一行 why，换行折叠、200 字符截断；缺失时报
  `note is required: one line naming why this change exists`
- `note` 可选：条目级注释（为什么改这一处），折叠为单行；仅空串视为未提供
- `old_str` 匹配发生在**字节**上（精确或 fuzzy 等价类），唯一性由 replace/delete 强制；
  `insert_line` 的行号以**当前内容**计（链式：前一条目已生效）
- 同一 `path` 可重复出现：它是该文件的连续编辑步骤（链式的合法形状）
