/**
 * **limits 语义的集中对账**（`docs/guards.md` §2 第一条待守形状的机器守卫）。
 *
 * 待守形状：`0` 的双重语义 —— 同一个 `0`，在 `drain` 里是「不限」、在 `maxRetries` 里是
 * 「不重试」、在 `Scheduler.every` 里是**配置错误**。历史事故：`drain({ timeoutMs: 1 })`
 * 跨过 deadline 后**永不返回**（调用方与实现各按一套读法猜）。
 *
 * 这个文件只做一件事：拿 `src/core/limits.ts` 的那张表，去**驱动真实站点**逐条对账。
 * 所以它有两条性质，缺一不可：
 *
 * 1. **穷尽**：`PROBES` 的类型是 `Record<LimitKnob, …>` ⇒ 表里加了旋钮而没加探针，
 *    `typecheck:tests` 直接红（不是「忘了补文档」，是构建失败）。
 * 2. **真跑**：每个探针调的是**那个 API 本身**（`new AsyncRunner(...)`、`mapWithConcurrency(...)`、
 *    `resolveTraceLimits(...)`），不是在本文件里复刻一遍判定 —— 复刻出来的绿只能证明
 *    「我抄对了」，证明不了产物。这也是本仓对测试的既有口径（见 `e2e-cli` 那条：
 *    字面跑产物自己的命令）。
 *
 * ⚠️ 探针必须能把声明的读法**与相邻读法区分开**，否则它只是走过场。例如
 * `runTimeoutMs: 0` 的探针不能只断言「构造没抛错」（那对 `unlimited` / `disabled` 都成立），
 * 而要断言「任务真的没被打断」；`Scheduler.every(0)` 的探针必须断言**抛错**
 * （那才对 `invalid` 成立）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncRunner, createBudgetGuard, executeRun } from '../src/index.js';
import type { AgentTool, AppCallable, Trace, TraceRecordEvent } from '../src/index.js';
import { LIMIT_SEMANTICS, type LimitKnob, type ZeroMeaning } from '../src/core/limits.js';
import { interruptibleSleep, withTimeout, TIMED_OUT } from '../src/core/timeout.js';
import { mapWithConcurrency } from '../src/engine/concurrency.js';
import { runAgent } from '../src/engine/loop.js';
import { resolveTraceLimits, TraceRecorder } from '../src/engine/tracer.js';
import { backoffDelay, resolveRetry } from '../src/engine/retry.js';
import { toolInputPayload } from '../src/engine/tool-events.js';
import { resolveMaxRetries } from '../src/integrations/adapter-options.js';
import { createAnthropicClient } from '../src/integrations/anthropic.js';
import { metricsSink } from '../src/integrations/metrics.js';
import { DrainGate } from '../src/transport/drain-gate.js';
import { Scheduler } from '../src/transport/scheduler.js';
import { TaskEventStreams } from '../src/transport/task-events.js';
import { createHttpHandler } from '../src/transport/http.js';
import { sseWriter } from '../src/transport/sse.js';
import type { ServerResponse } from 'node:http';
import { endTurnMsg, mockClient, toolUseMsg, waitFor } from './helpers.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 一条最小的 run trace（run 根 + `labels.tenant` 属性 + 给定 token 数）——
 * 只为驱动 metricsSink 的归因标签路径（探针要断言「折叠真的发生、且量不丢」，
 * 得有量可数）。
 */
function labelTrace(tenant: string, tokens: number): Trace {
  return {
    traceId: 't-label',
    rootSpanId: 'root-label',
    status: 'ok',
    totalUsage: {
      inputTokens: tokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    spans: [
      {
        spanId: 'root-label',
        traceId: 't-label',
        parentSpanId: null,
        kind: 'run',
        name: 'agent.run',
        startedAt: 0,
        endedAt: 1,
        status: 'ok',
        attributes: { 'labels.tenant': tenant },
        events: [],
      },
    ] as never,
  };
}

/** 一个「跑得慢但会成功」的 app：用来观察 runTimeoutMs 到底有没有把任务砍掉 */
function slowApp(ms: number): AppCallable {
  return {
    name: 'slow',
    async run() {
      await sleep(ms);
      return {
        run: { runId: 'r', status: 'succeeded' as const },
        result: { finalText: 'ok' },
      } as never;
    },
  };
}

/** 模拟背压的假 res：write() 恒回报「没消费完」，writableLength 随写入增长 */
function stalledRes(): ServerResponse & { out: string; ended: boolean; writableLength: number } {
  const rec = {
    out: '',
    ended: false,
    writableLength: 0,
    writeHead() {
      return rec as unknown as ServerResponse;
    },
    write(chunk: string) {
      rec.out += chunk;
      rec.writableLength += chunk.length;
      return false;
    },
    end() {
      rec.ended = true;
    },
  };
  return rec as unknown as ServerResponse & typeof rec;
}

const OBJ = { type: 'object', properties: {} } as const;

/** 真路径 HITL app（同 `tests/transport/approval.test.ts` 的夹具口径：走真引擎） */
function hitlApp(): AppCallable {
  const { client } = mockClient([toolUseMsg('danger', {}, 'tu1'), endTurnMsg('t1 done')]);
  const tools: AgentTool[] = [
    {
      name: 'danger',
      description: '危险操作',
      inputSchema: OBJ,
      approval: 'required',
      run: () => 'done',
    },
  ];
  return {
    name: 'hitl',
    run: (messages, opts) => executeRun({ messages, client, tools, ...opts }),
  };
}

async function pollUntil(runner: AsyncRunner, taskId: string, status: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rec = await runner.poll(taskId);
    if (rec?.status === status) return;
    if (Date.now() > deadline)
      throw new Error(`等 ${taskId} 进 ${status} 超时（现 ${rec?.status}）`);
    await sleep(5);
  }
}

/**
 * 每个旋钮一支探针：**跑真站点**，返回实测出来的 0 语义。
 *
 * 返回值必须用证据得出，而不是「我知道它是这个」（不许直接 `return 'unlimited'` 了事 ——
 * 下面的断言就是证据本身；`assert` 抛了就说明实测与声明不符）。
 */
