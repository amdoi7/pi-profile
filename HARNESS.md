# HARNESS — Agent Harness Experience 设计文档

设计角度文档,非执行规则。模型不加载、不执行、不 grill 本文件;执行规则见
AGENTS.md 与 skills。本文记录 harness 的 AX(Agent Experience)设计:为什么
这样设计、借鉴了什么、界面与状态模型如何组装。

## 设计角度:AX

AX 是 harness 设计者的视角,对 Agent 接触的每个界面问四个问题:

1. Agent 在行动的那一刻看到了什么(感知)?
2. Agent 在调用之间携带什么状态(上下文)?
3. Agent 能从什么中恢复(失败语义)?
4. Agent 被允许决定什么(自主边界)?

设计原则:感知同理心(坐在 Agent 的位置环顾房间,补上它缺失的信息)与
行动显式化(把 Agent 的内部选项外化为显式选择)。

## 角色体系

四角色覆盖调度、实现、过程检查、终审,执行与检查分离:

| 角色 | 职责 | 独立于 |
|---|---|---|
| 首辅 | 理解上意、拆分任务、调度执行;分发前 triage(验收可测、查重、依赖就绪) | — |
| 织造 | 写代码、改文件、实现功能 | — |
| 清流 | 检查过程中修改的文件/代码,确保符合预期 | 织造 |
| 掌印 | 审查最终产出,确保符合用户意图 | 织造、清流 |

责任模型:Agent 可执行,最终责任与放行权在人类(掌印终审 + 强制放行选项)。

## AX 界面(落地为工具与回调)

- **分发**:pi_worker 工具 run(异步,run 立即返回;id = pi-worker-<name>#<合约hash>)。
  机制语义、状态约束与回调格式以工具描述为准。
- **回调**:settled 为 XML 结构化消息(`<worker-settled>`:id/name/status/turns/usage(tool_calls/tokens/cost),四要素呈报全文在 `<report>` 内,usage 字段缺省省略,可机器断言)/ ask id= question= / failed id= exit= stderr尾;
  deliverAs=followUp + triggerTurn 注入父 session 消息队列——与用户输入同一条唤醒
  路径,等待过程对父 agent 不存在(阻塞等待事件 ≠ 轮询)。
- **worker 通信**:子侧 send_message(to, text) 工具,to 缺省 parent;to=parent 即
  ask(结束本轮等 follow_up),to=worker 经父侧路由投递(name 唯一解析、仅 idle
  可收、pending ask 拒收),路由成功与失败均以审计回调留痕父 session——首辅世界
  模型不破。
- **行动显式化**:审查结论必须是显式选项——通过 / 打回(附原因)/ 丢弃 /
  强制放行(记录理由)。选项空间呈现给决策者,不假设 Agent 推导。
- **结论留痕**:掌印终审结论落交付物 frontmatter `verdict`(通过/打回/丢弃/强制放行),
  审查闭环的 memory 事实源;打回/丢弃的 issue 不静默消失,后续会话可追溯。
  写入者归属与 status 值域以 AGENTS.md Deliverable 契约为准(设计文档不单列执行规则)。

## AIG 交互原则

1. 披露身份:Agent 呈报带角色标识,不被误认为人类。
2. 原生栖居:Agent 通过平台现有模式工作(worker 是完整 pi 会话,同一套
   工具/文件)。
3. 即时反馈:被调用即回执(确认接收 + 计划概要),沉默导致不确定性。
4. 状态透明:pi_worker status 可查状态/用量/recent 事件,子 session jsonl 可审计。
5. 尊重退出:收到 stop 立即停止新工作,只收尾呈报;收到明确信号才重新参与。
6. 责任归属:人类与 Agent 之间有清晰委托模型,最终责任在人类。

## 借鉴来源

- **Raft(AX)**:收件箱(可查询信号,Agent 拉取)、搁置草稿(新鲜度检查 +
  显式四路径)。失败根因模型:回合制 Agent 与持续在场房间之间的缝隙。
- **Raft(团队协作)**:命名 agent(名字 = 路由原语 + 期望缓存,角色是 schema、名字是
  实例)、审查 gate 前置(可证伪断言清单)、信任是状态非事件(读系统信号;失败回溯到输入)。
- **Linear Teams**:triage(新工作进工作流前的审查关口)、retire(冻结保留历史)。
- **Linear Issue Relations**:blocked-by/blocking(依赖调度)、related(相关引用)、
  duplicate(合并到 canonical)。
- **Linear Comments**:线程 + resolve(问题已答/决定已做即标记解决,不重复处理)。
- **Linear AIG**:六条 Agent 交互原则(见上)。

## Harness 状态模型

- **进程即隔离**:父会话与每个 worker 各是独立 pi 进程,内存不跨进程共享;
  子进程持久驻留(--mode rpc),JSONL 命令驱动,事件流推送;
  唯一持久副作用是 session 文件。
- **有状态事实源**(单一,读写走文件边界):
  - repo:产物真相(核验第一优先)
  - session jsonl:有损审计(auto-compaction 总结旧消息、工具结果截断 2000 字符);
    worker 落 <cwd>/.pi/worker/sessions/,session-id = id
  - memory:跨会话认知
- **核验优先级**:repo 产物与测试结果 > 回调呈报 > 子 session 审计。不复制状态。

## 架构总览

```
pi(执行器) + AGENTS.md(治理) + pi_worker 扩展(a2a 载体,基于 pi RPC)
子进程:pi --mode rpc(PI_WORKER_CHILD=1,独立 session,jsonl 审计)

执行语义零自研:prompt/steer/follow_up/abort 原生命令,agent_settled 完成信号,
get_last_assistant_text 呈报,get_session_stats 用量,子侧 send_message 调用经
tool_execution 事件流原生传输(参数结构化,无信封)。extension 只自建 pi 没有的:
进程生命周期、状态机(action 合法性)、回调桥(sendMessage 注入父队列)、消息路由。
内部组合:watcher 是纯翻译器(字节流 → WorkerEvent),manager 是唯一反应者
(全部政策:状态机/呈报/投递/路由集中 onWorkerEvent)。

首辅 triage → pi_worker run(立即返回,回调送达)→ 织造执行 → 清流检查 →
掌印终审(显式四选项)→ 论功/撤换
```

采用 RPC 基质:完成信号是原生事件(agent_settled),消费端挂在 pipe 的 data
事件上阻塞等待,零定时器零轮询;回调与用户输入共享 pi 消息队列唤醒路径。
弃 tmux+文件协议的动因正是轮询代价——刮 pane 烧父上下文、询问间隔即空窗。
不引入自研 daemon:子进程就是 pi 本身,extension 只做生命周期/状态机/桥接。
