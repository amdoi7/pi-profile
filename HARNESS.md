# HARNESS — Agent Harness Experience 设计文档

设计角度文档,非执行规则。模型不加载、不执行、不 grill 本文件;执行规则见
AGENTS.md 与 skills。本文记录 harness 的 AX(Agent Experience)设计:为什么
这样设计、借鉴了什么、界面与状态模型如何组装。

> retire(2026-08-26):worker 机制(pi_worker 扩展、多 worker 拓扑、子会话
> 编排)已整体移除;同机跨会话协作仅存 pi_peer(socket 即名册,who 实时身份,
> 零磁盘缓存)。
> 下文涉及 worker 的段落冻结为设计历史,不再对应运行实体;其中的通用原则
> (角色分离判据、AIG 原则、核验优先级)不随机制退役。

## 设计角度:AX

AX 是 harness 设计者的视角,对 Agent 接触的每个界面问四个问题:

1. Agent 在行动的那一刻看到了什么(感知)?
2. Agent 在调用之间携带什么状态(上下文)?
3. Agent 能从什么中恢复(失败语义)?
4. Agent 被允许决定什么(自主边界)?

设计原则:感知同理心(坐在 Agent 的位置环顾房间,补上它缺失的信息)与
行动显式化(把 Agent 的内部选项外化为显式选择)。

## 设计立场:塑形器与元方法

harness 的职责是塑造模型参差不齐(spiky)的智能,把它引向任务;判断标准是
任务表现(客户满意),不是结构美学。三条立场:

- **Bitter Lesson 的正确读法(Sutton,一手文本)**:教训不是"结构越薄越好",
  而是装"发现的过程"而非"已发现的"——"We want AI agents that can discover
  like we can, not which contain what we have discovered"。前者(search/learning)
  随算力扩展,后者短期有效、长期 plateau 且抑制进步。对 harness 的推论:
  durable 结构 = 元方法——任务级 evals(发现过程)、memory(记录发现)、
  拟合循环(对 harness 变体的搜索)、测试先行(奖励信号);任务特定 prompt/
  钩子 = 已发现的——允许存在(客户满意是目标),但视为易腐资产:标注能力
  半衰期,随代际重审,eval 说移除即移除。为薄而薄才是误用:既非 Sutton 的
  主张,也拒绝承认 harness 的塑形职责。
- **效应有界,不过拟合**:harness 格式细节的边际效应有限——工具形状(OAI vs
  Ant patch)略有关,但一旦定制即 out-of-distribution,真正的智能应泛化;
  Model-Task fit 在 post-training 的权重高于 Model-Harness fit(open-weight
  模型的 multi-harness 训练为证)。不追 prompt 格式保真,不写针对当前模型
  怪癖的规则。
- **evals 是 driver,harness 不是 moat**:harness 易复制,不可复制的是拟合
  循环——任务级 evals 裁决结构增删,delta 记入 memory,保留胜者移除败者。
  结构增删的裁决者是数据,不是立场。机制见下段。

## 拟合循环(harness 演进机制)

harness 演进由任务级 eval 驱动,不靠判断或时尚:

1. 定义任务:选真实反复执行的任务类型(bug 修复带测试、TDD 功能、文档/
   skill 撰写…),每任务给可判定结果指标(pass/fail + 验收)与成本指标。
   成本按稀缺资源计量,不按人月式过程合规:agent 时间在批量/异步场景不稀缺
   (可并行、可复制);「可恢复」有界——父进程死亡丢在途调度/路由/pending
   ask,外部副作用动作不幂等。三种稀缺资源(定义以此为准,L1 只载名目与
   行为内核,清单定义不复制):
   - 人类注意力(不可再生):终审耗时、打回轮次、无信息量阻塞提问数——
     提问本身是正常流量(Grill me 明示「问比独自死磕便宜」),计数只罚
     仓库证据可解却不查就问;交互场景 agent 墙钟与人类注意力耦合,
     agent 等待即间接消耗此资源。
   - context 完整性(有损不可恢复):compaction 次数、goal drift 事件、
     缓存命中率。
   - token(可计价):tokens/墙钟,只在跨方案比较(如分发 vs 自做 3-10x)
     时计入,墙钟仅作参考。
   产出指标:一次通过率(verdict=通过 且无 reopen)、返工率(打回、revert、
   同主题 issue 复发)、核验证据链完整性(红灯→绿灯、repo 产物)。一次
   通过率必须与返工率/reopen 率联读——单看通过率是被 scope 收缩、易验收、
   强制放行洗出来的失败信号,不是成功信号。
   指标自身也耗人类注意力,度量集适用同一剃刀:每个指标必须能指出它裁决
   哪类结构增删,指不出的移除;最小集 = 一次通过率、打回轮次、人类响应
   耗时、compaction 次数、每交付物 token。采集路径见「状态模型」段。
