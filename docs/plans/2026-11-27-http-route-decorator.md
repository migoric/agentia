# 2026-11-27 HTTP 路由装饰器：`@Controller` 只做分组，不做 MVC

> 状态：**评估，未实现**。本文只回答「该不该做、做成什么形状、动了谁会红」。
> 实现留待单独决定；本文的结论可以直接当作实现依据，也可以当作不做的理由。

## 0. 定案

1. **做 «具名任务入口»**：`@Route({ path, ... })` 声明一条路径固定触发一次 run。
2. **做 `@Controller`，但只做它的一半**：类级**路径前缀 + 类级缺省配置**（`model` / `tools` /
   `system`），方法级 `@Route` 覆盖。**不做**参数装饰器（`@Body` / `@Param`）、**不做**动词
   装饰器（`@Get` / `@Post`）—— 前者在 Stage 3 下不存在，后者与「一次 run」语义冲突（§4.3）。
3. **不做 «通用业务路由»**（方法体自己写 handler）。`@Controller` 的方法体仍然**不执行**。
4. **不做 «能力直暴露»**（`POST /tools/<name>` 直接调能力）。
5. 装饰器住 `toolkit/`，路由 spec 类型住 `core/`，装配期收集、装配期校验，运行期只读。
6. 「路径自带配置」与「引用已有能力」两种挂法都支持 —— 但**引用有边界**：只能引用
   `@SubAgent` / `@Skill`，引用 `@Tool` / `@Prompt` 在装配期直接抛错（§4.2 是本文最重要的
   一节，也是 §0.6 的收窄说明）。
6. v1 只做**精确路径 + 同步 + 走鉴权**，不做路径参数、异步任务、免鉴权豁免（§8）。

## 1. 现状（实测，不是推测）

| 事实 | 位置 | 说明 |
|---|---|---|
| 路由判定是纯函数 | `src/transport/http-route.ts:69` | `(pathname, method, hasMetrics) → HttpRoute`，不碰 req/res |
| 顺序是「这个文件的全部内容」 | `src/transport/http-route.ts:8-25` | 三条踩过的坑，头注写明「改任何一条都是行为变更」 |
| `transport` 的依赖白名单 | `tests/architecture/layering.test.ts:45` | `['core','engine','store']` —— **不许依赖 toolkit** |
| transport 认的应用结构面 | `src/transport/async.ts:257-263` | 只有 `name` + `run(messages, opts)` |
| 四类装饰器的注册方式 | `src/toolkit/tool.ts:43` 等 | 各自 `WeakMap<Function, Spec>`，零反射 |
| **类装饰器先例：0 个** | `grep "kind === 'class'" src/ tests/` 零结果 | 四类能力全是方法级；`@Controller` 会是第一个 |
| 标准装饰器、无 legacy 开关 | `tsconfig.json` 无 `experimentalDecorators`；`typescript@7.0.2` | **参数装饰器语法不存在**，这是 §2 第 5 点的硬依据 |
| 收集器沿原型链扫描 | `src/toolkit/collect.ts:29` | 四个 `collect*` 共用这一份实现 |
| `@SubAgent` 方法体不执行 | `src/toolkit/subagent.ts:68` | 「运行时拉起独立循环」—— 这是 B 与 A 的分界线原型 |
| HTTP 只产 handler、不 listen | `src/transport/http.ts:15` | 明确「可挂进任意 Node HTTP 框架」 |
| 鉴权判据是否定式 | `src/transport/http.ts:366` | 「不是免鉴权组才过闸」，豁免名单只有 `isPreAuthRoute` 一份 |
| 当前公共导出面 | `packages/website/src/fragments/api.html:29` | **269** 个 |
| 路由测试规模 | `tests/transport/http-route.test.ts` | 202 行 / 17 条 |
| 方法级体量闸 | `tests/architecture/method-size.test.ts:71` | 单可调用体 ≤ **260** 行；`http-route.ts` 现 111 行 |
| roadmap 无此项 | `docs/roadmap.md:185`（R7） | 剩余候选只有「中间件二次评估」「Workers playground」 |

结论前提：这不是补债，是**新产品面**。新增的是公共导出、spec 章节、与一条新的路由分支。

## 2. 为什么不做 «通用业务路由»

不是「工作量大」，是**它会拆掉已有的四条不变量**。

