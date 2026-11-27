# 业务框架层与抽样回路（ADR + 骨架方案）

- 日期：2026-11-28
- 状态：**已锁定**（2026-11-28 01:15 定八项，01:25 补意图层为第 9 项，见 §11）；**尚未实现**
- 涉及三处：新仓 `agentia-service`、`agentia`（只读缝，不改 API）、`agentia-harness`（新增 ingest 通道）

---

## 1. 结论先行

1. 新增**第三层** `agentia-service`（独立仓）：承载鉴权、租户、A2A、多 agent 实例部署。平台成本记在这一层。
2. `agentia` **不改 API**。四个宿主缝 + `labels.*` → trace 根属性已经够用（第 3 节逐条给了行号）。
3. `agentia-harness` 只读消费 OTLP，**不连业务库、不调写接口**；线上样本只造题、不判分（拟增不变量 10）。
4. A2A 走**同进程组合**，不做独立代理进程。理由是 `serve()` 收的是任意 handler，组合点本来就有。
5. 「通用」= **一个宿主 + 一份装配清单**，不是一门配置语言（D8）。可配置的只有「装什么」，不配置「什么时候做什么」。
6. harness 的 web 层**不持有写权限**（D9）：RSI 的写留在 CLI 与常驻 worker 里，web 只能读 + 入队触发。另外业务框架必须提供**评测租户**（D10），否则已部署的实例无法被判据层验。
7. 服务入口用成熟框架（Fastify，D11），但**只接管新长出来的路由**；引擎的 `/run` `/tasks` `/healthz` `/metrics` 通过 `reply.hijack()` 原样挂载为终局 fallthrough——重写它们等于第二次实现同一语义。
8. 意图层按 superagent 思路做成**一个 router agent**（D12）：能力目录直接读各 agent 的 card，派发走 A2A 外化，显式指定则短路。它需要自己的 `evals/intent/`，否则路由错误会被端到端通过率掩盖。

分层对应的现实参照是 ADK / Agent Engine / A2A 那条线：写 agent 是一件事，托管运行时是一件事，跨 agent 协议是第三件事——塞进一个进程就会互相锁死演进。

---

## 2. 三层与成本归属

| 层 | 承载 | 变更频率 | 依赖面 | KPI |
|---|---|---|---|---|
| `agentia-service`（新） | 鉴权策略、租户/配额、A2A、agent 装配与路由、部署产物 | 高（跟业务走） | 中（auth + PG + 容器） | 可用性、隔离、单租户成本 |
| `agentia`（引擎） | run 语义、turn/messages、工具/技能、任务面、trace | 低（语义稳定优先） | **极低**（现有运行时依赖为 0） | 公共 API 不破、覆盖率棘轮 |
| `agentia-harness`（判据） | 出题、跑分、归因、RSI、留出账 | 中 | 低（只依赖引擎） | 可复现、可审计、假阳性不累积 |

判断某件事该落在哪层的机械标准：**它需不需要「改标准」**。需要 → harness；需要「多租户/权限/实时」→ service；两者都不需要，只是语义 → 引擎。

---

## 3. 引擎侧现状核对（决定「不用改 agentia」的依据）

| 业务框架要的 | 已有的缝 | 位置 |
|---|---|---|
| 鉴权闸 | `authenticate`：除 `/healthz` `/metrics` 外全路径、**先于读 body**、未通过即断开 | `src/transport/http.ts:123`（说明在 :26 与 :100） |
| 身份 / 租户 / 配额 | `resolveRunOptions`：`principal` → blackboard，客户端 options 走白名单、服务端值覆盖、预算**取更严者** | `src/transport/run-options.ts` |
| 对象级授权 | `authorizeTask(req, {action, taskId, task, principal})` | `src/transport/http.ts:48` |
| 可信审批人 | `resolveApprovalActor` | 同上 |
| 任务面 | `/run`、`/tasks` 提交/轮询/SSE/取消/审批、`drain()` 优雅停机 | `src/transport/async.ts`、`serve.ts:128` |
| 持久化 | fs / sqlite / redis / PG 四后端 | `src/store/*`、`packages/pg` |
| 可观测 | OTLP exporter（零依赖，手写 `fetch` 打 `/v1/traces`）+ Prometheus `/metrics` | `src/integrations/otlp.ts:435` |
| **归因标签** | `options.labels` 逐键写成 run 根的 `labels.<k>` 属性 | `src/engine/loop.ts:424-426` |

最后一行是这次最省事的一条：**租户、agent 名、提示词版本都可以用 `labels` 注入，不需要给引擎加任何字段**，`resolveRunOptions` 里一次 `labels: { tenant, agent, promptVersion }` 就进了 trace。

⚠️ 但 `labels` 只进 trace，**不进 metrics**（`loop.ts:422` 的注释写的是「trace 侧无基数问题；进 metrics 是…」）。所以 `/metrics` 上不要按 tenant 打标签，否则 Prometheus 基数爆炸。抽样数据只走 trace，这个限制不影响本方案。

---

## 4. 决策记录

### D1 —— 独立仓 `agentia-service`，不进 agentia monorepo

**决定**：新仓，依赖 `@migor/agentia`（版本下限跟随，与 harness 同构）。

**理由**：与 harness 完全同构——它是引擎的消费方，不反向要求引擎改 API。发布节奏也不同（业务框架跟着业务发，引擎跟着语义发）。塞进 monorepo 会立刻污染 20 项发布面守卫（三包版本 / `AGENTIA_VERSION` / 脚手架 pin 全要跟着动）。

**否决**：`packages/service`。代价是每次改鉴权都要过一遍引擎的全链门禁（8 步 + 官网构建），且根 `package.json` 的零依赖承诺会被读成「引擎带 auth 了」。

### D2 —— A2A 同进程组合，不做独立代理进程

**决定**：

```ts
const engine = createHttpHandler(app, {
  store, authenticate, resolveRunOptions, authorizeTask, resolveApprovalActor,
});

// 心智模型：先判归属，再交给该管的人。谁写响应只有一个人。
if (a2a.matches(req)) a2a.handle(req, res);   // 新路由：框架自己的 schema 与处理器
else engine(req, res);                        // 引擎路由：原样交还 req/res
```

具体落点在 Fastify 的 `onRequest` 钩子里（见 D11 与 §13 的实测）——**不是** catch-all handler。

**理由**：`serve(handler, opts)` 收的就是 `(req, res) => unknown`（`src/transport/serve.ts:53`），组合点是现成的，不需要给 `http-route.ts` 加扩展点（它是纯函数，只认已知 kind，其余落 `notFound`）。少一跳网络 = 少一处超时/重试/鉴权不一致。

**否决**：独立 A2A 代理进程。它在「引擎已有 tasks/SSE/审批」之上再建一套转发，等于同一语义两份实现——`0.10.15` 那个「会话正文只看 `finalText`」的 bug 就是这个形状。

**⚠️ 实现红线**：A2A 路由**必须复用同一个 `authenticate`**。否则 A2A 就是绕过鉴权的后门，而且 `authenticate` 那条「先于读 body」的性质会在 A2A 路径上丢一半。

### D3 —— 多 agent = 一进程一实例，网关按 agent id 分发

**决定**：一个 `serve` 进程装配一个 agent（`createHttpHandler(app)` 绑一个 `AppCallable`）。多个 agent 就是多个实例，网关按路径前缀或 host 分发。起步阶段不共享进程。

**理由**：隔离配额、隔离崩溃、隔离依赖（不同 agent 可能挂不同 MCP server）。而且 trace 归因靠 `labels.agent`，进程隔离让「哪个 agent 的哪一版」不会串。

**否决**：进程内编排图（ADK orchestration 那种）。跨 agent 的因果在当前归因体系里无法归因（一个 A2A 调用会变成两条独立 trace），进 RSI 会直接违反不变量 2「归因不用模型」和 4「一轮最多采纳一个」。**agent 之间的协作走 A2A 协议外化，不走进程内调用。**

