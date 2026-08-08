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
- `edits` 的 JSON 字符串形式会被解析，以兼容内置 `edit` 的输入容错

## Execution

- canonical path 仅用于同一物理文件的 mutation queue
- 同一调用中的所有替换要么全部写入，要么一个也不写入
- 重叠或嵌套的 replacement 被拒绝
- LF/CRLF 与直引号/弯引号只做窄范围归一化；空白、破折号和其他文本仍须精确匹配
- 成功后由 `jsdiff` 生成结构化 line hunk，并将阈值内 changed block 细化为逐行 word ranges，再交给 Pi `Component` renderer 展示双行号最终 diff；`jsdiff` 超时（250ms，整文件重写等退化场景）时降级为公共前后缀剥离的 unlocated 行 diff，stats 保持准确

## Failures

失败信息只保留失败原因与下一步：

- `NOT_FOUND`：重新读取文件，逐字复制 `oldText`，包括空白
- `DUPLICATE_MATCH`：增加最小上下文，或设置 `replaceAll: true`
- `NO_CHANGE`：确认补丁是否已经应用

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
- 失败时标题是路径的唯一展示位置，正文只显示恢复信息

## Structure

- `index.ts`：tool 注册入口
- `pipeline.ts`：输入规范化、单文件执行、agent/UI payload
- `edit-engine.ts`：匹配、替换、落盘
- `ui.ts`：call/result render
- `*.test.mjs`：行为测试