1. **与宿主无关的定位冲突**。`http.ts:15` 的设计目标是「只产 handler」：用户要什么框架自己套。
   内建 MVC 等于让 agentia 同时当 web 框架，与 Hono / Express / Fastify 正面竞争，而这些
   框架在中间件生态、静态资源、multipart、压缩上已经做了十年。
2. **鉴权语义必须开洞**。现在是「`/healthz`、`/metrics` 之外一律先鉴权」（`http.ts:366`）。
   一旦有任意用户 handler，就得回答「用户的路由要不要鉴权」；答「要」则静态页、探针都得带
   token，答「不要」则要引入第二份豁免名单 —— 与 `isPreAuthRoute` 打架，而那份头注刚说过
   顺序问题踩过三次坑。
3. **`drain()` 的范围要重定义**。`drain()` 现在等在飞同步 run + 异步任务，超时后强制收口 SSE。
   用户 handler 算不算「在飞」？如果算，框架要监控任意 Promise 的生命周期；如果不算，优雅停机
   会在用户 handler 跑到一半时切断。
4. **更好的解法已经存在且零成本**：外层套一层 Hono，把 `createHttpHandler(app)` 当一个
   handler 挂上，用户路由与框架路由并存，鉴权仍由宿主决定。文档 `examples/deploy/` 已经是
   这个形态。
5. **Stage 3 装饰器根本没有参数装饰器**。NestJS 的 controller 体验有一半来自
   `@Post('/x') foo(@Body() dto: Dto)` 这一行 —— `@Body` / `@Param` / `@Query` 是
   `experimentalDecorators` 时代的产物，Stage 3 提案里已被移除（TS 7.0.2 未开 legacy 开关，
   见 §1 实测）。agentia 若要照搬，只能得到一个**没有参数注入的 controller**：用户仍需手写
   `parseBody` / 逐个取字段 / 自己 validate，而这正是装饰器本来要省掉的事。**残缺的 NestJS
   比没有更糟** —— 用户会按 NestJS 的直觉写，然后在运行期发现参数全是 `undefined`。
6. **动词装饰器与「一次 run」语义冲突**。run 有 body、有副作用、有预算与 trace —— 它恒为
   `POST`。给它配 `@Get` 只会诱导用户写查询端点，而「查一次 run 的结果」在框架里已经有
   `GET /tasks/<id>`，不需要第二条语义相同的路。

一句话：**A 的收益是「少装一个依赖」，代价是把框架的语义边界让给用户去猜。**

## 3. 为什么不做 «能力直暴露»

1. **旁路掉核心卖点**。spec §2/§3 的定义是「主 agent 作为路由器，自主决定调哪些能力」。
   `POST /tools/x` 让调用方指定能力 = 把 router 换成 caller。
2. **返回值形态不匹配**。`@Tool` 的产物是 `tool_result`（值或 `is_error`），不是 HTTP 响应体。
   直接暴露要把 `is_error` 翻译成状态码，而 tool 的失败语义（模型可自我修正）与 HTTP 的失败
   语义（调用方可重试）不是一回事。
3. **审批与预算无处安放**。`@Tool({ approval: 'required' })` 的挂起/恢复是围绕 run 设计的
   （`TaskRecord` + `suspendedMessages`）；裸调能力没有 run 边界，审批就成了无主之物。
4. 真想做，用户在 `@Tool` 外面包一层自己的 fetch handler 更可控，且不污染框架语义。

## 4. 设计（B：具名任务入口）

### 4.1 表面

```ts
// 形态一：@Controller 分组（路径前缀 + 类级缺省）
@Controller({
  prefix: '/v1',
  model: 'claude-opus-5',
  tools: ['repo-tools'], // 类级缺省；方法级 tools 整体覆盖（不是深合并）
})
export class TriageController {
  @Route({
    path: '/triage', // 实际路径 /v1/triage
    description: '给一个 issue 分诊',
    schema: { type: 'object', properties: { issue: { type: 'string' } }, required: ['issue'] },
    system: '你是仓库分诊员……',
  })
  triage() {} // 方法体**从不执行**（与 @SubAgent 同构）

  @Route({ path: '/classify', schema: { … }, system: '…' })
  classify() {} // /v1/classify

  @Route({ path: '/logo', capability: 'regenerate-logo' })
  regenerate() {} // /v1/logo，引用已有能力
}

// 形态二：单条路径，不需要分组时不用 @Controller
export class OpsModule {
  @Route({ path: '/health-report', schema: { … }, system: '…' })
  report() {}
}
```

