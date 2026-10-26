# serve / gracefulShutdown：把「起服务 + 停机」从 35 行降到 8 行

- 日期：2026-10-22
- 状态：**已实现**（`src/transport/serve.ts` + `tests/transport/serve.test.ts` 13 例，变异 6/6）；
  待收口的是导出面、示例改造、文档与 §10 决策（见 §8）。
- 起因：宿主反馈「server 这块让用户写的好麻烦」。对照 `examples/deploy/src/main.ts`（108 行，
  其中约 35 行是与业务无关的 server 样板）与 NestJS 的 `NestFactory.create()` → `app.listen()`。
- 相关守卫：待补 `tests/transport/serve.test.ts`（新）；既有 `tests/transport/http*.test.ts` 不覆盖这一层。

## 1. 问题不是「行数」，是「写错没人报」

样板本身只是啰嗦；真正的成本是那 35 行里藏着四个**静默错**：

| 坑 | 写错的后果 |
|---|---|
| **连接没收干净** | `server.close()` 要等所有连接结束。⚠️ **版本有关**：Node **19.0.0** 起 `close()` 自己会收空闲连接（nodejs/node#43522，官方措辞「19 之后没必要再配合调 `closeIdleConnections()`，但调也无害」）⇒ 只有 **18.x** 上「不显式收 keep-alive」才会让它等满 `keepAliveTimeout`。旧版 Node 对「已连接但没发过请求」的裸 TCP 还需要 `closeAllConnections()` 兜底；2026-10-26 在 Node 26.5 实测它已能在预算前干净收掉裸 TCP / 半开请求，故测试按运行时分支，不再把旧行为写成跨版本不变量 |
| **先 close 再 drain** | 顺序反了会把在飞请求直接切断（`close()` 不再接受新连接，但已建立的连接仍可写；先 close 等于把「排空」这层保护作废） |
| **二次信号被吞** | `if (stopping) return;` 只是忽略，**信号已被拦截**，默认行为不会发生 ⇒ 运维第二次想强杀时杀不掉 |
| **超时后不退出** | `drain()` 返回 `false` 的含义是「本进程此后不再推进任何任务 ⇒ 宿主必须退出」（`drain-gate.ts` 的类头注释）；不退出会让停机窗口里已落库的记录永远停在 `running` |

⇒ 这四条每一条都不是「多写几行」能解决的，是**必须知道才会写**。

## 2. 非目标

- **不做 `serve(app, {...})` 一体化**：那会把 `createApp` / `AsyncRunner` / `createHttpHandler`
  三件事焊死。想把 agent 挂进已有 Express 的宿主（`createHttpHandler` 的既有卖点）反而用不上。
- **不自动订阅信号**：`createApp()` 里 `process.on('SIGTERM')` 是**替宿主做进程级决策**
  （spec 的成文纪律：不读 env、不做进程级决策）。要订阅必须是**宿主显式传 `signals`**。
- **不调用 `process.exit()`**：退出码与「关池 / 冲 sink 之后再退」是宿主的编排；本原语只在
  `onSecondSignal` 里把这个决定权交回去（不传 = 忽略第二次信号）。

## 3. API

```ts
// 起监听：createServer + listen + 拿实际端口（port: 0 时由 OS 分配）
export async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => unknown,
  opts: { port: number; host?: string; backlog?: number },
): Promise<{ server: Server; port: number; close(opts?: { timeoutMs?: number }): Promise<boolean> }>;

// 停机编排：返回幂等的 stop（第一次真跑，后续返回同一结果）
export function gracefulShutdown(opts: {
  server: Server;
  drain: () => Promise<boolean | void> | boolean | void;
  signals?: readonly NodeJS.Signals[];   // 不传 = 不订阅
  timeoutMs?: number;                    // 总预算，缺省 15_000
  onSecondSignal?: (signal: NodeJS.Signals) => void;  // 通常是 process.exit(1)
  onShutdown?: (clean: boolean) => void;              // 停机完成时回调一次（留给 process.exit 的缝）
}): () => Promise<boolean>;
```

宿主侧最终形态：

```ts
const handler = createHttpHandler(app, { runner, metrics });
const { server, port } = await serve(handler, { port: PORT });
gracefulShutdown({
  server,
  drain: () => handler.drain({ timeoutMs: 15_000 }),
  signals: ['SIGTERM', 'SIGINT'],
  onSecondSignal: () => process.exit(1),
  onShutdown: (clean) => process.exit(clean ? 0 : 1),
});
```

## 4. 边界：为什么这不算「做进程级决策」

与 NestJS 的对照（查的是官方 Lifecycle Events 页）：Nest 的 `app.listen()` 一行之所以成立，
是因为**它拥有 HTTP adapter**（Express/Fastify 在核心内）；而它**也不自动订阅信号** ——
`enableShutdownHooks()` 是显式 opt-in（官方理由：listener 占资源，一进程多实例会 listener 泄漏）。

⇒ 判据不是「框架 / 库」，也不是「有没有 listen 这个动作」，而是**谁发起**：