### D4 —— 鉴权策略在业务层实现，引擎不读凭据

**决定**：三档策略都填 `authenticate`：API key（M2M）、OIDC/JWT（用户）、A2A 的签名/mTLS。JWT 验签先用 `node:crypto`（RS256/ES256 + JWKS 缓存），只有需要 JWE 时才引 `jose`。

**理由**：`http.ts:26` 的「框架不读 env、不碰凭据」不是缺口是资产——引擎一旦自己读凭据，凭据就有两个来源，而 `resolveRunOptions` 那条「配额不能被叫价方抬高」的保证会从根上失效。`node:crypto` 起步与引擎「OTLP 手写 fetch 不用 SDK」同一口味。

**否决**：引擎内建 JWT。等于把「谁是权威身份源」写进引擎，多租户产品一旦要接第二个 IdP 就要改引擎发版。

### D5 —— 数据出口只有 OTLP 与 `/metrics`

**决定**：业务框架配 `createOtlpExporter({ endpoint, headers })`，样本落地由 collector / file sink 负责。harness **不连业务库**。

**理由**：库是隐私面 + schema 会漂（`CYCLE_SCHEMA` 从 2 到 3 就是例子）。trace 是只增不改的观测面，且已经是引擎的公共契约。

### D6 —— 线上样本只造题，不判分（拟增不变量 10）

**决定**：流量样本只能流向「候选 case 池」，必须经人审 + 补断言才能进 `evals/`。**判分只在离线、留出、只验一次。**

**理由**：线上分布 = 已有流量的分布。拿它当 holdout，等于把 agent 训成「擅长老问题」，而且评判标准会随流量漂移——这正是 0.4.0 分期留出要防的那件事，只是换了个入口。

**否决**：线上 A/B 直接当门。它同时破坏不变量 1（门在写权限之外）、4（一轮一改）、8（留出只验一次）三条。

### D7 —— 先给报告加 `schemaVersion`，再接线上数据

**决定**：`EvalReport` 与 `CycleReport` 各加 `schemaVersion: number`（只增字段，老记录按缺省读）。

**理由**：线上数据要跨版本读。契约一漂，历史样本全废——这比「加数据库」便宜两个数量级，覆盖的却是「别人来读我的数据」这个真实需求。

### D8 —— 「通用」收敛为「一个宿主 + 一份装配清单」

**决定**：`service.json` 里可配置的只有装配：agent 列表、模型端点、鉴权模式、store DSN、配额上限、路径前缀。不可配置：编排、工具实现、判据。

**理由**：「通用框架」一旦开始配置**逻辑**（workflow DSL / 条件分支 / 动态工具编排），它就变成一门没人维护的语言，而且每个配置项都是一个新失败模式——这与「稳定运行」是直接冲突的，不是权衡关系。装配是数据，逻辑是代码；把逻辑挪进配置，等于把编译器该报的错推迟到运行时。

**机械判据**：`service.json` 里出现 `if` / `when` / `onError` / `steps` 这类键 ⇒ 设计错了，应写代码。加载期用键白名单拒掉（与 `evals/load.ts` 的 `phase` 白名单同一手法）。

**否决**：ADK 式的声明式编排。它在单 agent 内是便利，在跨 agent 时就是 D3 已经否决的那张图。

### D9 —— 写权限留在进程里，不给网络

**决定**：区分「能力」与「通道」。RSI 的写能力完整保留，但只在 CLI 与常驻 worker 里；web 层不持有写权限。

| 通道 | 能力 | 触发者 | 写什么 |
|---|---|---|---|
| CLI（本地 / CI） | 全权限：跑题、提案、采纳、回滚 | 人 / CI job | 工作区（`evals/`、assets、`.workspace/`） |
| 常驻 worker `rsi --watch` | 同上，**串行**推进，有节流与停止条件 | cron / systemd timer | 同上 |
| web（`serve`） | 只读报告与进度（GET only） | 人 | 无 |

**理由**：「写」本身不危险，危险的是**失去时间边界与触发者边界**。RSI 现在建立在三个隐含前提上，网络直写会同时打掉：

1. **串行** —— 一轮一改（不变量 4）靠「同时只有一个 round 在推进」。并发触发就是多轮并行，归因立刻失效，而报告看起来仍然正常。
2. **同进程** —— 提案、验证、采纳、回滚在同一进程同一时刻完成，`journal` 的顺序（不变量 7）才有意义。拆到不同请求上，就会出现「提案在 A 实例、采纳在 B 实例」，回滚时找不到对应的历史行。
3. **可回滚** —— 指纹回滚要求「这一版」是确定的。网络触发会被超时与重试放大成半完成状态：文件改了、历史没写。

**触发只有 cron / systemd timer / CI job**——这是最成熟的做法：不自己写队列，也就不存在「请求超时但轮次仍在跑」的中间态。要看结果读只读 API，要触发就敲一条命令或等定时器。少一个队列，就少一处「队列里有残留 job」的故障面。

**红线**：RSI 写的永远是 harness 自己的工作区，**永远不直接改线上**。业务 agent 的装配更新是一次部署（人审 PR → 镜像 → 灰度 → 指纹核对），不是 RSI 的写动作。RSI 与服务直连 = 自动自我修改生产系统，这是不变量 1 的延伸，不在讨论范围。

**否决**：(a) web 直写 `evals/` / assets —— 执行面与判据面重合，且失效是静默的；(b) 多租户评测平台 —— 需要调度能力时，CI 调度器（Actions / Argo）是更合适的宿主，harness 只提供 CLI、worker 与只读 API。

### D10 —— 业务框架必须提供「评测租户」

**决定**：`agentia-service` 支持 `tenant=eval-*` 的专用租户：独立配额、独立 trace 标签、独立 TaskStore 分区、**不写线上 metrics**。harness 跑 case 时打这个租户。

**理由**：框架一旦通用并上线，harness 就不能再「进程内 spawn 一个 app」来跑题——要验的是**已部署的那一份**（同一镜像、同一装配、同一 store 语义）。没有评测租户，跑题会和线上流量抢配额；trace 混在一起后，「这次的通过率」也无法归因到具体版本。

**红线**：评测租户只能跑 `evals/` 里的固定 case，不接收线上流量；线上租户不能跑评测。这是 D6 的机制化，不是靠纪律。

### D11 —— 入口用成熟框架，但只接管新路由

**决定**：`agentia-service` 用 **Fastify** 作为唯一 listener；引擎那几条路由通过 `reply.hijack()` + `createHttpHandler(req, reply.raw)` 原样挂载。

**挂载点是 `onRequest` 钩子**里的「路径归属判定 + hijack」，**不是** `app.all('/*')` 的 handler——后者会让所有带 body 的请求静默挂住（§13 有实测）。

**为什么不重写引擎那 5 条**：它们的语义比看起来细——鉴权先于读 body、413/405/503 的精确状态码、SSE 收口、`drain()` 期间的拒单与「停机中仍可轮询」。在框架里重写一遍，就是第二次实现同一语义——`0.10.15` 的 `finalText` bug 正是这个形状。**框架负责「新长出来的」，引擎负责「已经稳的」**，边界是一次 `onRequest` 归属判定。

**选型对比**：

| 方案 | 优点 | 致命点 |
|---|---|---|
| **Fastify** | `reply.hijack()` 就是「交还原始 socket」；`onRequest` 早于 body 解析；JSON Schema 校验 + OpenAPI 生成；生态成熟 | 依赖树中等（20+ 包）；插件封装有学习曲线 |
| Hono | 零依赖、Web 标准、体积极小 | **没有 hijack**，raw req/res 交接要绕 `c.env.outgoing`，SSE 容易双写 |
| Express 5 | 天然可挂 raw handler，最省事 | 无 schema / OpenAPI；async 错误处理刚补齐 |
| NestJS | 结构最「框架级」 | DI + `reflect-metadata` + 装饰器，与引擎的显式风格相反，依赖树最大 |