合并规则（三条，都要在装配期校验）：

- **`prefix` 只许出现在 `@Controller` 上**，`@Route.path` 不许再带前缀 —— 两处都能拼前缀会让
  「这条路径到底是什么」需要心算。
- **类级 `model` / `tools` / `system` 是缺省，方法级整体覆盖**，不做深合并。理由是 `tools: []`
  本身是合法语义（一个能力都不挂），深合并会让「我要清空」表达不出来。
- **`prefix` 必须 `/` 开头、不许 `/` 结尾、不许含 `:`**（v1 无路径参数，见 §8）。

**方法体不执行，这不是实现细节，是定义。** 与 `subagent.ts:68` 同一个理由：运行时拉起的是
一次 run，不是调用作者写的方法。这条不成立，`@Route` 就退化成了 §2 的 A，只是换了语法糖。
装饰器实现要显式拒绝「方法体里有副作用」这个期待 —— 文档与报错文案都要说清。

⚠️ **`@Controller` 这个名字的代价要正视**：它在 NestJS 里就是「写 handler 的地方」，而这里
方法体不执行。这是本文最容易被误读的一处。两条缓解措施缺一不可：`usage-guide` 的
`@Controller` 一节**第一句**就写「声明容器，方法体不执行」；`@Route` 首次装配时若检测到
「类里有被装饰方法以外的方法」，不报错但记一条 `console.warn`（不能靠 `toString()` 判断方法体
是否为空 —— 打包压缩后不可靠，只能是提醒）。

### 4.2 引用已有能力的语义分档（本文最重要的一节）

「两种挂法都支持」不等于「什么都能引用」。按被引用能力的运行时本质来分档：

| 被引用 | 一次 run 的要素齐不齐 | 结论 |
|---|---|---|
| `@SubAgent` | 完整独立循环 + `schema` + `system` + `tools` —— 正好是一次 run 的全部要素 | **最干净**，推荐形态 |
| `@Skill` | 受限子运行（`runAgentScoped`），有 `schema`，但没有主 agent 的路由层 | **可做**，语义是「跑一个 skill」而不是「跑一次主 run」，要在响应里说清 |
| `@Tool` | 有 JSON schema，但返回值是 `tool_result`，没有 system / tools | **不允许** —— 会退化成 §3 的 C |
| `@Prompt` | 无入参、纯文本资产 | **不允许** —— 没有可校验的入口 |

**装配期必须按 kind 校验并抛错**，文案要点明原因，而不只是「不支持」：

```
@Route 不能引用 @Tool 能力 "search_issue"：端点会把能力直调旁路掉主 agent（见 plans/2026-11-27 §3）。
可引用：@SubAgent / @Skill。要暴露工具，请在自己的 HTTP 宿主里包一层。
```

这条校验是「两种都支持」能否成立的关键：没有它，`@Route({ capability })` 在 `@Tool` 上
会给出一个能跑但语义可疑的端点，而这类「能跑但语义可疑」正是本仓库 §1.2「静默失效」清单
里最贵的一类。

### 4.3 分层与路由表位置

分层约束是硬的（`layering.test.ts:45`）：

```
core ← engine ← {runtime, store} ← transport
core ← engine ← runtime ← toolkit
```

`transport` 不依赖 `toolkit`，而装饰器注册表在 `toolkit`。三条边都不能加，所以：

| 件 | 住哪 | 理由 |
|---|---|---|
| `RouteSpec` / `ControllerSpec` 类型 | `src/core/route-spec.ts` | core 是叶子，transport 与 toolkit 都能依赖；纯类型 + 纯校验函数，无 IO |
| `@Route` / `@Controller` 装饰器 | `src/toolkit/route.ts` | 与四类能力同目录，方法级复用 `collect.ts` 的 `scanDecoratedMethods` / `assertMethodTarget` |
| 收集与校验 | `AgentApp` 构造期（`src/toolkit/module.ts:274`） | 与菜单收集同一条路径，同一时机报错 |
| 路由判定 | `src/transport/http-route.ts` | 保持纯函数，只多一个入参与一个 `kind` |

**`@Controller` 是这个仓库的第一个类装饰器 —— 实测现在 0 个**（`grep "kind === 'class'"`
在 `src/` 与 `tests/` 零结果；四类能力全是方法级）。这带来两件 `collect.ts` 现在不覆盖的事：

