# Agentia gRPC 宿主示例

**第 4 个宿主**（前三个：HTTP 同步 RPC / 异步任务 / 定时）。演示「宿主只做翻译」这条缝：

```
gRPC 请求  →  normalizeMessages  →  app.run / runner.submit  →  响应消息
```

业务侧（能力声明、菜单、trace 记账、成本管控）**一行都不改** —— 四种触发共用同一份
`RunInput` 契约，「换宿主不换语义」。本示例的装配段与 [`../deploy/`](../deploy/) 的 HTTP 宿主
逐字同形，可以对着看。

## 跑起来

```bash
# 框架本体先出 dist（本示例以 file:../.. 依赖它，运行期解析的是那边的产物）
npm run build                 # 在仓库根执行一次

cd examples/grpc-host
npm install
npm run build                 # 出本示例的 dist/（serve 跑的是 node dist/main.js）

# 终端 A：起宿主。PORT=0 会打印**实际**端口（不靠外部探空闲端口，没有抢占窗口）
npm run serve

# 终端 B：把四个 RPC 跑一遍
npm run client            # 默认连 127.0.0.1:50051
npm run client -- 127.0.0.1:<端口>
```

开发期不想两头 build 就用 `npm run dev`（tsx watch 直接跑 src，跳过 dist）。

模型侧默认走框架的 Anthropic client（读 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`）。
不想接真端点就用一个假的 OpenAI/Anthropic 兼容端点 —— 仓库的 e2e 就是这么干的：

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:9999 ANTHROPIC_API_KEY=fake AGENTIA_MODEL=fake-model npm run serve
```

## 四个 RPC（每个都对齐一条已有的 HTTP 路径）

- `Agent/Run` ↔ `POST /run`：一元同步 run，整份结果一次返回
- `Agent/RunStream` ↔ `POST /run` + `Accept: text/event-stream`：服务端流，增量逐帧。
  帧名与 SSE 事件**一一对应**（`text_delta` / `end`），前端能共用一套渲染逻辑
- `Agent/Submit` ↔ `POST /tasks`：异步投递即回 `taskId`；去重键走 metadata `idempotency-key`
- `Agent/GetTask` ↔ `GET /tasks/:id`：查任务终态；查不到回 `NOT_FOUND`

## 宿主必须自己接上的四处（这是本示例的重点）

漏掉任何一条都**不会报错**，只会静默丢东西 —— 这类「不报错地不干活」是本仓库最贵的一类故障：

```
① deadline / 客户端取消  →  AbortSignal   （main.ts 的 abortOnCancel）
   不接 = 客户端已经走了，服务端还把这次 run 跑完（token 照烧）
② metadata traceparent   →  traceContext  （run 根记一条 link：跨进程关联）
   不接 = 关联在服务边界上断掉
③ 框架错误 → gRPC 状态码  （照抄 classifyError 的分类，别 instanceof 厂商错误类）
   不接 = 全塌成 UNKNOWN，调用方的重试策略失效
④ trace → sink           （fileTraceSink：一行一个 run，可喂 agentia report / diff）
   不接 = RPC 回了结果，但「为什么慢 / 贵 / 失败」没有证据
```

**run 失败 ≠ RPC 失败**：与 HTTP 宿主的 200 + `status: failed` 同口径（`rethrow: false`）——
run 的硬失败是业务结果，只有宿主层面的失败（入参不可规整、停机中）才用非 OK 状态码。

## trace 去哪了

`out/trace.jsonl`，一行一个 run 的完整调用树（`AGENTIA_TRACE_FILE` 可改）：

```bash
npx @migor/cli report out/trace.jsonl   # 调优报告：哪个能力慢 / 贵 / 爱失败
npx @migor/cli diff out/trace.jsonl out/trace-b.jsonl   # 两次调用的 A/B 比对
```

换个 sink 就进生产观测栈（OTLP / 落库 / 采样 / 脱敏）：见 [`../observability/`](../observability/)
与 `docs/observability.md`。

## 文件

```
proto/agent.proto   服务定义（四个 RPC + 消息形状，注释里写明与 HTTP 路径的对应）
src/main.ts         宿主：装配 + 四处翻译 + 优雅停机（本示例的主体）
src/client.ts       客户端：拼 metadata / 给 deadline / 回调转 Promise（npm run client 与 e2e 共用）
src/registry.ts     能力注册表（与 agentia g 维护的形状一致；换宿主不用动它）
src/tools/echo/     示例能力
```

## 生产化时要改的

- **凭据**：gRPC 侧用 metadata 传 token + `ServerInterceptor` 校验（对应 HTTP 宿主的 `authenticate`
  钩子）。框架不实现策略 —— 不读 env、不碰凭据，鉴权是宿主的事
- **存储**：示例用 `InMemoryTaskStore` / `InMemorySessionStore`（重启即丢）。生产换
  `SqliteTaskStore` / Redis 即可，构造参数一处改 —— 缝没变，见 [`../deploy/`](../deploy/) 的
  `resumePending()` 崩溃续跑
- **TLS**：`grpc.ServerCredentials.createInsecure()` 只适合本机；生产换
  `createSsl(...)` 或把 TLS 交给前面的反代 / sidecar
- **限流与并发**：`AsyncRunner` 已有在飞闸门与 `drain()`；入口侧的限流按宿主自己加
  （对应 HTTP 宿主的 `maxConcurrentRuns` / 503 那条）

## 为什么它不是一个 npm 包

框架本体承诺**零运行时依赖**（`package.json` 三个依赖字段全空），而 gRPC 必须引第三方客户端
（`@grpc/grpc-js`）⇒ 它落在「可选能力一律 duck-typed / peer」那一侧，只能以示例 + 配方存在。
判别规则只有一条：**客户端是不是标准库**（MCP 连接器能内置，靠的是 `spawn` + 全局 `fetch`
一个第三方依赖都没加）。

真到该拆包的时候，粒度是**一个第三方客户端一个包**，不是把这些集成塞进一个「服务包」——
理由与升级触发条件写在 `docs/spec.md` §10（2026-09-18 ref-host-integration-recipe）。

## 门禁

`npm run e2e:grpc`（仓库根；已并入 `npm run e2e`）：真构建、真起宿主、用**本示例自带的客户端**
跑四个 RPC，并守四处语义 —— deadline 到期后服务端的 run 真被 abort（trace 里
`error.type=aborted`）、`traceparent` 落成 run 根 link、同 `session_id` 两轮共享历史、
同 `idempotency-key` 重投不重复执行。
