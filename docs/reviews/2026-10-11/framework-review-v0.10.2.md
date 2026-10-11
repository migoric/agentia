# Agentia 框架 review（v0.10.2 之后）—— 体检 / 边界 / 单测 / 趋势 / 延伸方向

- **基线**：`main` = `cc9a9f4`（v0.10.2 发版提交）。本文写于 2026-10-11 深夜 ~ 10-12 凌晨。
- **本文重心 = agentia 本体**：§1 规模与单测 → §2 边界 → §3 门禁射程 → §4 趋势对拍 →
  §5 可观测深钻 → §6 ROI 建议 → §7 没核实的。
- **附录 A 是 OTel GenAI semconv 回源核** —— 它只是本次 review 的**触发源**（「文档里的基准版本」
  这条断言过期了，顺手回源核了一遍），**不是 review 的目标，可以直接跳过**。
- **落库状态**（读本文前先看这条，别把「工作区」当「已入库」）：semconv 那条核心处置
  （`src/integrations/otlp.ts` 头注 + `docs/{observability,roadmap,usage-guide,spec}.md`）已入库
  **`dd33d02`**（分支 `fix/otlp-genai-baseline`）；而附录 A.6 的 **4 条二级订正**与**本文件本身**
  在写本文时仍在**工作区未提交**。
- **口径**：本文所有数字都是**当场现查**的；凡「静态 grep 计数」都标了口径，未标注的是一次真实读数。
- **一句话结论**：**工程质量与可观测是已兑现的强项，不是瓶颈**。真正跟生态对不上的地方只有三处，
  且都很具体（**工具 span 模型**、**MCP/A2A 协议面**、**semconv 基线**——后者已在附录 A 处置）。
  **可观测值得深钻 —— 但方向是「协议对齐 + 配方 + CLI 面」，不是「再加一个子系统」。**

> **本目录口径**：`docs/reviews/<日期>/` 是**快照目录**（见 `docs/reviews/2026-09-28/README.md` §0）——
> 正文记的是**当日读数**，要判「今天还成不成立」，看 `docs/spec.md` §10 的落地条目。

---

## 1. 体检：规模与单测现状（现查）

| 面 | 读数 | 口径 |
|---|---|---|
| `src/` | **111 个 `.ts` / 22,800 行**，9 个目录（core 15 / engine 29 / transport 23 / integrations 15 / toolkit 13 / store 5 / runtime 5 / eval 4 / container 1）+ `index.ts` | 逐文件 `wc -l` 求和（**工作树**，含附录 A.5 的注释订正 ⇒ 比 `cc9a9f4` 多 **2** 行；复算命令见下） |
| `tests/` | **178 个 `.ts` / 45,514 行**，其中 **162 个 `*.test.ts`** | 同上 |
| 用例数 | **1,659**（口径①：行首 `^\s*(it|test)\(`）/ **1,761**（口径②：任意位置 `\b(it|test)\(`） | ⚠️ 静态 grep，**参数化循环会低估**；真值看运行时的 `# pass` |
| 覆盖率（最近一次落盘跑） | `All files` **98.58 语句 / 92.85 分支 / 98.45 函数 / 98.58 行** | `test-all.mjs` 的 c8 汇总表（复算：跑 `npm test`） |
| 覆盖率阈值（棘轮） | 行 **95** / 分支 **89** / 函数 **95**，`--include src/**`，只挂框架套件 | `scripts/test-all.mjs:36-38`（现查） |
| 守卫数 | README 顶部 **90+** —— 由 `tests/docs/scoreboard.test.ts` 每次现算，下限 `GUARDS_FLOOR = 90` | 写「下限」而非精确值，是**刻意**的 |

**§1 两个主读数的复算命令**（数会烂、命令不会）：`find src -name '*.ts' -print0 | xargs -0 wc -l | tail -1` → **22,800**；
`git diff --numstat cc9a9f4 -- src` → **`otlp.ts 8/6`**。⚠️ 行数**别用 `cat <文件> +` 拼接法**：
它对**尾行无换行**的文件会少计（本仓恰有 2 个），本条初稿写的 22,799 就是这么来的。