1. **类级 spec 的 registry**：`WeakMap<Function, ControllerSpec>`，key 是**构造函数**。
   收集时不能只看 `instance.constructor` —— 子类继承父类的 `@Controller` 时，子类构造函数不在
   表里。要沿原型链找，这与 `scanDecoratedMethods` 的 override 语义同源（`collect.ts:29` 已经
   处理过「未装饰的 override 不挡父类」），可以复用同一套规则。
2. **`assertMethodTarget` 的对偶**：现在只接 `context.kind === 'method'` 并拒绝静态方法。
   类装饰器需要 `assertClassTarget`（拒 `kind !== 'class'`），同时**拒绝把 `@Controller` 挂在
   方法上、把 `@Route` 挂在类上** —— 这两种错配如果只靠 TS 类型，用户用 `as any` 就绕过了，
   而表现是「路由静默消失」。

路由表怎么交给宿主：**`AgentApp` 暴露只读 `routes`，`createHttpHandler` 缺省从 app 读，
`opts.routes` 可覆盖。**

`AppCallable`（`async.ts:257`）加一个可选字段 `routes?: readonly RouteSpec[]` 即可 ——
这是**结构面**而非层依赖，toolkit 不需要 import transport，`AgentApp` 结构上满足它。
好处是 `main.ts` 一行不改（升级即得），高级用户仍能覆盖。

为什么不要求用户手动传：`createHttpHandler(app, { routes })` 会让「忘了传」的表现变成
「路由 404」，而 404 与「没声明」无法区分。

### 4.4 `routeRequest` 的变化与顺序

签名从 `(pathname, method, hasMetrics)` 变成：

```ts
routeRequest(pathname, method, opts: { hasMetrics: boolean; routes: readonly RouteSpec[] })
```

返回值新增一个分支（`HttpRoute` 是 transport 内部类型，未进公共面，改名不破坏使用者）：

```ts
| { kind: 'custom'; route: RouteSpec }
```

**顺序：固定端点在先，用户路由在后。** 理由与现有头注同源 —— `/run`、`/tasks`、`/healthz`、
`/metrics` 是框架语义，不允许被用户的同名路径覆盖。

而且这不该靠运行期顺序解决，要靠**装配期拒绝**：`path` 命中保留集
（`/run`、`/tasks`、`/healthz`、`/metrics`、以及 `/tasks/` 前缀）时，构造期抛错。运行期才发现
的表现是「我的 `/run` 请求跑到了别的地方」，与「顺序写错了」无法区分。

`http-route.ts:8-25` 的头注必须增加第四条：**用户路由段永远在固定端点之后**。不写这一条，
下一个人会在它前面插一条 `if`。

### 4.5 鉴权

自定义路由**默认走鉴权**，与 `/run` 同一档。判据不用改：`http.ts:366` 是「非免鉴权组一律过闸」，
用户路由天然不是免鉴权组。

v1 **不提供豁免开关**。要公开端点，用户在外层宿主里挂 —— 这与「框架只给缝，策略是宿主的事」
（`http.ts:24-26`）一致。提供一个 `public: true` 会让鉴权面出现第二个真源，而 `isPreAuthRoute`
那份头注已经写明它是唯一的豁免名单。

### 4.6 同步 / 异步 / SSE

| 项 | v1 | 理由 |
|---|---|---|
| 同步 | 做 | 复用 `/run` 的整条路径：body 上限、在飞计数、`drain()`、错误口径全都不用重定义 |
| 异步 | 不做 | 要重定义 `TaskSubmitBody` 的 options 白名单、store 的 `spec` 投影、`resumePending` 的归属 —— 每一条都是独立的语义决策，不该塞进第一版 |
| SSE | 做 | `POST /run` 已支持 `Accept: text/event-stream`，复用 `sseWriter` 即可。砍掉会制造「同一个 run 在两条路径上行为不同」 |

异步留 v2 是**范围限制，不是遗漏** —— 这一点要在 usage-guide 里写明，否则用户会以为
「换条路径就不能异步了」是 bug。

### 4.7 响应形状

复用 `RunHttpResponse`（`src/transport/http-shapes.ts`）。不新增形状。

这是「换宿主不换语义」的落点：某个任务是走 `/run` 还是走 `/triage`，返回体的字段必须一致，
否则客户端要写两套解析。

## 5. 影响现有守卫（逐条）

