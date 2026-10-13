import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  DEFAULT_RETRY,
  backoffDelay,
  resolveRetry,
  sleep,
  retryAllowed,
} from '../../src/engine/retry.js';
import type { RetryOptions } from '../../src/engine/retry.js';
import { MAX_TIMER_DELAY_MS } from '../../src/core/timeout.js';
import { streamTurn } from '../../src/engine/turn.js';
import { TraceRecorder } from '../../src/engine/tracer.js';
import { classifyError, runAgent } from '../../src/index.js';
import type { ModelClient } from '../../src/index.js';

describe('RetryOptions 归一（resolveRetry）', () => {
  it('undefined → 缺省开启，填入缺省值', () => {
    const r = resolveRetry(undefined);
    assert.ok(r);
    assert.equal(r.maxAttempts, DEFAULT_RETRY.maxAttempts);
    assert.equal(r.baseDelayMs, DEFAULT_RETRY.baseDelayMs);
    assert.equal(typeof r.isRetryable, 'function');
    assert.equal(typeof r.onRetry, 'function');
  });

  it('false / maxAttempts<1 → 关闭（null）', () => {
    assert.equal(resolveRetry(false), null);
    assert.equal(resolveRetry({ maxAttempts: 0 }), null);
  });

  it('用户值覆盖缺省，函数字段缺省注入', () => {
    const r = resolveRetry({ maxAttempts: 5, baseDelayMs: 10 });
    assert.ok(r);
    assert.equal(r.maxAttempts, 5);
    assert.equal(r.baseDelayMs, 10);
    assert.equal(r.maxDelayMs, DEFAULT_RETRY.maxDelayMs);
  });

  it('显式 undefined 的字段 → 回落到缺省值（「没给」与「给了个 undefined」不是一回事）', () => {
    // tsconfig 未开 exactOptionalPropertyTypes，所以 `{ maxAttempts: cfg.retries }` 这类
    // spread/透传组装出来的配置能带着 undefined 过类型检查、一路抵达这里。旧写法
    // `{...DEFAULT_RETRY, ...o}` 会让 undefined **覆盖**默认值：
    //  - maxAttempts 变 undefined → `!(undefined >= 1)` 成立 → **重试被静默关闭**，
    //    而 run 根快照记 config.retry.maxAttempts: 0（看着像用户主动关的）；
    //  - baseDelayMs 变 undefined → backoffDelay 每次算出 NaN，退避失效、trace 里
    //    `llm.retry.delayMs` 记 NaN。
    // 注意：`exactOptionalPropertyTypes` 之后这种字面量**已经编译不过**（这正是那个开关
    // 带来的第一道防线）。这里用 cast 模拟第二道：调用方从 JSON / 动态 spread 拼出来的
    // 配置带显式 undefined 时，`definedOnly` 必须仍然兜住（运行时防线不能省）。
    const r = resolveRetry({
      maxAttempts: undefined,
      baseDelayMs: undefined,
      maxDelayMs: undefined,
      jitter: undefined,
    } as unknown as RetryOptions);
    assert.ok(r, '不得被静默关闭');
    assert.equal(r.maxAttempts, DEFAULT_RETRY.maxAttempts);
    assert.equal(r.baseDelayMs, DEFAULT_RETRY.baseDelayMs);
    assert.equal(r.maxDelayMs, DEFAULT_RETRY.maxDelayMs);
    assert.equal(r.jitter, DEFAULT_RETRY.jitter);
    // 退避算得出来（NaN 会从这里冒出来）
    assert.equal(backoffDelay(2, { ...r, jitter: 0 }), DEFAULT_RETRY.baseDelayMs * 2);

    // 混合：显式 undefined 只回落到缺省，不牵连同一对象里的真实值
    const mixed = resolveRetry({
      maxAttempts: undefined,
      baseDelayMs: 10,
    } as unknown as RetryOptions)!;
    assert.equal(mixed.maxAttempts, DEFAULT_RETRY.maxAttempts);
    assert.equal(mixed.baseDelayMs, 10);
  });

  it('缺省 isRetryable 走 classifyError：429 可重试、普通错误不可', () => {
    const r = resolveRetry(undefined)!;
    // 鸭子类型分类：任何带数值 status=429 的错误都可重试（不限于 SDK 错误类）
    assert.equal(r.isRetryable(Object.assign(new Error('x'), { status: 429 })), true);
    assert.equal(r.isRetryable(new Error('boom')), false);
    assert.equal(classifyError(new Error('boom')).retryable, false);
    // 超时可重试（2026-09-17 起走 type:'timeout'，此前走 connection —— retryable 一直是 true）
    assert.equal(r.isRetryable(new DOMException('x', 'TimeoutError')), true);
    assert.equal(r.isRetryable(Object.assign(new Error('x'), { code: 'timeout' })), true);
  });
});