**覆盖率的时效（如实标注）**：那次跑在 ③（`#executeInner` 重构）的分支提交上，squash 合进主干是
`1539a71`。`git diff --numstat 1539a71..cc9a9f4 -- src` 只有 **1 行**（`src/index.ts` 的版本常量
`0.10.1`→`0.10.2`）⇒ **读数实质仍成立**。⚠️ 本分支 `HEAD`（`dd33d02`）在此之上又改了
`src/integrations/otlp.ts`（`7/6`，**纯注释**）—— 注释不进 c8 射程，读数不变；但**引 diff 要看 HEAD**：
`1539a71..HEAD` 现在**不是** 1 行。我**没有重跑**确认。

**体量闸（两道，形状不同，别合并）**：
- `tests/architecture/source-size.test.ts`：单文件**含代码行**（整行注释与空行不计入）≤ **750**（`MAX_CODE_LINES`）；防真空：`src/**` 文件数 ≥ 60。
- `tests/architecture/method-size.test.ts`：单个可调用体**原始行** ≤ **240**（`MAX_CALLABLE_LINES`）；防真空：可调用数 ≥ 400、最大体 ≥120 行的文件数 ≥ 8。
- 口径选「含代码行」而非「行数」的原因写在 `guards.md`：本仓注释占 29~55%，按行数设闸等于**逼人删注释**。
- ⚠️ 已知盲区（本仓自己登记的）：**「体小、比例高」量不出来** —— 抽件时分子分母同减，比例结构上降不下来（`method-size.test.ts` 头注）。

---

## 2. 边界：本仓自己划的线 vs 实际实现

### 2.1 三处「边界集中地」，都在，且都被守卫盯着

| 位置 | 内容 | 守卫 |
|---|---|---|
| `docs/usage-guide.md` §7（约 **90 行表**） | 「已知边界（如实标注，不要指望框架替你兜）」 | `tests/docs/boundary-table.test.ts`（锚点 + 行数 + pin/choice/gap 三态下限） |
| `docs/guards.md` §1 | 已挂守卫清单，按危险类分 4 张子表 | `tests/docs/guards-registry.test.ts`（**货架完整性**：`tests/architecture` + `tests/docs` 每个测试文件必须在注册表里有行） |
| `docs/spec.md` §9.3 / §9.4 / §10 | 出口决策 + 采样决策 + 追加式决策链（按天编号） | `tests/docs/commit-refs.test.ts`（引用 SHA 必须在主干）、`code-fences.test.ts`（文档围栏代码真编译） |

### 2.2 ⚠️ §7 是一张 90 行的表 —— 本仓最「反直觉」的资产

绝大多数框架的「已知边界」是博客里的一句话。这里是一张**逐条回源核对过**的表 —— `guards.md` §2 记着
2026-09-29 那次：抽样 3 条 gap **3 条全过期**，其中 2 条**写下时就错** ⇒ pin 从 49 回填到 56。
这条纪律本身值得单列：**「边界」也是断言，会用旧。**（同附录 A.4：形状可判、真假不可判。）

### 2.3 `guards.md` §2「待守」当前只剩 **2 行活动缺口**（现查）

| 缺口 | 状态 |
|---|---|
| `transport/approval-supervisor.ts` 两条早返回判据（`rebuild` / `markSuspended` 的 `rec.suspendedReason === undefined`）**无用例钉住** | 活动。夹具造不出「`status==='suspended'` 但无 reason」的记录 ⇒ 走不到那条 return |
| `usage-guide.md` §7 的 **`gap` 三态会过期、且没有守卫盯** | 活动。gap 的判定是「读法」不是「声明」⇒ 机械可判的只有「候选文件存在」与「理由够长」 |

（其余 5 行都是划线行的历史记录 —— §2 是**活的**，进了 §1 才划线。）

### 2.4 三条「缝」的设计（这是定位的落点）

```
TraceSink { export(trace) }         ← 收尾拿整棵，会投递（有兜底）
onTraceEvent(e)                     ← 运行期逐笔，不保证送达
中间件 / 入参包 app.run / 出参包 sinks ← 其余一切策略的缝
```

不变量写死在 §9.3：**把一次 run 的全部事件按 `seq` 折回，必须逐字等于 `snapshot()`**（不丢 / 不重 / 顺序 / 同源，
一条用例钉住）。这条不变量是「两条缝」能并存的前提。

---

## 3. 单测与门禁的射程

