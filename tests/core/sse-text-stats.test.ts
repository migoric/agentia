import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { sseLines } from '../../src/core/sse.js';
import { textOf } from '../../src/core/text.js';
import { percentile } from '../../src/core/stats.js';
import { capabilityKindOf } from '../../src/core/trace.js';
import { interruptibleSleep } from '../../src/core/timeout.js';
import type { Message, Span } from '../../src/index.js';

/**
 * 单源化的 core 原语（sse / text / stats / trace / timeout）。
 *
 * 这些实现是 2026-09-17 从多份重复里合出来的：合并本身是「零语义变更」的重构，
 * 但**合出来的那一份**从此是多处行为的唯一来源，所以边界要钉在这里 —— 以前写在
 * 各适配器/出口里的隐式约定（CRLF、无尾换行、分位口径、separator 语义）得有归宿。
 */

/** 把若干字节块喂成一个 `ReadableStream`（模拟 fetch 的分片到达） */
function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

describe('core 单源原语', () => {
  it('sseLines：按行分帧、剥 CRLF、末尾无换行的残行也交出', async () => {
    const lines: string[] = [];
    // 分片故意切在行中间（真实网络就是这样到达的）
    for await (const l of sseLines(streamOf('data: a\r\nda', 'ta: b\n\ndata: c'))) {
      lines.push(l);
    }
    assert.deepEqual(lines, ['data: a', 'data: b', '', 'data: c']);
  });

  it('sseLines：单行超上限 ⇒ 带上游故障 status 抛出（不 OOM）', async () => {
    const chunks = Array.from({ length: 9 }, () => 'x'.repeat(1_000_000));
    await assert.rejects(
      async () => {
        for await (const _ of sseLines(streamOf(...chunks))) {
          /* 不应产出完整行 */
        }
      },
      (e: unknown) => {
        assert.equal((e as { status?: number }).status, 500);
        assert.match((e as Error).message, /分帧上限/);
        return true;
      },
    );
  });

  it('sseLines：提前 break 时取消底层流（读锁不释放就漏连接）', async () => {
    let cancelled = false;
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: a\n'));
        c.enqueue(enc.encode('data: b\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const l of sseLines(body)) {
      if (l === 'data: a') break; // 提前收工（对应适配器里的 [DONE] / abort 路径）
    }
    assert.equal(cancelled, true);
  });

  it('textOf：separator 是调用方语义 —— 引擎用 \\n 保分段，适配器用空串还原原文', () => {
    const msg = {
      content: [
        { type: 'text', text: '第一段' },
        { type: 'tool_use', id: 't', name: 'x', input: {} },
        { type: 'text', text: '第二段' },
      ],
    } as unknown as Message;
    // 非文本块被跳过（不是被当成空串）
    assert.equal(textOf(msg, '\n'), '第一段\n第二段');
    assert.equal(textOf(msg, ''), '第一段第二段');
    assert.equal(textOf({ content: [] } as unknown as Message, '\n'), '');
  });

  it('percentile：Prometheus 的「最近 rank」语义，空数组 0、q=0 不越界', () => {
    assert.equal(percentile([], 0.5), 0);
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.equal(percentile(sorted, 0.5), 5); // ceil(0.5×10)=5 → 第 5 个
    assert.equal(percentile(sorted, 0.95), 10);
    // rank 钳到 [1, n]：q=0 取最小样本而不是 sorted[-1]
    assert.equal(percentile(sorted, 0), 1);
    assert.equal(percentile([7], 1), 7);
  });

  it('capabilityKindOf：按 attribute 认能力类型，认不出即 capability', () => {
    const span = (attributes: Record<string, string | number | boolean>): Span =>
      ({ attributes }) as unknown as Span;
    assert.equal(capabilityKindOf(span({ skill: 'x' })), 'skill');
    assert.equal(capabilityKindOf(span({ subagent: 'y' })), 'subagent');
    assert.equal(capabilityKindOf(span({})), 'capability');
    // 两个都有（不该发生，但要有确定答案而不是抛）
    assert.equal(capabilityKindOf(span({ skill: 'x', subagent: 'y' })), 'skill');
  });

  it('interruptibleSleep：可被 signal 中断，抛出的是 AbortError 而非 TimeoutError', async () => {
    const ac = new AbortController();
    const p = interruptibleSleep(5_000, ac.signal, 'run 已被取消');
    ac.abort();
    await assert.rejects(p, (e: Error) => {
      assert.equal(e.name, 'AbortError');
      // 取消不是超时：归成 timeout 会让 loop 记错停止原因
      assert.notEqual((e as { code?: string }).code, 'timeout');
      assert.equal(e.message, 'run 已被取消');
      return true;
    });
  });

  it('interruptibleSleep：已中止的 signal 立即 reject（此时计时器还没建）', async () => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(interruptibleSleep(5_000, ac.signal), { name: 'AbortError' });
    // 非正数 = **不睡**（调用方不必自己判 0），且这一判**先于** aborted 检查 ——
    // 与 `withTimeout(p, 0)` 的「不设超时」同一口径：预算 ≤0 ⇒ 这次机制关掉，
    // 与 signal 状态无关，所以即使 signal 已中止也 **resolve**。
    // ⚠️ 别把它「修」成 reject（2026-09-19 外部复核真这么改过一次，就是被这条拦下的）。
    await assert.doesNotReject(interruptibleSleep(0, ac.signal));
  });

  it('interruptibleSleep：正常到点 resolve，且摘掉 abort 监听器（长 run 里不累积）', async () => {
    const ac = new AbortController();
    const ac2 = new AbortController();
    const count = (): number => getEventListeners(ac.signal, 'abort').length;
    // 对照组：同信号上再挂一个常驻监听，证明计数真的在数这条信号
    ac.signal.addEventListener('abort', () => {});
    const baseline = count();
    // ⚠️ 2026-09-26 §1 逐行审计订正：**光挂对照监听是不够的**，必须断言它出现在计数里。
    // 此前只把 baseline 当比较基准、从不检查它非零 —— 实测把 `getEventListeners` 打瞎
    // （恒返回 `[]`）后，baseline=0、after=0、ac2=0，三条断言全过，**用例照样绿**。
    // 也就是说「带一个常驻监听做对照，防「计数函数恒 0」的假绿」这句话**当时是假的**。
    // 现在这条断言把「测量工具还活着」变成红/绿的判据。
    assert.equal(
      baseline,
      1,
      `对照监听必须出现在计数里（实测 ${baseline}）—— 计数恒 0 时下面那条会假绿`,
    );
    await interruptibleSleep(1, ac.signal);
    assert.equal(count(), baseline, '到点后必须摘除自己那个监听器');
    // 另一个信号上从未挂过 —— 顺带钉住「摘的是自己那条信号上的」
    assert.equal(getEventListeners(ac2.signal, 'abort').length, 0);
  });
});