**「可读性」的真正来源不是框架名**，是两件事：路由表一屏读完、schema 贴在路由旁边。Fastify 的 route options 直接满足；Express 靠约定、Nest 靠装饰器魔法。所以这三者里选 Fastify 是为了**这两条性质可机械检查**（验收判据 20 用 OpenAPI 与实际路由交叉校验）。

**四条风险，都必须在实现时显式处理**：

0. **body 被提前消费**（实测必踩）—— Fastify 生命周期是 `onRequest → preParsing → 解析 → handler`。写在 `all('/*')` handler 里的 hijack **已经太晚**：POST 的流早被读完，引擎再等 `data` / `end` 就永远不返回——表现为请求挂住，**没有异常、没有日志**。这是最坏的一种失败形态，必须在 `onRequest` 里接手。
1. **双写** —— `reply.hijack()` 之后框架不能再写响应。fallthrough 里只要 hijack 了就 `return`，任何 `reply.send()` 都是 `ERR_HTTP_HEADERS_SENT`。
2. **双上限** —— `POST /a2a` 走框架的 `bodyLimit`，引擎路由走 `maxBodyBytes`。两个值不同不算 bug，但必须**有意为之并写进文档**，否则排查「为什么 2MB 的 body 在 A2A 上过了、在 /run 上 413」要花很久。
3. **形状分裂** —— 引擎错误是 `{error}`，Fastify 默认是 `{statusCode, error, message}`。新路由统一成人读的形状，**老路由保持原样**（已发布契约，不为美观改动）。

### D12 —— 意图层是一个 router agent，不是一层分类器代码，也不做进程内编排图

**决定**：按 superagent 的思路，把「用户说了什么 ⇒ 该谁做」做成一个**普通 agent**（`agents/router.ts`），跑在同一个引擎上，只挂两个工具：

| 工具 | 干什么 |
|---|---|
| `list_capabilities` | 汇总注册表里各 agent 的 `agent-card.json` 的 `skills`（名称 + 一句描述 + 输入约束） |
| `dispatch` | 按 agent id 派发，走 A2A `message/send`，拿回 taskId 与结果 |

意图层本体**不新写控制流**——它就是一次 run，多轮、工具调用、trace、审批全部复用引擎已有语义。这是「不第二次实现同一语义」在 agent 层的同一手法。

**三条硬约束**：

1. **目录唯一来源是 agent-card**。路由用的能力目录 = 各 agent 对外发布的 `skills`，**不另维护一份 registry 描述**。否则「可发现」与「可路由」会漂移成两份，而且漂移方向恰好是最坏的那个：card 说能做、路由不知道——外面发现得到，里面派不过去。
2. **派发必须外化**。意图层派给子 agent 一律走 A2A（跨进程），不做进程内调用。所以这里的「superagent」是**跨进程的调度者**，不是一张进程内编排图（D3 已否决那张图）。代价要认下来：多一跳网络、错误处理跨进程、归因要靠 `traceparent` 拼。
3. **显式指定优先，短路意图层**。请求已带 agent id（`/agents/<id>/...`、A2A 直达某 card、OpenAI 兼容端点 `model` → agent 映射）时**不进意图层**；注册表只有 1 个 agent 时也不进。这不是性能优化，是正确性——显式指定被模型改写等于行为不可预期。

**能做的 / v1 不做的**：

| 做 | 不做（要判据，另开 ADR） |
|---|---|
| 选 agent（单意图 → 单 agent） | 并行 fan-out 拆解多意图 |
| 补齐参数：缺关键信息时回 `input-required`，不猜 | 跨 agent 结果仲裁（冲突谁说了算、部分失败怎么办） |
| 拒绝：没有任何 agent 覆盖时明说没能力，不硬派 | 会话内改派（v1 一会话一 agent） |

fan-out 不做的理由不是「麻烦」，而是**聚合语义没有判据**：三个 agent 给了三个不一致的答案，谁算对？没有这一条，聚合层就是一层不可归因的东西，进 RSI 直接破坏不变量 2。

**归因（接 RSI 的前提）**：

| 写什么 | 写在哪 | 为什么 |
|---|---|---|
| `intent.route` 事件：`chosen` / `candidates` / `reason`（短枚举，不是自由文本） | trace 事件 | 事后能回答「为什么派给它」，且不用模型解释 |
| `labels.routeAgent` | run 根属性 | 枚举、低基数，可按 agent 检索 |
| 意图原文 | **哪儿都不进** | 高基数 + PII；只留在脱敏前的原始 trace 里 |

派发出去的 A2A 调用透传 `traceparent`，并用 `labels.parentRun` 指回意图层那次 run——两条 trace 靠这两个值拼，不靠时间邻近。

`dispatch` 本身的机制（三态返回、会话键、串行队列、幂等、预算降级、三条越权禁令）在 **§5.5** 单列一节——它是这层最容易做错的地方，值得独立成篇。

**评测口径必须独立（最容易被漏的一条）**：

端到端通过率**会掩盖路由错误**。用户问 A 领域、被派给 B，B 也能糊一个像样的答案——通过率照涨，问题被藏住。所以意图层要有自己的 eval 集与自己的判据：`evals/intent/` 三条——`route_accuracy`（该派谁）、`clarify_rate`（该问的时候问没问）、`refuse_accuracy`（没能力时是否拒）。

配套一条 RSI 侧的要求：**采纳意图层改动时 `route_accuracy` 必须不下降，与任务通过率并列进 `isWorthAccepting`**。否则 RSI 会收敛到「全派给最全能的那一个」——通过率可能还升，路由多样性却塌缩成单 agent，而这件事在现有判据里**完全看不出来**。

**否决**：① 网关里写一个分类器（embedding 检索 / 小模型打标）。它便宜、快，但意图不只是「选标签」——要能追问、能拒绝、能补参数，这三件都是多轮的，写成分类器就得在网关里把 loop 重新实现一遍。② 进程内编排图，见 D3。

---

## 5. 新仓骨架

```
agentia-service/
  src/
    server/
      app.ts             # Fastify 实例：hooks、错误形状、日志（全进程唯一 listener）
      routes.ts           # 路由表：一屏读完，schema 贴在旁边
      engine-mount.ts     # onRequest 钩子：路径归属判定 → reply.hijack() → createHttpHandler
      protocols/
        a2a/
          card.ts         # /.well-known/agent-card.json
          rpc.ts          # JSON-RPC 2.0 解析与错误码
          methods.ts      # message/send、message/stream、tasks/get、tasks/cancel
          map.ts          # A2A task ↔ agentia TaskRecord（状态映射只在这一个文件里）
        openai/
          completions.ts  # /v1/chat/completions（含 stream），messages[] → run
      auth/
        apikey.ts         # M2M
        oidc.ts           # 用户（JWKS + 验签）
        principal.ts      # principal 形状（唯一来源）—— 引擎与 A2A 共用同一个函数
      tenant/
        resolve.ts        # resolveRunOptions 实现：tenant → blackboard + labels
        quota.ts          # 预算取更严者
      registry/
        agents.ts         # agentId → 装配（prompt / skills / tools / model），加载即校验
    intent/
      gate.ts             # 短路判定：显式指定 / 单候选 / context 已绑定（D12）
      capability.ts       # 从 agent-card 汇总能力目录（不落第二份描述）
      dispatch.ts         # dispatch 工具：三态返回 + 幂等 + 主动降级（§5.5）
      session.ts          # contextId → agent 绑定（PG `intent_session`，TTL 惰性）
      queue.ts            # per-context 串行队列（进程内锁 + PG advisory lock）
    agents/
      router.ts           # 意图层本体：装配 prompt + list_capabilities / dispatch
      ...                 # 其余每个业务 agent 一个文件，只做装配
  deploy/                 # Dockerfile / compose / 部署说明
  docs/a2a.md             # 锁定的 A2A 草案版本号 + 状态映射表
```

