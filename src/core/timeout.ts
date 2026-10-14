/**
 * Agentia —— 「等待的终点」超时原语（**单源**）。
 *
 * 为什么在 core：engine 的工具级超时（`engine/turn.ts`）与桥的 MCP 调用超时
 * （`integrations/mcp.ts`）**必须共用同一套判定**。此前两处各写一份，代价是
 * 2026-09-14 的「硬保证」收紧只落进了 `engine/concurrency.ts`，桥那一份继续用竞速判定 ——
 * 同一个承诺两套实现，于是同一个事件在 trace 里能有两种账（见 `docs/spec.md` §10 2026-09-17 ref-mcp-timeout-single-source）。
 * `integrations` 只能依赖 core（`tests/architecture/layering.test.ts` 强制），
 * 所以单源的落点是 core。core 是叶子：本文件只 import `limits.js`（**纯数据表，零 import**）
 * —— 2026-09-28 起它要 `zeroClauseOf`：两处 `assertTimerDelay` 的文案必须与 limits 表同源
 * （外部深评 C3/C4 的「单源断了一头」）。叶子性没变：数据表不引入任何运行期依赖，也不成环。
 */

import { zeroClauseOf } from './limits.js';

/** 超时哨兵：区分「超时」与「工具恰好返回了 undefined」 */
export const TIMED_OUT = Symbol('agentia.timed-out');

/**
 * Node 定时器延迟的**物理上限**：`2^31-1` ms（约 **24.86 天**）。
 *
 * 为什么它必须是单源（而不是各调用点各写一份）：超过这个值的延迟**不会「等那么久」** ——
 * Node 只会在 stderr 留一行 `TimeoutOverflowWarning`（`Timeout duration was set to 1`），
 * 然后把延迟**钳到 1ms**。于是「30 天后触发」变成「立刻触发」、「退避到限流窗口之后」
 * 变成「热重试打风暴」。实测（Node 22）：`delay = 2^31` 在 200ms 内触发并打警告，
 * 而 `delay = 2^31-1`（边界内）如期不触发。
 *
 * 本仓此前的处置是**每个旋钮各自设防**（`transport/scheduler.ts` 的 every/at 各一条，
 * 2026-09-19 复审加的），而「派生出来的等待」没有 —— 那些正是漏网的部分：
 * `withTimeout`（引擎 `toolTimeoutMs`）、`interruptibleSleep`（退避）、
 * `DrainGate.waitForIdle`（drain 预算）、`#raceTimeout`（`runTimeoutMs`）、
 * `composeSignal`（client `timeout`）五处都直喂 `setTimeout` 且只查「非负有限」。
 * 单源收在这里（见 `docs/spec.md` §10 2026-09-28 ref-timer-cap-single-source）。
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * 校验一个**将要喂给 `setTimeout` 的延迟**：`NaN` 与超过 [MAX_TIMER_DELAY_MS] 一律抛。
 *
 * 「拒绝」而不是「钳制」是刻意的 —— 钳制正是 Node 现在做的事（钳到 1ms），
 * 它把「远期」静默变成「立即」，是本条要消灭的那种失败模式。照 `Scheduler.at`
 * 的既有先例：超上限直接抛，让使用者在配置处就看见（远期等待请拆成多次自检）。
 *
 * ⚠️ **非正数不在此列**：`0` / 负数在调用点各有合法语义（「不设超时」/「一直等」/「不睡」），
 * 各按 `core/limits.ts` 的表读 —— 本函数只挡「物理上兑现不了」的值。
 * ⚠️ `NaN` 单独判并**必须排在调用点的「非正」早返回之前**：`!(NaN > 0)` 与 `NaN <= 0`
 * 都不成立或都成立得不一致，不先挡就会被静默读成另一种语义（见 `withTimeout` 处的注释）。
 */
export function assertTimerDelay(ms: number, where: string): number {
  if (Number.isNaN(ms)) {
    throw new RangeError(
      `${where} 不能是 NaN —— 它既不是「不限」也不是任何时长，` +
        `静默接受会把它读成另一件事（各旋钮 0 的含义见 core/limits.ts 的表）`,
    );
  }
  if (ms > MAX_TIMER_DELAY_MS) {
    throw new RangeError(
      `${where} 超过 Node 定时器延迟上限 ${MAX_TIMER_DELAY_MS}ms（约 24.86 天），收到 ${ms} —— ` +
        `超上限的延迟不会被遵守：Node 只在 stderr 留一行 TimeoutOverflowWarning，` +
        `随后把延迟钳到 1ms（远期变立即）。远期等待请拆成多次自检`,
    );
  }
  return ms;
}

