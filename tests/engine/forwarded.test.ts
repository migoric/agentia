/**
 * `forwardToolContext`（穷尽转发的单源）的**运行期**用例。
 *
 * 类型层的那半在 `tests/types/forwarding.types.ts`（只编译不运行）：守「归类穷尽」与
 * 「全部键必填」。这里守运行期才看得见的两件事：
 *
 * 1. **取的键正好是清单里的全部键** —— 不多（引擎自装配的键不许漏进来）、不少。
 * 2. **不做真值判定** —— `false` / `0` 是有意义的值，判空会把它们吃成「没设」。
 *    这条与 `engine/tool-context.ts` 的三档判定同因，是本仓踩过的那类静默降级。
 *
 * 「传下去之后子循环真的用上了」由既有套件覆盖（`tests/engine/eventChars.test.ts`、
 * `toolTiming.test.ts`、`capabilityUsage.test.ts` 都穿过 @SubAgent / @Skill 的真路径）——
 * 本文件不重复造那条链。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FORWARDED_TOOL_CONTEXT_KEYS, forwardToolContext } from '../../src/engine/forwarded.js';
import type { ToolRunContext } from '../../src/core/tool.js';

/** 造一个「七个旋钮都设了 + 六个引擎自装配键也在」的 ctx */
function fullCtx(): ToolRunContext {
  const signal = new AbortController().signal;
  return {
    // 引擎自装配（不该被转发）
    client: { messages: { stream: () => ({ on() {}, finalMessage: async () => ({}) }) } } as never,
    recorder: { traceId: 't1', setAttribute: () => undefined } as never,
    parentSpanId: 'span-1',
    abandoned: signal,
    approval: { approved: true, decidedBy: 'alice' } as never,
    deferUntil: () => undefined,
    // 七个要转发的
    signal,
    priceOverrides: { 'my-model': { in: 1, out: 2 } },
    onUnpricedModel: () => undefined,
    maxEventChars: 1234,
    maxToolResultChars: 4321,
    maxTotalTokens: 5678,
    maxCostUsd: 0.5,
    usageOffset: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    toolTimeoutMs: 9000,
  };
}

describe('forwardToolContext：穷尽转发的取值单源', () => {
  it('取出的键正好是转发清单那七个（不多不少）', () => {
    const out = forwardToolContext(fullCtx());
    assert.deepEqual(
      Object.keys(out).sort(),
      [...FORWARDED_TOOL_CONTEXT_KEYS].sort(),
      '取出的键集必须与 FORWARDED_TOOL_CONTEXT_KEYS 完全一致 —— 少了会静默漏字段，多了会把引擎自装配的东西灌进子循环',
    );
  });

  it('引擎自装配的键一个都不许漏进来（清单从夹具派生 + 数量下限）', () => {
    const out = forwardToolContext(fullCtx()) as Record<string, unknown>;
    // 为什么不再手抄键名：这份清单原先写死五个键，而 `deferUntil` 是新增的第六个 ——
    // 没人补清单，于是「引擎自装配的键不许漏进来」这条断言**对它不成立**（换个组照样全绿）。
    // 改成从夹具派生：夹具是形状的权威，它有的键只要不在转发清单上就必须不在结果里。
    const forwarded = FORWARDED_TOOL_CONTEXT_KEYS as readonly string[];
    const checked = Object.keys(fullCtx()).filter((k) => !forwarded.includes(k));
    // 数量下限（防真空变绿）：夹具被清空 / 键被挪进转发组 ⇒ 这条立刻红。
    // 6 = 当前的 client / recorder / parentSpanId / abandoned / approval / deferUntil；
    // 新增不转发键时要连着改这个数 —— 那份「要不再想想该不该转发」的停顿是故意的。
    assert.equal(checked.length, 6, `被检查的引擎自装配键：${checked.join(', ')}`);
    for (const k of checked) {
      assert.ok(!(k in out), `${k} 属于引擎自装配，不该出现在转发结果里`);
    }
  });

  it('值原样带过去，不做真值判定（false / 0 是有意义的值）', () => {
    const ctx = fullCtx();
    const out = forwardToolContext(ctx);
    assert.equal(out.maxEventChars, 1234);
    assert.equal(out.maxToolResultChars, 4321);
    assert.equal(out.maxTotalTokens, 5678);
    assert.equal(out.maxCostUsd, 0.5);
    assert.equal(out.usageOffset, ctx.usageOffset);
    assert.equal(out.toolTimeoutMs, 9000);
    assert.equal(out.signal, ctx.signal);

    // ⚠️ 关键：`false`（不截断）与 `0`（不重试/不超时这类）都必须原样在场。
    // 若实现写成 `ctx.maxEventChars ? … : undefined`，这里会变成 undefined ⇒ 红。
    const zero = forwardToolContext({ ...ctx, maxEventChars: false, maxTotalTokens: 0 });
    assert.equal(zero.maxEventChars, false, 'maxEventChars:false（不截断）不能被真值判定吃掉');
    assert.equal(zero.maxTotalTokens, 0, 'maxTotalTokens:0 必须原样带过去');
  });

  it('七个键**全在场**，即使值都是 undefined（与「没转发」区分开）', () => {
    const bare = {
      client: {} as never,
      recorder: {} as never,
      parentSpanId: 's',
      abandoned: new AbortController().signal,
    } as ToolRunContext;
    const out = forwardToolContext(bare) as Record<string, unknown>;
    for (const k of FORWARDED_TOOL_CONTEXT_KEYS) {
      assert.ok(k in out, `${k} 必须在场（undefined 表示「本 run 没设」，与漏转发是两件事）`);
      assert.equal(out[k], undefined);
    }
  });
});
