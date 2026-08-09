# edit extension

本地 `edit` 扩展说明。

位置：`~/.pi/agent/extensions/edit`

## Contract

`edit` 是单文件精确替换工具。

- 每次调用接受 `{ path, edits }`，并原子修改一个文件
- 同一文件的多个不重叠替换放在 `edits[]`
- 多文件修改使用多个 `edit` call，Pi 并行执行
- 调用前完成校验；失败时不落盘

## Input

```json
{
  "path": "src/a.ts",
  "edits": [
    { "oldText": "foo", "newText": "bar" },
    { "oldText": "oldName", "newText": "newName", "replaceAll": true }
  ]
}
```

- `oldText` 与 `newText` 必须是字符串
- 未设置 `replaceAll` 时，`oldText` 必须只匹配一个位置
- `replaceAll: true` 时，替换该文件内的全部匹配
- 每个 `edits[].oldText` 都针对原始文件匹配，不按前一个 replacement 增量匹配

### 输入容错

以下 legacy/退化形状会被归一化（语义无歧义才接受，否则照常拒绝）：

- `edits` 的 JSON 字符串形式会被解析，以兼容内置 `edit` 的输入容错
- flat legacy 形状 `{ path, oldText, newText }` 合并为 `edits[0]`（与内置 `edit` 对齐；顶层 `replaceAll` 一并合并）
- `oldText2/newText2`…（顶层或 edit 对象内）成对出现时按序追加为额外 edit，绝不静默丢弃
- `expectedOccurrences` 被丢弃（legacy 字段；其默认语义即本工具的 unique-match 契约）

其余未知 key、缺 `path`、缺 `oldText` 仍拒绝，错误消息为 arktype 错误原文。

## Execution

- canonical path 仅用于同一物理文件的 mutation queue
- 同一调用中的所有替换要么全部写入，要么一个也不写入
- 重叠或嵌套的 replacement 被拒绝
- LF/CRLF 与直引号/弯引号只做窄范围归一化；空白、破折号和其他文本仍须精确匹配
- 成功后由纯 TS diff 引擎生成结构化 line hunk（公共前后缀剥离 + 无共享行 fast path + `jsdiff` Myers 250ms tripwire），在每进程一个长期 worker 中计算（batch 提交，首次调用预热）；展示保持 unified 块形态，配对仅在预算内计算词级高亮；可证明整文件替换走 O(N) rewrite path；Myers 超时等退化场景降级为 unlocated 行 diff，stats 保持准确

## Failures

服务对象是 LLM agent：错误正文只传增量（事实 + 必要定位/原因），修复协议已在 promptGuidelines/schema 中声明，不重复传递：

- `NOT_FOUND`：`oldText was not found.`——模型自会 fetch/copy/retry，不传任何诊断或指令
- `DUPLICATE_MATCH`：匹配行号
- `NO_CHANGE`：`newText` 归一化后等于 `oldText`（替换不产生任何变化）
- 重叠：`replacement N overlaps replacement M`
- 参数校验失败：arktype 错误原文

`path` 独立保存在结果字段和 UI 标题中，不在错误正文重复。首个 replacement 不显示内部数组下标；后续 replacement 显示为 `replacement N`。

## Agent Result

`execute()` 返回 compact JSON `content`。

成功结果：

- `status: "applied"`
- `path`
- `changes`
- `firstChangedLine`

失败结果：

- `status: "failed"`
- `path`
- `error.kind`
- `error.message`

## UI

- pending 阶段只显示文件标题，不读取文件或预计算 diff
- 成功时标题后显示统计和最终 diff；旧/新行号分列，changed word 使用反显，折叠行显示省略数量，源码空行保留 gutter
- 失败时标题是路径的唯一展示位置，正文只显示错误消息

## Structure

- `index.ts`：tool 注册入口
- `pipeline.ts`：输入规范化、单文件执行、agent/UI payload
- `edit-engine.ts`：匹配、替换、落盘
- `ui.ts`：call/result render
- `*.test.mjs`：行为测试
