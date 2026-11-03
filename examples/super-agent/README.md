# 多工单编排（Super-agent 形状）

一个用户目标进来，拆成若干**可并行的工单**，各自在独立上下文里跑完，需要改数据的动作停下来等人批，
最后汇总成一段答复 —— 这就是 DeepSeek Harness 团队 2026-10-31 公开的 *Super-agent*（Router + Worker）
在 Agentia 里的落法。

本示例只管这一件事。它不教你怎么接渠道、怎么做事件过滤（那是你的业务），它**只证明编排骨架走得通**，
并把六个必踩的坑标出来。

## 跑

```bash
npm install
npm run demo     # 零 API key、零网络、零副作用，30ms 跑完并自检
```

`npm run demo` 用 `scriptedClient` 把每个 agent 的回合写成剧本，于是**编排路径本身是可断言的**：
拆了几单、哪一单挂起等人批、批完有没有真落地、四棵 trace 是不是连成一串 —— 断言全中才算过
（条数以输出那行为准，会随断言增减）。

要接真模型（`npm start`）：

```bash
ANTHROPIC_API_KEY=sk-ant-... npm start
# 或指到 OpenAI 兼容端点（DeepSeek / vLLM / Ollama…）：
# OPENAI_BASE_URL=https://api.deepseek.com OPENAI_API_KEY=... AGENTIA_MODEL=deepseek-chat npm start
```

```bash
# 派发一个目标（立刻 202，工单在后台跑）
curl -X POST localhost:3000/goal \
  -H 'content-type: application/json' \
  -d '{"goal":"客户投诉下单 2 件单价 50 只算了 50 元，请复现并修复","goalId":"msg-1"}'

# 看这个目标下所有工单
curl localhost:3000/goal/msg-1

# 挂起的写操作：批它（taskId 从上一行响应的 pendingApprovals 所在工单里拿）
curl -X POST localhost:3000/approve/<taskId> \
  -H 'content-type: application/json' -d '{"approved":true,"decidedBy":"me"}'
```

## 门禁（CI 每 PR 真跑）

`scripts/e2e-examples.ts` 第 11 步会按本示例自己的 `npm run build` 构建，再跑 `dist/demo.js` 的产物，
然后**自己复算一遍 trace 图**：谁是唯一的根、每条树沿 `links` 几跳回家、哪条是挂起段 / 恢复段。

它**不转发** demo 的结论：把下面那个 `hopsTo()` 改成恒返回 1，门禁仍然绿（那张缩进图只是给人看的）；
而真行为变了 —— Worker 的 `traceContext` 去掉、写工具的 `approval` 摘掉 —— 门禁会红并点名哪一条。

门禁要原始产物（`SUPERAGENT_DEMO_OUT=<file>` 时 demo 才落一份 JSON），所以交互式 `npm run demo`
保持零副作用。想自己看那份结构：

```bash
SUPERAGENT_DEMO_OUT=/tmp/sa.json npm run demo && python3 -m json.tool /tmp/sa.json | head -40
```

## 核心判断：Worker 走 **task**，不走 `@SubAgent`

这是整套架构里唯一容易做错、且错了要重写的决定。`@SubAgent` 是**同步工具调用**，拿它当 Worker 会撞四堵墙：

| 墙 | 后果 |
|---|---|
| 主 agent **阻塞等**子 agent 返回 | Router 变串行瓶颈，而 Super-agent 的卖点就是并行推进 |
| `contextPolicy` **不进子循环**（usage-guide §7） | Worker 长跑必撞上下文上限，以 api 错误收尾 |
| 子循环里的审批**不支持挂起**（§7） | 要改数据的 Worker 直接废掉 |
| 子循环**没有 `TaskRecord`** | 崩溃后 `resumePending` 捡不回来，工单永久消失 |

`AsyncRunner` 的 task 把这四条全兜住：独立 run、独立并发槽、独立预算、独立审批挂起、记录落库、
崩溃按 `ownerId` 租约认领。所以：

```
Router   = 一次短 app.run（收到目标才跑，产出可校验的工单清单）
Worker   = runner.submit() 开的一条 task
汇总     = 读 TaskRecord.result（Worker 的隔离报告）
```

## 代码地图