describe('RetryOptions 数值旋钮校验（2026-10-13 深评 A1：坏值必须响亮，不得静默）', () => {
  it('maxAttempts: NaN 曾静默关闭重试（`!(NaN >= 1)` 成立）—— 现在抛 TypeError', () => {
    assert.throws(() => resolveRetry({ maxAttempts: Number.NaN }), {
      name: 'TypeError',
      message: /非负安全整数/,
    });
    assert.throws(() => resolveRetry({ maxAttempts: Number.POSITIVE_INFINITY }), TypeError);
    assert.throws(() => resolveRetry({ maxAttempts: -1 }), TypeError);
    assert.throws(() => resolveRetry({ maxAttempts: 1.5 }), TypeError);
  });

  it('baseDelayMs / maxDelayMs：NaN、负数、超 Node 定时器上限一律抛', () => {
    assert.throws(() => resolveRetry({ baseDelayMs: Number.NaN }), {
      name: 'TypeError',
      message: /有限数/,
    });
    assert.throws(() => resolveRetry({ baseDelayMs: -1 }), TypeError);
    assert.throws(() => resolveRetry({ baseDelayMs: MAX_TIMER_DELAY_MS + 1 }), TypeError);
    assert.throws(() => resolveRetry({ maxDelayMs: Number.NaN }), TypeError);
    assert.throws(() => resolveRetry({ maxDelayMs: -1 }), TypeError);
    // 边界值合法：0 = 不退避 / 封顶为零（limits 表口径），上限本身可收
    assert.ok(resolveRetry({ baseDelayMs: 0 }));
    assert.ok(resolveRetry({ maxDelayMs: 0, baseDelayMs: 100 }));
    assert.ok(resolveRetry({ maxDelayMs: MAX_TIMER_DELAY_MS }));
  });

  it('jitter 超出 0~1 抛 TypeError（>1 会把退避拉成负数再被静默钳回 0）', () => {
    assert.throws(() => resolveRetry({ jitter: 1.5 }), { name: 'TypeError', message: /0 ~ 1/ });
    assert.throws(() => resolveRetry({ jitter: -0.1 }), TypeError);
    assert.ok(resolveRetry({ jitter: 0 }));
    assert.ok(resolveRetry({ jitter: 1 }));
  });

  it('runAgent 入口同款校验：配置错响亮抛出，不收成「失败的 run」更不谎报「用户取消」', async () => {
    // 深评 A1 的实测路径：`retry:{baseDelayMs:NaN}` + 429 曾 → stopReason:'aborted'
    const alwaysFail: ModelClient = {
      messages: {
        stream: () => ({
          on() {},
          finalMessage: async () => {
            throw Object.assign(new Error('429 too many'), { status: 429 });
          },
        }),
      },
    };
    await assert.rejects(
      () =>
        runAgent({
          messages: [{ role: 'user', content: 'hi' }],
          client: alwaysFail,
          retry: { baseDelayMs: Number.NaN },
        }),
      { name: 'TypeError', message: /retry\.baseDelayMs/ },
    );
    await assert.rejects(
      () =>
        runAgent({
          messages: [{ role: 'user', content: 'hi' }],
          client: alwaysFail,
          retry: { maxAttempts: Number.NaN },
        }),
      { name: 'TypeError', message: /retry\.maxAttempts/ },
    );
  });
});