| 守卫 | 会怎样 | 动作 |
|---|---|---|
| `tests/architecture/layering.test.ts:45` | 新文件住 core / toolkit，不新增边 | **不改表**；若实现时发现必须加边，说明设计错了，回头改设计而不是改表 |
| `tests/transport/http-route.test.ts`（17 条） | `routeRequest` 第三参数从 `boolean` 变对象 | 17 条调用点全改；新增断言：用户路由在固定端点之后、保留路径装配期抛、`custom` 分支命中 |
| `tests/architecture/method-size.test.ts:71` | `routeRequest` 现约 40 行，加动态匹配后仍在 260 内 | 不改阈值；若逼近则拆 `http-route-custom.ts` |
| `packages/website/src/fragments/api.html:29` | 269 → 269 + N（预计 4：`Controller`、`Route`、`RouteSpec`、`ControllerSpec`） | 每个新导出登记 + 改计数 |
| `docs/guards.md` §1.1（形状） | 新增公共类型 | 登记一行，说明保护的是「spec 与运行时表同源」 |
| `docs/spec.md` §3 | 「四个装饰目标」→ 五个 | §3 表格加一行、§4 加示例、§10 加决策条（带 slug） |
| `docs/spec.md` §6 | 触发三类不变，但「同步请求」多了一个实现面 | 补一句 `/run` 是通用入口、`@Route` 是具名入口 |
| `docs/circle-refs` 守卫 | 注释里出现 `ref-xxx` 必须在 §10 有锚点 | 写注释时先建锚点再引用 |
| `tests/architecture/single-source-messages.test.ts` | 新增报错文案若重复两处会被点名 | 报错只在 `core/route-spec.ts` 写一份 |
| `tests/architecture/no-legacy-decorator-metadata.test.ts` | **不受影响**：类装饰器不用 `Symbol.metadata`，spec 存 `WeakMap` | 不改；但**别顺手引入 metadata** —— 那是另一个决策，会动「零反射」这条对外承诺 |
| `tests/architecture/toolkit-map.test.ts` | 守「toolkit 新增文件必须在 `AGENTS.md` 露名，或进 `CONCEPT_ONLY` 显式豁免」 | 新增的 `toolkit/route.ts` 必须表态：要么在 AGENTS.md 目录树写文件名，要么进豁免表并说明被哪个概念短语覆盖 |
| `packages/website` 首屏 hero-stats | 写着 `4 类能力` / `0` 反射 | 两类都不变（`@Controller` 不是能力，也不引入反射），但要跑一遍 api-page 的数字推导守卫确认 |

**顺带一条风险**：`http-endpoints.ts` 新增 `custom` 分支时，很容易复制一段 `run` 的编排
（读 body → 跑 run → 写响应）。这正是 0.10.15 那个 bug 的形状（同一语义两份拷贝）。实现的
时候要么抽出共用函数，要么让 `custom` 分支**复用同一个编排函数**、只替换入参来源。

## 6. 成本实算

| 项 | 量 |
|---|---|
| 新增 `src/core/route-spec.ts` | 约 80 行（`RouteSpec` / `ControllerSpec` + 路径校验 + 保留集 + 前缀合并规则） |
| 新增 `src/toolkit/route.ts` | 约 140 行（两个装饰器 + 方法级收集 + 类级收集 + kind 校验 + 错配拒绝） |
| 改 `src/transport/http-route.ts` | 111 → 约 150 行 |
| 改 `src/transport/http-endpoints.ts` | +约 40 行（`custom` 分支） |
| 改 `src/toolkit/module.ts` | +约 30 行（`AgentApp.routes` 收集） |
| 改 `src/transport/async.ts` | +3 行（`AppCallable.routes?`） |
| 改 `src/index.ts` | +N 个导出 |
| 测试 | `tests/toolkit/route.test.ts` 约 18 条（含类装饰器 6 条）；`http-route.test.ts` 改 17 条 + 新增 6 条；`tests/transport/http-custom-route.test.ts` 约 8 条 |
| 文档 | spec §3/§4/§6/§10、usage-guide 一节、api.html、guards.md、CHANGELOG |

**没有一项是「改一行就行」**，所以这不是 patch 版本的量。按仓库节奏，它够一个 minor。

## 7. 验证清单（实现时逐条可复现）