2. 跑 baseline 与变体:同任务同输入,变体只改一个结构因素(prompt 肉、记忆
   召回、工具形态、compaction 策略),一次一个变量。
3. 记 delta:结果/成本变化落 memory(issue 或 lesson),注明任务、变体、n、
   日期;一次实验一条记录。
4. 裁决:保留有实测收益的结构,移除无收益或负收益的。移除是常规操作不是
   损失——分层正交保证可重加路径(见 Prompt 分层),删除本身不需要犹豫。
5. 重审:规则有能力半衰期——随模型代际重跑关键 evals,为弱模型写的护栏在
   强模型上可能变成冲突源(注入经济学推论三),删 80% 无评测损失是常态。

判定基准是"是否改变下一步行动"与任务结果,不是行数、不是结构审美。

## 角色体系

覆盖调度、实现、过程检查、终审,执行与检查分离:

责任模型:Agent 可执行,最终责任与放行权在人类(掌印终审 + 强制放行选项)。

多角色与多 worker 拓扑针对的单上下文失败模式(归因借鉴 Claude Code
dynamic workflows):

- **agentic laziness**:长任务中途宣告完成(50 项审查做 20 项即收工)——
  验收断言清单与掌印终审拦截。
- **self-preferential bias**:偏好自己的产出,自查自验失真——清流/掌印
  必须独立于织造的结构因。
- **goal drift**:多轮与 compaction 后目标保真度递减(每次总结有损,边界
  约束与"不做 X"先丢)——交付物 frontmatter 与 memory 把目标与约束外化
  出上下文,不依赖对话记忆。

分解判据(借鉴 Anthropic multi-agent 生产分析):按 context 边界分工,不
按问题类型分工——按阶段拆角色(planner/implementer/tester/reviewer 各一
agent)每次交接都丢 context(telephone game),协调 token 超过执行 token
(实测 3-10x)。本体系角色拆分的合法性来自 context 边界真实存在:首辅→
织造以自含 prompt 完整搬运任务 context;清流/掌印是 blackbox 验证者——
验证天然不需要实现 context,是唯一被跨域验证有效的角色拆分。多 agent
的三个正当因:context 污染隔离、可并行探索、工具/prompt 专精;除此之外
单 agent + 好 prompt 通常更优,分发须有过得去的证据。

## AX 界面(落地为工具与回调)

