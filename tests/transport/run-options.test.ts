import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRunOptions, pickClientRunOptions } from '../../src/transport/run-options.js';

/**
 * 纯件层的口径（HTTP 那一侧的行为在 `http-run-options.test.ts` 里钉）。
 *
 * 这里只管两件容易写错的事：**校验的边界**（NaN / 负数 / 空 traceId 都必须拒）与
 * **合并的三条不同语义**（blackboard 替换、labels 合并、预算取更严）。
 */
describe('pickClientRunOptions：白名单与类型校验', () => {
  it('不传 / 空对象 → 通过且为空', () => {
    assert.deepEqual(pickClientRunOptions(undefined), { ok: true, options: {} });
    assert.deepEqual(pickClientRunOptions({}), { ok: true, options: {} });
  });

  it('非对象 → 拒；null 与 undefined 同义（都当「没给」）', () => {
    assert.equal(pickClientRunOptions([]).ok, false);
    assert.equal(pickClientRunOptions('x').ok, false);
    assert.equal(pickClientRunOptions(1).ok, false);
    assert.deepEqual(pickClientRunOptions(null), { ok: true, options: {} });
  });

  it('黑名单键被点名拒绝，并给出可用清单', () => {
    for (const key of ['blackboard', 'tools', 'model', 'fallbacks', 'priceOverrides']) {
      const r = pickClientRunOptions({ [key]: {} });
      assert.equal(r.ok, false, `${key} 不该被接受`);
      if (!r.ok) {
        assert.match(r.error, new RegExp(key));
        assert.match(r.error, /traceContext/);
      }
    }
  });

  it('预算：NaN / Infinity / 负数 / 字符串都拒（0 合法 = 一分不许花）', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, '5']) {
      assert.equal(pickClientRunOptions({ maxCostUsd: bad }).ok, false, `maxCostUsd=${bad}`);
      assert.equal(
        pickClientRunOptions({ maxTotalTokens: bad }).ok,
        false,
        `maxTotalTokens=${bad}`,
      );
    }
    const zero = pickClientRunOptions({ maxCostUsd: 0 });
    assert.deepEqual(zero, { ok: true, options: { maxCostUsd: 0 } });
  });

  it('traceContext：要求非空 traceId，spanId 可选但给了就必须是非空串', () => {
    assert.equal(pickClientRunOptions({ traceContext: {} }).ok, false);
    assert.equal(pickClientRunOptions({ traceContext: { traceId: '' } }).ok, false);
    assert.equal(pickClientRunOptions({ traceContext: { traceId: 'a', spanId: 1 } }).ok, false);
    assert.deepEqual(pickClientRunOptions({ traceContext: { traceId: 'a' } }), {
      ok: true,
      options: { traceContext: { traceId: 'a' } },
    });
    assert.deepEqual(pickClientRunOptions({ traceContext: { traceId: 'a', spanId: 'b' } }), {
      ok: true,
      options: { traceContext: { traceId: 'a', spanId: 'b' } },
    });
  });
});

describe('mergeRunOptions：三条语义各不相同', () => {
  it('没有宿主注入 → 原样返回', () => {
    const client = { maxCostUsd: 1, labels: { a: '1' } };
    assert.deepEqual(mergeRunOptions(client, undefined), client);
  });

  it('blackboard 整体替换（身份载体不允许「合并」）', () => {
    const out = mergeRunOptions(
      { blackboard: { tenant: 'client' } },
      { blackboard: { tenant: 'acme', region: 'cn' } },
    );
    assert.deepEqual(out.blackboard, { tenant: 'acme', region: 'cn' }, '客户端键不能残留');
  });

  it('labels 按键盘合并、服务端胜', () => {
    const out = mergeRunOptions(
      { labels: { tenant: 'client', job: 'j1' } },
      { labels: { tenant: 'acme' } },
    );
    assert.deepEqual(out.labels, { tenant: 'acme', job: 'j1' });
  });

  it('预算取更严者；宿主没设时不擦掉客户端的值', () => {
    assert.equal(mergeRunOptions({ maxCostUsd: 5 }, { maxCostUsd: 2 }).maxCostUsd, 2);
    assert.equal(mergeRunOptions({ maxCostUsd: 0.5 }, { maxCostUsd: 2 }).maxCostUsd, 0.5);
    assert.equal(mergeRunOptions({ maxCostUsd: 5 }, {}).maxCostUsd, 5);
    assert.equal(mergeRunOptions({}, { maxTotalTokens: 100 }).maxTotalTokens, 100);
  });
});
