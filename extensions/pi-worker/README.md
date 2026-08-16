# pi-worker

子 agent worker 编排:父会话经 `pi_worker` 工具(run/send/stop/collect/kill/status)
派生、干预、验收、撤换独立 pi 进程;`/pi-worker` 面板提供决策队列视图与动作面;
RoomBus + `send_message` 工具构成 parent/worker 的 room 消息平面。worker session
jsonl 落 `<cwd>/.pi/worker-sessions`(审计、冷恢复历史与重启认领的唯一否决源)。

## 模块地图(src/)

- `index.ts` — 生命周期接线:startup `claimLeftovers`、`session_shutdown → killAll`、快捷键与 footer。
- `tool.ts` — `pi_worker` 工具 schema 与执行;status 输出是 RPC 父的机器契约(合法动作面直出)。
- `manager.ts` — 唯一反应者:副作用(spawn/handshake/terminate)、事件政策、升级引擎 `escalate`、决策落标。watcher 事件全经 `onWorkerEvent` 落实。
- `state-machine.ts` — 纯 FSM(8 态),`requireState` 守合法集,`WorkerError` 提示真实出路;无副作用,可单测。
- `types.ts` — `WorkerState`/`WorkerRecord` 词汇与 `TERMINAL_STATES`。
- `watcher.ts` — 子进程事件流 → 领域事件翻译,零政策(不迁移状态、不投递)。
- `rpc-client.ts` — newline-JSON RPC:id 关联请求/响应 + 事件流。
- `spawner.ts` — `spawnChild`;`terminate` = SIGTERM → 2s 宽限 → SIGKILL。
- `recovery.ts` — G1 重启认领:目录扫描(身份判定委托 pi 原生 `SessionManager.listAll`)、marker 尾窗精确匹配与残行安全写入。
- `present.ts` — UI 投影纯函数;`STATE_FACETS` 是状态面单一来源(rank/decision/mark/toolActions/paneActions),footer/overlay/status 共读。
- `pane.ts` — `/pi-worker` overlay:decision 区(failed/idle/exited)优先,exited >2 折叠,动作执行经 `opFor`。
- `transcript.ts` — transcript 投影(`SessionEntry` 平铺;live = 事件流增量 + `get_messages` 回填,dead = 文件解析)。
- `room-bus.ts` — room 消息管道:一种语义(异步 fire-and-forget),地址 = name/id/"parent"。
- `messaging.ts` — worker 侧 `send_message` 工具;父 watcher 经工具名原生识别,无信封。
- `contract.ts` — 合约纯函数:id/name RE、时限常量单一事实源、prompt 构建、路径约定。

## 状态机(8 态,每态 = 唯一动作面 × 唯一解析事件 × 唯一父可见信号)

| 状态 | 语义 | 合法动作 | 出边 |
|---|---|---|---|
| `starting` | 握手未落地(30s 超时兜底) | kill | prompt 接受→running;exit→failed |
| `running` | 有轮在飞 | send(steer)/stop/kill | settled→idle;stop→stopping;exit→failed |
| `stopping` | stop 已发,只收尾呈报 | kill | settled→idle;兑底链:30s 宽限→abort→15s 窗→terminate;exit→failed |
| `idle` | 无轮在飞,等父验收/新轮 | send/消息(followUp 唯一合法源)/collect(verdict) | followUp→running;exit→exited |
| `exited` | 报告已交、进程死(唯一非终态死态) | send(冷恢复)/collect(verdict) | send→starting(`--session` 同文件续接) |
| `killing` | kill 已发,等 exit | 无 | exit→done |
| `done` | 终态:已验收/已撤换 | 无(status 末位) | — |
| `failed` | 终态:未交账即死(唯一自动投递 failed 回调) | collect(清账后重派;status 首位) | — |

判决语义:collect 的 verdict(通过/丢弃/强制放行)只在 idle/exited 提供——报告先于
进程死,判决不因进程死失效;failed 无报告可判,只给清账重派。`idle` 的 kill 虽 FSM
合法,两个投影都不推(终局动作是带判决的 collect)。以上投影与 FSM 合法集的一致性由
`tests/present.test.mjs` 的经验探针测试双向守门(非法提供与合法遗漏皆红)。

## 持久化与重启认领(G1)

原则:**政策只在 API 边,事件反应器零政策**。终态决策在 `collect()`/`kill()` 内同步
落盘(先于进程终止,与 watcher 事件时序解耦);`killAll()`(session_shutdown)零持久化
副作用——shutdown 不是对 deliverable 的决策,重启认领因此存活。

认领的否决源只有一个:**COLLECTED_MARKER**(per-file)——`collect`/`kill` 决策即在
session 尾部落标(`appendSessionLine` 残行补换行,marker 恒独占完整一行),扫描时尾窗
64KB 逐行解析 `customType` 精确排除(呈报文本含字面量不误判);审计保留,不删文件。
同 id 多代次遗留按最新 createdAt 认领。无 marker 即活代次:重派后的新文件不会被
旧代次的终态压住(否决只看文件自身,不看任何旁路记录)。

冷恢复(O3):exited 记录 `send` 即 `--session` 同文件续接,历史完整;授权链(O4):
`new_session(parentSession)` 原生写入子 jsonl header,恢复时归属是数据不是启发式。

## 升级链

`escalate(id, policy)` 一副骨架三种政策参数化(`{graceMs, abortWindowMs, awaitAbort,
onlyIfState}`),代次令牌内聚(fire 时句柄换代即失效):stop = `{30s, 15s, 不等, 守
stopping}`;kill = `{0, 0, await abort 后 terminate}`;killAll = `{0, 0, 即发即忘}`。
abort 尽力而为(管道断/进程死由 watcher 转移兜底);terminate 才是硬兑底。

## 测试

```bash
npx vitest run                              # 全部(含 substrate live)
npx vitest run --exclude tests/substrate/** # 仅单测(假句柄,不起进程)
```

- 单测(15 文件):fake handle 注入 rpc/proc/watcher;升级链用 fake timers;认领
  用临时目录真文件。
- `tests/substrate/`:真进程真 LLM 端到端(默认 `opencode-go/deepseek-v4-flash`,
  `PI_WORKER_TEST_MODEL` 覆盖;单条约 15-35s)。覆盖 run→settled→collect 全链路、O3 冷
  恢复记忆、重启认领回归。

## 已知边界

- 同 cwd 多 TUI 窗口:活他窗口的 worker 文件也会被认领(exited 记录,无 pid 归属
  可判——平铺布局固有限制);危险动作(resume 再 spawn)仅发生在父显式 send 时。
- 终态记录会话内保留(live verdict 展示与重跑诊断继承);重启即清,审计在
  子 session 文件(marker 与全文)。