| 层 | 内容 |
|---|---|
| **本链（`scripts/verify-all.sh`，8 步）** | ①`typecheck && biome ci` ②`build` ③`typecheck:types` ④`typecheck:tests` ⑤`build:cli` ⑥`test`（= `test-all.mjs`：三套件 + c8 棘轮）⑦`e2e` ⑧`build:website && check-website-agent-readiness.mjs` |
| **链外必需（CI 独立 job，本机也跑得动）** | `e2e:mcp`（真端到端 D1–D4）、`import-floor`（Node **18 / 20** 真导入） |
| **刻意不进 CI（手跑）** | `e2e:live`（真模型）、`e2e-soak*`、5 个 `bench-*` |
| **元守卫** | `verify-all-wiring.test.ts`（`verify-all.sh` ↔ `ci.yml` 互为真值）、`toolkit-map.test.ts`、`no-runtime-deps.test.ts`（零运行时依赖）、`layering.test.ts` + `file-cycles.test.ts`（分层单向 + 运行期无环）、`no-legacy-decorator-metadata.test.ts`（零反射） |

**值得单独记的工程文化**（有记录的机制，不是自夸）：`guards.md` 记着一轮 6 批审计**主动猎出 3 条假守卫**
（`tracer` 的自我比较、`sse-text-stats` 的对照没人断言、`transport-errors` 的样本不咬）——
三者的共同形状是「**机制写下了，但没有一条断言能让机制本身失效变红**」。
而附录 A 这条 semconv 缺口是**同一形状换了一层**：**基线写下了，但没有一条断言能让它过期变红。**

---

## 4. 与 2026 agent 趋势的对拍

> 依据：2026-08~10 的公开材料（agent 可观测 / 评测行业综述、MCP 规范演进时间线、context engineering 实践文）
> **加本轮的上游原文回源**（附录 A、§4.1 第 3/4 行带我们自己的读数）。凡标「需回源再核」的，落地前要回源。

| 趋势（2026） | agentia 现状 | 判定 |
|---|---|---|
| **可观测 + 评测是 table stakes**（生产中 94% 有 observability、62% 详细 tracing；**质量**是头号生产阻塞，排在成本前） | trace 一等公民（run == trace 1:1，含每步 usage）+ `TraceSink` + OTLP + metrics + exemplars（指标尖峰一键跳 trace）+ `trace-view` 本地面板 + CLI `report`/`diff`/`export`/`harvest` + Grafana 看板 + 四条配方 | 🟢 **强项**，是差异化卖点。⚠️ 但 **span 模型有缺口**，见 §5.2 A |
| **Trajectory-level eval**（评「走的路径」不只评答案） | trace **就是** trajectory 的天然基底；`Score` 一等公民（run 根事件）、`defineEval` 自动落 score、metrics 出 `agentia_score` 族、`harvest` 回流数据集；`eval-gate` 附属包（private） | 🟡 **有基底，配方薄** |
| **HITL 从「闸门」演进为「异步升级」+ TTL** | `@Tool({ approval:'required' })` + `suspended` + `approve` + 惰性超时 + 恢复段独立 trace（经 `links` 挂上一段） | 🟢 **已对上趋势**。可补：分级 TTL 默认值 + escalation 触发配方 |
| **Prompt injection = 新 SQL 注入，答案是 containment** | §7 最后一行明写「**框架不执行模型生成的代码**、无沙箱可言」；鉴权只是缝。已有的「能力引用两种粒度 + canCall 能力边」**本身就是 least-privilege 机制** | 🟡 定位是**有意**的（只占运行时 + 可观测两层）。缺「默认拒绝」与**工具级权限声明**这一小步 |
| **Cost-per-task > cost-per-token** | 价格表单源 + `priceOverrides` + 缓存四项计量 + 预算护栏（回合级）+ 模型 fallback 链（每环独立 llm.turn，成本归因正确） | 🟡 缺两块：① 模型**路由**配方；② **task/session 级成本视图** |
| **⭐ 上游 GenAI 约定的重心正在从「span」挪到「event」**（本轮现查：新基准末次提交正是 `Make gen_ai.client.inference.operation.details event recommended instead of opt-in (#579)`；`docs/gen-ai/client-inference.md` 已 **116 KB**，而 `non-normative` 之外还新出现 **`mcp.md`（114 KB）**、`gen-ai-token-metrics.md`（88 KB）、`gen-ai-exceptions.md`） | 本仓 llm.turn → **span**（`gen_ai.operation.name=chat`）；`score` 事件 → `gen_ai.evaluation.result`。**没有**发 client-inference 事件 | 🔴 **新出现的缺口**，且与 §5.2 A 同源 —— 见 §6 建议 #1b |
| **MCP spec 2026-07-28 大改**（核心变 **stateless** / `tools/list` 可缓存 `ttlMs`+`cacheScope` / Extensions / Tasks / MCP Apps / 授权硬化） | 桥自陈「**无状态 server**、宽容」—— **方向上正好对上**；只做 `tools/list` + `tools/call`（YAGNI 清单写明） | 🟡 stateless 已对；缺缓存协商、Extensions、Tasks |
| **A2A v1.0（2026-03）+ 进 Linux Foundation AAIF（2026-08）+ 五语言 SDK** | roadmap R8 登记「**缓**：A2A 协议适配（协议漂移中）」 | 🔴 **触发条件已部分满足** |
| **Agent experience**（llms.txt / markdown 直供 / MCP 暴露 / agent-first docs） | ✨ 官网已做 **`Accept: text/markdown` 内容协商** + 每页 markdown 变体 + 语言协商 + `check-website-agent-readiness.mjs`；另有 **MCP 反向桥**（`createMcpServer`，stdio/StreamableHTTP） | 🟢 **被低估的强项** —— 这一格跑在很多框架前面，但对外**几乎没讲** |
| ~~OTel GenAI semconv 搬家~~ | ~~`otlp.ts` 钉 v1.37~~ | ✅ **附录 A 已处置**（改钉新仓 commit + 删假断言） |

