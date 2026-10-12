# 2026-10-12 补可观测三缺口：G6（会话 / 任务视图）· G7（交接 / 护栏约定）· G8（观测面 MCP 入口）

**依据**：`docs/reviews/2026-10-12/observability-deep-dive.md` §3 缺口表与 §4 落地状态 ——
十项里已完成七项（G1 / G2 / G4 / G5 / G9 / G10 + G3 的三键）、**没做的正是本题三项**。

## 0. 三条判据先落在最前面（都是本文档自己的取舍，别绕过）

1. **不逼核心变厚**（§四 判据 ①）：三项都不该往 `src/core` 加抽象。落点分别是
   `packages/cli` / **additive 属性** / 示例或附属包。
2. **只给缝不给策略**（`docs/spec.md` §9.3 已锁死）：不内建存储、看板、采样、脱敏。
3. **体量闸与记账**：`packages/cli` 新增代码要补 `LINE_BUDGET` + `TOTAL_BUDGET` 棘轮账，并写
   「为什么」（`packages/cli/test/structure.test.mjs`）。

## 1. 现状读数（改前，`main` @ `ab45bd9`）

| 面 | 读数 |
|---|---|
| `packages/cli/src/report.ts` | **194 行** |
| `packages/cli/src/diff.ts` / `harvest.ts` | **443 / 389 行** |
| `packages/trace-view/src/summary.js` / `view.js` | **106 / 334 行** |
| `src/engine/mcp-server.ts`（反向桥） | **442 行** |
| CLI 子命令 | `create` `g`(=generate) `dev` `doctor` `report` `harvest` `diff` `export` `add` —— **9 个** |

**三个缺口逐条现查**：

- **G6** —— `report` 的 `ReportJson` 只有**能力维度**（`capabilities: SummaryRow[]`）+ run 级**计数**
  （`runs` / `failed` / `failures`）。**没有** task / 会话维度；`failed` 是**次数不是分母**，
  所以现在算不出「成功率」。
- **G7** —— 全仓 `handoff` / `guardrail` **零命中**。本仓现有的对应物是：
  ① **交接** ≈ `@SubAgent`（capability span，类型靠 `attributes.subagent` 区分，`core/trace.ts:241-254`）；
  ② **护栏** ≈ **审批**（`approval.requested` / `approval.decided` 两个事件，记在发起它的 `llm.turn`
  span 上、**不建 span**，`engine/turn.ts:543,622`）。
- **G8** —— `createMcpServer(app, opts)`（`engine/mcp-server.ts:398`）已能把 `{ tools }` 暴露成 MCP
  server（出站反向桥），但**没有任何地方**把 `report` / `diff` / `harvest` 包成 tools。

## 2. G6：会话 / 任务级成本与成功率

**落点**：`packages/cli/src/report.ts`（**同文件加维度**，不新开子命令 —— 9 个命令已经不少，
且 `report` 的输入（同一批 trace 行）与它的用途（调优）完全重合）。

**口径**（这几个数必须先定，否则「成功率」又是一笔假账）：

| 读数 | 口径 |
|---|---|
| 分组键 | run 根 span 的 `session.id` 属性（触发条件 `session: { store, id }`，**不是** `sessionId`）；缺失归入 `(无会话)` 桶 |
| task 级 | `TaskRecord`（`result.trace`）额外带任务标识时用任务键；与 session 二选一，不混排 |
| 成功 | `trace.status !== 'error'`（与现有 `okRuns` **同一个判据**，不新造） |
| 成功率 | `成功 run 数 / 该组 run 数` —— ⚠️ **必须给分母**：只报百分比在小组上是噪声 |
| 成本 | 该组各 run 的 capability 行 `costUsd` 之和（现成的 `summarizeTrace` 产物，不另算） |
| 每成功任务成本 | `成本 / 成功 run 数`；成功数为 0 时输出 `-`（**不是 0**，别把「除不了」伪装成 0） |

**输出**：`ReportJson` 增 `sessions: SessionRow[]`（字段增补是兼容的，改名/删字段才是破坏性）。
人类可读输出加一区块，`--json` 同步。

**体量**：预计 +60~90 行（含注释），棘轮账按实测补。

