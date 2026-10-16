# 2026-10-17 修「与墙钟赛跑」的测试族（并发下 3/4 次红）

**依据**：本轮深度评估的实测 —— 完整套件连跑 5 次（1828 用例）**4 次红**，且每次红的用例不同。
这不是某条用例手滑，是**一族**用例共用一个错误假设。

## 0. 三条判据（本档自己的取舍，别绕过）

1. **不调「阈值数字」来掩盖**：把 30ms 抬到 300ms 只是把抖动窗口推远，**没有换判据**。凡是
   「必然会发生 N 次」这类断言，一律换成 `waitFor`（`tests/helpers.ts:88`，仓内既有工具，
   已用 34 处）等**真实事件**。
2. **只修「用墙钟断言必然性」的站点**：`sleep(5)` 这类用来**制造交错机会**的不动 —— 它断言的是
   「可能」而不是「必然」，放大它没有语义收益。
3. **修前实证 + 修后反向验证**：每处都要能说出「退回原写法 ⇒ 在负载下复现红」。

## 1. 现象（改前读数，`main` @ `b4c7aed`）

完整套件 `node --import tsx --test "tests/**/*.test.ts"` 连跑 5 次：

| 次数 | 红掉的用例 |
|---|---|
| 1 | `Scheduler.every.maxInFlight —— 0 读作「invalid」`（tests/limits.test.ts:427） |
| 2 | `tools/call 不起第二个计时器` · `StreamableHTTP：超时裁判权`（mcpConnector） |
| 3 | `timeout 到点 ⇒ 在飞请求以 TimeoutError 中止`（anthropic.test.ts:734） |
| 4 | `哨兵区别于「工具恰好返回了 undefined」`（core/timeout）· `TimeoutError 中止` |
| 5 | 全绿 |

随后 4 次复跑：`run1` 红（anthropic:734）、`run2` 红（limits:427 + 连带的父 suite）、
`run3` 红（anthropic:734）、`run4` 绿 ⇒ **7 次里 5 次红**。

⚠️ 已知先例：`tests/integrations/mcpConnector.test.ts:45-51` 的注释早已记录过同款
（「5s 预算曾把握手判成超时；并发跑时才现，单跑与 10 路 CPU 忙循环下都复现不出」）——
**本轮用 4 个 CPU burner 加压同样复现不出**，只有整仓并发跑才现。这与那条注释的结论一致。

## 2. 根因：三类，都不是「用例写错了逻辑」，而是**判据选错了**

### 2.1 用固定墙钟断言「必然发生 N 次」

`tests/limits.test.ts:421`（阳性对照 `Infinity = 关闸门`）：

```ts
const h = s.every(5, 'x', { maxInFlight: Infinity });
await sleep(40);          // ← 期望 40ms 内发生约 8 次 tick
h.cancel(); s.stop();
return calls.length;
...
assert.ok((await dispatch(Infinity)) > 1, '...每个 tick 都派发');
```

负载下 40ms 内事件循环可能只推进 1 次 tick ⇒ `calls.length === 1` ⇒ `> 1` 失败。
**实测错误**：`expected: true, actual: false`，duration 290ms（说明它确实在等）。

### 2.2 毫秒级预算短于「负载下建立一次本地往返」的时间

`tests/integrations/anthropic.test.ts:717`：

```ts
createAnthropicClient({ apiKey: 'sk-test', baseURL, timeout: 30 });
...
assert.equal(hits, 1, '超时中止不得再触发重试');
```

`hits === 0`（**假端点一次都没收到请求**）而 `err.name === 'TimeoutError'` 成立 ⇒
30ms 在负载下**短于连接建立**，超时发生在请出门口之前。断言意图（「不得重试」）没错，
错的是「用 30ms 保证请求必然已到达」。

### 2.3 微任务延迟被当成「实测耗时」

`src/core/timeout.ts:205` 的硬超时判据是 `settledAt - startedAt >= timeoutMs`，
而 `startedAt` 在**同步段**记录（:178）、`settledAt` 在**微任务里**记录（:185）。
宿主被饿住 50ms 时，`withTimeout(Promise.resolve(undefined), 50)` 判成超时 ⇒
`tests/core/timeout.test.ts:24`（「哨兵区别于『工具恰好返回了 undefined』」）红。

