/*
 * run 生效旋钮的**直接**单测（src/engine/run-config.ts）。
 *
 * 此前这批编码决策只在集成测试里被抽样：concurrency.test.ts 抽了并发上限、
 * eventChars.test.ts 抽了截断关掉、pricing.test.ts 抽了 retry/contextPolicy ——
 * 每条都要起整个 mock run 才能问一句「这个值怎么记的」，且边界值（NaN / Infinity /
 * -1 / 0 / 小数）一个都没覆盖。这里把「生效值 → 记录值」的映射逐条钉住，不再借道 run。
 *
 * 断言的共同主题：**记录值必须能被读对**。`'off'` vs `false` vs `0` 三者在日志/看板上
 * 含义完全不同（无上限 / 上限为 0 / 关闭），所以每条都双向断言（记了什么 + 没记什么）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_TOKENS,
  resolveDefaultModel,
  runConfigSnapshot,
} from '../../src/engine/run-config.js';
import { DEFAULT_RETRY } from '../../src/engine/retry.js';
import type { TraceLimits } from '../../src/engine/tracer.js';
import type { MessageParam } from '../../src/core/message.js';
import type { ContextPolicy, RunAgentOptions } from '../../src/engine/types.js';

/** 最小合法 options：只有 messages 必填；其余按需覆盖 */
const BASE: RunAgentOptions = { messages: [{ role: 'user', content: 'go' }] };
const snap = (
  o: Partial<RunAgentOptions> & { traceLimits?: TraceLimits } = {},
): Record<string, string | number | boolean> => runConfigSnapshot({ ...BASE, ...o });

/** 改 AGENTIA_MODEL 跑一段、跑完恢复 —— 缺省模型解析读 process.env，别把环境漏给别的用例 */
function withEnv(value: string | undefined, fn: () => void): void {
  const prev = process.env.AGENTIA_MODEL;
  if (value === undefined) delete process.env.AGENTIA_MODEL;
  else process.env.AGENTIA_MODEL = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.AGENTIA_MODEL;
    else process.env.AGENTIA_MODEL = prev;
  }
}

const stubPolicy = (budgetTokens?: number): ContextPolicy => ({
  ...(budgetTokens === undefined ? {} : { budgetTokens }),
  beforeTurn: (messages: MessageParam[]): Promise<MessageParam[]> => Promise.resolve(messages),
});

describe('resolveDefaultModel —— 显式 > env > 缺省', () => {
  it("env 未设时回落 'claude-opus-5'", () => {
    withEnv(undefined, () => assert.equal(resolveDefaultModel(), 'claude-opus-5'));
  });

  it('显式传入优先于 env（显式值就是最终值）', () => {
    withEnv('env-model', () =>
      assert.equal(resolveDefaultModel('explicit-model'), 'explicit-model'),
    );
  });

  it('env 生效，且两端空白被修掉（export 出来的值常带空格）', () => {
    withEnv('  deepseek-chat  ', () => assert.equal(resolveDefaultModel(), 'deepseek-chat'));
  });

  it('env 是空串 / 纯空白 → 回落缺省（不把空模型名送进请求）', () => {
    for (const v of ['', '   '])
      withEnv(v, () => assert.equal(resolveDefaultModel(), 'claude-opus-5'));
  });
});

describe('runConfigSnapshot —— 记录的必须是生效值', () => {
  it('缺省三件套也记 —— 「没配」与「配了缺省值」可区分于「该项不存在」', () => {
    const a = snap();
    assert.equal(a['config.model'], 'claude-opus-5');
    assert.equal(a['config.maxTokens'], DEFAULT_MAX_TOKENS);
    assert.equal(a['config.maxIterations'], DEFAULT_MAX_ITERATIONS);
  });

  it('传入即覆盖缺省（含 0 这类「看着像没给」的值）', () => {
    assert.equal(snap({ model: 'm-1' })['config.model'], 'm-1');
    assert.equal(snap({ maxTokens: 123 })['config.maxTokens'], 123);
    assert.equal(snap({ maxIterations: 0 })['config.maxIterations'], 0);
  });
});

describe('只记传入项 —— 但 0 也算传入（`!= null`，不是真值判定）', () => {
  it('未传时三个上限键都不在场', () => {
    const a = snap();
    for (const k of ['config.maxTotalTokens', 'config.maxCostUsd', 'config.toolTimeoutMs'])
      assert.equal(k in a, false, `${k} 不该在场`);
  });

  it('传 0 时原样记 0（零预算 / 不超时都是有效配置，不能被静默吃掉）', () => {
    const a = snap({ maxTotalTokens: 0, maxCostUsd: 0, toolTimeoutMs: 0 });
    assert.equal(a['config.maxTotalTokens'], 0);
    assert.equal(a['config.maxCostUsd'], 0);
    assert.equal(a['config.toolTimeoutMs'], 0);
  });
});

