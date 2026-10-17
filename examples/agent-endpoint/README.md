# 在已有服务上加一个 agent 端点

> 场景：你有一个**已经在跑**的订单服务（`GET /api/orders/:id`）。现在要让模型能回答
> 「我的订单到哪了」。**不推倒重来、不引新依赖、不改老代码** —— 加一条路由。

这是本仓唯一一个「**改造视角**」的示例：`deploy/` 讲「从零建一个可交付服务」，
`complete/` 讲「一个真实服务长什么样」，这个讲「**在存量服务里增量加**」。
真实项目里 90% 的人是这一种。

## 改造清单（6 步，全部改动集中在 `src/main.ts`）

| # | 动作 | 代码量 | 在哪里 |
|---|---|---|---|
| ① | 装一个包 | `npm i @migor/agentia` | 零运行时依赖，`node_modules` 只多一个包 |
| ② | 把**已有函数**包成 `@Tool` | ~20 行 | `src/tools/lookup-order/index.ts` |
| ③ | **复用**同一份鉴权 | 0 行新增（调用已有函数） | `main.ts` 的 `requireApiKey` |
| ④ | 加**一条分支**：业务优先，其余交给 agent | 6 行 | `main.ts` 的 `createServer` |
| ⑤ | 把 `drain()` 接进已有 SIGTERM | 5 行 | `main.ts` 末尾 |
| ⑥ | 设上四个预算旋钮 | 3 行 | `createApp({ maxTotalTokens, maxCostUsd, maxIterations })` |

`src/orders.ts` 是「已有业务」—— **加 agent 前后一行未改**，这是示例刻意保持的对照。

## 跑起来

```bash
cd ../..                     # 仓库根
npm install && npm run build # 先把框架构建到 dist/

cd examples/agent-endpoint
npm install                  # file:../.. → 装上刚构建的框架
export ANTHROPIC_API_KEY=sk-ant-...
export API_KEY=dev-key       # 设了就要带鉴权；不设 = 本地裸跑

npm start                    # 或 npm run dev（tsx watch）
```

```bash
# 已有业务：行为与加 agent 之前完全一致
curl -H 'x-api-key: dev-key' localhost:3000/api/orders/A-1001

# 新增：同步 run（失败也回 200，判 status 不判退出码）
curl -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"A-1002 到哪了？多少钱？"}]}' \
  localhost:3000/run

# 新增：异步任务（长活走这条）
curl -H 'x-api-key: dev-key' -H 'content-type: application/json' \
  -d '{"input":{"messages":[{"role":"user","content":"查一下 A-1003"}]}}' \
  localhost:3000/tasks

# 健康检查（不鉴权 —— 生产请由反代限制 /metrics 的可达性）
curl localhost:3000/healthz
```

跑完之后 `.agentia/traces.jsonl` 里就有这次 run 的完整调用树 —— 它正是
`agentia report` / `diff` / `harvest` / `export` 的输入：

```bash
npx agentia report .agentia/traces.jsonl    # 哪个能力慢 / 贵 / 爱失败
```

## 三个刻意的设计

**1. 鉴权只有一份。** `requireApiKey` 同时被业务路由和 agent 路由调用 —— 框架**不实现**
token / JWT / 签名策略，只给「除 `/healthz` 外所有路径都过它、且在读 body 之前」这条缝。
把它写成两份，迟早会漂。

**2. RAG 不是框架的事。** `lookup-order` 里没有 embedding、没有向量库 —— `findOrder` 换成
`pg.query(...)` 或 `vectorStore.search(...)` 就是你要的检索。框架的职责是「把调用接到模型、
把账记进 trace」，**内置 RAG 会同时撞上它的两条硬约定**（零运行时依赖、只给缝不给策略）。

**3. 预算没设 = 没有保险丝。** 示例里 `maxTotalTokens: 200_000` / `maxCostUsd: 0.5` /
`maxIterations: 12` 三个都写了。超限以 `budget_exceeded` **算失败**收尾（带结构化 error），
不是静默截断。

## 与相邻示例的关系

| 想看什么 | 去哪个 |
|---|---|
| 从零建一个可上线的服务（Docker / compose / 健康检查） | [`../deploy/`](../deploy/) |
| 一个真实服务长什么样（四类能力 + 三种触发 + 全观测栈） | [`../complete/`](../complete/) |
| 真业务 + 人工审批挂起/恢复 | [`../patrol/`](../patrol/) |
| **在存量服务里加一个端点** | 本目录 |

## 已知边界（如实标注）

- 任务存储用 `InMemoryTaskStore` ⇒ **重启即丢**。要跨重启续跑，换 `SqliteTaskStore`
  （Node ≥ 22.5）或 `RedisTaskStore`，并把 `runner.resumePending()` 接进启动流程。
- 示例**没有**接 `metrics`（Prometheus）。要接就在 `createHttpHandler` 里传 `metrics`，
  并像 `complete/` 那样把 `/metrics` 挂在业务路由之外。
- 本示例**不进 e2e**（`scripts/e2e-examples.ts`）：它要真 API key 才有意义，而
  `deploy/` / `complete/` 已经覆盖了「服务能起来、三种触发能跑通」。
  本目录的保证是 **`typecheck:tests` 编译级**（`tsconfig.tests.json` 里包含它）。