依赖策略：`@migor/agentia` + `@migor/agentia-pg`（生产 TaskStore）+ 零新增 auth 依赖（`node:crypto`）。这条和引擎的「运行时依赖为 0」是同一口味，也是它能长期不腐的原因。

A2A 状态映射（写死在 `map.ts`，不外溢）：`submitted`/`working`/`input-required`/`completed`/`canceled`/`failed` ↔ `TaskRecord` 的 queued/running/awaiting-approval/done/failed。引擎的「审批」在 A2A 里就是 `input-required`，这是两边语义唯一需要翻译的地方。

### 5.1 一键部署的最小形态（「稳定运行」的四件事）

引擎已经给的：`/healthz`（含 `inFlight` / `suspended` 读数）、`/metrics`、`handler.drain()`、`resumePending`（重启后接管未完成任务）、`@migor/agentia-pg` 的幂等建表。

必须由业务框架补的四件——缺一件，「一键」就变「一键挂」：

| 事项 | 为什么引擎不做 | 落点 |
|---|---|---|
| SIGTERM → `drain()` | `http.ts:180` 明写「框架**不订阅 SIGTERM**：`process.on('SIGTERM', () => handler.drain())` 是宿主的事」 | `server/main.ts`，全仓唯一一处，带超时 |
| `/readyz` 与 `/healthz` 分离 | 引擎只有存活口径（存活 + 在飞读数），没有「能不能接单」（store 连不上 / 迁移未完成） | 组合层，与 A2A 同一个 `handler` |
| 启动自检 | 引擎只校验自己的构造参数（`maxBodyBytes` / `maxConcurrentRuns` 这类构造期就炸），不认识 agent 装配 | `registry/agents.ts`，加载即校验，早于任何 `listen` |
| 回滚单位 | 引擎不知道「这一版是哪一版」 | 装配文件 + `assetFingerprint`，与 harness 的指纹回滚共用同一个值 |

「一键」的具体形态：`deploy/Dockerfile` + `docker-compose.yml`（app + postgres）+ 一份 `service.json`，`docker compose up -d` 起全套。**不做 helm chart、不做 operator**——等真有第二个部署环境再谈。

### 5.2 评测租户

| 租户 | 能跑 `evals/` | 能收线上流量 | trace 标签 | 配额来源 |
|---|---|---|---|---|
| 线上租户 | 否 | 是 | `labels.tenant=<id>` | `resolveRunOptions` 按租户封顶 |
| 评测租户 `eval-*` | 是 | 否 | `labels.tenant=eval-<team>` | 独立池，不占线上额度 |

两者**共用镜像与装配**，只在 `resolveRunOptions` 分叉（DSN + 配额表 + metrics 开关）。这样「评测的就是线上的同一份代码」才成立——否则验的是另一套东西，通过率再高也不迁移。

**PG 分离**：线上与评测各自一个 **database**（同一实例、两个 DSN）。理由三条：权限边界（评测进程不该有线上表的写权限）、备份恢复粒度不同、迁移可以各自推进。同库不同 schema 省不了多少运维，却把这三条都丢了。

**租户两层**：`org → agents`。`org` 是鉴权与配额单位，`agent` 是路由与 trace 单位（`labels.tenant` / `labels.agent`）。

### 5.3 协议矩阵：五种入口，两个已有主人

| 协议 | 用途 | 现状 | 谁实现 | 要框架吗 |
|---|---|---|---|---|
| REST（`/run`、`/tasks`、`/tasks/:id`、`/events`、审批） | 自有前端 / 内部调用 | 引擎已有（`transport/http-endpoints.ts`） | 引擎，原样挂载 | 否 |
| MCP | 作为工具被别的 agent 调用 | 引擎已有（`engine/mcp-server.ts`，stdio / HTTP） | 引擎 | 否 |
| A2A（card + JSON-RPC + SSE） | 跨组织、跨进程协作 | 无 | service | **是** |
| OpenAI 兼容 `/v1/chat/completions`（含 stream） | 让现成客户端与工具零改造接入 | 无 | service | **是** |
| Webhook / 事件回调 | 业务异步通知、A2A pushNotification | 无 | service（后置） | 是 |

结论：框架真正买的是**后三个**。前两个已有主人的路由，一行都不该重写。

A2A v1 只做规范核心五法（`card` / `message/send` / `message/stream` / `tasks/get` / `tasks/cancel`）；`pushNotification`、扩展 URI、多模态 part 后置——「正常就行」的意思是按规范实现，不加自创字段。

MCP 那条值得单说：引擎已经能把自己暴露成 MCP server，所以「一个 agent 当工具被用」不需要 service 参与。service 只在需要「按租户鉴权 + 集中配额」时才在前面加一层。

OpenAI 兼容端点有个真实设计点：它是**有状态语义**（`messages[]`），而 agentia 的 run 也是消息驱动，映射几乎一一对应——但多轮要靠 `user` 字段或 `X-Session-Id` 头固定，否则每条请求都是新 run，上下文全丢。

### 5.4 意图层的落点与短路

请求进来的判定顺序（越前越便宜，也越确定）：

| 顺序 | 条件 | 动作 |
|---|---|---|
| 1 | 路径带 `/agents/<id>/` | 直接进该 agent，**不产生意图层 run** |
| 2 | 注册表只有 1 个 agent | 同上 |
| 3 | session 已绑定 agent（多轮） | 同上（v1 不中途改派） |
| 4 | 其余 | 进意图层：一次 run → `list_capabilities` → `dispatch` |

第 3 条是 v1 的明确取舍：多轮会话中途「换话题」不会被自动改派，客户端要么新开 session，要么用户明说。自动改派需要「话题边界检测」，那又是一层要判据的东西——现在加等于给归因体系加一个无法回滚的变量。

意图层这次 run 自己的成本也要记账：它**多花一跳 LLM**。所以短路三条是硬门，不是优化项——单 agent 部署（最常见的起步形态）不该为这个能力付一分钱。

### 5.5 dispatch 层：它不是 RPC，是「会话接续器」

先纠正一个会带歪整层设计的心智模型。**dispatch 不是「调用一个远程函数」，是「给一段已存在的会话续一条消息」。** 这个区别决定了下面前九个小节的全部内容。

#### 5.5.1 三个 id 的分层对应

| A2A 侧 | 引擎侧 | 生命周期 | 谁生成 |
|---|---|---|---|
| `contextId` | `sessionId`（派生出子会话 id，见 5.5.2） | 天级（跨请求） | 意图层首轮生成，回给客户端 |
| `taskId` | `TaskRecord.taskId` | 请求级（到终态） | 引擎 `submit` |
| `messageId` | 无（由 `turnSeq` 记账） | 单条 | service |

关键是第一行：**同一 `contextId` 下的多个 task 共享同一个 `sessionId`**。这正是 `SessionStore.load/append` 的语义，也是引擎 `options.sessionId` 已经接好的通道（`transport/async.ts:1094`）。所以 A2A 的多轮不需要新机制，只需要正确映射：

| 客户端发来 | A2A 语义 | 引擎动作 |
|---|---|---|
| 无 `taskId`、新 `contextId` | 新上下文第一问 | `submit`（新 task + 新 sessionId） |
| 无 `taskId`、旧 `contextId` | 同上下文追问 | `submit`（新 task + **同一** sessionId） |
| 带 `taskId` | 继续那个 task | `POST /tasks/:id/events` |

第三行是最容易做错的一格。子 agent 回 `input-required` 之后，用户的补充**不是新任务**，是给旧任务投事件。做错的表现很隐蔽：派发出一个全新 task，子 agent 手里已收集的参数全丢，于是它把同样的问题再问一遍——用户看到的是「它怎么又问一遍」，日志里一切正常。