## 3. G7：交接 / 护栏 —— 约定 + 视图（additive 属性）

**为什么用属性而不是新 span**：上游这两格**无标准**（OpenAI Agents SDK 的
`HandoffSpanData` 只有 `from_agent` / `to_agent`，`GuardrailSpanData` 只有 `name` / `triggered`
—— 词汇量极小）。新造 span kind 会**扩大核心词汇**；加 attribute 则是 `Span.attributes:
Record<string, string|number|boolean>`（`core/trace.ts:202`）现成的自由 KV，**零核心改动**。

**约定（写进 `usage-guide.md`，这是「可查的约定」那一半）**：

| 键 | 值 | 加在哪 | 何时加 |
|---|---|---|---|
| `agentia.handoff.from` | 调用方 agent 名 | 被调 `@SubAgent` 的 capability span | 该 span 由另一个 agent 的回合发起时 |
| `agentia.handoff.to` | 被调 agent 名 | 同上 | 同上 |
| `agentia.guardrail.name` | 护栏名（审批策略名） | 发起它的 `llm.turn` span | 记 `approval.requested` 时 |
| `agentia.guardrail.triggered` | `true` | 同上 | 同上（**只在触发时发**，不设 `false` —— 与 `gen_ai.conversation.compacted` 同款口径） |

⚠️ **刻意不做**：不把审批**升级成 span**。`approval.*` 现在是事件、与「普通 `@Tool` 只发事件」
同形；升级会动 engine 记账点，且下游已能按事件消费（§2 行 13/14 的既有口径）。

**视图**：`packages/trace-view` 的 summary 行加 `guardrail:<名>` 一类聚合（与现有 `tool:<名>`
同构）；CLI `report` 复用（G6 的同一张表）。

## 4. G8：观测面给 agent 消费的入口

**落点**：**示例 + 附属包**，不进核心 —— 与「三个 `@migor/*` 附属包不发 npm」同款定位
（§四「已书面写明的有意为之」）。

**形状**：新示例 `examples/observability-mcp/`，用 `createMcpServer`（现成的反向桥）把只读能力
包成 tools：`report`（trace 文件 → 能力表 + G6 的会话表）、`diff`（两个 trace → 差异）。
⇒ agent 能自己查「我上一轮慢在哪」。

**为什么复用反向桥而不是新写 server**：`createMcpServer` 已经把 `tools/call` 的协议面
（含 #235 刚落地的 `_meta.traceparent` 入站缝合）都做完了；新写一份等于把协议面抄第二遍 ——
那正是 `mcp-protocol.ts` 抽出来要避免的事。

⚠️ **要判的一句话**：这是**分发面**不是功能面（§四「本仓瓶颈是产品面 / 分发面」）。
所以它的验收标准是「能被外部 agent 接上」，不是「新增了多少能力」。

## 5. 分期与验收

| 期 | 做什么 | 验收判据 |
|---|---|---|
| **①** | **G6**（ROI 第 4 位，最独立、纯 `packages/cli`） | `report` 出会话表；「成功数为 0 ⇒ `-`」有反向断言；棘轮账补齐 |
| **②** | **G7** 属性 + 约定 + summary 聚合 | 四个键各有「在场 / 不在场」两态用例；审批**不建 span** 由既有守卫继续钉住 |
| **③** | **G8** 示例 | 起真 server，用 `mcpTools` 连回去跑通一次 `report` |

每期都要：**变异验证**（守卫真的会咬）→ `verify-all` 8 步 → 单独 PR。

## 6. 边界（不做什么 · 别外推）

- ❌ 不内建存储 / 看板 / 采样 / 脱敏（`spec.md` §9.3）。
- ❌ 不给 G7 造新 span kind（理由见 §3 开头）。
- ❌ 不把 G6 做成「新子命令」（`report` 输入输出完全重合）。
- ⚠️ G6 的会话维度**依赖使用者配了 `session: { store, id }`** —— 没配就全是
  `(无会话)` 桶。这是**如实呈现**，不是缺陷（#234 已把那个静默失效改成出声）。
- ⚠️ 三个读数都会**腐烂**（行数 / 命令数）：本文件里的数字是 `ab45bd9` 当日的读数，
  复核时现算。