/**
 * 把**外部数据**得出的延迟夹进可兑现区间（`retry-after` 等）。
 *
 * 与 [assertTimerDelay] 的分工是刻意的、别合并：
 * - 那个「**拒绝**」使用者配出来的坏值 —— 配置错误必须响亮，否则修法会被写歪；
 * - 这个「**夹**」上游回给我们的值 —— `Retry-After: 99999999` 不是使用者的错，
 *   为它抛错会把一次 429 升级成硬失败；但放它直通 `setTimeout` 会钳到 1ms，
 *   把「等限流窗口过去」变成「热重试」，那才是真危害。
 */
export function clampTimerDelay(ms: number): number {
  if (!(ms > 0)) return 0; // 含 NaN / 负数：调用点读 0 即「不睡」（见 limits 表）
  return ms > MAX_TIMER_DELAY_MS ? MAX_TIMER_DELAY_MS : ms;
}

/**
 * 超时错误（`code === 'timeout'`）。
 *
 * 为什么需要它：超时此前只能靠**错误文案**辨认 —— 桥抛的是普通 `Error`，而
 * `classifyError` 里没有 timeout 这一类，于是 trace 里记成 `error(unknown)` +
 * `errorKind=threw`，与引擎自己判的超时（`error(timeout)` + `errorKind=timeout`）
 * 成为同一事件的**两种账**（见 `docs/spec.md` §10 2026-09-17 ref-mcp-timeout-single-source）。
 *
 * 判定契约（对使用者可见）：**任何** `code === 'timeout'` 的错误都会被引擎归为
 * `errorKind='timeout'`，不需要 import 这个类（`isTimeoutError` 也认鸭子类型）。
 */
