# pi-agent-workspace

个人 [pi coding agent](https://github.com/earendil-works/pi) 配置仓库：扩展、主题、skills、本地工具与 agent 指令全部在此收口。克隆到 `~/.pi/agent` 即可复现整套环境。

## 目录

| 路径 | 内容 |
|---|---|
| `extensions/` | 本地 pi extensions（总目录见 [extensions/README.md](extensions/README.md)）：mirasim provider、edit/bash 相关工具、UI 组件、peer 通信等 |
| `skills/` | skills 符号链接，canonical 源在 `~/Desktop/_obsidian/amdoi7/01_Area/Vibe_Coding/skills/` |
| `themes/` | pi 主题（moon-nord 及色觉适配版） |
| `cli/` | `apply-patch` 本地 CLI |
| `bin/` | 本地构建的小工具 |
| `npm/` | 已安装的 pi packages（pi-updater 等） |
| `AGENTS.md` | agent 执行规则（模型加载） |
| `HARNESS.md` | agent 体验设计文档（只设计，不执行） |
| `SYSTEM.md` | 系统 prompt 镜像 |

机器专属凭据与运行时状态不入库：`auth.json`、`models.json`、`settings.json`、`sessions/`、`models-store.json` 等见 `.gitignore`。

## 使用

```sh
git clone https://github.com/amdoi7/pi-profile.git ~/.pi/agent
pnpm install
pi
```

依赖 pi 本体：`npm i -g @earendil-works/pi-coding-agent`（`package.json` 把 pi 与 pi-tui link 到全局安装）。

## 测试

```sh
pnpm test   # pnpm -r --if-present run test
```