### 4.1 本轮新增的上游读数的含义（两张「新面孔」）

1. **`mcp.md` 出现在 GenAI 约定仓里** ⇒ MCP 不再是「桥的协议实现细节」，它有了**自己的一族语义约定**
   （span / 属性 / 指标）。本仓按 MCP 查 trace 目前是**零命中**（§6 建议 #6）。
2. **`client-inference.md` 116 KB + 末次提交把 `gen_ai.client.inference.operation.details` 定为 recommended**
   ⇒ 上游对「一次推理到底记了什么」的粒度要求**比我们细**，而且**载体是 event 不是 span**。
   本仓的 `llm.turn` span 装了 `gen_ai.request.model` + usage 两个键，属于**最小集**。
   ⚠️ 这条与「普通 `@Tool` 不建 span」（§5.2 A）合起来看：**上游在加记录面，本仓在最小集上停住了。**

---

## 5. 可观测深钻：方向是对的，但要选对钻法

### 5.1 为什么值得钻（两条判据）

1. **它是本仓唯一「已经从一个缝长成生态」的面**：`TraceSink` 一个接口 → OTLP 导出器 → metrics 累加器 →
   exemplars → 本地 `trace-view` → CLI 四命令 → Grafana 看板 → 四条开箱配方。**这已不是「顺手做的」，是主干。**
2. **趋势把它推到了采购门槛**（observability + evals 从 nice-to-have 变 procurement requirement；quality 是头号阻塞）。
   而 agentia 的定位恰是「**可直接上线的 Agent 服务**」—— 可观测是它跟「LLM SDK」拉开距离的**唯一**一条现成护城河。

### 5.2 四个可钻的方向（附反方判据）

**A. 补齐 span / event 模型与上游约定的差距 —— 优先级最高**

现查事实（`src/core/trace.ts:10` 头注释原文）：**capability span 只由 skill / subagent 创建**；
**普通 `@Tool` 调用不建 span**，只发 `tool.input` / `tool.output` 两笔事件挂在父 `llm.turn` span 上。

后果：OTLP 导出到 Datadog / Langfuse 后，**「哪个工具最慢 / 哪个工具失败最多」在 span 树上问不出来**（只在事件里）；
而 OTel 的约定把 `execute_tool` 当**一等 span**（v1.37 的 `gen-ai-agent-spans.md` 里 `## Execute tool span` 就在，
另有 `Create agent span` / `Invoke agent span` 一整族）。本仓现在只映射了 `invoke_agent`（run 根 + subagent）、
`chat`（llm.turn）、`execute_tool`（**仅 skill**）、`gen_ai.evaluation.result`（score）。

⚠️ 这是**有意**的 trade-off（`guards.md` 记着「普通工具刻意不建 capability span」）。**但生态变了 ⇒
这个 trade-off 的代价变了**：metrics 侧仍有工具维度（`metrics-state.ts` 读 `TOOL_OUTPUT_EVENT`），可 span 侧没有。