#### 5.5.2 会话键必须是 `contextId#agentId`，不是 `contextId`

D12 说 v1 一会话一 agent，那为什么还要拼 agentId？

因为**显式路由和意图路由会共用同一个客户端会话**。`/agents/sales/...` 与 OpenAI 兼容端点用同一个 `user` 字段时，两路请求的 `contextId` 相同。若 `sessionId` 直接用 `contextId`，sales 的 system prompt 与对话、billing 的 system prompt 与对话会写进同一个 store 条目；下一轮 `load` 出来是一段**两套人设交替**的历史——模型会精神分裂，而错误信息完全指不到根因。

拼一个字符串是零成本，防的是最难查的一类 bug。格式：`${contextId}#${agentId}`。

#### 5.5.3 每个 context 一条串行队列（不做会硬失败）

`runtime/session.ts:22` 写死了一条已知边界：

> append-only 只保证「不互相覆盖、不丢数据」，不保证**角色交替**。两个并发 run 共用同一 sessionId 时，各自收尾 append 的 `[user, ..., assistant]` 可能交错成「连续两条 user」，下一轮 load 出来会撞 Anthropic 的角色交替校验（400）。

意图层做 proxy 恰恰会制造「同一 context 两条并发消息」。所以 dispatch 层必须持有 **per-context 串行队列**：进程内按 `contextId` 加一把锁，多副本部署时再加 PG advisory lock（键用 `hashtext(contextId)`）。

为什么这条不能"以后再说"：400 不发生在并发的这一轮，发生在**下一轮**——那时历史已经脏了，而且脏数据留在了 store 里。这是全套设计里归因难度最高的一类失败。

顺带一个反推：这也是为什么 D9 坚持「web 不入队 RSI」。串行不是性能取舍，是这套体系的正确性前提。

#### 5.5.4 dispatch 的返回是三态，不是二态

| 子任务到达 | `dispatch` 返回 | 意图层该做的 | 不许做的 |
|---|---|---|---|
| `completed` | `{status:'done', output}` | 汇总/改写后回答 | 把 output 原样当自己说的（要标明来源） |
| `input-required` | `{status:'needs_input', question, taskId}` | **原样**转给用户，记下 taskId | 改写追问、猜答案、换个 agent 再试 |
| 未到终态（预算用尽） | `{status:'accepted', taskId}` | 回「已受理，taskId=X」 | 假装完成、无限等 |
| `failed` | `{status:'failed', reason}` | 原样透传 | 编一个更友好的解释 |

`needs_input` 那格「不许改写」尤其重要：子 agent 追问的是**它需要的参数名**，意图层并不知道这些参数，任何改写都会让用户答非所问，而重试时又回到同一格，形成循环。

**意图层自己的澄清也要有上限**：同一个 context 连续 `input-required`（子 agent 侧）与意图层自己的澄清合计超过 **3 轮**，就不再问，改为给候选列表（「你是想 A 还是 B？」）+ 一句「告诉我哪个，我直接办」。继续猜是对话体验里最消耗耐心的一种失败——而且它没有自然的停止条件，必须有硬上限。

#### 5.5.5 预算：主动降级，不是被超时杀掉

工具侧预算只有一个来源：`ctx.toolTimeoutMs`（引擎传入）。**dispatch 不许自己再设一层超时**——`core/limits.ts` 把双计时器列为明令禁止项（双账本、双保险互相抵消）。

正确做法是在预算的 **80%** 处主动返回 `accepted`：

| 做法 | 用户看到 | 可恢复性 |
|---|---|---|
| 等 `withTimeout` 强杀 | 「莫名其妙失败」，无 taskId | 差：不知道任务还在不在跑 |
| 主动降级 `accepted` | 「已受理，taskId=X」 | 好：能轮询、能订阅 |

差别不在措辞，在**工具结果是否还在**。被强杀时结果丢失，意图层只能看到一个错误。

#### 5.5.6 幂等键：`(contextId, turnSeq, agentId, taskDigest)`

意图层 run 崩溃后重跑，会重放同一个 turn。没有幂等键就是派两次：子 agent 那边两个 task、用户收到两条回答、trace 里两条并行因果。

引擎 `TaskRecord.idempotencyKey` 已经存在（`store/store.ts:41`），`submit` 时传进去即可，不需要新表。四个成分都要：

- `contextId` + `turnSeq`：区分同一会话的不同轮
- `agentId`：同一轮可能先派 A 失败再派 B（虽然 5.5.7 禁止自动换人，但人为重试允许）
- `taskDigest`：任务描述的哈希。**没有它，同一轮里两次不同的派发会被误合并**

#### 5.5.7 三条「不许」，都是 proxy 不越权

| # | 不许 | 理由 |
|---|---|---|
| 1 | 改写子 agent 的追问 | 见 5.5.4：参数名只有子 agent 知道 |
| 2 | 失败后自动换 agent 重试 | 换人 = 用户的问题被两个系统各答一半；且这次重试在 trace 上是意图层的内部逻辑，**事后无法归因** |
| 3 | 会话内改派（v1） | 改派需要「话题边界检测」，那是一层要判据的东西（D12） |

第 2 条值得单独说明：自动换人是意图层最"自然"的反应，也是最坏的。它把一次可诊断的失败变成一次看似成功的回答，而回答来自一个不该被问的 agent。

#### 5.5.8 绑定存哪：service 自己的 PG 表

`blackboard` 是 per-run 的（`core/blackboard.ts`：`run({ blackboard })` 种子、`RunContext.get/set`），**重启即失**，不能承担跨天会话绑定。

| 方案 | 结论 |
|---|---|
| engine blackboard | 否：per-run，run 结束即失 |
| 内存 Map | 否：重启丢，用户第二天回来就重新路由 |
| **service 的 PG 表 `intent_session`** | 是：`context_id` 主键 + `agent_id` + `sub_task_id` + `sub_session_id` + `turn_seq` + `updated_at` |

TTL 用**惰性**实现：过期不是错误，只是「下次重新路由」。不做定时删除任务（那是运维负担），在 `gate` 读到过期行时顺手删。

#### 5.5.9 事件翻译：子 agent 的 trace 不直通客户端

`message/stream` 时，子 agent 的 `/tasks/:id/stream` 吐出的是**引擎 trace 事件**，不是 A2A 的 `TaskStatusUpdateEvent` / `TaskArtifactUpdateEvent`。两套形状不能混着发给客户端——客户端会收到两个 agent 的工具调用细节，且无法区分哪条属于谁。

只翻译三样：

| 转发 | 不转发 |
|---|---|
| 状态变化（working / input-required / completed / failed） | 子 agent 的每次工具调用 |
| 最终 artifact | 子 agent 的中间推理 |
| 节流的进度摘要（≥2s 一次） | 完整 trace（含 PII） |

翻译代码放 `map.ts`——D11 已经定过「状态映射只在一个文件里」，这里沿用同一条纪律。

#### 5.5.10 失败矩阵

| 失败 | 处理 | 为什么 |
|---|---|---|
| 子 agent 不可达（连接失败） | 报 `failed`，**不换人** | 5.5.7 第 2 条 |
| 子 agent `failed` | 原样透传 | 编解释等于伪造事实 |
| 预算耗尽 | `accepted` + taskId | 5.5.5 |
| 模型选了一个不存在的 agent | 工具层校验拒绝（不是派发） | 注册表是唯一真值；幻觉的 agentId 不该产生网络请求 |
| 挂起超过 TTL | 标 stale，下次消息按新 task 派 | 让「昨天的追问」不至于粘住今天的会话 |
| 同一 context 并发两条 | 排队，第二条等第一条到终态或挂起 | 5.5.3 |

#### 5.5.11 评测形状

dispatch 的评测量的是「每一轮派给谁」，不是「最终答案对不对」：

