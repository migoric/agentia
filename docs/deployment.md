# 上线清单（从跑通 demo 到推上生产）

> 本文回答「推上生产前要过哪些**决定**」：每条给判据与真源，不重复正文。可运行的完整接线见
> [`examples/deploy/`](../examples/deploy/)（Dockerfile / compose / 健康检查 / 优雅停机齐全，
> 且由 `scripts/e2e-deploy.ts` 真跑守着——含 SIGKILL 后同库重启续跑）；边界的完整清单在
> [`docs/usage-guide.md`](usage-guide.md) §7「已知边界」—— 本文只挑**上线相关**的子集并指回它。
> 运行时 API 的权威口径以 usage-guide 为准（本文提到的选项都在 §4 / §6 有表）。

## 0. 先决：版本怎么锁

- **0.x 期间**：锁定**精确版本号**（不用 `^`）。破坏性变更的判据不是版本号，是 CHANGELOG 里
  **有没有「迁移」小节**——现数命令与 1.0 门槛见 [README「稳定性与版本策略」](../README.md)。
- 升级前：读目标版本的迁移小节；回退前：读**当前**版本的迁移小节（见 §9）。

## 1. 运行环境与密钥

| 项 | 口径 |
|---|---|
| Node | ≥ 18（CI 在 18 / 20 / 24 上守全链；ESM-only）。⚠️ 这条是**框架库**的下限；**脚手架默认入口**（`agentia create` 后 `npm start` 起的那个服务）要 **≥ 22.5** —— 它的默认任务库 `SqliteTaskStore` 用 `node:sqlite`。低版本上它抛的是可读报错，不是崩；想在 18 上起服务就换 `FileTaskStore`（同一套 API，单写者前提） |
| 包 | `@migor/agentia` 单包、零运行时依赖（守卫 `tests/architecture/no-runtime-deps.test.ts` 钉着） |
| 密钥 | **框架不读 env**——模型客户端的 key 由宿主代码显式传入。`loadEnvFile` 是给本地开发的工具，不是生产的密钥方案；生产用编排平台的 secret 注入 |

## 2. 任务存储（耐久与恢复的根基）

| store | 耐久 | 多进程 | 适用 |
|---|---|---|---|
| `InMemoryTaskStore` | ✗ | — | 开发 / 可丢失的负载 |
| `FileTaskStore` | JSONL | ✗（单写者） | 单机、量小；`compact()` 压实日志 |
| `SqliteTaskStore` | WAL | ✓ 共库（单机共享卷） | 单机多进程的缺省选择 |
| `RedisTaskStore` | ✓ | ✓ 跨机 | 跨机部署；⚠️ **前提：单宿主写者** |

- ⚠️ **单宿主写者**的前提对 File / Redis 都成立：`save` 不是原子的（Redis 是两次 SET、未走
  MULTI），多写者并发下同键写可能交错——跨进程协调属部署层职责（分片 / 单写者选主）。
- **重启续跑**：`runner.resumePending()` 一趟做完（到期唤醒 / 审批超时恢复 / 孤儿认领重投）。
  不接线的话，挂起中的任务在进程死后就是死任务。
- `close()` / `compact()` 是 `TaskStore` 上的**可选**成员，**框架刻意不替你调**——停机序列由宿主编排（见 §5）。
- 对账口径：挂起段与恢复段是**两棵 trace 树**（不是一棵被续上的树），跨重启关联要靠 taskId。

## 3. 入口与网络边界

- **鉴权是缝**：`createHttpHandler({ authenticate })`——除 `/healthz` 与 `/metrics` 外所有路径
  都过它、且在读 body 之前。框架不实现策略（token / JWT / 签名由你的宿主或反代实现）。
- ⚠️ **`/healthz` 与 `/metrics` 不鉴权**：生产请由反代限制 `/metrics` 的可达性（指标里有能力名、
  成本等敏感读数）。
- TLS / 限流 / WAF：交给网关，框架不内置。
- 换协议：gRPC 宿主不内置（[`examples/grpc-host/`](../examples/grpc-host/) 是配方，且进 e2e）。

## 4. 健康检查与就绪

- `GET /healthz` → `{ ok, inFlight, draining }`：`ok` 恒 `true`（能回就是活着），**就绪与否看
  `draining`**——负载均衡据此摘流量。
- 停机中 `/healthz` 也回 200：把「活着」和「该给我派活」分开判。

## 5. 优雅停机（顺序是死的）

1. `process.on('SIGTERM', ...)`——**框架不订阅信号**，订阅是宿主的事；
2. `await handler.drain({ timeoutMs })`——拒新单 → 等在飞收尾 → 超时强制收口 SSE；
3. 编排器的**停机宽限必须大于** `timeoutMs`（compose 的话 `stop_grace_period`），否则宽限先到、
   容器被 SIGKILL，drain 等于没做；
