# custom-footer

两行网格状态栏：左列环境/会话信息，右列模型与订阅额度。纯函数渲染在
`custom-footer-format.ts`（无 pi 依赖，可单测），`index.ts` 只负责生命周期、
事件与数据获取。

## 布局

```
cwd: ~/.pi                                  Kimi For Coding/k3-256k · think:max │ ⎇ main ↑2
ctx: 53k 20% │ ↑69k ↓29k R973k W0 │ miss 143k (2×)      5h ▎░░░░░░░ 3% (2h 39m) │ Weekly ▏░░░░░░░ 1% (1d 9h)
```

- 行1（静态）：`cwd:` 工作目录（home 相对 `~` 路径，>30 列折叠中段）、`provider/model · think:level`（level 按 thinking* 主题 token 着色，与编辑器边框同色）、git branch（`⎇` + dirty `*` + ahead/behind `↑↓`，diverged 为 `↑3↓2` 紧凑式）；rebase/merge/cherry-pick/revert/bisect 进行中时追加操作标签（`REBASING 3/5`、`MERGING`…，warning 色）。
- 行2（动态）：`ctx:` 上下文 tokens 与使用率（≥70% 橙、≥85% 红）、token 流量
  `↑输入 ↓输出 R缓存读 W缓存写（均为会话累计）`、缓存失效汇总
  `miss次数× 重新计费tokens (+$金额)`（仅 missCount>0 时显示；金额≥1分且
  非订阅制才追加；算法口径与 pi cache-stats 一致：compaction 重置基线、
  1024 token 噪声底线）、会话成本 `$`、吞吐 `t/s`、
  订阅额度窗口（`5h` / `Weekly` 用量条，`(elapsed)` 已用时长）。
- 零值不抑制（`W0` 即诊断信息）；订阅制 provider（claude/codex/kimi）
  隐藏成本（恒 $0.00）；用量条为八分之一块精度（`▏▎▍▌▋▊▉█`），低用量保留刻度。
- 网格为设计量尺：左栏补齐到 40 单位，右列固定在其后 4 单位
  （`start = max(内容, 档宽下限) + 栏距`，一个公式两个档位），不随终端宽度漂移；
  档宽下限仅在宽 ≥100 时生效（branch 同时出现）。usage 缺失或宽 <72 时退化为三行流式。

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

## 模块

- `index.ts` — extension 入口；`session_start` 注册 footer，`agent_start/agent_settled` 定义本轮边界（用户消息 → 不再输出），`turn_start` 提供每条消息的 TTFB 起点，`message_update/end` 采集 tps 实时源，`agent_end` 批量消息采集 tps 锁定源，`thinking_level_select`/`model_select` 即时 flush，`onBranchChange` + gitDir watch（外部 git 变化即时重渲染）触发，30s 定时兜底。事件处理器只更新数据；渲染由数据源 onChange hook 集中调度（live 节流 / commit 立即）+ 进行中每秒 tick 兜底（thinking/工具执行期无事件也刷新）。
- `custom-footer-format.ts` — 纯格式化与布局：段函数（model/cwd/ctx/git/usage）、token flow 聚合（`computeTokenFlow`）、网格布局（`layoutFooter`）。
- `custom-footer-usage.ts` — 额度 fetcher 工厂 + TTL/退避缓存。
- `custom-footer-git.ts` — git status 缓存（TTL + mtime 校验，含操作标记文件）+ 操作状态检测（`detectGitState`）+ gitDir watch（`createGitWatcher`，目录级监听，失败静默降级）。
- `custom-footer-tps.ts` — 本轮（用户消息 → 不再输出）时长 tracker（agent_start → agent_settled）；t/s = 本轮速率（墙钟口径，与官方 TPS 一致）：分子 = output 含 thinking（pi 的 Usage 注释：reasoning 是 output 子集），双消息源——实时源（进行中显示）用 message_end 增量，锁定源（settled 锁定）用 agent_end 批量消息（官方源，失败/aborted 消息无 message_end 也不漏计），分母 = 本轮墙钟（首次 agent_start → agent_settled）；ttfb = 本条消息首块 − 本条消息 turn_start（每条 LLM 响应独立测量，缺失回退轮起点；turn_start 重置首块标记，失败消息残留不污染下一条）；速率/ttfb 跨轮保留（新轮完成时替换），含 onChange 渲染 hook。- `custom-footer-stats.ts` — 会话聚合（flow/cost/waste）增量/全量快照，含 onChange 渲染 hook。

## 测试

```bash
npx vitest run   # 109 tests：format 纯函数、usage fetcher（含 kimi 刷新链路 mock）、git 缓存与操作状态检测与 watcher、tps（双消息源）、session stats、index 集成（含事件接线与每秒 tick）
```