**B. 跨 run / session 维度（`run == trace` 1:1 的天花板）**

趋势讲的是 **session-level tracking**（一个会话/任务跨多个 run 的目标达成与推进）。现在跨 run 只有 `session.id`
属性 + 挂起/恢复段的 `links`。要做「会话级成本 / 会话级成功率 / 一条会话里哪次 run 退化了」，得靠 sink 在缝外拼。

**C. eval ↔ trace 闭环做厚**

基底齐全（trace / score / harvest / export / diff），缺的是**配方**：trajectory 判据（工具选择是否合理、
该不该升级给人、引用是否忠实）、评测进 CI 的形态。定位判据：§9.3 已锁「不内建后端/看板」⇒ 深钻 = **配方 + CLI**。

**D. 成本归因到 task / session**

现在细到 span、粗到 run。趋势的主指标是 **cost-per-task**。中间那层（task 成本视图）是 CLI 面能低成本补的。

**反方（写下来防止越界）**：`spec.md` §9.3 明确锁死「不内建日志层 / 采样 / 脱敏 / 存储 / 部署产物」；
R7 对照 Langfuse / LangSmith 后的结论是「**不学它们建看板 / CMS**」。⇒ 可观测深钻**不许**变成
「加一个可观测子系统」，只能走**协议对齐（A）+ 配方（C）+ CLI 面（B/D）**。

---

## 6. 建议清单（按 ROI 排序）

| # | 建议 | 判据 | 成本 | 会不会逼核心变厚 | 状态 |
|---|---|---|---|---|---|
| **1** | **semconv 基线重新对齐** | 文档里的版本号是断言；且基准位置已废弃 | **低**（`otlp.ts` 单模块 + 6 处文档） | 否 | ✅ **核心已入库 `dd33d02`**；官网两处 + 附录 A.6 的二级订正在工作区未提交 |
| **1b** | **补发 `gen_ai.client.inference.operation.details` 事件的映射**（或把 `llm.turn` 的键补到上游 recommended 集） | 上游末次提交正是把它从 opt-in 改为 **recommended**；载体是 event 不是 span | **低**（`mapEvent` 一处 + 用例） | 否（additive，映射集中单模块） | 🆕 **本轮新发现** |
| **2** | **普通 `@Tool` 可选建 span**（opt-in，或把 `tool.*` 事件投影成 OTLP child span） | 上游把 `execute_tool` 当一等 span；平台按 span 查工具 | **中**（engine 记账点 + 指标防双计 + 体量闸） | ⚠️ **会**（动 `turn.ts` 记账点）—— 必须 opt-in 且默认不变 | 待办 |
| **3** | **MCP 兼容性复查**：按 spec 2026-07-28 核 `tools/list` 缓存协商（`ttlMs`/`cacheScope`）、Extensions、Tasks | 兼容性 = 分发面；桥已 stateless，方向已对 | **中** | 否（桥在 `integrations/`） | 待办 |
| **4** | **trajectory eval 配方**（工具选择质量 / 升级判定 / 引用忠实）+「评测进 CI」形态 | 趋势：evals 是必需检查，且 trajectory-level | **低**（配方 + 文档 + 用例） | 否（缝外） | 待办 |
| **5** | **task / session 级成本与成功率视图**（CLI / 配方） | cost-per-task 是 2026 主指标；现在 span↔run 之间空着 | **低** | 否 | 待办 |
| **6** | **MCP 语义约定属性**（按新基准仓的 `docs/gen-ai/mcp.md`） | ⭐ 本轮现查：MCP 在上游已有独立约定文档（114 KB）；本仓按 MCP 查 trace 零命中 | **中** | 否（`integrations/`） | 待办 |
| **7** | **A2A 出站适配**（当一条缝：`@SubAgent` 的一种 transport） | A2A 已有 v1.0 + 进 AAIF；roadmap 的「缓」理由已部分解除 | **高** | 否（新 transport 层）—— 但**要先立项**（判据：真有第二个使用方要同一份逻辑？） | 待办 |
| **8** | **把「agent 可读性」讲出去**（llms.txt / markdown 协商 / MCP 反向桥） | 这一格跑在前面却几乎没对外讲 | **极低**（文案 / 官网） | 否 | 待办 |

**不做的**（已锁定，别当待办）：内建日志层 / 采样 / 脱敏 / 存储 / 看板 / DAG 编辑器 / swarm 编排。