- **分发**:pi_worker 工具 run(异步,run 立即返回;id = pi-worker-<name>#<合约hash>)。
  机制语义、状态约束与回调格式以工具描述为准。
- **回调**:settled 为 XML 结构化消息(`<worker-settled>`:id/name/status/turns/usage(tool_calls/tokens/cost),四要素呈报全文在 `<report>` 内,usage 字段缺省省略,可机器断言)/ failed id= exit= stderr尾;
  deliverAs=followUp + triggerTurn 注入父 session 消息队列——与用户输入同一条唤醒
  路径,等待过程对父 agent 不存在(阻塞等待事件 ≠ 轮询)。
- **worker 通信**:子侧 send_message(to, text) 工具,to 缺省 parent;to=parent 即
  ask(结束本轮等 follow_up),to=worker 经父侧路由投递(name 唯一解析、仅 idle
  可收、pending ask 拒收),路由成功与失败均以审计回调留痕父 session——首辅世界
  模型不破。提问经济学:父是常驻 agent,send_message 唤醒即答,worker 沉默死磕
  烧的是不可见轮次——charter 定「提问优先于死磕」,报告走回复文本/quiet,阻塞
  提问走唤醒路径。
- **行动显式化**:审查结论必须是显式选项——通过 / 打回(附原因)/ 丢弃 /
  强制放行(记录理由)。选项空间呈现给决策者,不假设 Agent 推导。
- **结论留痕**:掌印终审结论落交付物 frontmatter `verdict`(通过/打回/丢弃/强制放行),
  审查闭环的 memory 事实源;打回/丢弃的 issue 不静默消失,后续会话可追溯。
  写入者归属与 status 值域以 AGENTS.md Deliverable 契约为准(设计文档不单列执行规则)。

## 工具 I/O 设计

- **自然语言是最高密度表征**:模型参数空间中自然语言的条件概率密度最高,
  tool input/output 均以自然语言承载决策相关信息。output 返回"部署失败:
  端口 3000 被 nginx(pid 8432) 占用"而非 {"exit_code": 1}——裸数据让
  下一步 token 分布平坦,自然语言直接抬高正确动作的概率。结构化(XML/
  JSON)定位是机器断言与精确抽取(回调 envelope、--jq),不是默认认知
  界面;回调 <report> 内是自然语言呈报即此原则的落地。
- **意图先行**:input 侧把自然语言描述字段放参数序最前(先述意图再生成
  结构化参数),已生成的意图进入 context,抬高后续参数质量。
- **裁剪发生在进入 context 之前**:输出按需裁剪(gh --json/--jq 范式),
  无关字段不只浪费 token,还污染语义空间干扰后续推理。

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
- **Claude Code dynamic workflows**:失败模式三归因(见上)、fan-out +
  adversarial verification 模式、quarantine(读不可信内容的 agent 不执行
  高权限动作,动作由另一类 agent 完成)、非技术任务同样受益于编排。
  工具设计教训:随模型能力演进重审既有工具假设——曾经必需的脚手架
  (todo 提醒)会变成约束(模型误以为必须死守清单);加新工具门槛要高,
  优先 progressive disclosure(skill 按需加载,对应 L3)而非堆工具数;
  删除同理:不再有 eval 收益的工具是约束,按「拟合循环」移除。
- **Claude 5 context engineering**(Anthropic):规则有能力半衰期,删 80%
  system prompt 无评测损失;冲突指令迫使模型花 thinking 仲裁;判断替代
  规则、接口设计替代示例、工具指令收进 tool description 不在 system
  prompt 重复(对应 L2 机制权威层)、references 富化(测试套件/代码/
  rubric 比自然语言描述更高保真)。详见"注入经济学"段。
- **Anthropic multi-agent 生产分析**:多 agent 三正当因(context 污染/
  并行/专精)与 3-10x token 成本;context-centric 分解优于 problem-
  centric;verification subagent 是唯一跨域稳定的角色拆分;early victory
  problem(验证者跑两个测试即放行)以具体断言/负例测试/"必须跑全量"
  约束缓解——与质量契约"核验必须能暴露失败"互为印证。
- **gh CLI(agent-friendly CLI 设计)**:resource 层(资源路径 + 收敛动词
  list/get/create/update/delete,API 文档即 CLI 文档)承接长尾能力,
  command 层承接无法 resource 化的意图;默认输出语义化,--json/--jq 供
  串联与裁剪;flag 跨 command 一致(--repo/--json/--web)提高泛化。
- **Anthropic prompt engineering 2026**:正述要做什么优于枚举不做什么;
  显式允许表达不确定以防幻觉;示例对现代模型是约束而非帮助;XML tag
  与重 role prompting 已过时——AGENTS.md 规则审计的判据来源之一。
- **Schema 即 instruction channel**(论文观点,用户转述):tool JSON
  Schema 与 prompt 同为指令通道,schema 结构(参数命名/枚举/可选性/
  字段序)都在指导模型——工程对象从 prompt 扩为整面指令面。详见
  Prompt 分层"指令面视角"段。
- **Claude Code system prompt 与工具描述(一手文本)**:收敛互证——
  探索性问题 2-3 句建议可重定向、风险动作按 scope 逐次确认、注释纪律
  (默认不写,WHY 非显然才写)与 Grill me/Delivery 规则一致;L2 同构——
  Grep/Read 描述载使用政策与 context 成本提示(head_limit"large result
  sets waste context"、Read"只需部分就别读全"),与"判据归 L2"裁决互相
  印证;sleep 工具 cache-window 提示见注入经济学范例。差异:其 Grep
  禁 bash grep 是权限沙盒模型驱动,pi 的聚合管道(sort|uniq -c)必须
  bash——tool-vs-bash 边界取决于 harness 权限模型,非通则。
- **Bitter Lesson(Sutton,一手文本)**:元方法 vs 知识内容——"agents that can
  discover like we can, not which contain what we have discovered";对 harness
  的正确推论:durable 结构 = 元方法(evals/记忆/拟合循环),任务特定规则是
  易腐资产。误用(为薄而薄)与反误用(拒绝塑形)在「设计立场」段消解。
- **Chung 设计三问(转述)**:理解应用结构 → 随模型进步重估 → 让结构易移除;
  第三条是能力不是义务。Kaplan(Anthropic)"build things that don't quite
  work yet"同源:结构先行,模型追赶,harness 按"模型会变强"设计。
- **Evals 驱动拟合(用户方法论)**:harness 无 moat,拟合循环才是资产;
  Model-Task fit > Model-Harness fit(multi-harness 训练的 open-weight 模型
  为证);harness 准备上下文让模型沿任务 Pareto 前移,结构增删由数据裁决。

## Harness 状态模型

- **进程即隔离**:父会话与每个 worker 各是独立 pi 进程,内存不跨进程共享;
  子进程持久驻留(--mode rpc),JSONL 命令驱动,事件流推送;
  唯一持久副作用是 session 文件。
- **有状态事实源**(单一,读写走文件边界):
  - repo:产物真相(核验第一优先)
  - session jsonl:有损审计(auto-compaction 总结旧消息、工具结果截断 2000 字符);
    worker 落 <cwd>/.pi/worker-sessions/,session-id = id
  - memory:跨会话认知
- **核验优先级**:repo 产物与测试结果 > 回调呈报 > 子 session 审计。不复制状态。
- **指标采集路径**:最小集全部可由现有文件计算,不新增机制——人类响应耗时
  = session jsonl 消息时间戳差(agent final → 下一 user message);打回轮次
  = 交付物审查历史(session jsonl 事件为准;frontmatter 单字段后审覆盖先审,
  只留终态);一次通过率/返工率 = memory frontmatter 聚合(通过且无 reopen /
  打回、revert、同主题 issue 复发);compaction 次数与 token 成本 = session
  jsonl usage 与事件。
- **持久化边界**:可恢复单元是 session(jsonl)与 memory,不是进程内编排
  状态。父进程死亡 = 在途调度/路由/pending ask 丢失;恢复路径是读 memory
  索引(status: active 的交付物)+ repo 现状重建世界模型,非 checkpoint
  恢复。推论一:跨会话 durable 的协调事实必须落 memory 交付物,不能只存
  在于对话与进程内存。推论二:有外部副作用的动作(发消息/建票据/发布)
  不幂等,resume 后按外部系统与 repo 现状核验续作,不按记录重放——
  "resume 从断点继续"只对幂等且副作用 repo-local 的步骤成立。

## 架构总览

## Prompt 分层

四层注入面正交组合,每层单一职责,跨层引用不复制:

指令面(Instruction Surface)视角:模型遵循的指令不只是 prompt 文本——
tool schema 本身也是 instruction channel:参数命名、枚举取值、可选性、
字段序都在告诉模型怎么做(枚举即行为提示、意图先行的字段序、分发判据
入 schema 均为此原则的落地)。工程对象因此是整面而非单点:prompt
engineering → instruction surface engineering——每处模型可见文本按同一
判据("是否改变下一步行动")审计,schema 与 prompt 同标准。

| 层 | 载体 | 职责 | 加载方式 |
|---|---|---|---|
| L0 行为契约 | `~/.pi/agent/SYSTEM.md` | 输出到达机制(最终消息完整性、结论先行、如实呈报)、回合推进纪律 | 替换 pi 默认 system prompt 基座 |
| L1 治理政策 | `AGENTS.md`(全局+项目链) | 质量契约、memory、worker 使用政策、Framing、交付、风格;工程判断指向 coding-discipline skill,不留副本 | pi 自动拼接进 `<project_context>` |
| L2 机制权威 | 各工具 schema description | 分发判据(when-to-use/when-not)、机制语义、状态机、回调格式;schema 结构本身即指令(参数命名/枚举/可选性/字段序) | API tools 参数随请求发送 |
| L3 领域规程 | `skills/*/SKILL.md` | 特定任务的程序性知识 | 索引进 prompt,按需 read 加载 |

判据归 L2 的裁决:when-to-use/when-not 放工具描述因为它不可被项目级
AGENTS.md 覆盖、离工具调用最近;L1/L3 不复制,重复即漂移源与双份 token。

组装顺序(源码 `dist/core/system-prompt.js`):SYSTEM.md → APPEND_SYSTEM.md →
`<project_context>`(AGENTS.md 链)→ skills 索引 → cwd 行。L2 不进 system
prompt,经 API tools 通道。本文件不被模型加载,属设计文档。

文档分工:worker 与父同载 AGENTS.md 链,治理条款同效——charter 只载 worker 独有
条款,不复制父侧治理。AGENTS.md 只载使用政策,分发判据/机制语义/状态约束以工具
描述为唯一权威,不复制。

注入经济学:output 计价远高于 input,廉价 input 的 hint 可以买昂贵 output
的确定性——判据是"是否改变下一步行动",不是数量。推论一:模型自己一次
工具调用能发现的事实不写,写了是纯成本且稀释注意力。推论二:冲突的规则
是最贵的 input,模型花 output 仲裁而非执行;各层职责正交、跨层引用不复制
即防冲突的结构因。推论三:规则有能力半衰期——为弱模型写的兜底护栏在强
模型上变成冲突源,随模型代际重审各层规则,删改以实测验证无回退
(实测 = 任务级 eval,机制见「拟合循环」段;Claude 5 代际删 80% system
prompt 评测无损失);用判断替代枚举式禁令
("match surrounding code" > "DO NOT add comments"),用接口设计替代示例
(参数与枚举本身即行为提示,示例反而收窄探索空间)。
范例:Claude Code sleep 工具把 cache TTL(5min)经济学写进描述——"不选
300s:要么 270s 留在 cache 窗口,要么 1200s+ 摊薄 miss;想等待多久不如
想在等什么"——非显然的领域知识直接改变参数选择,是 hint 判据的教科书例。

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
