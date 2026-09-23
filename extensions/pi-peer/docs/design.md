# pi-peer 并发设计（数据结构 · 队列 · 抢占 · 堵塞）

文档性质：设计与决策留档。现状实现见 `src/`；本文回答"多 session 同时通信
如何不抢占、不堵塞、不饥饿"的结构答案，并记录契约裁决。

## 0. 顶格约束（决定一切形状的因果机制）

pi-peer = 每 pi 会话一个进程，**无共享内存**。跨进程介质只有文件系统 +
unix socket。由此：

- 队列只能存在于三处：**进程内 / socket 连接（一连接一请求）/ 磁盘**。
  不存在"全局共享队列"这种结构。
- 唯一的跨进程同步原语是 **socket 的 bind 与 connect**：
  bind 成功 = 原子接管身份；connect+ack = 原子移交消息。
- 结论：**抢占靠 bind 即 CAS；堵塞的病态项已修（150ms 普查超时）；**
  剩下的是队列公平/背压（证据门槛未到）与发送侧 O(N)。

## 1. 三张数据结构

### ① 名册 —— FS 是真相，进程内只读快照 + 事件驱动增量
```
PeerRosterCache (per-process)
  Map<sessionId, PeerSnapshot>
PeerSnapshot { identity, presence(online|suspended|dead|unknown),
               socketPath, hbPath, lastProbeAt }
```
- 现状"零缓存、readdir + N×who 握手"的 pull 是正确的形状（目录=真相，
  心跳=权威）。升级只该在量到 N 大后加 fs.watch 增量 + TTL 兜底——
  不许破坏"目录即真相"不变量。
- 单进程内 Map 无锁；跨进程正确性靠 FS 原子 + 操作前可选 re-probe。

### ② 出站票据 —— sender 进程内，把"投递中"变成可见状态
```
OutboundEntry (per (from→to) 的惰性队列元素)
  { id, target, text, ts, attempts, nextRetryAt,
    state: created | connecting | acked | failed(offline|rejected|timeout-ambiguous) }
```
- **不落盘**：sender 退出即放弃 = best-effort 契约，不改。
- **id 用 UUIDv7**（若 ids 需要跨边界持久化时；进程内短命 id 连 v7 都不需要）：
  理由 = 既有 session 词汇即 v7、IETF RFC 9562 标准、无 base32 编解码面。
  不用 ULID：URL/文件名场景在本系统不存在，社区格式无互通收益。
- 幂等：同文同窗由 WindowQuota repeat 抑制；超时歧义不自动重发。

### ③ 入站队列 —— receiver 进程内，背压点（证据门槛未到，先画形状）
```
InboundQueue (per receiver)
  容量 BOUND（tripwire 非 roadblock）；超限 → ack{ok:false,error:"inbox full"}
  → 发送方退避重试；按 from 分桶 FIFO 轮询（单 sender 洪泛不饿死他人）
```
- **未实现**：没有量到 pi 注入背压的失败模式。Evidence Gate 要求先有演示
  再定型，容量与轮询细度等证据。

## 2. 队列语义

- **出站**：同 peer 组内串行（去重/配额是 per-peer 顺序依赖）、组间并行
  （已落地：`src/tool.ts` 分组提投）。同 target 保序（FIFO）；跨 target
  并行。退避：明确 offline/rejected → 2^n·500ms、上限 3 次 → 落账；
  timeout-ambiguous 不自动重发。
- **入站**：FIFO + per-from 公平轮询 + 有界拒收。ack=已接管语义不变。
- 工具面保持同步 ack——不把 peer_send 改成"异步入队即返"（夺走模型即时
  ack 是契约变更，不做）。

## 3. 抢占协议（preemption）

- 同 id 双进程接管：双 probe → 双见 dead → 双 rm+listen → **OS bind 仲裁**，
  赢者 serving、输者退让、60s tick 再试。无 split-brain。
- 加固（已落地）：**心跳只在 serving 后开写、让位/退役即停删**（fencing）——
  心跳 = "我在服务此身份"，fork/resume 双活只由 serving 方代写、pid 不翻摆；
  amIServing token 每 tick 验证"还是不是我"。
- 加固（已落地）：**接管恢复活性 ≤10s**——赢者骤死后输家默认 tick 60s→10s
  才接管；单次探测毫秒级，语义不变。
- 护栏保留：心跳新鲜但不应答 → 退让（busy 不抢）。

## 4. 堵塞（blocking）治理清单

| 堵塞源 | 状态 |
|---|---|
| wedged peer 拖普查 | ✅ 已修：WHO 1000ms → ROSTER_SWEEP 150ms（回归 guard 已锁） |
| 慢/挂起接收者 | ✅ 退避重试已落地：离线/被拒最多 3 次尝试（500ms·2^n），超时歧义不重发；SEND_TIMEOUT 2s 上界保留 |
| 接收侧注入堆积 | 入站队列（证据门槛未到） |
| fork/resume 心跳双写·pid 翻摆·退役误标 | ✅ 已落地：心跳 serving 门控 + 退役/让位即停删 + 回归测试 |
| 单 sender 洪泛 | per-from 分桶轮询（同门槛） |
| 目标多 | ✅ 已修：跨目标并行投递（305ms vs 串行约 1200ms @ 4×300ms） |
| 配额 | WindowQuota 每对 10/5min，结构正确不动 |

## 5. 契约裁决表（改动即改变模型可见行为，须显式决策）

| 变更 | 性质 |
|---|---|
| 并行 fan-out | ✅ 已做（行为不变，顺序逐字节保持） |
| sender 退避重试（离线/被拒 3 次上限，超时歧义不重发） | ✅ 已做：失败可见性变为“最终失败 + 尝试次数”（design-change，经决策） |
| `inbox full` 新错误类 + 有界拒收 | design-change：新错误类别 |
| 投递优先 O(1) send（去掉前置全量 sweep） | ❌ 量后拒绝：N=50 单目标 send 仅 3.6ms(sweep 3.2ms)，节省量不值契约变化 |
| 磁盘持久队列 / 跨主机 | 重设计、外部契约，不在本扩展 |

## 6. 红线不变量（任何方案不许破坏）

1. 目录即名册真相（socket 文件存在性 + 心跳是权威）；
2. ack = 已接管（成功返回 = 对方进程收下，不是"写进 socket"）；
3. 同 peer 只投一次、配额只对成功记账；
4. best-effort：进程退出即放弃，不落盘、无回滚。