describe('backoffDelay（指数 + 上限 + 抖动）', () => {
  const base = {
    ...DEFAULT_RETRY,
    maxAttempts: 5,
    jitter: 0,
    isRetryable: () => true,
    onRetry: () => {},
  };

  it('无抖动时按指数增长', () => {
    assert.equal(backoffDelay(1, base), 500);
    assert.equal(backoffDelay(2, base), 1000);
    assert.equal(backoffDelay(3, base), 2000);
  });

  it('封顶 maxDelayMs', () => {
    assert.equal(backoffDelay(10, base), 8000);
  });

  it('抖动落在 ±jitter 区间内', () => {
    const jittered = { ...base, jitter: 0.2 };
    for (let i = 0; i < 200; i++) {
      const d = backoffDelay(1, jittered); // 500 ± 20% → [400, 600]
      assert.ok(d >= 400 && d <= 600, `得到 ${d}`);
    }
  });

  it('正向抖动把退避推过 Node 定时器上限时夹回（超上限的 setTimeout 会被钳到 1ms）', () => {
    // maxDelayMs 贴上限 + jitter=1 ⇒ 抖动最高把 capped 翻倍（2 × 2^31-1），不夹就会让
    // sleep 的 assertTimerDelay 抛 RangeError —— 配置本身合法，不该死在派生值上
    const huge = {
      ...base,
      baseDelayMs: MAX_TIMER_DELAY_MS,
      maxDelayMs: MAX_TIMER_DELAY_MS,
      jitter: 1,
    };
    let sawClamped = false;
    for (let i = 0; i < 500; i++) {
      const d = backoffDelay(1, huge);
      assert.ok(d <= MAX_TIMER_DELAY_MS, `${d} 超上限`);
      if (d === MAX_TIMER_DELAY_MS) sawClamped = true;
    }
    assert.ok(sawClamped, '500 次采样应至少踩到一次「夹回上限」的分支');
  });
});

describe('sleep（可中断）', () => {
  it('正常等到点', async () => {
    // 单调时钟量时间（同 drain-gate / task-waiters）：墙钟截断到整毫秒且会漂移，
    // 用它量会把「等满了」读小；下界再留 10ms 余量，别写成「断言 == 预算」。
    const t0 = performance.now();
    await sleep(30);
    assert.ok(performance.now() - t0 >= 20);
  });

  it('中止立即 reject（AbortError）', async () => {
    const ac = new AbortController();
    const p = sleep(5000, ac.signal);
    ac.abort();
    await assert.rejects(p, (e: unknown) => (e as Error).name === 'AbortError');
  });

  it('已中止的 signal → 立即 reject，不等待', async () => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      sleep(5000, ac.signal),
      (e: unknown) => (e as Error).name === 'AbortError',
    );
  });
});

describe('retryAllowed —— 重试闸（从 streamTurn 的行内合取抽出）', () => {
  /** 夹具：只需 maxAttempts 与 isRetryable 两个字段，其余（退避配置）不参与本判定 */
  const cfg = { maxAttempts: 3, isRetryable: (e: unknown) => e === 'retryable' } as never;

  it('四项全满足 ⇒ 允许重试', () => {
    assert.equal(retryAllowed(cfg, 1, 'retryable', false), true);
  });

  it('重试关闭（cfg 为 null）⇒ 一律不重试', () => {
    assert.equal(retryAllowed(null, 1, 'retryable', false), false);
  });

  it('次数未尽：attempt 严格小于 maxAttempts（到顶那次不重试）', () => {
    assert.equal(
      retryAllowed(cfg, 2, 'retryable', false),
      true,
      'maxAttempts=3 时第 2 次失败仍可重试',
    );
    assert.equal(retryAllowed(cfg, 3, 'retryable', false), false, '第 3 次失败已到顶');
  });

  it('错误判定为不可重试 ⇒ 不重试（即使次数还有余量）', () => {
    assert.equal(retryAllowed(cfg, 1, 'fatal', false), false);
    assert.equal(retryAllowed(cfg, 1, new Error('x'), false), false);
  });

  it('**已吐出文本 ⇒ 一律不重试**（重复输出护栏：吐出去的字收不回来）', () => {
    assert.equal(retryAllowed(cfg, 1, 'retryable', true), false, '这一条压过其余三项');
  });
});