**另**：`guards.md` §2 那 2 行活动缺口（`approval-supervisor` 的两条早返回、§7 gap 三态过期无守卫）已经积了一段
时间 —— 它们是**下一轮 review 的起手动作**，建议顺手清掉，别让 §2 变成新的「过期清单」。

---

## 7. 我这轮**没能**核实的（如实标注）

1. **「下游 Datadog / Axiom / Langfuse 已按 1.37+ 识别这批键」** —— 只出现在旧注释里，**无法独立核实**，
   已按纪律**删除**（不当依据用）。⚠️ 注意这与「additive 不破坏既有看板」是**两件事**：后者成立（我们**保留**了旧键），
   被删的只是「下游会读 `gen_ai.*`」这个对**别人**行为的断言。
2. **覆盖率 98.58 / 92.85 / 98.45** —— 来自 ③ 合并后那次落盘跑；`src/` 之后只动了版本常量 1 行，
   我判断读数**实质未变**，但**没有重跑**。
3. **用例数** —— 静态 grep，**参数化循环会低估**；运行时真值应以 `test-all.mjs` 的 `# pass` 为准（本轮未取）。
4. **趋势结论** —— 2026-08~10 的公开综述与规范跟踪文，**非全部规范原文**；附录 A / §4.1 那几条是**本轮真回源**的，
   其余（MCP spec 字段、A2A 状态、行业百分比）**未回源**，落地前需核。
5. **`docs/genai` 新仓「全篇 Development」** —— 我只核了**抽到的 5 份规范文档 + 7 个键**，不是该仓全部文件。

---

## 附录 A：OTel GenAI semconv 回源核（2026-10-12）—— 假断言 + 过期基准

> 这一节是本次 review 的**触发源**：体检时发现「文档里的基准版本」是一条会腐烂的断言，顺手回源核了一遍。
> **与 agentia 本体无关，不想看可跳过。**

### A.1 起因

`src/integrations/otlp.ts` 模块头注与 `docs/{observability,usage-guide,roadmap}.md` **四处**都写着
「对齐 OTel GenAI semconv **v1.37**」，其中头注还多一句理由：

> 该版本里 `gen_ai.client` 侧（chat / execute_tool / `gen_ai.request.model` / `gen_ai.usage.*`）已 stable，
> agent 侧（`invoke_agent` / `gen_ai.agent.name` / `gen_ai.conversation.id` / evaluation 事件）仍是 experimental；
> 选 stable 键优先 …… 是因为下游（Datadog / Axiom 等）已按 1.37+ 识别这批键。

**回源核（直接读 `semantic-conventions` @ `v1.37.0` 原文，不是二手材料）：那句话是假的。**

### A.2 证伪：v1.37.0 里 `gen_ai.client` 侧**不是** stable

| 核什么 | 读数（`open-telemetry/semantic-conventions` @ `v1.37.0`） |
|---|---|
| 文档状态 | `docs/gen-ai/gen-ai-spans.md` / `gen-ai-metrics.md` / `gen-ai-agent-spans.md` 文首**均为** `**Status**: [Development][DocumentStatus]` |
| 徽章总数 | spans `Stable` 10 / `Development` 75；metrics `Stable` 14 / `Development` 139；agent-spans `Stable` 8 / `Development` 83 |
| **本仓实际映射的 7 个键** | `gen_ai.operation.name` / `gen_ai.request.model` / `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` / `gen_ai.tool.name` / `gen_ai.conversation.id` / `gen_ai.agent.name` —— **逐条 `![Development]`（7/7）** |

⇒ 本仓自己映射的键**一个 stable 都没有**。「选 stable 键优先」这个理由当时就不成立。

### A.3 第二件事：这个基准**钉在一个不再维护的仓库位置上**