const PROBES: Record<LimitKnob, () => Promise<ZeroMeaning>> = {
  // ── 0 = 不限 ────────────────────────────────────────────────────────────
  async 'AsyncRunner.runTimeoutMs'() {
    // 坏值响亮失败（否则 NaN/Infinity 会被 setTimeout 钳到 1ms ⇒ 每个任务立即「超时」）
    assert.throws(
      () => new AsyncRunner(slowApp(10), { runTimeoutMs: Number.POSITIVE_INFINITY }),
      /有限数/,
      '坏值必须抛错',
    );
    // 0 放行，且**真的不限**：任务活过一段远超任何「立即超时」的观察窗
    const runner = new AsyncRunner(slowApp(400), { runTimeoutMs: 0 });
    const t = runner.submit('x');
    await sleep(200);
    assert.equal(
      (await runner.poll(t.taskId))?.status,
      'running',
      '0 必须读作「不限」：任务不该在 0ms 预算下被砍掉',
    );
    await runner.awaitTask(t.taskId);
    return 'unlimited';
  },

  async 'AsyncRunner.approvalTimeoutMs'() {
    assert.throws(
      () => new AsyncRunner(hitlApp(), { approvalTimeoutMs: Number.NaN }),
      /有限数/,
      '坏值必须抛错',
    );
    // 0 = 不限：挂起后不会被「超时兜底拒绝」收掉，而是一直等人
    const runner = new AsyncRunner(hitlApp(), { approvalTimeoutMs: 0 });
    const t = runner.submit('x');
    await pollUntil(runner, t.taskId, 'suspended');
    await sleep(250);
    assert.equal(
      (await runner.poll(t.taskId))?.status,
      'suspended',
      '0 必须读作「不限」：挂起不该被自动拒绝',
    );
    return 'unlimited';
  },

  async 'AsyncRunner.drain.timeoutMs'() {
    const gate = new DrainGate();
    let idle = false;
    const waiting = gate.waitForIdle(() => idle, 0);
    // 0 = 一直等：非空闲时**不能**立刻返回 false（历史事故正是这里读错）
    const raced = await Promise.race([
      waiting.then(() => 'settled' as const),
      sleep(150).then(() => 'still-waiting' as const),
    ]);
    assert.equal(raced, 'still-waiting', '0 必须读作「一直等」，而不是「已到点立刻返回 false」');
    // 归零后被唤醒（证明上面那个「还在等」是真的在等，而不是卡死）
    idle = true;
    gate.signalIdle(() => idle);
    assert.equal(await waiting, true, '归零应唤醒等待者');
    return 'unlimited';
  },

  async 'mapWithConcurrency.limit'() {
    const ran: number[] = [];
    const out = await mapWithConcurrency([1, 2, 3], 0, async (n) => {
      ran.push(n);
      return n * 2;
    });
    // 0 worker 会让 fn 一次都不调、results 全是 undefined，而调用方拿到「成功」的空结果
    assert.deepEqual(ran, [1, 2, 3], '0 必须读作「不限」：三项都要真跑到');
    assert.deepEqual(out, [2, 4, 6]);
    return 'unlimited';
  },

  // ── 0 = 机制关掉 / 一次都不做 ───────────────────────────────────────────
  async 'traceLimits.maxEvents'() {
    assert.throws(() => resolveTraceLimits({ maxEvents: -1 }, 'x'), /非负安全整数/);
    assert.deepEqual(resolveTraceLimits({ maxEvents: 0 }, 'x'), { maxEvents: 0 }, '0 是有意义的值');
    // 0 = 一条都不记（**不是**「不限条数」）：真记一笔 span，事件数必须还是 0
    const rec = new TraceRecorder({ maxEvents: 0 });
    const root = rec.begin('run', 'app', null);
    rec.setAttribute(root, 'k', 'v');
    rec.event(root, 'e', {});
    rec.end(root, { status: 'ok' });
    const events = rec.snapshot('ok').spans[0]!.events;
    assert.equal(
      events.filter((e) => e.name === 'e').length,
      0,
      '0 必须读作「一条都不记」—— 若读成「不限」，这里会是 1 条 e 事件',
    );
    // 但「少记了」这件事本身必须留下痕迹（有计数才叫可解释）：设计上是**两笔**同名簿记
    // （起点标记 `{ limit }` 标断点 + 收尾摘要 `{ droppedEvents, limit }` 报计数，见 `TraceLimits`）
    const marks = events.filter((e) => e.name === 'trace.truncated');
    assert.equal(marks.length, 2, 'maxEvents:0 应留两笔 trace.truncated（起点标记 + 收尾摘要）');
    assert.deepEqual(marks[0]!.body, { limit: 0 }, '起点标记只带上限 —— 断点在这里');
    const summary = marks[1]!.body as { limit: number; droppedEvents: number };
    assert.equal(summary.limit, 0, '摘要里的 limit 应如实反映生效的上限');
    assert.ok(summary.droppedEvents >= 1, '丢了多少条必须有计数');
    return 'disabled';
  },

  async maxRetries() {
    assert.throws(
      () => resolveMaxRetries(Number.NaN, 'x'),
      /非负安全整数/,
      'NaN ⇒ 无限重试，必须拦',
    );
    // 0 = 不重试（与「不限」相反）：必须放行，且解析出来的就是 0
    assert.equal(resolveMaxRetries(0, 'x'), 0, '0 = 不重试，是有意义的值');
    return 'disabled';
  },

  async 'RetryOptions.maxAttempts'() {
    // NaN 曾让 `!(NaN >= 1)` 成立 ⇒ 重试被静默关闭（2026-10-13 深评 A1）
    assert.throws(() => resolveRetry({ maxAttempts: Number.NaN }), /非负安全整数/);
    assert.throws(() => resolveRetry({ maxAttempts: 1.5 }), /非负安全整数/);
    assert.throws(() => resolveRetry({ maxAttempts: -1 }), /非负安全整数/);
    // 0 = 关闭重试（不是「不限」：重试没有「不限」的读法 —— 无限重试是事故不是语义）
    assert.equal(resolveRetry({ maxAttempts: 0 }), null, '0 必须读作「关闭重试」');
    assert.ok(resolveRetry({ maxAttempts: 1 }), '1 = 只试一次（仍是一条合法配置）');
    return 'disabled';
  },

  async 'RetryOptions.jitter'() {
    assert.throws(() => resolveRetry({ jitter: 1.5 }), /0 ~ 1/);
    assert.throws(() => resolveRetry({ jitter: Number.NaN }), /0 ~ 1/);
    // 0 = 不加抖动（机制关掉）：退避必须等于无抖动的确定值，而不是「抖动失效报错」
    const r = resolveRetry({ baseDelayMs: 100, maxDelayMs: 8000, jitter: 0 })!;
    assert.equal(backoffDelay(1, r), 100, '0 = 不加抖动：退避必须逐字等于指数值');
    assert.equal(backoffDelay(3, r), 400);
    return 'disabled';
  },

  async maxEventChars() {
    const body = { a: 'x'.repeat(50) };
    const use = { id: 'tu1', name: 't', input: body } as never;
    const off = toolInputPayload(use, false);
    const full = toolInputPayload(use, JSON.stringify(body).length);
    const zero = toolInputPayload(use, 0);
    assert.ok(off.input.includes(body.a), 'false = 不截断：全文必须在场');
    assert.ok(zero.input.length < full.input.length, '0 不是「不截断」—— 它把正文截得更短');
    assert.ok(zero.input.length < off.input.length);
    return 'disabled';
  },

  async 'runAgent.maxIterations'() {
    const { client, seen } = mockClient([toolUseMsg('t', {}), endTurnMsg('never reached')]);
    const r = await runAgent({
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 't', description: 't', inputSchema: OBJ, run: () => 'ok' }],
      client,
      maxIterations: 0,
    });
    // 0 = 一次都不跑：模型请求压根没发出（不是「不限次」）
    assert.equal(seen.length, 0, 'maxIterations:0 必须读作「一次都不跑」—— 不该发出任何模型请求');
    assert.equal(r.stopReason, 'max_iterations', `实际 stopReason=${r.stopReason}`);
    return 'disabled';
  },

  async 'withTimeout.ms'() {
    // 非正 = 不设超时、原样透传：预算被忽略，拿回的是原 promise 的值而不是 TIMED_OUT
    const ok = await withTimeout(
      sleep(30).then(() => 'ok' as const),
      0,
    );
    assert.equal(ok, 'ok', '非正必须透传：若读成「立即超时」这里会是 TIMED_OUT');
    assert.notEqual(ok as unknown, TIMED_OUT);
    return 'disabled';
  },

  // ── 0 = 立即执行 ────────────────────────────────────────────────────────
  async 'RetryOptions.baseDelayMs'() {
    // NaN 曾让 backoffDelay 算出 NaN ⇒ sleep 抛 RangeError ⇒ 被吞成「用户取消」（深评 A1）
    assert.throws(() => resolveRetry({ baseDelayMs: Number.NaN }), /有限数/);
    assert.throws(() => resolveRetry({ baseDelayMs: -1 }), /有限数/);
    assert.throws(() => resolveRetry({ baseDelayMs: 2 ** 31 }), /有限数/, '超 Node 定时器上限必拒');
    // 0 = 不退避（立即重试）：任何 attempt 算出的退避都是 0
    const r = resolveRetry({ baseDelayMs: 0, jitter: 0 })!;
    assert.equal(backoffDelay(1, r), 0, '0 必须读作「不退避」—— 若读成别的这里非零');
    assert.equal(backoffDelay(5, r), 0);
    return 'immediate';
  },

  async 'RetryOptions.maxDelayMs'() {
    assert.throws(() => resolveRetry({ maxDelayMs: Number.NaN }), /有限数/);
    assert.throws(() => resolveRetry({ maxDelayMs: -1 }), /有限数/);
    // 0 = 封顶为零：再大的指数退避也被压到 0（立即重试）
    const r = resolveRetry({ baseDelayMs: 1000, maxDelayMs: 0, jitter: 0 })!;
    assert.equal(backoffDelay(5, r), 0, '0 必须读作「封顶为零」—— 若读成「不限」这里会是 16000');
    return 'immediate';
  },

  async 'interruptibleSleep.ms'() {
    const t0 = Date.now();
    await interruptibleSleep(0);
    assert.ok(Date.now() - t0 < 50, '非正 = 不睡（立即 resolve）');
    return 'immediate';
  },

  async 'metricsSink.intervalMs'() {
    // 0 = 立即导出：export() 当场发请求并交回 Promise（由框架 await）
    const trace = { traceId: 't1', rootSpanId: 's1', status: 'ok', spans: [], totalUsage: {} };
    const zero = metricsSink({
      export: 'otlp',
      endpoint: 'http://127.0.0.1:9',
      intervalMs: 0,
      onExportError: () => undefined,
    });
    const ret = zero.export(trace as never);
    zero.stop();
    assert.ok(
      ret instanceof Promise,
      'intervalMs:0 必须读作「立即导出」（返回 Promise 交给框架 await）',
    );
    await ret.catch(() => undefined); // 端点不存在：失败交 onExportError，不抛给测试

    // 对照组：>0 只累加，由定时器负责导出 ⇒ export() 返回 undefined
    const every = metricsSink({
      export: 'otlp',
      endpoint: 'http://127.0.0.1:9',
      intervalMs: 60_000,
      onExportError: () => undefined,
    });
    const none = every.export(trace as never);
    every.stop();
    assert.equal(none, undefined, 'intervalMs>0 应只累加，不在 export() 里导出');
    return 'immediate';
  },

  // ── 0 = 不限（数量旋钮：全表第二个 `unlimited`，与直觉的「一条都不许排」相反）──
  async 'AsyncRunner.maxQueued'() {
    // 声明的读法是 `zero: 'unlimited'`（0 = 不设排队上限）—— 与直觉的 `disabled`
    // （0 = 一条都不许排）**正好相反**，所以探针要把两者分开：concurrency 1 之下灌 3 条，
    // 读成 unlimited ⇒ 全部受理；读成 disabled ⇒ 第 2 条当场抛。
    const runner = new AsyncRunner(slowApp(20), { concurrency: 1, maxQueued: 0 });
    const ids = [runner.submit('a'), runner.submit('b'), runner.submit('c')];
    assert.equal(ids.length, 3, 'maxQueued: 0 必须**照收**（若读成 disabled，第 2 条就抛了）');
    await runner.drain({ timeoutMs: 5_000 });
    assert.equal(runner.queued, 0, '排空后计数归零（不然「不限」是假的：额度被泄漏光了）');
    return 'unlimited';
  },

  // ── 0 = 非法配置（响亮失败）─────────────────────────────────────────────
  async 'AsyncRunner.concurrency'() {
    assert.throws(() => new AsyncRunner(slowApp(1), { concurrency: 0 }), /必须为正数/);
    assert.throws(() => new AsyncRunner(slowApp(1), { concurrency: -2 }), /必须为正数/);
    return 'invalid';
  },

  async 'Scheduler.every.intervalMs'() {
    const scheduler = new Scheduler(new AsyncRunner(slowApp(1)));
    assert.throws(() => scheduler.every(0, 'x'), /必须为正有限数/);
    assert.throws(() => scheduler.every(Number.NaN, 'x'), /必须为正有限数/);
    return 'invalid';
  },

  async 'Scheduler.every.maxInFlight'() {
    // 0 / 负数：闸门判据是 `inFlight.size >= maxInFlight` ⇒ 0 时**恒真**，每次 tick 都跳过，
    // 周期任务「既不跑也不失败」。与 `AsyncRunner.concurrency` 同族，同款构造期响亮失败。
    const scheduler = new Scheduler(new AsyncRunner(slowApp(1)));
    assert.throws(() => scheduler.every(10, 'x', { maxInFlight: 0 }), /必须为正数/);
    assert.throws(() => scheduler.every(10, 'x', { maxInFlight: -1 }), /必须为正数/);

    // 证据（不是「我知道」）：用一个只记派发次数的 runner 真跑一段。
    // 任务停在 running ⇒ 缺省 1 会在首次派发后把闸门占满，而 Infinity = 关闸门、每 tick 都派发。
    /**
     * 真跑一段并等「派发次数」达到预期 —— 等的是**事件**，不是墙钟。
     *
     * ⚠️ 原写法是 `await sleep(40)` 后断言次数（plan 2026-10-17 §2.1）：5ms 的 tick 间隔下
     * 40ms 只有 8 个 tick 的窗口，满载 runner 上事件循环一次饿住，就能把「Infinity 每 tick
     * 都派发」判成只派发 1 次（实测：完整套件连跑 7 次里 1 次红在这条）。
     *
     * `holdMs` 只给**否定断言**用（「不得再派发」没有事件可等，只能等「足够久」）——
     * 那种窗口要按 tick 间隔的**倍数**给（200ms = 40 个 tick），不是拍一个数。
     */
    const dispatch = async (
      maxInFlight: number | undefined,
      atLeast: number,
      holdMs = 0,
    ): Promise<number> => {
      const calls: number[] = [];
      const stub = {
        submit: () => ({ taskId: `t${calls.push(calls.length)}`, status: 'running' as const }),
        poll: (taskId: string) => ({ taskId, status: 'running' as const }),
      };
      const s = new Scheduler(stub as never);
      const h = s.every(5, 'x', maxInFlight === undefined ? {} : { maxInFlight });
      await waitFor(() => calls.length >= atLeast, `调度器应至少派发 ${atLeast} 次`, 5_000);
      if (holdMs > 0) await sleep(holdMs);
      h.cancel();
      s.stop();
      return calls.length;
    };
    assert.equal(await dispatch(undefined, 1, 200), 1, '缺省 1：首个任务占满闸门后不再派发');
    assert.ok(
      (await dispatch(Number.POSITIVE_INFINITY, 2)) > 1,
      'Infinity = 关闸门（合法）：每个 tick 都派发 —— 阳性对照，防「一律抛错」蒙过这条',
    );
    return 'invalid';
  },

  async 'HttpHandlerOptions.maxBodyBytes'() {
    // 判据是 `size > maxBytes` ⇒ 0 时任何字节都超限 ⇒ 所有带 body 的请求 413
    // （实测 POST /run 带 {} / {"a":1} 都是 413）。与同一接口里的 maxConcurrentRuns
    // （0 ⇒ 全部 503）同款：配置错误，构造期响亮失败。
    assert.throws(() => createHttpHandler(slowApp(1), { maxBodyBytes: 0 }), /必须为正数/);
    assert.throws(() => createHttpHandler(slowApp(1), { maxBodyBytes: -1 }), /必须为正数/);
    assert.throws(() => createHttpHandler(slowApp(1), { maxBodyBytes: Number.NaN }), /必须为正数/);
    // 阳性对照：缺省（1 MiB）与 Infinity（不限）都必须仍构造成功
    assert.equal(typeof createHttpHandler(slowApp(1)), 'function', '缺省必须构造成功');
    assert.equal(
      typeof createHttpHandler(slowApp(1), { maxBodyBytes: Number.POSITIVE_INFINITY }),
      'function',
      'Infinity = 不限，必须构造成功',
    );
    return 'invalid';
  },

  async 'HttpHandlerOptions.maxConcurrentRuns'() {
    // 闸门判据是 `inFlightRuns >= maxConcurrentRuns`：0 / 负数时恒真 ⇒ 全部 503；
    // NaN 时恒假 ⇒ 闸门静默失效。存量旋钮，2026-09-27 补登记进表（此前没进真源）。
    assert.throws(() => createHttpHandler(slowApp(1), { maxConcurrentRuns: 0 }), /必须为正数/);
    assert.throws(() => createHttpHandler(slowApp(1), { maxConcurrentRuns: -1 }), /必须为正数/);
    assert.throws(
      () => createHttpHandler(slowApp(1), { maxConcurrentRuns: Number.NaN }),
      /必须为正数/,
    );
    // 阳性对照：缺省（32）与 Infinity（无上限）都必须仍构造成功
    assert.equal(typeof createHttpHandler(slowApp(1)), 'function', '缺省必须构造成功');
    assert.equal(
      typeof createHttpHandler(slowApp(1), { maxConcurrentRuns: Number.POSITIVE_INFINITY }),
      'function',
      'Infinity = 无上限，必须构造成功',
    );
    return 'invalid';
  },

  async 'SseWriterOptions.maxBufferedBytes'() {
    // 判据是**写入前**的 `pending > limitBytes` ⇒ 0 时第 1 帧照写、**第 2 帧必收口**
    // （实测：closed=true / ended=true / onBackpressure 回调 1 次）—— 流活不过一帧。
    assert.throws(() => sseWriter(stalledRes(), { maxBufferedBytes: 0 }), /必须为正数/);
    assert.throws(() => sseWriter(stalledRes(), { maxBufferedBytes: -1 }), /必须为正数/);
    // 透传那条也要在**构造期**拦（不然要等第一个 SSE 请求才炸，那时响应头已写出）
    assert.throws(
      () => createHttpHandler(slowApp(1), { sseMaxBufferedBytes: 0 }),
      /必须为正数/,
      'createHttpHandler 的 sseMaxBufferedBytes 透传也必须在构造期拦',
    );
    // 阳性对照：Infinity = 不限 —— 必须构造成功，且连写两帧都**不因积压收口**
    const w = sseWriter(stalledRes(), { maxBufferedBytes: Number.POSITIVE_INFINITY });
    w.event('a', 1);
    w.event('b', 2);
    assert.equal(w.closed, false, 'Infinity = 不限：连写两帧都不该收口');
    return 'invalid';
  },

  async 'createAnthropicClient.timeout'() {
    assert.throws(() => createAnthropicClient({ timeout: 0 }), /正的有限毫秒数/);
    assert.throws(() => createAnthropicClient({ timeout: -1 }), /正的有限毫秒数/);
    // 「不限」的表达是**不传**，而不是传 0 —— 与 runTimeoutMs 相反，这条差别必须钉住
    const client = createAnthropicClient({ apiKey: 'k' });
    assert.equal(typeof client.messages.stream, 'function', '不传 timeout = 不限，必须构造成功');
    return 'invalid';
  },

  async 'metricsSink.windowSize'() {
    assert.throws(() => metricsSink({ windowSize: 0 }), /必须为正数/);
    assert.throws(() => metricsSink({ maxCapabilities: 0 }), /必须为正数/);
    return 'invalid';
  },

  async 'metricsSink.maxLabelValues'() {
    assert.throws(() => metricsSink({ maxLabelValues: 0 }), /必须为正数/);
    assert.throws(() => metricsSink({ maxLabelValues: -1 }), /必须为正数/);
    // 正数放行且真的生效：cap=1 时第二个相异值折叠进 __other__（见 metrics 用例的完整对账）
    return 'invalid';
  },

  async 'metricsSink.maxLabelCombos'() {
    assert.throws(() => metricsSink({ labelKeys: ['tenant'], maxLabelCombos: 0 }), /必须为正数/);
    assert.throws(() => metricsSink({ labelKeys: ['tenant'], maxLabelCombos: -1 }), /必须为正数/);
    // 与相邻读法区分开：不是「0 = 不限」也不是「0 = 关掉折叠」—— 0 是配置错误（抛），
    // 正数放行且**真的生效**：cap=2 时第 3 个组合必须折进同一个全 __other__ 的桶，
    // 且量不丢（三条 run 的 tokens 之和 == 全局 tokens）。
    const m = metricsSink({ labelKeys: ['tenant'], maxLabelCombos: 2 });
    for (const tenant of ['a', 'b', 'c']) m.export(labelTrace(tenant, 10));
    const s = m.snapshot();
    const combos = Object.keys(s.runLabels);
    assert.deepEqual(combos.sort(), ['tenant=__other__', 'tenant=a', 'tenant=b']);
    assert.equal(s.droppedLabelCombos, 1, '第 3 个组合必须计数（静默折叠不算守卫）');
    assert.equal(
      Object.values(s.runLabels).reduce((n, a) => n + a.tokens, 0),
      s.tokens,
      '折叠只丢标签粒度，不丢量',
    );
    return 'invalid';
  },

  async 'AsyncRunner.streamBufferEvents'() {
    // 坏值一律构造期抛 TypeError（走 AsyncRunner 公共旋钮 —— 它内部构造 TaskEventStreams）。
    // ⚠️ NaN 必须单拎出来：旧实现 `Math.max(1, NaN)` = NaN，随后 `length > NaN` 恒假
    // ⇒ 内存闸静默失效；这条探针若只测 0/负数，NaN 那路就没人守。
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => new AsyncRunner(slowApp(1), { streamBufferEvents: bad }),
        TypeError,
        `streamBufferEvents: ${String(bad)} 必须抛 TypeError（0 读作 invalid，不是静默抬成 1）`,
      );
    }
    // 与相邻读法区分开：disabled（0 放行 = 机制关掉）不成立 —— 上面 0 已抛；
    // 正整数放行且**真的生效**：上限 2 的缓冲推 3 条，最旧那条必须被丢（不静默）。
    const streams = new TaskEventStreams({ maxEvents: 2 });
    streams.open('t1');
    const ev = { type: 'span.begin' } as never;
    streams.push('t1', ev);
    streams.push('t1', ev);
    streams.push('t1', ev);
    const replayed = streams.replay('t1');
    assert.equal(replayed.events.length, 2, '上限 2 必须真的拦住第三条');
    assert.equal(replayed.droppedBefore, 2, '丢了最旧一条必须明示（droppedBefore = 2）');
    return 'invalid';
  },

  async 'TaskEventStreams.retainTerminal'() {
    // 坏值一律构造期抛 TypeError。⚠️ NaN 的失效方向与 maxEvents **相反**：判定是
    // `excess <= 0 提前返回` ⇒ NaN 恒假 ⇒ 全部无订阅者的终态流被清空（保留机制静默失效）。
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => new TaskEventStreams({ retainTerminal: bad }),
        TypeError,
        `retainTerminal: ${String(bad)} 必须抛 TypeError`,
      );
    }
    // 0 读作 disabled：不留终态流（终态即忘）。
    const zero = new TaskEventStreams({ retainTerminal: 0 });
    zero.open('t1');
    zero.markDone('t1');
    assert.equal(zero.has('t1'), false, 'retainTerminal: 0 ⇒ 终态流立即被淘汰');
    // 正整数真的生效：留 1 条时，第二个终态把第一个（最旧、无订阅者）淘汰。
    const one = new TaskEventStreams({ retainTerminal: 1 });
    one.open('t1');
    one.markDone('t1');
    one.open('t2');
    one.markDone('t2');
    assert.equal(one.has('t1'), false, '超出保留条数 ⇒ 最旧的终态流被淘汰');
    assert.equal(one.has('t2'), true, '保留条数内的终态流必须还在');
    return 'disabled';
  },

  async 'TaskEventStreams.nonTerminalBuffers'() {
    // 坏值一律构造期抛 TypeError（走 AsyncRunner 公共旋钮 —— 内部构造 TaskEventStreams，
    // 这样两处接线一起被驱动；方向与 retainTerminal 相反的那半见下面的 0）。
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => new AsyncRunner(slowApp(1), { streamNonTerminalBuffers: bad }),
        TypeError,
        `streamNonTerminalBuffers: ${String(bad)} 必须抛 TypeError`,
      );
    }
    // 0 读作 disabled：**非终态流不留回放缓冲**（只有实时转发）。判据必须是「回放拿不到东西」+
    // 「表项还在」—— 只断言「构造没抛」对 disabled/unlimited 都成立，那是走过场。
    // ⚠️ 这一条同时是「回收缓冲 ≠ 删表项」的钉子：连表项一起删的话，has() 会变 false，
    // 而后果是恢复段重开一条 nextIndex=1 的流（拿 Last-Event-ID 续订的读者从此静默收不到东西）。
    const evt = (n: number): TraceRecordEvent => ({
      type: 'span.attribute',
      seq: n,
      spanId: 's',
      key: 'k',
      value: n,
    });
    const zero = new TaskEventStreams({ nonTerminalBuffers: 0 });
    zero.open('t1');
    zero.push('t1', evt(1));
    const replayed = zero.replay('t1');
    assert.deepEqual(replayed.events, [], 'nonTerminalBuffers: 0 ⇒ 没人读的流不留回放缓冲');
    assert.equal(replayed.droppedBefore, 2, '缺口必须明示（droppedBefore = 下一条的序号）');
    assert.equal(zero.has('t1'), true, '0 回收的是缓冲，表项留着（任务确实还在本进程）');
    // 正整数真的按**条数**生效：配额 1 时第二条流的缓冲把第一条（最旧、无订阅者）挤掉。
    const one = new TaskEventStreams({ nonTerminalBuffers: 1 });
    one.open('t1');
    one.push('t1', evt(1));
    one.open('t2');
    one.push('t2', evt(1));
    assert.deepEqual(one.replay('t1').events, [], '超出配额 ⇒ 最旧的非终态流缓冲被回收');
    assert.equal(one.replay('t2').events.length, 1, '配额内的流缓冲必须还在');
    return 'disabled';
  },
  // ── 0 = 立即触发（第一次记账就撞线）─────────────────────────────────────
  async 'BudgetGuardOptions.maxTotalTokens'() {
    const guard = createBudgetGuard({ maxTotalTokens: 0 });
    const usage = (inputTokens: number) => ({
      totalUsage: { inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    // 0 用量的那一笔**不**撞线（判据是严格大于）—— 这条同时钉住「0 不是「一进来就失败」」
    assert.equal(guard.check(usage(0)), null, '0 用量不该撞线（严格大于）');
    assert.equal(
      guard.check(usage(1)),
      'tokens',
      '0 必须读作「第一次记账就超预算」；读成「不限」这里会是 null',
    );
    return 'immediate';
  },

  async 'BudgetGuardOptions.maxCostUsd'() {
    const guard = createBudgetGuard({ maxCostUsd: 0 });
    const usage = (costEstimate: number) => ({
      totalUsage: {
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costEstimate,
      },
    });
    assert.equal(guard.check(usage(0)), null, '零成本不该撞线');
    assert.equal(
      guard.check(usage(0.001)),
      'cost',
      '0 必须读作「第一笔成本就超」；读成「不限」这里会是 null',
    );
    return 'immediate';
  },
  // ── 0 = 非法配置（基数封顶；0 让所有条目折进同一个桶）───────────────────
  async 'metricsSink.maxCapabilities'() {
    assert.throws(() => metricsSink({ maxCapabilities: 0 }), /必须为正数/);
    return 'invalid';
  },

  async 'metricsSink.maxModels'() {
    assert.throws(() => metricsSink({ maxModels: 0 }), /必须为正数/);
    return 'invalid';
  },

  async 'metricsSink.maxScores'() {
    assert.throws(() => metricsSink({ maxScores: 0 }), /必须为正数/);
    return 'invalid';
  },
};

/**
 * `badValue: 'rejects-nan'` 旋钮的对账探针（2026-10-09 补：此前 A4 只穷尽 `throws` 类，
 * 这两个旋钮的 NaN 闸只有 tests/engine/budget.test.ts 在守，对账表这一层是空的）。
 *
 * 键的类型从表本身 `Extract` 出来 ⇒ 表里新增一条 rejects-nan 旋钮而漏了探针，
 * `typecheck:tests` 当场红（与 PROBES 同款机制）；运行期互查见下面的用例。
 *
 * 每条探针要断两个方向，缺一不可：
 * 1. **NaN 构造期被拒**（`x > NaN` 恒 false ⇒ 闸静默失效，方向与「设了个上限」相反）；
 * 2. **0 / 负数 / ±Infinity 照旧放行**（与 `throws` 类区分开 —— 它们都有合法读法；
 *    0 的语义本身由上面 PROBES 里那条「0 读作 immediate」的探针守）。
 */
type RejectsNanKnob = Extract<
  (typeof LIMIT_SEMANTICS)[number],
  { badValue: 'rejects-nan' }
>['knob'];

const REJECTS_NAN_PROBES: Record<RejectsNanKnob, () => void> = {
  'BudgetGuardOptions.maxTotalTokens': () => {
    assert.throws(
      () => createBudgetGuard({ maxTotalTokens: Number.NaN }),
      (e: unknown) =>
        e instanceof RangeError && /maxTotalTokens 收到 NaN/.test((e as Error).message),
      'NaN 必须构造期抛 RangeError（闸否则会静默失效）',
    );
    assert.doesNotThrow(
      () => createBudgetGuard({ maxTotalTokens: 0 }),
      '0 = 第一次记账就超预算（合法）',
    );
    assert.doesNotThrow(() => createBudgetGuard({ maxTotalTokens: -1 }), '负数同理放行');
    assert.doesNotThrow(
      () => createBudgetGuard({ maxTotalTokens: Number.POSITIVE_INFINITY }),
      'Infinity = 不限（合法）',
    );
  },
  'BudgetGuardOptions.maxCostUsd': () => {
    assert.throws(
      () => createBudgetGuard({ maxCostUsd: Number.NaN }),
      (e: unknown) => e instanceof RangeError && /maxCostUsd 收到 NaN/.test((e as Error).message),
      'NaN 必须构造期抛 RangeError（闸否则会静默失效）',
    );
    assert.doesNotThrow(() => createBudgetGuard({ maxCostUsd: 0 }), '0 = 第一笔成本就超（合法）');
    assert.doesNotThrow(() => createBudgetGuard({ maxCostUsd: -1 }), '负数同理放行');
    assert.doesNotThrow(
      () => createBudgetGuard({ maxCostUsd: Number.POSITIVE_INFINITY }),
      'Infinity = 不限（合法）',
    );
  },
};

describe('limits 语义单一真源：表 ↔ 真实站点逐条对账（guards §2 待守形状①）', () => {
  for (const sem of LIMIT_SEMANTICS) {
    it(`${sem.knob} —— 0 读作「${sem.zero}」（${sem.where}）`, async () => {
      const observed = await PROBES[sem.knob]();
      assert.equal(
        observed,
        sem.zero,
        `${sem.knob}：limits 表声明 zero=${sem.zero}，实测=${observed}。` +
          `表与实现漂了 —— 要么改实现，要么改表（${sem.where}）`,
      );
    });
  }

  it('构造期报错文案里的「0 = …」取自同一张表（不是各写一份）', async () => {
    // 这条守的是「单源」本身：文案与表若各写一份，改了表文案不会跟着改
    const cases: Array<[LimitKnob, () => unknown, RegExp]> = [
      [
        'AsyncRunner.runTimeoutMs',
        () => new AsyncRunner(slowApp(1), { runTimeoutMs: -1 }),
        /0 = 不限/,
      ],
      [
        'AsyncRunner.approvalTimeoutMs',
        () => new AsyncRunner(hitlApp(), { approvalTimeoutMs: -1 }),
        /0 = 不限/,
      ],
      ['maxRetries', () => resolveMaxRetries(-1, 'x'), /0 = 不重试/],
      [
        'traceLimits.maxEvents',
        () => resolveTraceLimits({ maxEvents: 1.5 }, 'x'),
        /0 = 一条都不记/,
      ],
      [
        'AsyncRunner.streamBufferEvents',
        () => new AsyncRunner(slowApp(1), { streamBufferEvents: 0 }),
        /0 没有「缓冲几条」的读法/,
      ],
      // 下面两条是 2026-09-26 补的：`Scheduler.every` 的校验此前**手写**文案，
      // 表里那两句 `zeroClause` 没有任何调用点 ⇒ 表说「有构造期校验的旋钮由实现代码
      // 直接插进错误消息里」，对它两条都不成立（单源断了一头）。
      [
        'Scheduler.every.intervalMs',
        () => new Scheduler(new AsyncRunner(slowApp(1))).every(0, 'x'),
        /0 会空转/,
      ],
      [
        'Scheduler.every.maxInFlight',
        () => new Scheduler(new AsyncRunner(slowApp(1))).every(10, 'x', { maxInFlight: 0 }),
        /0 = 没有在飞名额/,
      ],
      [
        'HttpHandlerOptions.maxBodyBytes',
        () => createHttpHandler(slowApp(1), { maxBodyBytes: 0 }),
        /0 = 每个带 body 的请求都 413/,
      ],
      [
        'HttpHandlerOptions.maxConcurrentRuns',
        () => createHttpHandler(slowApp(1), { maxConcurrentRuns: 0 }),
        /0 = 全部 503/,
      ],
      [
        'SseWriterOptions.maxBufferedBytes',
        () => sseWriter(stalledRes(), { maxBufferedBytes: 0 }),
        /0 = 流活不过一帧/,
      ],
      // 下面 8 条是 2026-09-28 外部深评 C4 补的：它们都声明了 `badValue: 'throws'`，
      // 却一直没有对账 case（**表说「有构造期校验」，而校验文案里有没有那句「0 = …」没人核**）。
      [
        'AsyncRunner.concurrency',
        () => new AsyncRunner(slowApp(1), { concurrency: 0 }),
        /0 = 没有 worker/,
      ],
      [
        'AsyncRunner.maxQueued',
        () => new AsyncRunner(slowApp(1), { maxQueued: -1 }),
        /0 = 不限（不设排队上限）/,
      ],
      ['withTimeout.ms', () => withTimeout(Promise.resolve(1), Number.NaN), /非正 = 不设超时/],
      ['interruptibleSleep.ms', () => interruptibleSleep(Number.NaN), /非正 = 不睡/],
      [
        'createAnthropicClient.timeout',
        () => createAnthropicClient({ timeout: 0 }),
        /不设 = 不限；0 = 非法/,
      ],
      ['metricsSink.windowSize', () => metricsSink({ windowSize: 0 }), /0 = 窗口里什么都没有/],
      [
        'metricsSink.maxLabelValues',
        () => metricsSink({ maxLabelValues: 0 }),
        /0 = 一个标签值都认不下/,
      ],
      [
        'metricsSink.maxLabelCombos',
        () => metricsSink({ maxLabelCombos: 0 }),
        /0 = 一个标签组合都认不下/,
      ],
      [
        'TaskEventStreams.retainTerminal',
        () => new TaskEventStreams({ retainTerminal: -1 }),
        /0 = 不留终态流/,
      ],
      [
        'TaskEventStreams.nonTerminalBuffers',
        () => new TaskEventStreams({ nonTerminalBuffers: -1 }),
        /0 = 不为没人读的非终态流保留回放缓冲/,
      ],
      // 这三条是同一天补登进表时**被 A4 逼出来**的（第一次跑就红 —— 正是它该做的事）
      [
        'metricsSink.maxCapabilities',
        () => metricsSink({ maxCapabilities: 0 }),
        /0 = 一个能力都认不下/,
      ],
      ['metricsSink.maxModels', () => metricsSink({ maxModels: 0 }), /0 = 一个模型都认不下/],
      ['metricsSink.maxScores', () => metricsSink({ maxScores: 0 }), /0 = 一个分数都认不下/],
      // 2026-10-13 深评 A1 补登的四个 retry 旋钮（与 maxRetries 同纪律，文案插 zeroClauseOf）
      ['RetryOptions.maxAttempts', () => resolveRetry({ maxAttempts: -1 }), /0 = 关闭重试/],
      ['RetryOptions.jitter', () => resolveRetry({ jitter: 2 }), /0 = 不加抖动/],
      ['RetryOptions.baseDelayMs', () => resolveRetry({ baseDelayMs: -1 }), /0 = 不退避/],
      ['RetryOptions.maxDelayMs', () => resolveRetry({ maxDelayMs: -1 }), /0 = 退避封顶为零/],
    ];
    for (const [knob, run, expected] of cases) {
      const clause = LIMIT_SEMANTICS.find((s) => s.knob === knob)?.zeroClause ?? '';
      assert.match(clause, expected, `表里 ${knob} 的 zeroClause 应含 ${String(expected)}`);
      const re = new RegExp(clause.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      // 坏值在**同步**站点上表现为 throw，在 **async** 站点上表现为 rejection（`withTimeout` 是
      // `async function`：`assertTimerDelay` 的 RangeError 包在返回的 promise 里）—— 两种都要认，
      // 而且都要「真的炸了」才算数（原来只 `assert.throws`：async 站点会被记成
      // 「Missing expected exception」，那不是「没炸」，是「炸在了另一条通道上」）。
      let syncError: unknown;
      let pending: Promise<unknown> | undefined;
      try {
        const out = run();
        if (out instanceof Promise) pending = out;
        else syncError = new Error('没有抛错（同步站点）');
      } catch (e) {
        syncError = e;
      }
      if (pending) {
        await assert.rejects(pending, re, `${knob}：async 站点应以 rejection 报出同一句文案`);
      } else {
        assert.match(
          String((syncError as Error | undefined)?.message),
          re,
          `${knob}：文案要对上表`,
        );
      }
    }

    // A4 · **单向穷尽**（2026-09-28 外部深评 C4 的正是这条）：每个声明「坏值抛错」的旋钮都必须
    // 有一条 case。原先这里是个 `Array`：新增一个 throws 旋钮却忘了对账，**不会有任何东西红**
    // —— 「表说它有构造期校验」与「文案真的与表同源」之间没有任何机器守着（与 #164 那条
    // 「枚举靠人记」是同一类失效模式）。列表内不允许多余项：case 引用一个不存在的 knob 会在
    // 上面 for 里以 clause 为空串的形式当场红。
    const throwing = LIMIT_SEMANTICS.filter((s) => s.badValue === 'throws').map((s) => s.knob);
    const covered = new Set(cases.map(([knob]) => knob));
    assert.deepEqual(
      throwing.filter((k) => !covered.has(k)),
      [],
      '这些旋钮声明了 badValue: throws，却没有对账 case —— 文案与表可能已经漂开',
    );
  });

  it('rejects-nan 旋钮逐条对账：NaN 构造期被拒、0/负数/±Infinity 照旧放行（A4 的第五类补全）', () => {
    // 运行期互查（tsx 不做类型检查，Record 的编译期守卫生效不到这里 —— 与末尾探针互查同款兜底）
    const declared = LIMIT_SEMANTICS.filter((s) => s.badValue === 'rejects-nan').map((s) => s.knob);
    assert.deepEqual(
      Object.keys(REJECTS_NAN_PROBES).sort(),
      [...declared].sort(),
      'REJECTS_NAN_PROBES 与表里的 rejects-nan 旋钮漂移了 —— 两边必须一一对应',
    );
    for (const knob of declared) REJECTS_NAN_PROBES[knob]!();
  });

  it('探针与表一一对应（运行期互查 —— tsx 不做类型检查，Record 的编译期守卫生效不到这里）', () => {
    // Record<LimitKnob, …> 在 typecheck:tests 守「表加了没探针 / 探针加了表里摘了」，
    // 但单跑 `node --import tsx --test` 时类型检查根本不发生 —— 这条用例是运行期兜底：
    // 从表里摘掉一行登记，这里当场红（而不是等下一次 typecheck 才发现）。
    assert.deepEqual(
      Object.keys(PROBES).sort(),
      LIMIT_SEMANTICS.map((s) => s.knob).sort(),
      '探针表与 LIMIT_SEMANTICS 漂移了 —— 两边必须一一对应',
    );
  });
});