4. store 的 `close()`（若有）排在 drain **之后**——drain 不关 store（同一个 store 可能被调度器
   或另一个宿主共用）。

第 1–2 步加「起监听」合起来约 20 行样板，里面藏着四个**静默错**（写错没人报、只在 K8s 滚动
更新那天发作）：连接没收干净（close 等满超时）、先 close 再 drain（切断在飞请求）、
`if (stopping) return` 吞掉第二次信号（运维强杀杀不掉 —— 信号**已被拦截**，Node 默认行为不会
发生）、停完不 exit。⇒ 用 `serve()` + `gracefulShutdown()` 把四条收进实现（2026-10-22 ref-serve-graceful-shutdown）：

```ts
import { gracefulShutdown, serve } from '@migor/agentia';

const { server, port } = await serve(handler, { port: PORT });
gracefulShutdown({
  server,
  drain: () => handler.drain({ timeoutMs: 15_000 }),
  signals: ['SIGTERM', 'SIGINT'],          // 不传 = 一个都不订阅
  onSecondSignal: () => process.exit(1),
  onShutdown: (clean) => { store.close(); process.exit(clean ? 0 : 1); },   // 关 store 排在最后
});
```

⚠️ 两个原语都**要宿主显式调用**——这不是「框架替你做进程级决策」：判据是**谁发起**，
与 Nest 的 `app.listen()` / `enableShutdownHooks()` 同构（那边信号订阅**也是显式 opt-in**）。

崩溃路径（没机会 drain）：挂起任务由下次启动的 `resumePending()` 兜回（§2）。

## 6. 资源上限（失控保险丝）

- 四个旋钮：`maxIterations` / `maxCostUsd` / `maxTotalTokens` / `deadline`——**没设值就没有保险丝**。
- 超限以 `budget_exceeded` 收尾并**算失败**（带结构化 error，不是静默截断）。
- 别与「上下文预算」（trim/compact 那族）混为一谈：一个是**钱的上限**，一个是窗口管理——见
  usage-guide §6.3。

## 7. 可观测

- **trace**：出口一条缝 `TraceSink { export(trace) }`，run 收尾必投递、sink 抛错不影响 run。
  缺省**不记 assistant 文本**（要 `traceContent:'full'`，注意脱敏）。
- **metrics**：进程内、不跨进程聚合；`GET /metrics` 需在 `createHttpHandler` 里显式传 `metrics`。
- 落库 / 采样 / 脱敏 / 日志关联 = **四配方**（[`docs/observability.md`](observability.md) +
  [`examples/observability/`](../examples/observability/)——配方包不进 npm，拷目录用）。
- 日志层**刻意不内建**（spec §9.3 锁定）——别等一个不会来的内置 logger。

## 8. 多副本

- 单机多进程：`SqliteTaskStore`（WAL + `busy_timeout`）可共库。
- 跨机多副本：`RedisTaskStore`——但仍受 §2 的**单宿主写者**前提约束：多副本**同时写**需要部署层
  协调（按 key 分片，或写路径收敛到单写者）。异步任务的 `ownerId` 认领语义能防双跑（同库的
  `resumePending` 按 `ownerId` 跳过别人的记录），但**不是**通用分布式锁。

## 9. 回滚

- 回退框架版本前：读**当前版本**的迁移小节（CHANGELOG）——迁移多为「新代码读旧数据」方向的；
  **反方向（旧代码读新数据）不保证**。
- 落盘记录的旧形状由 `parseTaskRecord` **读时归一**（已知改名有垫片，如 2026-09-28 ref-suspend-state-reason 的
  `awaiting_approval` → `suspended`），但这是**逐案维护**的清单，不是通用兼容承诺。
- 回退演练：拿 store 导出（如 `FileTaskStore` 的 JSONL）在新版本上 `agentia report` 一遍，确认
  读得回、状态认得出。

## 10. 上线前自检

- [ ] 版本**精确锁定**；目标 / 当前版本的迁移小节已读（§0）
- [ ] store 选型定了；`resumePending()` 已接进启动序列；做过一次**崩溃演练**（SIGKILL 后同库重启，
      `e2e-deploy` 的做法可以照抄）（§2）
- [ ] `authenticate` 已实现，或**明确决定**只有反代可达、并写进运维文档（§3）
- [ ] `/metrics` 的可达性已由反代限制（§3）
- [ ] `SIGTERM → drain` 已接线（手写的请逐条对 §5 那四个静默错）；停机宽限 > `timeoutMs`；
     store `close()` 排在 drain 后（§5）
- [ ] 四个预算旋钮至少设了 `maxTotalTokens`（§6）
- [ ] trace 的消费方式定了（四配方之一）；缺省不记 assistant 文本这点已知（§7）
- [ ] `/healthz` 已接负载均衡，`draining` 用于摘流量（§4）
- [ ] 多副本的话，写路径的协调方案定了（§8）