1. 装配期：`@Route` 的 `path` 命中 `/run` → 抛错，错误文案点名保留路径。
2. 装配期：两条 `@Route` 落在**同一个最终 path**（含前缀合并后）→ 抛错，文案给两条声明的位置。
3. 装配期：`@Route({ capability: '<@Tool 名>' })` → 抛错，文案说明会旁路主 agent。
4. 装配期：`@Route({ capability: '<不存在>' })` → 抛错，列出可用名单。
5. 装配期：`@Route({ capability: '<@SubAgent 名>' })` → 通过，且该路径跑出的 run 用 subagent 的 spec。
6. 运行期：`POST /triage` 返回体字段与 `POST /run` **逐字段相同**（同一个 `RunHttpResponse`）。
7. 运行期：未带 token 的 `POST /triage` → 401，**且 body 一个字节都不读**（与 `/run` 同档）。
8. 运行期：`GET /triage`（方法不符）→ 405 + `Allow: POST`，不是 404。
9. 运行期：`POST /triage` 时 handler 处于 drain 中 → 503 + `Retry-After`（与 `/run` 同款）。
10. 运行期：`Accept: text/event-stream` → SSE 帧序列与 `/run` 一致，`run.end` 形状相同。
11. 装配期：`@Controller({ prefix: '/v1' })` + `@Route({ path: '/triage' })` → 实际匹配 `/v1/triage`。
12. 装配期：`prefix: '/v1/'`（尾斜杠）或 `prefix: 'v1'`（无前导斜杠）→ 抛错，文案给出正确写法。
13. 装配期：类级 `tools: ['a']` + 方法级 `tools: ['b']` → 结果是 `['b']`（**覆盖**，不是 `['a','b']`）。
14. 装配期：类级 `tools: ['a']` + 方法级 `tools: []` → 结果是 `[]`（能表达「清空」）。
15. 装配期：`@Controller` 挂在方法上 / `@Route` 挂在类上 → 抛错，不是静默跳过。
16. 装配期：子类不加 `@Controller` 继承父类的 `@Controller` → 前缀沿用父类；子类加自己的 → 覆盖。
17. 守卫：移除「用户路由在固定端点之后」这一条 → 恰好「用户声明 `/run`」那条红。
18. 守卫：把 `custom` 分支改成复制一份 run 编排 → `single-source-messages` 或新增的重复检测红。

第 17、18 条是变异验证，不是功能测试 —— 按本仓库纪律，改完要还原并核对 `sha256`。

## 8. 边界（明确不做，且要写进文档）

| 不做 | 理由 |
|---|---|
| 路径参数 `/triage/:id` | 任务入参本来就在 body 里。路径参数是 REST 资源语义，硬套在「一次 run」上会制造「id 与 body 里的字段是什么关系」的歧义 |
| 异步任务 `/triage` → 202 + taskId | 见 §4.6，需要独立一轮语义决策 |
| 免鉴权豁免（`public: true`） | 见 §4.5，会让豁免名单出现第二个真源 |
| 方法体执行（写成 handler） | 这是定义，不是边界：执行了就不是 `@Route`，而是 §2 的通用 MVC |
| **参数装饰器** `@Body` / `@Param` / `@Query` | **Stage 3 没有这个语法**（§2 第 5 点）。不是选择不做，是做不了 —— 要它必须先开 `experimentalDecorators`，而那与 spec §4 的已定决策正面冲突 |
| **动词装饰器** `@Get` / `@Put` / `@Delete` | run 恒为 `POST`（§2 第 6 点）。`method` 字段也不留 —— 留一个只能填一个值的字段是给未来挖坑 |
| 中间件 / pipes / interceptors / 守卫链 | 那是 §2 的 A 全套，`@Controller` 刻意只做「前缀 + 类级缺省」 |

## 9. 未决（留给决定实现时回答）

1. **路由表要不要进 `agentia manifest`**（`src/toolkit/manifest.ts`）？倾向**要** ——
   manifest 是「这个服务暴露什么」的机器可读契约，路由是暴露面的一部分。但 manifest 现在
   只描述能力（`CapabilityManifestEntry`），加路由会改变它的语义边界，需要单独定。
2. **同一个能力挂多条路径**算不算错？倾向算（`/triage` 与 `/classify` 指向同一个 subagent
   会让「哪条路径被用了」在 trace 里无法区分），但如果要支持，得在 trace 根属性里记 `route`。
3. **`@Route` 要不要参与版本锁**（`harness` 那套 `harness.lock.json` 是下游概念，本仓没有）？
   本仓不涉及，记一笔防止将来混淆。
4. **路径匹配大小写**：现在固定端点全小写精确比。`/Triage` 该不该匹配？倾向不匹配
   （与固定端点同口径），写进守卫。
