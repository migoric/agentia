import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  backoffMs,
  interruptibleSleep,
  isTimeoutError,
  MAX_TIMER_DELAY_MS,
  TIMED_OUT,
  TimeoutError,
  withTimeout,
} from '../../src/core/timeout.js';

/**
 * 共享超时原语（2026-09-17 单源化，见 `docs/spec.md` §10 2026-09-17 ref-mcp-timeout-single-source）。
 *
 * 为什么要**直接**单测它：这份原语此前散在两处 —— `engine/concurrency.ts` 与
 * `integrations/mcp.ts` 各写一份，于是「超时是硬的」那次收紧只落进前者，桥那一份
 * 继续用纯竞速判定，把超预算的调用记成成功、并在 trace 里落成 `errorKind=threw`。
 * 单源之后，这里的每一条都是**两个消费者共同**的性质；谁再想「就地改一处」，
 * 改的是别人也在用的东西，跑不过这里的门禁。
 */

describe('core/timeout：共享超时原语（engine 与桥共用）', () => {
  it('哨兵区别于「工具恰好返回了 undefined」', async () => {
    // 预算取 1000ms 而不是 50ms（plan 2026-10-17 §2.3）：`withTimeout` 的硬超时判据是
    // **实测耗时**（`src/core/timeout.ts:205`），而它在同步段记起点、在微任务里记终点
    // （:178 / :185）—— 宿主被饿住 50ms 时，**立即 resolve** 的 promise 也会被判成超时。
    // 这条验的是「哨兵可区分」（`TIMED_OUT` ≠ `undefined`），不是计时精度 ⇒
    // 预算取一个负载不可能吃掉的量级。⚠️ 别按「反正会立刻返回」把它调小。
    const out = await withTimeout(Promise.resolve(undefined), 1_000);
    assert.notEqual(out, TIMED_OUT);
    assert.equal(out, undefined);
  });

  it('预算非正数 = 不设超时，原样透传（不新建计时器、不改写结果）', async () => {
    const p = Promise.resolve('ok');
    assert.equal(await withTimeout(p, 0), 'ok');
    assert.equal(await withTimeout(Promise.resolve('ok'), -1), 'ok');
  });

  it('超时错误带 code="timeout"（引擎据此归 errorKind=timeout）', () => {
    const e = new TimeoutError('超了');
    assert.equal(e.code, 'timeout');
    assert.equal(e.name, 'TimeoutError');
    assert.equal(e instanceof Error, true);
  });

  it('isTimeoutError 认鸭子类型（使用者不必 import 这个类）', () => {
    assert.equal(isTimeoutError(new TimeoutError('x')), true);
    assert.equal(isTimeoutError(Object.assign(new Error('x'), { code: 'timeout' })), true);
    // 不得把「别的超时类」也算进来：只认框架约定的那一个 code
    assert.equal(isTimeoutError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), false);
    assert.equal(isTimeoutError(new Error('x')), false);
    assert.equal(isTimeoutError(null), false);
    assert.equal(isTimeoutError('timeout'), false);
  });
});

/**
 * 定时器延迟的**上界**（2026-09-28）。
 *
 * 待守形状：超过 `2^31-1`ms（约 24.86 天）的延迟 Node **不会遵守** —— 它只在 stderr 留一行
 * `TimeoutOverflowWarning`，随后把延迟**钳到 1ms**（实测：`delay=2^31` 在 200ms 内就触发、
 * `delay=2^31-1` 如期不触发）。于是「配 30 天超时」变成「每个调用立即超时」、
 * 「退避到限流窗口之后」变成「热重试」——**配置完全合法、行为完全相反**，且没人会看到那行警告。
 *
 * 为什么单源在 core：此前只有 `transport/scheduler.ts` 自备防线（every/at 各一条），
 * 而五处直喂 `setTimeout` 的站点（`withTimeout` / `interruptibleSleep` / `#raceTimeout` /
 * `composeSignal` / `DrainGate`）都没有 —— 「旋钮设了防，派生出来的等待没设防」。
 *
 * ⚠️ 分工是刻意的，别合并：**旋钮**（使用者配的）走 `assertTimerDelay`「拒」，
 * **外部数据**（上游的 `retry-after`）走 `clampTimerDelay`「夹」。
 */