| 核什么 | 读数 |
|---|---|
| 主线 README 是否还是正文 | `docs/gen-ai/README.md`：`v1.41.1` = **2,397 字节 / 49 行**（正文）→ `v1.42.0` = **404 字节 / 11 行**（`# Moved: Generative AI semantic conventions` + 「no longer maintained in this repository」） |
| 搬运时间点 | tag `v1.42.0` 的提交时间 = **2026-06-12**；`v1.41.1` = 2026-05-11 |
| 新家 | `open-telemetry/semantic-conventions-genai`，建于 **2026-05-05**，`archived: false` |
| 新家有没有 tag | `GET /tags` → **空数组（0 个）**；`RELEASING.md` + Towncrier 化的 `CHANGELOG.md` 存在，但内容**只有 `## Unreleased`** ⇒ **确实无版本可钉** |
| 新家当前 HEAD | `6fd0d763`（2026-10-09），提交信息 `Make gen_ai.client.inference.operation.details event recommended instead of opt-in (#579)` |
| 新家文档状态 | 抽到的 5 份规范文档（`gen-ai-spans` / `gen-ai-metrics` / `gen-ai-agent-spans` / `gen-ai-events` / `client-inference`）文首**全为 `[Development]`**；上表 7 个键也**全是 `development`** |

⇒ 「钉 v1.37」不只是措辞错，它**指着一个 4 个月前的、已经宣布搬迁的仓库路径**。生态的官方口径正是
「pin 到某个 commit / 记下你 instrument 的日期」，因为没有版本可钉。

### A.4 为什么**没有任何门禁会因此变红**（这条才是要记的）

`tests/integrations/otlp.test.ts` 验的是**映射结果**（键名对不对、值对不对），它**不验基准措辞**。
于是「文档里的版本号」这一层处在**零射程**上 —— 基准一旦钉在**会被废弃的仓库位置**上，
上游搬仓那天它就开始腐化，而**代码、类型、单测、门禁全都是绿的**。

⚠️ 这与 `boundary-table.test.ts` 那句「§7 每条 gap 的『今天还成不成立』仍要人读」**同根**：
**可机械判的只有形状，判不了「这句话今天是真是假」。**

### A.5 处置（本轮已落盘，未提交）

**判据：本仓对错误主张的纪律是删，不另写一个更正版。**

1. **删**掉「已 stable」那句假措辞；
2. 基准改钉 **`semantic-conventions-genai` @ `6fd0d763`（2026-10-09）**，并写明「该仓无 tag、未版本化」，
   免得下一个读者去那里找一个不存在的版本号；
3. **删**掉「下游 Datadog / Axiom / Langfuse 已按 1.37+ 识别这批键」—— 这条只出现在旧注释里，
   我**不能独立核实**（新基准 repo 里没有任何下游兼容性声明）⇒ 不把没证据的话当依据；
4. 决策链与证据记进 `docs/spec.md` §10 2026-10-12。

**影响面 = 六处**（初稿只数到四处，漏了官网）：

| 位置 | 改什么 |
|---|---|
| `src/integrations/otlp.ts:19-24` | 头注基准 + 删假理由 + 删未核实断言 |
| `docs/observability.md` §3 表一行 | 基准 |
| `docs/usage-guide.md` §「OTLP 的 `gen_ai.*` 对齐」 | 基准（并删「下游按 1.37+ 识别」半句） |
| `docs/roadmap.md` R7「已落地」一行 | 基准 |
| **`packages/website/src/fragments/api.html:226`** | ⚠️ **漏改项**：官网 zh API 页手写着 v1.37 |
| **`packages/website/src/fragments/en/api.html:227`** | ⚠️ **漏改项**：官网 en 同款 |

⚠️ 官网那两处**没有守卫盯散文** —— `tests/docs/api-page.test.ts` 只钉「表格首列的名字真实存在 +
`src/index.ts` 每个导出都出现」，**表内描述文字零射程**。这正是它漂移的机制。

**落库状态**：前四处随 **`dd33d02`** 入库；**官网那两处**是**本轮**才发现的，改动还在工作区（未提交）。

**零行为变更**：只动注释与散文；`genAiAttributes` / `mapEvent` 的映射**逐字未动**，
`tests/integrations/otlp.test.ts` 无需改动。

### A.6 顺手抓到的四个二级问题（都是「断言没现查」的形状）