describe('maxToolConcurrency —— 记生效的整数，不限记 off', () => {
  it('整数原样、小数向下取整（与 concurrency.ts 的 floor 同口径）', () => {
    assert.equal(snap({ maxToolConcurrency: 3 })['config.maxToolConcurrency'], 3);
    assert.equal(snap({ maxToolConcurrency: 2.7 })['config.maxToolConcurrency'], 2);
  });

  it("0 / 负数 / NaN / Infinity 一律记 'off' —— 绝不写出 NaN 或 -1", () => {
    for (const v of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const got = snap({ maxToolConcurrency: v })['config.maxToolConcurrency'];
      assert.equal(got, 'off', `maxToolConcurrency=${v} 应记 off，实得 ${String(got)}`);
    }
  });

  it('未传则不在场（与「传了不限」是两回事）', () => {
    assert.equal('config.maxToolConcurrency' in snap(), false);
  });
});

describe('maxEventChars —— false 与 0 是两回事', () => {
  it("false 记 'off'：没有上限，而不是「上限为 0」", () => {
    assert.equal(snap({ maxEventChars: false })['config.maxEventChars'], 'off');
  });

  it('0 与正数原样记；未传则不在场', () => {
    assert.equal(snap({ maxEventChars: 0 })['config.maxEventChars'], 0);
    assert.equal(snap({ maxEventChars: 1500 })['config.maxEventChars'], 1500);
    assert.equal('config.maxEventChars' in snap(), false);
  });
});

describe('maxToolResultChars —— 回模型上限与 trace 上限分记', () => {
  it('0 / 正数原样记，false 记 off，未传不在场', () => {
    assert.equal(snap({ maxToolResultChars: 0 })['config.maxToolResultChars'], 0);
    assert.equal(snap({ maxToolResultChars: 500 })['config.maxToolResultChars'], 500);
    assert.equal(snap({ maxToolResultChars: false })['config.maxToolResultChars'], 'off');
    assert.equal('config.maxToolResultChars' in snap(), false);
  });
});

describe('traceLimits.maxEvents —— 0 是「一条都不记」，不是「不限」', () => {
  it('传入原样记（含 0 —— 不记成 off：off 的口径是「不设上限」）', () => {
    assert.equal(snap({ traceLimits: { maxEvents: 500 } })['config.traceLimits.maxEvents'], 500);
    assert.equal(snap({ traceLimits: { maxEvents: 0 } })['config.traceLimits.maxEvents'], 0);
  });

  it('未传 / 空 traceLimits（= 不限）则不在场', () => {
    assert.equal('config.traceLimits.maxEvents' in snap(), false);
    assert.equal('config.traceLimits.maxEvents' in snap({ traceLimits: {} }), false);
  });
});

describe('retry —— 「关闭」与「缺省」必须可区分', () => {
  it('未传 → 缺省 maxAttempts 也可见（不是「没记」）', () => {
    assert.equal(snap()['config.retry.maxAttempts'], DEFAULT_RETRY.maxAttempts);
  });

  it('false → 0（主动关闭）；maxAttempts < 1 同样等同关闭', () => {
    assert.equal(snap({ retry: false })['config.retry.maxAttempts'], 0);
    assert.equal(snap({ retry: { maxAttempts: 0 } })['config.retry.maxAttempts'], 0);
  });

  it('自定义次数原样记（maxAttempts=1 = 关闭，但记的是用户给的值）', () => {
    assert.equal(snap({ retry: { maxAttempts: 1 } })['config.retry.maxAttempts'], 1);
    assert.equal(snap({ retry: { maxAttempts: 5 } })['config.retry.maxAttempts'], 5);
  });
});

describe('contextPolicy / priceOverrides / resultSchema', () => {
  it('contextPolicy：配没配；budgetTokens 有才记', () => {
    assert.equal(snap()['config.contextPolicy'], false);
    const none = snap({ contextPolicy: stubPolicy() });
    assert.equal(none['config.contextPolicy'], true);
    assert.equal('config.contextPolicy.budgetTokens' in none, false);
    assert.equal(
      snap({ contextPolicy: stubPolicy(4200) })['config.contextPolicy.budgetTokens'],
      4200,
    );
  });

  it('priceOverrides：只记覆盖了哪几个模型（不记单价），顺序与传入键序无关', () => {
    const a = snap({
      priceOverrides: { 'z-model': { in: 1, out: 2 }, 'a-model': { in: 3, out: 4 } },
    });
    assert.equal(a['config.priceOverrides'], 'a-model,z-model');
    assert.equal('config.priceOverrides' in snap({ priceOverrides: {} }), false);
  });

  it('resultSchema：只记配没配', () => {
    const schema = { type: 'object', properties: {} } as const;
    assert.equal(snap({ resultSchema: schema })['config.resultSchema'], true);
    assert.equal('config.resultSchema' in snap(), false);
  });

  it('快照只含标量 —— 函数型选项（beforeTurn / isRetryable / onUnpricedModel）不记函数体', () => {
    const a = snap({
      contextPolicy: stubPolicy(1000),
      retry: { maxAttempts: 2, isRetryable: (): boolean => true },
      onUnpricedModel: (): void => {},
      system: 'sys',
    });
    for (const [k, v] of Object.entries(a))
      assert.equal(
        ['string', 'number', 'boolean'].includes(typeof v),
        true,
        `${k} 不是标量：${typeof v}`,
      );
  });
});