```json
{ "context": "c1",
  "turns": ["上一版报告的导出格式是怎样的", "那 PDF 呢", "算了，帮我改成 CSV"],
  "expect": { "agentPerTurn": ["report", "report", "report"] } }
```

`route_accuracy` = 逐 turn 比对。第三轮是最有价值的一类 case：用户说「算了，帮我改成 CSV」——按关键词它像另一个 agent，按上下文它还是 report。这种「看起来该改派、实际不该」的样本，正是模型最容易错的，也是通过率完全测不出来的。

这也是为什么 dispatch 必须记 `turnSeq`：没有它，评测无法定位到第几轮错。

---

## 6. 数据契约

| trace 属性 | 谁写 | 值 |
|---|---|---|
| `labels.tenant` | `resolveRunOptions`（业务层） | 租户 id |
| `labels.agent` | 同上 | agent id（注册表键） |
| `labels.promptVersion` | 同上 | 装配里声明的版本 |
| `labels.routeAgent` | 意图层（D12） | 被派给的 agent id；显式路由时缺省 |
| `labels.parentRun` | `dispatch` 工具（D12） | 意图层那次 run 的 id，用于拼两条 trace |
| `labels.subTaskId` | `dispatch`（D12） | 子 agent 的 taskId，用于「一次请求两条 trace」对账 |
| `labels.turnSeq` | `gate` / `dispatch` | 会话轮次；`evals/intent/` 靠它定位「第几轮错了」 |
| `tools.menuHash` / `tools.names` | 引擎（`core/trace.ts` 常量） | 已有，0.10.16 起在公共面 |
| `prompts.versions` | 引擎 | 已有 |

- **跨进程归因**：A2A 调用要把 `traceparent` 透传（引擎已有 `parseTraceparent`）。一个 A2A 调用会生成两条 trace，拼接靠 `labels`/`traceparent`，不靠时间邻近。
- **脱敏在 ingest 侧做**：trace 里有完整用户输入。规则落在 harness 的 ingest 里（正文 → 长度桶 + 输入哈希，只保留结构不保留文本），不指望线上做。
- **去重键**：`(agent, promptVersion, 归一化输入哈希)`。没有去重键，流量样本会把 case 池灌成同一道题的 N 份拷贝。

---

## 7. 验收判据（机械可验，逐条能跑）

| # | 判据 | 怎么验 | 期望 |
|---|---|---|---|
| 1 | agent card 可发现 | `curl /.well-known/agent-card.json` | 200，含 `capabilities` 与 `skills` |
| 2 | A2A 主链路通 | `message/send` → 拿 taskId → `tasks/get` 轮询 | 到 `completed` 且有 artifact |
| 3 | 审批能翻译 | 触发审批的用例 | A2A 侧看到 `input-required`，approve 后回 `working` |
| 4 | 鉴权先于 body | 100MB `chunked` 上传、不带凭据，`curl -w '%{time_total}'` | 401 且 < 200ms（没等 body 传完） |
| 5 | A2A 不是后门 | 同样上传打 A2A 路径 | 同上 401 与耗时 |
| 6 | 跨租户隔离 | 租户 A 的 token 读租户 B 的 taskId | 403（走 `authorizeTask`） |
| 7 | 标签进 trace | `harness trace <id>` | 出现 `labels.tenant` / `labels.agent` / `labels.promptVersion` |
| 8 | 脱敏有效 | 造 10 条含已知手机号/邮箱的样本，ingest 后 `grep -r` | 评测仓内搜不到原文 |
| 9 | 线上样本进不了 holdout | 新增测试：候选 case 池的 case 调 `pickHoldoutBatch` | 抛错（holdout 只从 `evals/` 加载的 case 里选） |
| 10 | 报告可跨版本读 | 造一份无 `schemaVersion` 的老 `EvalReport` | 读取不炸，按缺省版本处理 |
| 11 | SIGTERM 会 drain | 有在飞任务时发 SIGTERM | 任务跑到终态或超时才退出，exit 0，不留孤儿任务 |
| 12 | readiness 与 liveness 分离 | 断开 store 后分别打 `/readyz` 与 `/healthz` | 503 / 200 |
| 13 | 评测租户隔离 | 用 eval 凭据跑 3 条 case | 线上租户 metrics 计数不变；trace 带 `labels.tenant=eval-*` |
| 14 | 配置里没有逻辑 | 给 `service.json` 塞 `when` / `steps` 键 | 加载期抛错，不启动 |
| 15 | web 无写口 | `POST /rsi/rounds`、`POST /evals`、`PUT /assets` 各打一次 | 404 / 405；工作区 mtime 不变 |
| 16 | worker 串行 | 连投 3 个轮次 job | 同一时刻只有一轮在跑（`cycles/*.json` 无重叠时间窗） |
| 17 | 中断后可续 | worker 跑到第 2 步 `SIGKILL` | 重启后 journal 有完整历史行，指纹可回滚，不出现半完成资产 |
| 18 | 单入口 | 所有路径（含 `/healthz`、`/metrics`、`/a2a`）打同一端口 | 只有一个 listener；`lsof -i` 只有一个进程占端口 |
| 19 | SSE 不被框架缓冲 | `message/stream` 与 `/tasks/:id/events` 各跑一次 | 首帧 < 500ms 到达，响应无 `content-length` |
| 20 | 路由表与文档一致 | `GET /openapi.json` 与 `routes.ts` 交叉枚举 | 双向一致；漏一条即失败 |
| 21 | 无重复写响应 | 打 `/run` 与 `/a2a` 各一次，开 `pino` 错误日志 | 无 `ERR_HTTP_HEADERS_SENT` |
| 22 | POST 不挂住 | `POST /tasks` 带 body，限时 2s | 回 202；超时即失败（body 被框架提前消费的症状） |
| 23 | 显式指定不被改派 | `/agents/sales/...` 配一段明显属另一领域的文本 | 仍进 sales；trace 里**没有**意图层 run |
| 24 | 单候选短路 | 注册表只留 1 个 agent，打普通入口 | 只有 1 次 run（没有 router run） |
| 25 | 路由决策可读 | `harness trace <routerRunId>` | 有 `intent.route` 事件，含 `chosen` / `candidates` / `reason`（枚举） |
| 26 | 没能力就拒 | 问一个无任何 agent 覆盖的领域 | `input-required` 或明确拒答；**不许**硬派给某个 agent |
| 27 | 路由不塌缩 | `evals/intent/` 跑 `route_accuracy`，与 pass rate 并列进 `isWorthAccepting` | 任一者下降即不采纳（改 `verify.ts` 一处） |
| 28 | 历史不串味 | 同一 `contextId` 交替打 sales 与 billing，各追问一轮 | 两个 `sessionId` 不同；各自 `load` 出的历史只含自己的 system |
| 29 | 并发同 context 不 400 | 同一 `contextId` 同时发 2 条 | 第 2 条排队；两条都进终态，全程无角色交替 400 |
| 30 | 追问是投事件不是新 task | 子 agent `input-required` 后回一条 | `taskId` 不变（`/tasks/:id/events`），不产生新记录 |
| 31 | 派发幂等 | 同一 turn 的 dispatch 重放 2 次 | 子 agent 侧只有 1 个 task（`idempotencyKey` 命中） |
| 32 | 预算内主动降级 | 子 agent 恒慢（sleep > 工具预算） | 返回 `accepted` + `taskId`，**不是**工具超时错误 |
| 33 | 失败不换人 | 让 sales 恒定失败后问一句 sales 领域的话 | 报 `failed`；billing 侧 task 数为 0 |

第 4、5 两条是这套设计里唯一一处「性能即正确性」的地方，必须量化。

---

## 8. 明确不做