export class TimeoutError extends Error {
  readonly code: 'timeout' = 'timeout';
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * 造一个「已取消」错误：`name === 'AbortError'`（**不是** `TimeoutError` —— 取消不是超时，
 * `engine/errors.ts` 按 `name` 把它归进 aborted，loop 据此以 `aborted` 收尾）。
 *
 * 为什么要导出：这个形状此前**只**活在 `interruptibleSleep` 内部，于是别处需要「以取消收场」
 * 时只能各写各的（写成 `TimeoutError` 或干脆不 settle）。MCP stdio 桥的「已中止就不该发请求」
 * 正是这种场景（2026-09-21 外部复核），两处共用一份形状，免得口径漂开。
 */
export function abortError(message = '已被取消'): Error {
  return Object.assign(new Error(message), { name: 'AbortError' });
}

/**
 * 是否超时错误。三条判据（任一条成立即算，**全部是鸭子类型** —— 使用者不必 import 本模块）：
 *
 * 1. 本模块的 `TimeoutError` 实例（框架自己判的超时，如 MCP 桥的兜底）；
 * 2. `code === 'timeout'`（工具作者自报超时的推荐写法）；
 * 3. 内建 `DOMException` 的 `name === 'TimeoutError'` —— `AbortSignal.timeout()` 与默认 client 的
 *    超时合成信号（`integrations/anthropic.ts` 的 `composeSignal`）产出的就是它，`name` 是规范值、
 *    不受压缩影响。
 *
 * 为什么第 3 条也算：`engine/errors.ts` 的分类**此前只有它**认这一条（当时把超时归进 `connection`），
 * 于是「超时」在 trace 里混在「连不上」里，看板与 `trace-diff` 分不出两者。现在超时有自己的
 * `type: 'timeout'`，这条判据由分类与工具级记账**共用**，口径一致（spec §10 2026-09-17 ref-timeout-error-type）。
 */
export function isTimeoutError(e: unknown): boolean {
  if (e instanceof TimeoutError) return true;
  if (typeof e !== 'object' || e === null) return false;
  const o = e as { code?: unknown; name?: unknown };
  return o.code === 'timeout' || o.name === 'TimeoutError';
}

/**
 * 给一个 promise 套超时；超时返回 `TIMED_OUT`。
 *
 * ⚠️ **不取消底层** —— `AgentTool.run` 拿不到 signal（那会破坏现有签名），所以
 * 「超时」的语义是**放弃等待**：副作用可能已经发生，只是我们不等了。
 * 想真停下来的工具请自行读 `ToolRunContext.signal`（框架传了，但**不强制**工具中断
 * —— 见 core/tool.ts 的说明：工具副作用无法回滚）。
 *
 * **超时是硬的**（2026-09-14 收紧，见 `docs/spec.md` §10）：判定不看竞速结果，而看**实测耗时**。
 * 原因：`Promise.race` 不是硬保证 —— 两个计时器在同一毫秒内建、又因事件循环被饿住而同批到期时，
 * 列表顺序决定谁先 resolve，**超预算的工具能赢过截止计时器**（实测 `60ms 工具 vs 20ms 预算`
 * 在 8 倍 CPU 超订下 1200 次翻转 1 次，记成 `ok: true`，护栏静默失效）。
 * 代价是语义收紧：`21ms 完成 / 20ms 预算` 由「成功」变「超时」—— 这正确，
 * 「预算」本来就是对**实际耗时**的承诺，不是对调度运气的承诺。
 *
 * `timeoutMs` 非正数 = 不设超时（直接返回原 promise）。
 *
 * ⚠️ **截止计时器绝不可 `unref()`**（2026-09-14 修正，见 `docs/spec.md` §10 ④）：
 * 这个计时器的**触发本身就是「被 await 的 promise 得以 settle」的条件**。一旦 unref，
 * 当它是事件循环里唯一的把手时，进程会在它触发前直接退出 —— `await` **永不 settle**。
 * 实测（空事件循环、挂死的 promise，Node 22 与 26 一个样）：
 *
 * | 计时器 | 结果 |
 * |---|---|
 * | `unref()` | 进程退出（顶层 await 未 settle），**什么都没返回** |
 * | 不 unref | `settled: TIMED_OUT`，exit 0 |
 *
 * 「兜底计时器不该让宿主为它续命」这条理由对**没人 await 的兜底 tick**（scheduler 的下一拍、
 * SSE 心跳、metrics 刷盘）成立，对**「等待的终点」**不成立：那正是调用方在等的东西。
 */
export async function withTimeout<T>(
  p: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof TIMED_OUT> {
  // 坏值先挡（NaN / 超 2^31-1，见 assertTimerDelay）。⚠️ 必须排在下面那句
  // 「非正 = 不设超时」**之前**：那句的判据是 `!(timeoutMs > 0)`，而 NaN 满足它
  // ⇒ 会被**静默**读成「不设超时」，与使用者「我设了个预算」的预期正好相反
  // （桥还会因此起自己的 60s 兜底 ⇒ 双计时器、双账本，见 limits 表 withTimeout.ms 的 note）。
  // `0` / 负数不在此列 —— 它们是合法的「不设超时」，走下面那句原样透传。
  assertTimerDelay(
    timeoutMs,
    `withTimeout 的 timeoutMs（引擎 toolTimeoutMs / 桥兜底超时；${zeroClauseOf('withTimeout.ms')}）`,
  );
  if (!(timeoutMs > 0)) return p;
  // 单调钟（performance.now）：硬超时判定看的是**耗时**，墙钟（Date.now）会被
  // NTP 回拨/跳变扭曲 —— 回拨让 settledAt - startedAt 变负，超时的工具被记成 ok，
  // 恰是这段代码要防的静默失效。
  const startedAt = performance.now();
  // 在**工具 settle 的那个微任务里**记时间，而不是 `await` 恢复之后再记：
  // 微任务紧跟在 resolve 它的那次回调之后跑，所以这个时刻最贴近「工具真正完成」。
  // 若改成 await 恢复后再测，宿主在「工具完成 → 恢复」之间被饿住会把按时完成的工具误判成超时。
  let settledAt = 0;
  const tracked = p.then(
    (v) => {
      settledAt = performance.now();
      return v;
    },
    (e) => {
      settledAt = performance.now();
      throw e;
    },
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    const out = await Promise.race([
      tracked,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
        // ⚠️ 不 unref：它的触发是「这个 await 得以结束」的条件（详见函数头注释的实测表）。
        // unref 过它 ⇒ 空事件循环下进程先退出，await 永不 settle。
      }),
    ]);
    // 竞速只当快路径；最终以实测耗时兜底判定（见上面注释里的翻转样本）。
    if (out === TIMED_OUT) return TIMED_OUT;
    return settledAt - startedAt >= timeoutMs ? TIMED_OUT : out;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 可被 signal 中断的 sleep（**单源**）。
 *
 * 合并两处逐字相同的实现：`engine/retry.ts` 的 `sleep`（重试退避期间收到取消就
 * 不必再等）与 `integrations/anthropic.ts` 的 `interruptibleSleep`（client 层退避）。
 * 那边此前自带一段「与 engine/retry.ts 的 sleep 同语义但不复用它 —— 分层约束：
 * integrations 只能依赖 core」的注解：**正是那条约束把两份代码逼成了重复**，
 * 所以下沉到 core 是让它们合一的唯一合法落点（见 spec §10 2026-09-17 ref-mcp-timeout-single-source 的单源化口径）。
 *
 * ⚠️ 「不合并退避计算器」的例外只针对**引擎层**：`engine/retry.ts` 的 `backoffDelay`
 * 是 ±20% 均匀抖动、底数/上限来自 `RetryOptions`，与 client 层策略不同（见下方
 * `backoffMs` 的注释）—— 合一就是改行为。两条 client 之间的逐字复制不在此列：
 * 它们的 `backoffMs` 也已收进本文件。
 *
 * `abortMessage` 参数化而非统一：文案是**调用方语境**（引擎说「run 已被取消」，
 * client 说「请求已被取消」），两者都会出现在用户眼前的报错里。为去重把两句话
 * 改成一句，是拿可读性换整洁度。
 *
 * 抛的是 `name === 'AbortError'` 的错误（而非 `TimeoutError`）：取消不是超时，
 * `engine/errors.ts` 按 `name` 把它归进「已中止」，`loop` 据此以 `aborted` 收尾。
 *
 * ⚠️ **`ms <= 0` = 「不睡」（立即 resolve），且这一判先于 aborted 检查** —— 别把它
 * 「修」成「已中止就该 reject」。这是本仓库统一的「非正数 = 机制关掉」口径，与
 * `withTimeout(p, 0)` 的「不设超时、原样透传」对称：预算 ≤0 时这次等待压根不存在，
 * 也就没有「被中断」可言（取消会在**下一步**（下一个 fetch / 下一轮循环）照常浮出来）。
 * 已有用例钉住这个语义：`tests/core/sse-text-stats.test.ts`（已中止 + `ms<=0` 仍 resolve）
 * 与 `tests/core/timeout.test.ts`（`withTimeout` 预算非正数）。2026-09-19 的外部复核
 * 曾把它当「一致性缺口」改反过一次，被这条用例拦住 —— 保留该用例，别删。
 */
export function interruptibleSleep(
  ms: number,
  signal?: AbortSignal,
  abortMessage = '已被取消',
): Promise<void> {
  // 坏值先挡（NaN / 超 2^31-1）：这句**先于**下面的 `ms <= 0`，因为 `NaN <= 0` 是 false
  // —— 它会穿透那句直落 `setTimeout(fn, NaN)`，被 Node 钳成 1ms ⇒「退避」静默变成
  // 「立刻重试」；超上限同理（钳到 1ms）。`0` / 负数仍是合法的「不睡」，
  // 且「先于 aborted 检查」那条次序（被用例钉着）不受影响 —— 见函数头注释。
  assertTimerDelay(
    ms,
    `interruptibleSleep 的 ms（重试退避；${zeroClauseOf('interruptibleSleep.ms')}）`,
  );
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    // 已中止：立即 reject（此处 timer 尚未创建，绝不能去 clear）
    if (signal?.aborted) {
      reject(abortError(abortMessage));
      return;
    }
    function onAbort(): void {
      clearTimeout(timer);
      reject(abortError(abortMessage));
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * client 层重试的退避毫秒（两条内置适配器**共用**的单源）：`retry-after`（秒数或
 * HTTP-date）优先；否则指数退避 `min(500 × 2^(attempt-1), 8000)` ±25% 抖动
 * （attempt 从 1 起 = 第一次重试）。
 *
 * ⚠️ **不要**与 `engine/retry.ts` 的 `backoffDelay` 合并（2026-09-17 去重时明确留下的
 * 例外 —— 那条例外针对的是**引擎层**，不是这里）：两者形似而策略不同，合一就是改行为。
 * 本函数 ±25% 固定抖动、且**优先尊重 `retry-after`**（限流窗口是上游说了算，框架不该
 * 拿自己的指数曲线去猜）；那个是 ±jitter（缺省 ±20%）的均匀抖动、底数与上限来自
 * `RetryOptions`，且它在引擎层（client 放弃之后的兜底重试）。
 *
 * 本函数此前在 `anthropic.ts` 与 `openai.ts` 各存一份逐字相同的副本 —— 「不合并」的
 * 例外从来不覆盖 client↔client 的逐字复制（引擎那条理由不适用于同层），两份相同代码
 * 只会各自漂移。
 */
export function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    // ⚠️ `retry-after` 是**上游数据**，可以大到兑现不了（`Retry-After: 99999999` ⇒ 1e11 ms）。
    // 这里走 clampTimerDelay（夹）而不是 assertTimerDelay（拒）：为上游的荒谬值把一次 429
    // 升级成硬失败是错的；而放它直通 setTimeout 会被钳到 1ms，把「等限流窗口过去」
    // 变成「热重试打风暴」—— 那才是真危害。两条分支都要夹（HTTP-date 可以指到几个月后）。
    if (Number.isFinite(secs)) return clampTimerDelay(Math.max(0, Math.round(secs * 1000)));
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return clampTimerDelay(Math.max(0, at - Date.now()));
    // 解析不了就回落指数退避
  }
  const base = Math.min(500 * 2 ** Math.max(0, attempt - 1), 8000);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}