⚠️ **这是语义边界、不是缺陷**：`withTimeout` 的注释（:139-144）明确写了「超时是硬的 ——
21ms 完成 / 20ms 预算由成功变超时，这正确」。所以**不动源码**，只把用例的预算改成
「与这条判据的精度无关」的量级。

## 3. 修法（逐条）

| # | 站点 | 改法 | 为什么这样改 |
|---|---|---|---|
| 1 | `limits.test.ts:427`（阳性对照） | 用 `waitFor(() => calls.length > 1, …)` 替 `sleep(40)` | 断言的是「最终会多派发」，`waitFor` 正是这个语义（预算 10s，与负载无关） |
| 2 | `limits.test.ts:424`（缺省 1 那条） | `sleep(40)` → **保留**但抬到 `sleep(200)` 并在注释写明理由 | 它是否定断言（「**不**再派发」），没有事件可等 ⇒ 只能等「足够久」，而 40ms 只有 8 个 tick 的窗口，200ms = 40 个 tick |
| 3 | `anthropic.test.ts:717` | `timeout: 30` → `timeout: 300`，并在发起调用后用 `waitFor(() => hits >= 1)` 确认「请求真的到达了假端点」再等结果 | 把「30ms 内必然到达」换成「**到达是等出来的**」；下界断言随之改为 `>= 200`（证明等到计时器，不是别的理由立刻失败） |
| 4 | `core/timeout.test.ts:24` | 预算 `50` → `1_000`（并在注释写明：这条验的是**哨兵可区分**，不是计时精度） | 立即 resolve 的 promise 在 1s 内必然 settle，负载不可能饿住 1s |
| 5 | `mcpConnector.test.ts:748` | `timeoutMs: 30` → `timeoutMs: 300`，**同时**把慢调用从固定 `setTimeout(120)` 改成**测试掌控的闸门**（`await gate`，测试等 `timeoutMs` 过后再放行） | 原设计「30 vs 120」的比值只有 4×，绝对量级太小 ⇒ 抬预算会**同时**削弱区分力。换成闸门后：错误实现（把 timeoutMs 用在 call 上）会在 300ms 内 reject ⇒ **区分力更强**，而正确实现不受任何墙钟影响 |
| 6 | `scheduler.test.ts:162` | `await sleep(120)`（十来个 tick） → `waitFor(() => calls === 1, …)` + 再等一份固定窗口确认「不再有第 2 次」 | 同 #2 的否定断言模式 |

## 4. 实测验证结果

### 4.1 定向对照实验（饱和负载，`anthropic.test.ts`）

⚠️ 关键方法：**4 个 CPU burner 复现不出**（与 §1 那条既有注释的结论一致）——必须**饱和**
（32 核起 32 个 burner）才稳定复现。这是本档方法论上的一个教训：取证要按**核数**给负载。

| 版本 | 5 次跑的结果 |
|---|---|
| 旧版（`git show HEAD:` 原版：`timeout: 30`，无 `waitFor`） | **4 次红**（31 pass / 1 fail），1 次绿 |
| 新版（`timeout: 300` + `waitFor(hits >= 1)`） | **5 次全绿** |

文件在实验后逐字节还原（`sha256` 一致，脚本自检输出 `OK`）。

### 4.2 改动的直接验证

| 项 | 结果 |
|---|---|
| 受影响的 4 个测试文件（limits / timeout / scheduler / anthropic） | 91 用例 pass 0 fail |
| `mcpConnector.test.ts`（含改动的 #5） | 48 用例 pass 0 fail |
| `biome ci`（5 个改动文件） | 无诊断 |
| `npm run typecheck:tests` | 通过 |

### 4.3 收尾门禁

1. **完整套件连跑 6 次**全绿（修前同一命令 7 跑 5 红 ⇒ 对照组）。
2. `bash scripts/verify-all.sh` 八步全绿。

## 5. 不做的（如实标注）

- **不改 `src/`**：§2.3 的边界是**有意**的语义（硬超时），改源码就是改行为。
- **不引入假时钟**（如 `mock.timers`）：仓内既有多处**真时钟**依赖（跨进程 / 真实 SSE /
  子进程握手），引入假时钟会把「真实时序」这一层验证整体抽掉 —— 代价大于收益。
- **不批量改所有 `sleep(N)`**：见判据 2。