- 进程内多 agent 编排图（D3）
- 意图层的并行 fan-out 拆解、跨 agent 结果仲裁、会话内改派（D12：聚合语义没有判据）
- 意图层另维护一份能力目录（D12：唯一来源是 agent-card）
- 失败后自动换 agent 重试（§5.5.7：换人让回答来自不该被问的 agent，且事后不可归因）
- 改写子 agent 的追问（§5.5.4：参数名只有子 agent 知道）
- dispatch 自己再设一层超时（§5.5.5：双计时器是 `core/limits.ts` 明令禁止的）
- 意图原文进 `labels` / `metrics`（高基数 + PII，D12）
- 细粒度 RBAC（先只做 tenant + 两档角色）
- 计费与账期
- harness 连业务库 / 调业务写接口（D5）
- 引擎内建 JWT（D4）
- 配置化编排 / workflow DSL / 条件分支（D8）
- 用框架重写 `/run` `/tasks` `/healthz` `/metrics`（D11：第二次实现同一语义）
- NestJS 式 DI 容器 / 装饰器路由（D11）
- web 直写 `evals/` / assets、多租户评测平台（D9）
- web 触发 RSI 轮次（改用 cron / systemd timer，D9）
- RSI 直接部署或改线上装配（D9 红线：上线永远是部署门）
- helm chart / operator / 自动扩缩容（5.1）
- 多区域、高可用、灰度发布（等真有第二个租户再谈）

---

## 9. 顺序与依赖（依赖边，不是工期）

```
S1 agent-card + message/send + tasks/get + /v1/chat/completions   ← 两条外部标准契约，兼容成本都在这里
   ├─→ S10 意图层（router agent + A2A 派发 + 短路）← 依赖注册表与 A2A；单 agent 部署可跳过
   │     └─→ S10b dispatch 会话层（session 表 / per-context 队列 / 三态 / 幂等，§5.5）
   └─→ S2 鉴权三档 + 租户/配额（resolveRunOptions + authorizeTask）
         └─→ S3 一键部署（Dockerfile / PG TaskStore / SIGTERM / readyz）
               └─→ S7 评测租户（eval-* 分区）← 两仓真正的联调点

S4 harness: schemaVersion            ← 无依赖，随时可做
   ├─→ S5 ingest（脱敏 + 去重 + case 池）← 可先用 CLI 产出的 traces.jsonl 打通
   │     └─→ S6 线上样本 → 人审 → 进 evals/
   ├─→ S8 只读看板 / 只读 API（GET only）
   └─→ S9 `rsi --watch` + cron / systemd timer（串行 + 节流）
```

S4/S5 与 S1–S3 并行不冲突：S5 的输入先用手工 trace，等 S1 上线再接 OTLP。

**为什么 S1 排第一**：它是唯一一旦对外就要背兼容成本的东西（agent-card 字段、状态机、错误码）。其余都能内部改。

---

## 10. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| A2A 规范仍在草案期 | 端点/字段改名 | 锁版本号写进 `docs/a2a.md`；映射表集中在 `map.ts`，改一处 |
| 跨进程 trace 拼接 | 归因断裂 | 透传 `traceparent` + `labels`；缺一不可，不能靠时间邻近 |
| PII 泄漏 | 评测仓成隐私面 | 验收判据 8 是硬门，不是建议 |
| 抽样偏差 | 越训越窄 | 不变量 10：样本只造题，判分只离线留出 |
| 标签基数 | Prometheus 爆 | `labels` 只进 trace；`/metrics` 不打 tenant |
| 误派被通过率掩盖 | 路由错但不报警 | 独立 `evals/intent/` + 判据 27（`route_accuracy` 并列进采纳判据） |
| 多一跳 LLM | 延迟与成本上升 | 短路三条（显式 / 单候选 / context 绑定）；单 agent 部署零成本 |
| 并发写坏会话历史 | **下一轮**才 400，历史已脏 | per-context 串行队列（§5.5.3）+ 判据 29 |
| 追问被当成新任务 | 子 agent 丢参数、重复提问 | 三态返回 + 判据 30（`taskId` 必须不变） |
| 意图层反复澄清 | 用户被问烦 | 澄清上限 3 轮，超了给候选列表而不是继续猜 |

---

## 11. 已锁定（2026-11-28 01:15，同日 01:25 补第 9 项）

| # | 问题 | 决定 | 影响 |
|---|---|---|---|
| 1 | 仓名 | **`agentia-service`** | 独立仓（D1） |
| 2 | 租户层级 | **两层：`org → agents`** | 不做 project 层；`labels.tenant` 记 org，`labels.agent` 记 agent |
| 3 | A2A | **按规范正常实现**：不自定义扩展、不追草案新特性 | v1 五法：card / `message/send` / `message/stream` / `tasks/get` / `tasks/cancel`；pushNotification 后置 |
| 4 | PG | **评测与线上独立 database**（同一实例即可，两个 DSN） | 权限边界、备份粒度、迁移解耦；跑崩的评测不污染线上表 |
| 5 | 一键部署 | **Docker**：`deploy/Dockerfile` + compose（app + postgres） | 不做 helm / operator |
| 6 | RSI 触发 | **最成熟方案**：CLI + cron / systemd timer + `rsi --watch` | 不做入队 API；web 完全只读（D9 已改） |
| 7 | OpenAI 兼容 | **做**，进 S1 | `routes.ts` 第一天就有两条外部标准契约（A2A + OpenAI），形状不会再返工 |
| 8 | 框架 | **Fastify** | `reply.hijack()` 挂引擎路由（D11） |
| 9 | 意图层 | **superagent 思路：router agent + A2A 派发**（D12） | 单意图 → 单 agent；不做 fan-out；能力目录唯一来源是 agent-card |

---

## 12. 开工第一步（S1 骨架）

1. 建仓：`npm init` + `tsconfig` + biome（strict / lint 口味对齐 agentia）
2. `src/server/app.ts`：Fastify 实例 + 统一错误形状 + 日志，**不挂任何业务路由**
3. `src/server/routes.ts`：先只有两条 —— `/.well-known/agent-card.json`、`/readyz`
4. `src/server/engine-mount.ts`：`onRequest` 钩子里做路径归属判定 → `reply.hijack()` → `createHttpHandler(req, reply.raw)`（**不要用 `all('/*')`**，见 §13）
5. 先跑通验收 1 / 18 / 21（card 可发现、单入口、无重复写响应）
6. 再接 `POST /a2a`（`message/send` 先、`message/stream` 后）与 `/v1/chat/completions`

其余一切（鉴权、租户、评测租户、部署产物）都等第 4 步证明「挂载不打架」再动——**如果 hijack 与引擎 SSE 有冲突，整个 D11 要重选**，那是最该先验的一件事。

---

## 13. 挂载验证记录（2026-11-28 spike，已跑）

环境：`/tmp/spike-hijack`，`fastify@5.12.8` + 从 registry 装的 `@migor/agentia@0.10.16`（真包，非本地源码）。假 Anthropic 端点回整份 JSON，真引擎跑真 run。

| 实验 | 结果 |
|---|---|
| `all('/*')` + hijack，GET `/healthz` | 200 ✅ |
| `all('/*')` + hijack，**POST `/tasks`** | **挂住不返回**（2.5s 超时）❌ |
| `onRequest` + 路径白名单，POST `/tasks` | 202 + `taskId` ✅ |
| 同上，POST `/run` | 200，`finalText` 来自假模型 ✅ |
| 同上，GET `/tasks/:id/stream` | 200，`text/event-stream`，**无 content-length**，首帧 **3ms**，单次读到 4434 字节 ✅ |
| 同上，GET `/healthz` | 200 ✅ |

跑通的最小挂载（可直接抄）：

```ts
const ENGINE = ['/run', '/tasks', '/healthz', '/metrics'];
const owns = (url: string) => {
  const p = url.split('?')[0];
  return ENGINE.some((x) => p === x || p.startsWith(`${x}/`));
};

app.addHook('onRequest', (req, reply, done) => {
  if (!owns(req.url)) return done();
  reply.hijack();
  engine(req.raw, reply.raw);      // 之后不再调 done()，也不碰 reply
});
```

