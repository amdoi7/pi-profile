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

## 展示 diff：不求解，直接构造

通用 diff（Myers, O(N·D)）解决的是「只知道前后两个文本、不知道改了哪里」；
edit **确切知道**改了哪些字节（matched spans），所以 diff 是已知的，不是待求的。
`span-diff.ts` 由此把展示 diff 的规模从**文件规模**降到**编辑规模**：

- 每个 span 扩到行边界 + 4 行 context = 一个展示窗口，重叠窗口合并；
- 窗口内部仍交给共享 diff 引擎（行对齐、词级高亮、EOF annotation），输入只有
  窗口那几行；窗口被 span 完整覆盖时走 O(N) rewrite path；
- 窗口之间/首尾按精确行数补 fold 行（未改动区域两侧文本相同，行数天然相等）；
  相邻 fold 合并成一条；
- 唯一的全文级成本是数换行（`indexOf` 扫描，用于行号与折叠计数）。

因此没有 diff worker、没有超时 tripwire 依赖、没有阈值预算——那些机器原本都是
为「求解一个已知答案」服务的。正确性判据是逐字节等价：`span-diff.test.mjs` 断言
构造出的 display / stats / firstChangedLine / 词级高亮与「把整个文件交给通用
diff」完全相同。

## Failures

服务对象是 LLM agent：错误正文传事实 + 引引下一步，不重复 promptGuidelines/schema
里的完整协议；但引擎手上已有的字节必须随错误交回——扣着不给只换来一次往返：

- `NOT_FOUND`：定位 + 文件原文。先逐字指认第一处分歧
  （`L287 col 56: file "、" U+3001 ≠ oldText "," U+002C`），再跟带行号的原文区域
  （≤ 8 行，单行 ≤ 100 字符）；文件里没有相近文本时明说 `no similar text in the file`，
  不编行号。实现在 `nearest-text.ts`：按行暴力对齐，无索引无相似搜索（只走失败路径，
  8MB/20 万行 × 21 行锚 = 153ms）。依据（2026-08-27 全量语料）：913 次 NOT_FOUND 之后
  模型 70% 立刻重读同一个文件（bash 59% + read 11%）、5% 逐字节原样重发。
- `DUPLICATE_MATCH`：匹配行号
- `NO_CHANGE`：`newText` 归一化后等于 `oldText`（替换不产生任何变化）
- 重叠：`replacement N overlaps replacement M`
- 参数校验失败：带字段路径（`files[1].edits[0].oldText must be a string`）
- 参数残缺：报残缺本身，不报成形状错误——`edits` 缺失说「这一项只写了
  path，重发」；`edits` 到达时是不合法 JSON 文本则带上 parser 原因并说「很可能在
  传输中被截断，原样重发」。依据：实测语料里这两种形状几乎全是参数截断，
  而非模型搞错 schema；报错说错原因会把模型送去改一个本来就对的东西。

`path` 独立保存在结果字段和 UI 文件行中，不在错误正文重复。单个文件内的首个
replacement 不显示内部数组下标；后续 replacement 显示为 `replacement N`。

## Agent Result

`execute()` 返回 compact JSON `content` 与批次 `details`。

信封（`isError`）不在 `execute` 的返回值里：`AgentToolResult` 没有这个字段，
`executePreparedToolCall` 对正常返回一律写 `isError:false`（pi-agent-core
`dist/agent-loop.js`）。所以软失败（`rejected`/`partial`）由扩展的 `tool_result`
handler 改信封；写在 execute 返回值里会被静默丢弃。

成功：

```json
{"status":"applied","files":[{"path":"a.py","changes":{"additions":2,"deletions":1,"changedLines":3},"firstChangedLine":12}]}
```

失败（`rejected` = 零写入，`partial` = 部分留在盘上）：

```json
{"status":"rejected","written":[],"failed":[{"path":"b.py","kind":"NOT_FOUND","message":"replacement 2: oldText was not found; L88 col 5: file 4 spaces ≠ oldText 2 spaces; copy from the file:\n88|    return compute()"}]}
```

`written` 是磁盘现状（仍被改动的文件），模型据此决定重发整批还是只修失败点。

## UI

- pending 阶段显示意图头 + 计划文件行，不读取文件或预计算 diff
- 结果显示意图头（失败态附 `rejected · nothing written` / `partial · some files
  left changed`），下面每文件一行：路径 + 统计 + `hint` / `not written` /
  `restored`，成功文件行后接自己的 diff
- 工具名归因只在意图头出现一次，文件行靠缩进归属；缩进用 `Text` 的 paddingX
  而不是字符串前缀——paddingX 逐行施加，所以 hint / 长路径折行后续行仍在层级内
  （hint 宽度 p90=77 列，常见终端宽度下必然折行）
- diff 旧/新行号分列，changed word 使用反显，折叠行显示省略数量
- 渲染层不做契约裁判：读不懂 details 时（执行前失败的 `details={}`、旧版本会话
  回放）直接降级渲染工具自己的 content 文本——那是当时能给用户的唯一真实信息

## Structure

- `index.ts`：tool 注册入口（schema/guidelines/execute/render 装配）
- `pipeline.ts`：参数契约与校验、canonical 去重、批次执行、agent/UI payload
- `input-normalize.ts`：模型输入容错（单文件形状 → 批次）
- `edit-engine.ts`：匹配、替换、事务（多锁 + 解析闸门 + 回滚）
- `span-diff.ts`：已知 span → 展示 diff（规模 = 编辑规模）
- `ui.ts`：call/result render
- `*.test.mjs`：行为测试