| # | 问题 | 形状 |
|---|---|---|
| a | 新写进 `otlp.ts` 的订正句里引用的是 `docs/gen-ai/spans.md` / `metrics.md` —— **真实文件名带 `gen-ai-` 前缀**（`gen-ai-spans.md` / `gen-ai-metrics.md`，`spans.md` 根本不存在） | 注释里的**路径也是断言**（同 `guards.md` 记的那条：引用 gitignore 里的路径 = 坏引用） |
| b | `spec.md` §10 那条写「README 字符数 v1.41.1 = 2,396 → v1.42.0 = 403」—— 我**复算不出**这两个数：同一口径（GitHub contents API `size`，字节）现查是 **2,397 → 404**；`wc -c` / `wc -m` 两种口径也都给 2397/404 | 能现算的数字必须**现算一遍**；数字对不上时**换更稳的口径**（这里改用「49 行 → 11 行」） |
| c | `spec.md` §10 那条**引用体检报告时写的却是 `.workbuddy/reports/…`** —— 那是 **gitignore 目录**，clone 下来读不到（现已改为入库路径 `docs/reviews/2026-10-11/framework-review-v0.10.2.md`） | 「文档指向一个读不到的东西」本身就是坏引用（`docs/reviews/2026-09-28/README.md` §0 记着同款教训，并因此**改了入库惯例**） |
| d | 官网 `docs.html:94` / `en/docs.html:96` **曾留着同款未核实断言**「`gen_ai.*` 键，Langfuse / Grafana / Datadog 直接识别」—— 与 A.5 第 3 条删掉的是同一句话 | ✅ **已删（2026-10-12）**：原「本轮有意未动、判定权留给用户」，经确认后按同款纪律删掉 —— 只留「对齐 OTel GenAI semconv（`gen_ai.*` 键）」，不再对**别人的行为**做未核实断言 |

⚠️ 边界说明：`docs.html:418` / `en/docs.html:419` 只写「对齐 OTel GenAI semconv」（**无版本号**）⇒ 不构成上面任何一条问题，
**不需改**。

---

## 附录 B：本轮回源核的原始读数与复算命令

> 原始响应体落在本地 scratch（**gitignore**，故此处不引路径当证据，
> 只把可复算的读数列出 —— 上游 tag 不可变，命令随时可重跑）。

| 读什么 | 命令（`gh` 已登录，无需代理） | 读数 |
|---|---|---|
| 主线 tag 序列 | `gh api 'repos/open-telemetry/semantic-conventions/tags?per_page=12' --jq '.[].name'` | `v1.44.0 … v1.34.0`（`v1.37.0` / `v1.41.1` / `v1.42.0` 均在） |
| v1.37.0 状态行 | `gh api 'repos/open-telemetry/semantic-conventions/contents/docs/gen-ai/gen-ai-spans.md?ref=v1.37.0' -H 'Accept: application/vnd.github.raw'` | `**Status**: [Development][DocumentStatus]` |
| v1.37.0 徽章数 | 同上取 3 份文档后 `grep -o '\[Stable\]' \| wc -l` / `'\[Development\]'` | spans 10/75、metrics 14/139、agent-spans 8/83 |
| 7 个键状态 | 在 spans / agent-spans 文档里抓「该键所在的表格行」，取行内 `badge/-<status>` 片段 | 7/7 = `development` |
| 搬运时间点 | `gh api 'repos/open-telemetry/semantic-conventions/commits/v1.42.0' --jq '.commit.committer.date'` | `2026-06-12T20:41:43Z`（`v1.41.1` = `2026-05-11`） |
| README 是否变桩 | `…/contents/docs/gen-ai/README.md?ref=<tag>` 的 `size` | `v1.41.1` 2,397 B / 49 行 → `v1.42.0` 404 B / 11 行（`# Moved: …`） |
| 新仓状态 | `gh api repos/open-telemetry/semantic-conventions-genai` | `created_at` 2026-05-05、`archived: false` |
| 新仓有没有 tag | `gh api repos/open-telemetry/semantic-conventions-genai/tags --jq 'length'` | `0` |
| 新仓 HEAD | `gh api repos/open-telemetry/semantic-conventions-genai/commits/main` | `6fd0d763` @ `2026-10-09T19:22:13Z` |
| 新仓文档状态 | 5 份规范文档文首 | 全 `[Development]` |

**本地侧**（可复算，与上游无关）：

- 本地能否解析上游 SHA（决定 `commit-refs` 守卫会不会红）：
  `git cat-file -t 6fd0d763` → **不解析**（`gh` 拉的是上游对象，不在本仓对象库里）
  ⇒ `docs/**` 写上游 SHA **安全**（守卫先 `git rev-parse --verify` 过滤，解析不到的跳过）。
  ⚠️ 但 `d1f9b67`（③ 的**分支**提交）**能解析**且**不在主干上** ⇒ 这类哈希要写在 `docs/reviews/**`
  （有历史快照豁免）里，或干脆换成 squash 后的 `1539a71`。
