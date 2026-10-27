# Agentia 部署示例

最小「可交付 Agent 服务」—— 演示 [spec §1](../spec.md) 定位里那一脚：交付物是**可上线的服务**，不是对话助手。

一个 HTTP agent 服务，带耐久任务存储、重启续跑、健康检查、指标与优雅停机。

## 里面有什么

| 件 | 说明 |
|---|---|
| `src/main.ts` | 宿主：装配 → `SqliteTaskStore` → `AsyncRunner` → `createHttpHandler` → 信号处理 |
| `src/tools/echo/index.ts` | 一个示例 `@Tool` 能力 |
| `src/registry.ts` | 显式注册表（形状与 `agentia g` 维护的一致） |
| `Dockerfile` | 多阶段构建（构建期编译 TS，运行期只带产物 + 运行期依赖，非 root） |
| `docker-compose.yml` | 端口 / 环境变量 / 数据卷 / healthcheck / 优雅停机宽限 |
| `.env.example` | 环境变量清单 |

## 跑起来

```bash
# 本地（需要 Node ≥ 22.5 —— SqliteTaskStore 用 Node 内置 node:sqlite）
cd ..                              # 仓库根
npm install && npm run build       # 先把框架构建到 dist/

cd examples/deploy
npm install                        # file:../.. → 装上刚构建的框架
export ANTHROPIC_API_KEY=sk-ant-...
npm start                          # 或 npm run dev（tsx watch）

# Docker（构建上下文是**仓库根**，见 Dockerfile 头部说明）
export ANTHROPIC_API_KEY=sk-ant-...
docker compose up --build
```

> **为什么依赖写 `file:../..`**：这是**刻意**的 —— 示例要跑的是**仓库里刚构建的那份框架**，
> 而不是 npm 发布版，所以先 `npm run build` 让它指向本仓库。想改用发布版就把这一行换成
> `^0.10.4`（与 `agentia create` 脚手架模板一致），Dockerfile 也能退回常规单包写法。
>
> 想要**更完整**的示例（四类能力 + 三种触发 + 鉴权 + 全观测栈）见 [`../complete/`](../complete/)。

### 镜像的验证状态（如实标注）

**服务本身**由门禁真跑守着：`scripts/e2e-deploy.ts` 起真进程、跑三种触发、`SIGKILL` 后同库重启
续跑（`resumePending`）、断言终态 —— 它在 `npm run e2e`（= 本地全链第 7 步）里。

**镜像这一层**只有一次构建证据：CI 的 `docker-image` job 真跑
`docker build -f examples/deploy/Dockerfile .`（构建上下文是仓库根，理由见 Dockerfile 头部）。
⚠️ 两点如实说清：① 本机没有 docker、**本地链跑不了它**，所以它**不是**必需状态检查
（首次绿就是它的验证，红了就是红的）；② 在此之前这个 Dockerfile **没有任何门禁构建过** ——
`docker` 在本仓 CI 配置里出现 0 次，镜像能不能建起来只活在文档的示例命令里。

## 端点

| 端点 | 说明 |
|---|---|
| `POST /run` | 同步 run；带 `Accept: text/event-stream` 则 SSE 逐帧 |
| `POST /tasks` | 异步任务（入队即回 `taskId`）；`GET /tasks/:id` 轮询 |
| `GET /healthz` | 健康检查（探针端点，**不鉴权**；`inFlight` / `draining` 见 usage-guide） |
| `GET /metrics` | Prometheus 文本（`metricsSink().render()`）；⚠️ 走 handler 之外，生产请由反代限制可达性 |

```bash
curl -s localhost:3000/healthz
curl -s -X POST localhost:3000/run -H 'content-type: application/json' \
  -d '{"prompt":"用 echo 工具回显 hi"}'
curl -s localhost:3000/metrics | head
```

## 生产要点（示例里都已接线）

- **耐久 + 多进程安全**：`SqliteTaskStore` 走 Node 内置 `node:sqlite`（WAL + `busy_timeout`），
  多进程可共库；`resumePending()` 重启续跑未完成任务（按 `ownerId` 跳过本进程记录）。
- **优雅停机**：`handler.drain({ timeoutMs: 15_000 })` —— 拒新单 → 等在飞收尾 → 超时强制收口 SSE。
  框架不订阅 `SIGTERM`，所以这里显式接了；compose 的 `stop_grace_period` 必须大于该超时。
- **成本硬管控**：`maxTotalTokens` 超限以 `budget_exceeded` 收尾（**算失败**）。
- **观测**：`/metrics` 已接；**落库 / 采样 / 脱敏 / 日志关联**四条配方见
  [`../observability/`](../observability/) 与 [`docs/observability.md`](../../docs/observability.md)。

## 本示例**没有**做的（生产按需补）

- **入口鉴权**：`createHttpHandler({ authenticate })` 是缝 —— token/JWT/签名策略由你的宿主或反代实现。
- **TLS / 反代 / 限流**：交给网关。
- **密钥管理**：示例读 env；生产用密钥服务 / 编排平台的 secret。
- **自动扩缩 / 多副本**：`SqliteTaskStore` 支持多进程共库，但多副本共享一份 SQLite 文件
  需要共享卷；跨机部署请换 `RedisTaskStore` 或自实现 `TaskStore`。