describe('定时器上界：拒绝坏值，而不是静默钳制', () => {
  it('上限就是 Node 的 32 位有符号整数边界（2^31-1ms ≈ 24.86 天）', () => {
    assert.equal(MAX_TIMER_DELAY_MS, 2_147_483_647);
  });

  it('withTimeout：超上限 / NaN 抛错；边界内与原「非正」语义都不受影响', async () => {
    await assert.rejects(
      () => withTimeout(Promise.resolve('x'), MAX_TIMER_DELAY_MS + 1),
      /超过 Node 定时器延迟上限/,
      '超上限的延迟 Node 不遵守（钳到 1ms）⇒ 必须响亮拒绝，不能静默变成「立即超时」',
    );
    await assert.rejects(
      () => withTimeout(Promise.resolve('x'), Number.POSITIVE_INFINITY),
      /定时器延迟上限/,
    );
    await assert.rejects(
      () => withTimeout(Promise.resolve('x'), Number.NaN),
      /不能是 NaN/,
      'NaN 会被那句 `!(x > 0)` 静默读成「不设超时」，与使用者「我设了个预算」正好相反',
    );
    // 边界内合法：promise 立刻 settle，不会真等 24.86 天
    assert.equal(await withTimeout(Promise.resolve('ok'), MAX_TIMER_DELAY_MS), 'ok');
    // 阳性对照：上界校验不得动到「非正 = 不设超时」这条既有语义
    assert.equal(await withTimeout(Promise.resolve('ok'), 0), 'ok');
    assert.equal(await withTimeout(Promise.resolve('ok'), -1), 'ok');
  });

  it('interruptibleSleep：超上限 / NaN 抛错（同步抛，不是 reject）；非正仍是「不睡」', async () => {
    assert.throws(
      () => interruptibleSleep(MAX_TIMER_DELAY_MS + 1),
      /超过 Node 定时器延迟上限/,
      '超上限 ⇒ 睡 1ms 后立刻醒：「退避」静默变「热重试」',
    );
    assert.throws(
      () => interruptibleSleep(Number.NaN),
      /不能是 NaN/,
      'NaN 穿透 `ms <= 0`（NaN <= 0 是 false）直落 setTimeout ⇒ 同样被钳到 1ms',
    );
    // 阳性对照：「不睡」这条既有语义（先于 aborted 检查，被本文件与 sse-text-stats 钉着）
    await interruptibleSleep(0);
    await interruptibleSleep(-1);
  });

  it('backoffMs：上游给的荒谬 retry-after 被**夹**到上限 —— 不抛（那不是使用者的错）', () => {
    // 秒数形态：`Retry-After: 99999999` ⇒ 1e11 ms ⇒ 直通 setTimeout 就会被钳成 1ms
    assert.equal(backoffMs(1, '99999999'), MAX_TIMER_DELAY_MS);
    // HTTP-date 形态（可指到几个月后）同样夹
    assert.equal(
      backoffMs(1, new Date(Date.now() + 3_000_000_000).toUTCString()),
      MAX_TIMER_DELAY_MS,
    );
    // 阳性对照：正常值一个字节都不动
    assert.equal(backoffMs(1, '2'), 2000);
    // 指数退避那条路：底数封顶 8000，再叠 ±25% 抖动 ⇒ 落在 [6000, 10000]
    // （⚠️ 别断言 `<= 8000` —— 那是把「封顶」误当成「结果上界」，会 flaky 红）
    const exp = backoffMs(9, null);
    assert.ok(exp >= 6000 && exp <= 10_000, `指数退避应落在 [6000,10000]，实测 ${exp}`);
  });
});