结论三条：

1. **hijack 与引擎 SSE 不冲突，D11 成立**——不需要换框架，也不需要给引擎加扩展点。
2. **挂载点必须是 `onRequest`**。Fastify 在 handler 之前已把 body 读完，`all('/*')` 里的 hijack 太晚；POST 表现为**静默挂住**：无异常、无日志、连接不动。
3. 易错点：`/tasks/:id/events` 是 **POST**（向任务投事件），SSE 在 `/tasks/:id/stream`（GET）。用错会拿到 405「方法 GET 不被允许，请用 POST」。

未覆盖一项（留给 S1 真实现时验）：**对已终态任务重放**的 `/stream`。假 app 不产生 trace 事件时该流不出任何帧，纯 `node:http` 挂载同样如此——与 Fastify 无关，是假 app 的产物。

---

## 14. 落地与验证记录（2026-11-28，`agentia-service` 首个可部署版本）

S1–S10 已按 §9 的顺序做完，判据逐条跑过。下面只记**结论与偏差**，不重复 §7 的表。

### 14.1 判据执行结果

| 来源 | 判据 | 怎么验的 | 结果 |
|---|---|---|---|
| `tests/auth.test.ts` | 4 / 5 | 裸 socket 只发头（声明 100MB）不打 body | **12ms 回 401**（本机）/ **12ms**（NAS 真部署），四个入口一致 |
| `tests/auth.test.ts` | 6 / 7 | 越权 vs 不存在同码同模板；ES256 签发/过期/换 aud/`alg:none` | ✅ 4 种绕过全拒 |
| `tests/server.test.ts` | 1 / 18 / 21 / 22 | healthz 读数、404 JSON、两处 card、`POST /tasks` 计时 | ✅ 202（几十毫秒级，未挂住） |
| `tests/a2a.test.ts` | 2 / 3 / 19 / 30 | 直连 send、同 context 新 task、get/cancel、四类错误码、SSE 帧序 | ✅ |
| `tests/a2a.test.ts` | 审批 | 挂起 → 同 taskId 批准 → 完成；**拒绝后 trace 里 `tool.output.ok` 数不变** | ✅ 拒绝路径靠 trace 验，不看模型说了什么 |
| `tests/intent.test.ts` | 23–26 / 28 / 29 / 31 / 32 / 33 | 见文件内注释 | ✅ 全绿 |
| `tests/openai.test.ts` | — | models / 非流式 / 流式 / system 前置 | ✅ |
| `tests/shutdown.test.ts` | 11 | 真进程 + SIGTERM + 在飞 run | ✅ 在飞跑到 `succeeded`，exit 0 |
| `tests/server.test.ts` | 12 | `markDraining()` 后 /readyz 503、/healthz 200 | ✅ |
| `tests/config.test.ts` | 14 | 塞 `when`/`steps`/`retry` | ✅ 加载期报错 |
| — | 13 / 15 / 16 / 17 / 20 / 27 | 属 harness 侧 | 见 §14.4 |

合计：service **56 个用例**（`npm run check` 全绿），harness **389 个用例**（全绿）。

### 14.2 真部署（NAS + 真 PG）

环境：UGreen NAS，`postgres:17.6`（host 网络 55432），容器 `network_mode: host`，
`node:22-alpine` 两阶段构建，非 root 运行。

最终形态是**用仓库里提交的 `deploy/Dockerfile` + `deploy/service.docker.json` 构建**的
（不是另写的部署变体）：宿主上 37 个文件上传 → Compose 项目 `agentia-service` → 构建 →
`PORT=18080` 起在 host 网络。中途用压缩包变体先跑通（见 §14.3 第 6、8 条），
之后换回提交版重新构建并复验了一遍，结论相同。

| 项 | 证据 |
|---|---|
| 启动 | `agents:["report","billing"] defaultAgent:"report" intent:true durable:true` |
| PG 落库 | 重启后 `tasks/get` 仍返回 `completed`（任务在库里，不在内存） |
| 审批 | `input-required` + `pendingApprovals:["tu_mock_2"]` → 同 taskId `completed` |
| 意图入口 | `list_capabilities → dispatch → 汇总`，返回 `"status":"done","agentId":"report"` |
| OpenAI | `chat.completion` / `model:"billing"` |
| SIGTERM | `收到信号` → 5.0s → `引擎已排空 drained:true` → 容器重启，无孤儿任务 |
| 鉴权先于 body | 四个入口均 **12ms / 401** |

### 14.3 落地时发现的偏差（都已修，且都值得记住）

1. **`providers` 不收裸类**：`providers: [BillingTools]` 直接类型错，必须
   `{ provide: 'billing-tools', useClass: BillingTools }`。
2. **`@Tool` 的 schema 在类定义阶段求值** ⇒ 需要构造参数的工具只能用**工厂闭包**
   （`createDispatchTools(deps)`）。副作用是顺带解决了「工具怎么知道自己属于哪个
   context」——`@Tool` 拿不到 `ToolRunContext`，闭包是唯一可靠通道。
3. **`blocking: true` 会死锁**：`dispatch` 若用阻塞模式，就排在自己占的
   `queue.run(contextId)` 里等子 agent —— 而子 agent 的同 context 请求也要那把锁。
   改成 `blocking:false` + 自轮询之后，「预算内主动降级成 `accepted`」才真正成立
   （原来的实现会撞工具超时，连 taskId 都丢掉）。
4. **`sessionId` 不在 `CLIENT_RUN_OPTION_KEYS` 白名单**：A2A 多轮**不能**绕 HTTP 传
   sessionId，必须在进程内直接 `runner.submit`（`options.sessionId`）。
5. **关掉假端点必须把 env 指回来**：同进程起第二个服务会覆盖
   `ANTHROPIC_BASE_URL`，关掉后 env 指向死端口，**先前那个服务**的后续 run 全部失败
   —— 报错落在无辜的服务上。
6. **镜像里 `COPY` 的文件要保持可读**：非 root 用户 + 上传工具留下的 0600 ⇒
   `EACCES: open './service.json'` 无限重启。`COPY --chmod=0644` 是必须的，不是洁癖。
7. **`/tasks` 的提交体是 `{ input, idempotencyKey?, options? }`**，不是裸 `{prompt}`；
   裸体会回 400「无法识别为任务输入: undefined」。
8. **端口必须能来自 `PORT`**：`server.port` 原来只收数字，于是同一个镜像在同一台宿主上
   换端口只能改配置文件（配置与镜像不一致）。现在 `"port": "${env:PORT}"` 也收 —
   容器编排里 `PORT` 是事实标准，写死会在这个最容易被踩的地方绊人（实测踩到了
   `EADDRINUSE 0.0.0.0:8080`：宿主上另有一个服务占着 8080）。

### 14.4 已知缺口（明确没做，别当成做了）

- **判据 27 的评测数据面没接**：`routeAccuracy` 的契约（`EvalCase.route` /
  `CaseResult.expectRoute` / `routedTo` / `EvalReport.routeAccuracy`）与采纳判据
  （`isWorthAccepting` 里「路由掉了就不采纳」）都已落地并有测试，但**还没有一个
  service-backed runner 去填 `routedTo`** —— 今天的 harness 直接跑 agent，不经过 A2A。
  所以真实报告里这个读数会缺席（缺席 = 不做判断，不会误判）。
- **判据 13/15/16/17/20** 属 harness 的 web/worker 面，不在本轮范围。
- **`tasks/get` 的 `contextId` 仍是占位**（`unknown#<agentId>`）：引擎的 `TaskRecord`
  不存这个协议概念。修法已写在 `docs/decisions.md`（在 `intent_session` 加反向索引）。
- **`message/stream` 是 250ms 轮询**，不是逐字增量。要逐字就接引擎的 increment 事件出口。