/**
 * 引擎侧（`turn.ts` 的重试循环）：**退避等待期间被取消**。
 *
 * 为什么单独钉：上面 `sleep(ms, signal)` 的纯件有取消用例（「中止立即 reject」），
 * 但**引擎怎么接住那声 reject** 没有被覆盖 —— `turn.ts` 在它外面套了 try/catch
 * ⇒ `aborted = true; break`，run 以 `stopReason='aborted'` 收尾。把那个 catch 拿掉，
 * 这声 AbortError 会从 run 里冒出去：调用方拿到的是**抛错**，而不是「被取消」这个
 * 结构化结论（本仓口径：取消也是结论，不是异常 — 见 loop-result 的四个具名出口）。
 *
 * 确定性：退避设 5000ms、50ms 时 abort。取消没被接住的话，这条要么等满 5s（超时红）、
 * 要么把 AbortError 抛出来（断言当场红）—— 两种都可见，不靠调度运气。
 */
describe('引擎侧：退避等待期间被取消（turn.ts 的重试循环）', () => {
  /** 每次 finalMessage 都抛的同款必失败 client（把 run 送进退避窗口） */
  function alwaysFail(err: unknown): ModelClient {
    return {
      messages: {
        stream: () => ({
          on() {},
          finalMessage: async () => {
            throw err;
          },
        }),
      },
    };
  }

  it('退避中 abort ⇒ 立刻以 aborted 收尾（不等满退避，也不把 AbortError 抛出去）', async () => {
    const ac = new AbortController();
    const retryAttempts: number[] = [];
    const started = Date.now();
    const pending = runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      client: alwaysFail(Object.assign(new Error('429 too many'), { status: 429 })),
      retry: {
        maxAttempts: 3,
        baseDelayMs: 5000,
        maxDelayMs: 5000,
        jitter: 0,
        onRetry: (info) => retryAttempts.push(info.attempt),
      },
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 50);
    const result = await pending;
    const elapsed = Date.now() - started;

    assert.deepEqual(retryAttempts, [1], '应当已安排好第 1 次重试退避（否则没踩到那个窗口）');
    assert.ok(elapsed < 2000, `退避期间取消必须立刻收尾，实际等了 ${elapsed}ms（退避是 5000ms）`);
    assert.equal(result.stopReason, 'aborted');
    assert.equal(result.error?.type, 'aborted', '取消是结构化结论，不是抛出去的异常');
  });
});

/**
 * 退避处 catch 的判别（2026-10-13 深评 A1）：`sleep` 不只抛 AbortError ——
 * `assertTimerDelay` 对坏延迟抛 RangeError。旧代码 `catch { aborted = true }` 把它
 * 吞成「用户取消」（实测 `retry:{baseDelayMs:NaN}` + 429 → stopReason:'aborted'）。
 * 入口校验落地后这条路本不该走到；这里绕过 resolveRetry 直接构造 hostile retryCfg，
 * 钉住「非 AbortError 必须原样抛出」这层纵深防御。
 */
describe('turn.ts 退避处 catch 只认 AbortError', () => {
  it('sleep 抛 RangeError（坏延迟）⇒ 原样抛出，不吞成 aborted', async () => {
    const recorder = new TraceRecorder();
    const rootId = recorder.begin('run', 't', null);
    const alwaysFail: ModelClient = {
      messages: {
        stream: () => ({
          on() {},
          finalMessage: async () => {
            throw Object.assign(new Error('429 too many'), { status: 429 });
          },
        }),
      },
    };
    const hostileRetry = {
      maxAttempts: 3,
      baseDelayMs: Number.NaN, // backoffDelay 算出 NaN ⇒ sleep 抛 RangeError
      maxDelayMs: 8000,
      jitter: 0,
      isRetryable: () => true,
      onRetry: () => {},
    };
    const ctx = {
      args: {
        client: alwaysFail,
        model: 'm',
        maxTokens: 100,
        maxIterations: 1,
        messages: [],
        tools: [],
        recorder,
        parentSpanId: rootId,
      },
      messages: [],
      apiTools: [],
      system: undefined,
      retryCfg: hostileRetry,
      pricing: {},
      unpricedSeen: new Set<string>(),
      budget: undefined,
      progress: { iterations: 0 },
      typed: undefined,
      submitted: false,
    } as never;
    // 旧行为：返回 { aborted: true }（谎报取消）；修复后：RangeError 原样冒出
    await assert.rejects(() => streamTurn(ctx), RangeError);
  });
});