| 文件 | 干什么 | 关键点 |
|---|---|---|
| `src/agents.ts` | 三个 app：Router + repro Worker + fix Worker | **菜单隔离**：repro 的菜单里没有写工具；`TICKETS_SCHEMA` 让拆单结果可校验 |
| `src/tools.ts` | 三个工具（读 / 搜 / 写） | `write_file` 标 `approval: 'required'` —— 唯一不可逆的动作 |
| `src/orchestrator.ts` | **编排核心，全示例唯一「聪明」的地方** | 拆单 → 派发 → 等落地 → 汇总；`dispatchGoal`（只派发）与 `runGoal`（派发 + 等） |
| `src/sandbox.ts` | 内存工作区 | 换成真文件系统时要自己补路径边界与写幂等 |
| `src/demo.ts` | 离线确定性 demo | 剧本即回归测试；`SUPERAGENT_DEMO_OUT` 指向文件时才落产物（给门禁用，平时零副作用） |
| `src/main.ts` | 真服务 | HTTP 宿主 + 多 runner + 审批路由 + 优雅停机 |

## 六个坑

1. **`suspended` 不是终态。** `awaitTask` 等的是终态，一个在等人批的任务永远是 `suspended` ⇒ 直接 await
   会一路等到超时（缺省 30s），然后你得到「超时」而不是「在等人」。本示例用「看得见状态的轮询」
   （`orchestrator.ts` 的 `settle`）：终态就收、挂起就找人批、其余继续等。
2. **一个 `AsyncRunner` 只绑一个 app。** repro / fix 菜单不同 ⇒ 两个 app ⇒ **两个 runner 共用同一个 store**
   （框架按 `ownerId` 区分归属，同进程多 runner 共库是受支持形状）。别用一个「什么都装」的 app 省事，
   那等于把写工具暴露给只该读的工单。
3. **预算是按 run 算的。** `maxCostUsd` / `maxTotalTokens` 是**单个 run** 的上限，一个目标的花费是
   N+1 条 run 之和。要「一个目标最多花多少」，自己在 `sink` 里按 `labels.goal` 聚合、在 `middleware` 里拦。
4. **Worker 的输入只能是文本。** `runner.submit` 只接受 `string` / `MessageParam[]` /
   `{ prompt? text? messages? }`（`normalizeMessages` 的口径）；塞对象会被 `TaskInputError` 当场拒
   （`submit` 是同步的）。工单信息要写成人话 —— 这本来也更对。
5. **审批必须找回任务归属的 runner。** 内置 `POST /tasks/:id/approve` 绑定在 handler 构造时传的
   **一个** runner 上；多 runner 场景自己读记录里的 `labels.kind` 再派给对应 runner，否则会用错的 app
   恢复执行。本示例的 `/approve/:taskId` 就是这么做的。
6. **观测上「一个目标」是多棵树。** `traceId == runId`，所以 Router 一棵、每个工单一棵；需要审批的
   还有**挂起段 + 恢复段两棵**，恢复段 link 到挂起段（不是 Router）⇒ 回家要走**两跳**。
   demo 的 `hopsTo()` 把这件事画成了缩进链路图 —— 第一版断言写成「一跳」直接判错了框架的正确行为。

## 边界（本示例刻意没做）

- **渠道接入**（群聊 / GitHub / 邮件）：那是宿主的路由与鉴权，`examples/agent-endpoint` 给了增量改造的写法。
- **事件过滤**：Super-agent 的「主动」= 事件源 + 两级过滤 + 派发。框架只给 `Scheduler` 与 `submit`，
  「什么值得处理」是你的策略。⚠️ 成本纪律：第一级必须用规则挡掉绝大多数事件，别对每条消息跑一次模型。
- **跨渠道会话归并**（「同一件事」在群聊和 PR 评论里各说了一遍）：框架的 `SessionStore` 是对话维度、
  不做归并，得自己在渠道层映射到同一个 `sessionId`。
- **崩溃恢复**：`resumePending` 没接进来（示例用 `:memory:` 默认跑）。真部署时在启动时调一次，
  并设 `staleAfterMs`（多副本共库时它是「判不了才用」的兜底，同机按 pid 判死活）。

## 相关阅读

- [`../../docs/usage-guide.md`](../../docs/usage-guide.md) §6.2 触发与宿主、§7 已知边界
- [`../patrol/`](../patrol/) —— 审批挂起/恢复、崩溃续跑的**上线级**写法（含 `npm run drill` 演练）
- [`../agent-endpoint/`](../agent-endpoint/) —— 在存量服务上加 agent 端点（鉴权复用、30 行胶水）
