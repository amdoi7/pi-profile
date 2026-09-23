# custom-footer

两行网格状态栏：左列环境/会话信息，右列模型与订阅额度。纯函数渲染在
`custom-footer-format.ts`（无 pi 依赖，可单测），`index.ts` 只负责生命周期、
事件与数据获取。

## 布局

```
cwd: ~/.pi                               │ ⎇ main ↑2                               │ Kimi For Coding/k3-256k · think:max
ctx: 53k 20% $0.87 miss 143k (2×)       │ ↑1k ↓317 (τ39%) ℂ99.21%               │ 100 t/s ttfb5.5s 本轮16m21s
```

- 行1（静态）：`cwd:` 工作目录（home 相对 `~` 路径，>30 列折叠中段）、`provider/model · think:level`（level 按 thinking* 主题 token 着色，与编辑器边框同色）、会话锚 `◈id8`（**真彩色 = id 哈希**——djb2→色相→HSL 直出 RGB ANSI，同 id 恒同色、跨会话异色，omp session-color 思路；不受主题 token 数限制）、git branch（`⎇` + dirty `*` + ahead/behind `↑↓`，diverged 为 `↑3↓2` 紧凑式）；rebase/merge/cherry-pick/revert/bisect 进行中时追加操作标签（`REBASING 3/5`、`MERGING`…，warning 色）。
- 行2 前段（session 级，同段同源）：`ctx:` 上下文 tokens 与使用率（≥70% 橙、≥85% 红）、会话累计成本 `$`（官方 usageTotals.cost 口径，含 toolResult/compaction 条目；订阅制 provider 前缀 `S`）、缓存失效汇总 `miss次数× 重新计费tokens (+$金额)`（仅 missCount>0 时显示；金额≥1分且非订阅制才追加；算法口径与 pi cache-stats 一致：compaction 重置基线、1024 token 噪声底线）。
- 行2 中段（轮级）：最近一轮（用户消息 → 不再输出）的 `↑输入 ↓输出`、thinking 占比 `(τ%)`、缓存命中率 `ℂ%`——进行中实时、settled 锁定，与尾段 t/s 同一轮同源（不是最后一条消息，也不是 session 累计；官方 footer 把 session 累计 ↑↓ 与最后一条消息 CH 并排是视角漂移来源，此处不混搭）。
- 行2 尾段（轮级动态）：吞吐 `t/s`（output 含 thinking，流式口径——分母 = 本轮流式时间，各消息首块→结束之和；工具执行/思考等待/消息间隙不计入，墙钟仅无流式记录时回退）、`ttfb`、`本轮时长`。
- 网格为设计量尺：两行共享三列（行1 `cwd │ branch │ model`，行2
  `ctx+$+miss │ ↑↓τℂ │ 动态段`），每列宽度 = 两行同段显示宽度的最大值，短列在 `│`
  前补空格 —— 两个 `│` 列上下对齐（同构公式，前后同规则），行首不动；
  列1 补齐到 40 单位下限，列2 内容驱动。无 branch 或宽 <100 时退化为右列对齐，
  usage 缺失或宽 <72 时退化为三行流式；轮级段缺失时（空会话）第二行退化为
  左对齐单段，不拼接空列。

## 颜色（FooterColor，由 pi 主题注入）

| 键 | 用途 |
|---|---|
| `text` | 主值：model、路径、tokens、↑↓ |
| `muted` | 标签（`cwd:`/`ctx:`/窗口名）、次要值（R/W、miss、tps、时间、分隔 `│`） |
| `success` | 使用率 <70%（ctx）/<50%（额度） |
| `warning` | ctx 70-84%、额度 70-89%、dirty 标记 |
| `error` | ctx ≥85% 或 ≥400k tokens、额度 ≥90% |
| `thinkingOff`…`thinkingMax` | `think:level` 标签，与编辑器边框同 token |
| `customMessageLabel` | 扩展状态行 |

额度 50-69% 用 `text` 中性色：信号色只在需要行动的阈值点火，`accent`
（主题品牌锚点）不用作计量色。

## 额度数据源（custom-footer-usage.ts）

只跟随当前模型 provider（`detectUsageProvider`）：

| provider | 来源 | 凭据 |
|---|---|---|
| kimi | `api.kimi.com/coding/v1/usages` | `auth.json` kimi-coding OAuth token；过期时经 `auth.kimi.com/api/oauth/token` 刷新并回写 |
| claude | `api.anthropic.com/api/oauth/usage` | keychain `Claude Code-credentials` |
| codex | `chatgpt.com/backend-api/wham/usage` | `~/.codex/auth.json` OAuth tokens |
| 其他（deepseek 等） | 不显示 | 按量付费 |

fetcher 有 60s TTL 与失败退避（5min）；刷新成功返回 `true` 触发重渲染。

## 模块（职责分层：事件 / 轮级 / session 级 / 展示）

- `index.ts` — **事件接线层**：extension 入口；`session_start` 注册 footer，`agent_start/agent_settled` 定义本轮边界（用户消息 → 不再输出），`turn_start` 提供每条消息的 TTFB 起点，`message_update/end` 采集轮级实时源，`agent_end` 批量消息采集轮级锁定源，`thinking_level_select`/`model_select` 即时 flush，`onBranchChange` + gitDir watch（外部 git 变化即时重渲染）触发，30s 定时兜底。事件处理器只更新数据；渲染由数据源 onChange hook 集中调度（live 节流 / commit 立即）+ 进行中每秒 tick 兜底（thinking/工具执行期无事件也刷新）。render 组装三段：session 级（`ctx.getContextUsage()` + stats 快照）、轮级（tps tracker）、额度（usage fetcher）。
- `custom-footer-tps.ts` — **轮级 tracker（一条消息 → 一轮）**：本轮（agent_start → agent_settled）时长、t/s、ttfb、以及轮级 token flow（↑↓τℂ 段数据源，`getRoundFlow`）；t/s 分母 = 流式时间（各消息 firstChunk→message_end 之和，工具/思考/间隙不稀释——2026-09 review 修正墙钟口径）；双消息源——实时源（进行中显示）用 message_end 增量，锁定源（settled 锁定）用 agent_end 批量消息（官方源，失败/aborted 消息无 message_end 也不漏计）。**不含 cost**——成本是 session 级指标。
- `custom-footer-stats.ts` — **session 级聚合（整个会话）**：flow/cost/waste 全量快照（`rebuild(entries)` 唯一更新路径；五桶加法与缓存浪费全部走官方 vendored 实现 `vendor/usage-totals.ts` / `vendor/cache-stats.ts`，不维护平行复刻）。**不含轮级数据**——轮级在 tps tracker。
- `custom-footer-format.ts` — **纯展示层**（无 pi 依赖，可单测）：段格式化（model/cwd/ctx/git/usage）、`formatSessionRow`（session 段 + 轮级段 + 动态段的拼接与视角分离）、网格布局（`layoutFooter`）。
- `custom-footer-usage.ts` — **订阅额度 fetcher 工厂** + TTL/退避缓存（仅跟随当前模型 provider）。
- `custom-footer-git.ts` — git status 缓存（TTL + mtime 校验，含操作标记文件）+ 操作状态检测（`detectGitState`）+ gitDir watch（`createGitWatcher`，目录级监听，失败静默降级）。

## 测试

```bash
npx vitest run   # 116 tests：format 纯函数、usage fetcher（含 kimi 刷新链路 mock）、git 缓存与操作状态检测与 watcher、tps（双消息源 + getRoundFlow 轮级 flow）、session stats、index 集成（含事件接线与每秒 tick）
```
