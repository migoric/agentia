# 示例

每个示例只管一件事。都只 import 框架的**公共面**（`@migor/agentia`），不碰内部路径。

| 目录 | 是什么 | 什么时候看 |
|---|---|---|
| [`observability/`](./observability/) | 四个现成 sink：按 runId 落库检索 / 日志关联 / 采样 / 脱敏（本地小包 `@migor/agentia-observability`，零依赖） | 要把 trace 送进生产观测栈时 |
| [`observability-mcp/`](./observability-mcp/) | 把调优报告（`report` / `diff`）包成两个 **MCP 只读工具**（本地小包，复用框架的反向桥）—— agent 自己就能查「我上一轮慢在哪」 | 想让不具备 shell 的 agent 也能读 trace 时 |
| [`deploy/`](./deploy/) | **最小**可交付服务：HTTP 宿主 + `SqliteTaskStore` + `/healthz` + 优雅停机 + Docker | 想知道「怎么把它跑上线」时 |
| [`agent-endpoint/`](./agent-endpoint/) | **存量改造**：在一个已在跑的 REST 服务上**增量**加 `/run` + `/tasks` 端点，老代码一行不动、复用同一份鉴权与业务函数（约 30 行胶水） | 想给现有服务加一个 agent 端点、又不想重写时 |
| [`complete/`](./complete/) | **完整**示例：四类能力 + 三种触发 + 鉴权 + 全观测栈（上面四个 sink 接成一条链）+ Docker | 想知道「一个真实服务长什么样」时 |
| [`patrol/`](./patrol/) | **真干活**的服务：对真目录做只读巡检、产出真报告，改动文件系统的动作走人工审批（挂起 → 人批 → 恢复）；附 `npm run drill` 上线演练，逐条验 `docs/deployment.md` | 想拿一个真任务对拍上线清单，或想看审批挂起/恢复、崩溃续跑怎么接时 |
| [`code-review/`](./code-review/) | **产品验证**示例：代码评审 agent 服务 —— 四类能力编排 + 结构化报告 + trace/成本数字，离线确定性 demo 与真模型两种跑法 | 想看「拿它做一个真业务长什么样、跑一轮花多少钱」时 |
| [`eval-gate/`](./eval-gate/) | **评测即发布闸门**：把 `defineEval` 的结论对上一版基线收成「这一版能不能发」的判据（补 `EvalReport.ok` 答不了的两件事：比上一版好还是坏 / 「删掉失败用例」这种过闸门方式） | 想把评测接进发布流程时 |
| [`grpc-host/`](./grpc-host/) | **第 4 个宿主**：gRPC 服务定义 → `RunInput` → `app.run` / `runner.submit`（一元 / 服务端流 / 异步投递 / 查任务；deadline→signal、metadata traceparent→link） | 想给已有服务加一个 gRPC 入口、又不想把语义写歪时 |
| [`terminal-bench/`](./terminal-bench/) | **跑分接入**：把 agent 接进 Terminal-Bench（Harbor）任务容器，并把 trace **原生直译成 ATIF** 轨迹 —— 评测不只看 reward 0/1，还能回看「它是真做对了还是瞎猫碰上死耗子」 | 想拿它去跑公开基准、或想知道「过程证据怎么留」时 |

配套阅读：[`docs/observability.md`](../docs/observability.md)（配方讲解）、
[`docs/usage-guide.md`](../docs/usage-guide.md)（API 速查）、[`docs/spec.md`](../docs/spec.md)（设计规格）。

## 依赖说明（重要）

各示例的依赖都写成 `"@migor/agentia": "file:../.."`（指向本仓库）—— 这是**刻意的**：
示例要跑的是**工作区里刚构建的那份框架**，而不是 npm 上的发布版。仓库的端到端门禁
（`scripts/e2e-examples.ts`）也靠这一点：换掉依赖，示例就不再验证本仓库的构建产物。

```bash
cd <仓库根> && npm install && npm run build    # 先把框架构建到 dist/
cd examples/complete && npm install            # 再装示例
```

要用 **npm 上的发布版**（`0.4.0` 起，本目录示例用到的能力都已包含），把那一行换成
`"@migor/agentia": "^0.10.3"` 即可；两个 Dockerfile 也能相应退回常规单包写法
（各自的 README 里都标注了改动点）。

## Docker

示例的 Dockerfile 都以**仓库根**为构建上下文（镜像里先从源码构建框架）：

```bash
docker build -f examples/complete/Dockerfile -t agentia-complete .
docker compose -f examples/complete/docker-compose.yml up --build
```

> Docker 只认**构建上下文根**上的 `.dockerignore` —— 所以忽略清单在仓库根
> （[`.dockerignore`](../.dockerignore)），放在示例目录里不会生效。