| 行为 | 谁发起 | 是否越界 |
|---|---|---|
| `createApp()` 内部 listen | 框架 | ❌ 越界 |
| 宿主写 `serve(handler, { port })` | 宿主 | ✅ 同 `app.listen()` |
| `createApp()` 内部 `process.on('SIGTERM')` | 框架 | ❌ 越界（spec 明写） |
| 宿主传 `signals: [...]` 给 `gracefulShutdown` | 宿主 | ✅ 同 `enableShutdownHooks()`，且**不传就不订阅** |

## 5. 实现要点

1. **顺序固定**：`drain()`（拒新单 + 等在飞）→ `server.close()` + `closeIdleConnections()`
   → 等 close 回调 → 超时 `closeAllConnections()`。顺序不可参数化 —— 反过来就是第 1 节的坑二。
   `closeIdleConnections()` **放在 `close()` 之后**（官方建议：避免两次调用之间新进的连接漏掉）；
   `engines` 是 `>=18` ⇒ 这行对 18.x 承重、对 ≥19 冗余，**只能用调用断言钉住**。
2. **一份预算**：`deadline = now + timeoutMs`，drain 与 close 共用（否则 15s + 15s = 30s，
   K8s 的 `terminationGracePeriodSeconds` 会被打穿）。2026-10-26 补上 drain 本身的等待闸：
   drain 永不返回时到期按 false 继续关服务器，不能只让 close 享受预算。
3. **drain 抛错仍然关 server**：排空失败按 false，不能因为业务排空失败就把监听继续挂着。
4. **幂等**：并发 / 重复 `stop()` 返回**同一个** in-flight promise（不是「第二次返回 false」——
   那会让调用方误以为没排干净）。
5. **`serve` 失败要响亮**：`EADDRINUSE` / `EACCES` 直接 reject，不 swallow（宿主 boot 阶段
   静默起不来比崩更难查）。

## 6. 变异清单（初版已实测；2026-10-26 补 drain 挂起与 Node 26 分支）

| # | 变异 | 实测（fail 数） |
|---|---|---|
| M1 | 删 `server.closeIdleConnections?.()` | 1（「Node 18 兼容契约」例；≥19 上只有调用断言能抓） |
| M2 | 删 `server.closeAllConnections?.()` | 旧版 Node 的「裸连接」+「预算耗尽」报 HUNG；Node 26 已会提前干净收口 |
| M3 | 删 `server.off('error', onError)` | 1（boot 的一次性 error 监听没摘掉） |
| M4 | `running ??=` → `running =` | 1（幂等例：drain 被跑了两次） |
| M5 | 二次信号分支改成直接 `return`（吞掉） | 1（只红「没给 onSecondSignal」那例 —— 给了的走不到这行） |
| M6 | drain 抛错就不关服务器 | 2 |
| M7 | 把 `closeServer` 提前到 `drain` 之前 | 1（drain 期间 `server.listening` 已是 false） |
| M8 | 删 `onShutdown?.(clean)` 调用 | 1 |
| M9 | drain 等待不过总预算 | 「drain 永不返回」用例 HUNG |

> M8 之外还补了 `onShutdown` 这个缝：本原语不 `process.exit`，但「停完就退」是宿主的刚需
> （`drain()` 返回 `false` 的契约就是「此后不再推进任何任务 ⇒ 必须退出」）⇒ 把结论回调出去。

⚠️ 原计划里「删 `closeIdleConnections()` → keep-alive 用例超时」这条**不成立**：本机 Node 22
的 `close()` 自己收空闲连接，行为断言抓不到。改成调用断言（并按运行时算期望次数：≥19 是 2 次，
Node 自己 1 次 + 我们 1 次；<19 是 1 次）⇒ 两个版本上删掉它都会红。

## 7. 验收

- `tests/transport/serve.test.ts` 全绿，且每条断言至少有对应变异（§6）；
- 本机 `npm test` 的 transport 子集绿（不整目录跑，见 `PITFALLS.md`）；
- `examples/deploy/src/main.ts` 与 `examples/complete/src/main.ts` 改用新原语后，
  `tsx scripts/e2e-deploy.ts` / `tsx scripts/e2e-examples.ts` 绿（含 `shutdownExitCode: 0`）；
- 文档：`usage-guide` 的优雅停机小节、`deployment.md` 的停机清单、`database.md` §7 三处同步。

## 8. 收口清单（实现之外还欠的）

1. `src/index.ts` 导出 `serve` / `gracefulShutdown` 及其两个 Options 类型（公共面变更 ⇒ 走 §10 + 版本节）；
2. `examples/deploy` / `examples/complete` 的 `main.ts` 改用新原语（停机样板从 ~35 行降到 ~8 行）；
3. `docs/usage-guide.md` 优雅停机小节、`docs/deployment.md` 停机清单、`docs/database.md` §7 同步；
4. 视情况在 `tests/docs/code-fences.test.ts` 里把新文档片段纳入真编译（若文档给了可编译示例）。
