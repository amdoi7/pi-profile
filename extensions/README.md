# extensions

本地 Pi extensions 之总目录。

方今已平铺，且不再分 core、plugins、tools 桶；每一项 extension 直接置于本层。根层只置真正入口目录；helper、tests、README 皆归所属 extension 内。

## 本地条目

### Runtime 与 memory

- `memory/` — `Issue -> Task` work control-plane owner；负责 project scaffold、prompt injection、issue/task/lesson contract 与 context features；无 CLI/graph，issues/tasks/lessons 由普通编辑工具按 project-memory skill 维护。
- `_shared/` — sibling extensions 共用 helper；非 extension 入口；`jsdiff` 先计算 line hunk，再将阈值内 changed block 细化为逐行 word ranges；Myers 超时（250ms）时降级为 O(n) 公共前后缀剥离的 unlocated 行 diff（stats 仍准确，无行号与 word 高亮）；Pi TUI renderer 只负责 gutter、range ANSI 与 width-aware wrapping。

### Tool ownership

- `edit/` — grouped exact edits；按文件分组，单文件原子，多文件隔离，并与 built-in `write` 共用 SDK file mutation queue。
- `bash-ui/` — `bash` 工具通用 UI：普通命令 fish 式语义高亮（theme syntax token + 命令存在性检查）；canonical standalone `apply_patch` 语法作为特例走 patch 视图（ephemeral before/after snapshots 与 CLI-confirmed grouped final diff）；原样委托 command execution，不改 CLI stdout/stderr/exit code 或 tool result contract。
- `command-policy/` — `bash` / `run_experiment` 的唯一 `tool_call` mutation owner；依次执行 uv Python normalization 与 package-manager deny。
- `uv/` — uv/Python pure rewrite 与 deny policy；不再直接注册 runtime hook。

### Workflow

- `btw/` — side-channel assistant overlay；提供 `/btw` 侧聊与 handoff summary。
- `session-breakdown/` — session/context inspection UI；统计 sessions、messages、tokens、cost 与 model/cwd/time breakdown。

### UI polish

- `custom-footer/` — 两行网格状态栏：左列 `cwd:`/`ctx:` 标签对齐，右列 model（含 think 级别）与订阅额度；行1 显示 cwd、model、git branch（静态），行2 显示 ctx 用量、token 流量（`↑in ↓out Rw Ww CH%`）、会话成本与额度窗口（5h / Weekly 用量条）；额度只随当前模型 provider 显示（claude/codex/kimi），按量付费 provider（如 deepseek）不显示；宽 <72 退化三行流式布局。
- `whimsical/` — streaming working-indicator variants；按 tool 类别切换 working message。
- `escape-rewind/` — early-ESC prompt rewind；assistant 尚未开始回复时，第二次 Esc 回填刚提交 prompt。

## 已配置之 package 资源

见 `~/.pi/agent/settings.json`。

- `npm:pi-updater@0.4.1` — Pi updater；注册 `/update`，并于 startup 做版本检查。
- `git:github.com/HazAT/glimpse@4b50cbb4312b56f2a2170131c8634351c1c12122` — 仅加载 `glimpse` skill。

## 边界原则

- 用户可见 Pi 行为优先落于 `~/.pi/agent/extensions/**`；勿改 installed package，除非明确授权。
- 每个 extension 应有单一 ownership；schema、execution、render、tests 尽量同归一处。
- 若覆写 built-in tool，须匹配其 result shape；prompt metadata 不会继承，需显式补上。
- 若 tool 会改文件，须参与 file mutation queue，或由该 extension 独占完整 read-modify-write 窗口。
- prompt injection 只放不可由 tool/command 表达之短规则；长上下文应变成文件、tool 或 command。
- `before_agent_start` 属最高风险 hook；`tool_call` 可作安全门；`tool_result` 宜作 notice 与 result normalization。
- 有 UI 者先判 `ctx.hasUI`；可降级则给 headless path，不可降级则明示拒绝。
- 长输出必须截断，并告知续读或完整输出位置。
- 状态须可从 session 恢复；优先用 tool result `details` 或 `pi.appendEntry()`，勿只藏于内存。
- session replacement、reload、shutdown 后，旧 `ctx` 与旧 `SessionManager` 不可复用；只传纯数据。

## 设计启发式

- 先问“谁拥有这条知识”，再决定 extension 边界；不要按执行步骤切浅层 wrapper。
- 能用 command 触发者，不注册 tool；只有模型必须主动调用时，才给 tool。
- 能在边界强制者，不写成 prompt 建议；安全、路径、执行策略应由 hook 或 wrapper 承担。
- 工具描述保持短、正交、事实化；每条 guideline 必须写明 tool 名，勿写“this tool”。
- UI 默认紧凑，detail 放 expanded view；不要把 UI-rich details 回灌给 LLM。
- Extension 间协作要显式；用 `pi.events`、shared helper 或稳定 custom entry，不靠文本约定互猜。
- 复杂 workflow 由 extension 固化状态机，模型只负责语义判断或生成当前步文本。
- 新功能进入前，先检查是否会与 `memory`、`edit` 或 `command-policy` 争夺同一边界。

## 维护清单

更新 extension 时，同步检查：

1. `agent/settings.json` 是否仍指向真实入口。
2. README 是否列出 command、tool、hook 之 ownership。
3. promptSnippet 与 promptGuidelines 是否短且自洽。
4. interactive 与 non-interactive mode 行为是否明确。
5. session start、switch、tree、shutdown 是否能恢复或清理状态。
6. 相关 tests 是否覆盖 contract，而非只覆盖实现细节。
