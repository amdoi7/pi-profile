# edit extension

本地 `edit` 扩展说明。

位置：`~/.pi/agent/extensions/edit`

## Contract

`edit` 是批量精确替换工具：**一次调用 = 一个意图 = 一个事务**。

- 每次调用接受 `{ intent, files }`，`files[]` 是这个意图触碰的全部文件
- 一个意图不拆成多次调用；不为同一个改动发并行 `edit` call
- 整批要么全部落盘，要么一个字节都不落（解析面失败 → 零写入）
- 调用前完成校验；失败时不落盘

## Input

```json
{
  "intent": "split ToolCtx into PullCtx/ActCtx",
  "files": [
    {
      "path": "packages/harness/src/harness/decl/model.py",
      "hint": "别名取 PullCtx|ActCtx 的并",
      "edits": [
        { "oldText": "foo", "newText": "bar" },
        { "oldText": "oldName", "newText": "newName", "replaceAll": true }
      ]
    },
    { "path": "src/app/decl.py", "edits": [{ "oldText": "ToolCtx", "newText": "PullCtx", "replaceAll": true }] }
  ]
}
```

- `intent` 必填：一行说明这批修改是什么改动（连续空白/换行折叠成一行）
- `files[].hint` 可选：这个文件在意图里的角色，展示在文件行尾
- `oldText` 与 `newText` 必须是字符串
- 未设置 `replaceAll` 时，`oldText` 必须只匹配一个位置
- `replaceAll: true` 时，替换该文件内的全部匹配
- 每个 `edits[].oldText` 都针对该文件的原始内容匹配，不按前一个 replacement 增量匹配
- 同一物理文件只能出现一次（同名或 canonical 相同都拒绝）：第二份 edits 会针对已改内容匹配，语义不成立

### 输入容错

以下形状会被归一化（语义无歧义才接受，否则照常拒绝）：

- `files` / `edits` 的 JSON 字符串形式会被解析（provider 序列化退化）
- 内置 edit 的单文件形状 `{ path, edits }` 抬升为 `files: [{ path, edits }]`
- flat 形状 `{ path, oldText, newText }`（含顶层 `replaceAll`）同样抬升为 files[0]

`intent` 从不代为编造：没有意图的批次直接拒绝——意图是事务的名字，不是装饰。

## Execution

- canonical path 用于去重与 mutation queue
- 事务一次持有 batch 内全部文件的 mutation lock，获取顺序 = canonical path 字典序
  （全局一致顺序 → 并发 batch 无环 → 无死锁）
- 解析面（尺寸闸门 → 可读写 → 读入 → 内存内应用 edits）不写任何字节；
  任一文件失败 → 整批 `rejected`，全部失败一次性回报
- 落盘面 IO 失败 → 已写文件按原始字节回滚：全部还原 = `rejected`，
  还原失败的留在盘上 = `partial`（响亮报出，绝不静默半提交）
- abort 在提交点之前生效；越过提交点后事务走完，避免半写状态
- 重叠或嵌套的 replacement 被拒绝
- LF/CRLF 与直引号/弯引号只做窄范围归一化；空白、破折号和其他文本仍须精确匹配
- 展示 diff：整批一次 worker 往返（每文件独立 strategy：可证明整文件替换走 O(N)
  rewrite path，否则 exact + 250ms Myers tripwire）；worker 不可用时降级为 O(N)
  unlocated 行 diff（stats 仍精确），绝不在主线程重跑刚失败的 Myers

## Failures

服务对象是 LLM agent：错误正文只传增量（事实 + 必要定位/原因），修复协议已在
promptGuidelines/schema 中声明，不重复传递：

- `NOT_FOUND`：`oldText was not found.`——模型自会 fetch/copy/retry，不传任何诊断或指令
- `DUPLICATE_MATCH`：匹配行号
- `NO_CHANGE`：`newText` 归一化后等于 `oldText`（替换不产生任何变化）
- 重叠：`replacement N overlaps replacement M`
- 参数校验失败：带字段路径（`files[1].edits[0].oldText must be a string`）

`path` 独立保存在结果字段和 UI 文件行中，不在错误正文重复。单个文件内的首个
replacement 不显示内部数组下标；后续 replacement 显示为 `replacement N`。

## Agent Result

`execute()` 返回 compact JSON `content`；`isError = status !== "applied"`。

成功：

```json
{"status":"applied","files":[{"path":"a.py","changes":{"additions":2,"deletions":1,"changedLines":3},"firstChangedLine":12}]}
```

失败（`rejected` = 零写入，`partial` = 部分留在盘上）：

```json
{"status":"rejected","written":[],"failed":[{"path":"b.py","kind":"NOT_FOUND","message":"replacement 2: oldText was not found."}]}
```

`written` 是磁盘现状（仍被改动的文件），模型据此决定重发整批还是只修失败点。

## UI

- pending 阶段显示意图头 + 计划文件行，不读取文件或预计算 diff
- 结果显示意图头（失败态附 `rejected · nothing written` / `partial · some files
  left changed`），下面每文件一行：路径 + 统计 + `hint` / `not written` /
  `restored`，成功文件行后接自己的 diff
- 工具名归因只在意图头出现一次，文件行靠缩进归属
- diff 旧/新行号分列，changed word 使用反显，折叠行显示省略数量

## Structure

- `index.ts`：tool 注册入口（schema/guidelines/execute/render 装配）
- `pipeline.ts`：参数契约与校验、canonical 去重、批次执行、agent/UI payload
- `input-normalize.ts`：模型输入容错（单文件形状 → 批次）
- `edit-engine.ts`：匹配、替换、事务（多锁 + 解析闸门 + 回滚）、展示 diff
- `ui.ts`：call/result render
- `*.test.mjs`：行为测试
