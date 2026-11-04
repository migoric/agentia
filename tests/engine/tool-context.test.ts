import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RecorderBackend, ToolRunContext } from '../../src/core/tool.js';
import { buildToolRunContext } from '../../src/engine/tool-context.js';

const ac = new AbortController();
const recorder = {} as RecorderBackend;
const base = {
  client: {} as ToolRunContext['client'],
  recorder,
  parentSpanId: 'sp1',
  abandoned: ac.signal,
};
const OPTIONAL = [
  'signal',
  'priceOverrides',
  'onUnpricedModel',
  'maxEventChars',
  'maxToolResultChars',
  'usageOffset',
  'maxTotalTokens',
  'maxCostUsd',
  'toolTimeoutMs',
  'approval',
] as const;

describe('tool-context —— 单工具执行的上下文装配（从 executeOneTool 抽出）', () => {
  it('必填四项原样在场（client / recorder / parentSpanId / abandoned）', () => {
    const c = buildToolRunContext({ ...base });
    assert.equal(c.client, base.client);
    assert.equal(c.recorder, recorder);
    assert.equal(c.parentSpanId, 'sp1');
    assert.equal(
      c.abandoned,
      ac.signal,
      'abandoned 是「超时后别等了」的通知通道，漏了工具会一直跑',
    );
  });

  it('缺省时八个可选键**都不在场**（不是 undefined 充数）', () => {
    const c = buildToolRunContext({ ...base });
    for (const k of OPTIONAL) assert.equal(k in c, false, `${k} 不该在场`);
  });

  it('**有意义的值必须透传**：maxEventChars=false（不截断）与 0（不超时 / 不限预算）', () => {
    const c = buildToolRunContext({
      ...base,
      maxEventChars: false,
      toolTimeoutMs: 0,
      maxTotalTokens: 0,
      maxCostUsd: 0,
    });
    assert.equal(c.maxEventChars, false, 'false = 不截断；用真值判定会把它吃掉，静默退回默认截断');
    assert.equal(c.toolTimeoutMs, 0, '0 = 不超时；掉了会变成默认超时');
    assert.equal(c.maxTotalTokens, 0);
    assert.equal(c.maxCostUsd, 0);
  });

  it('价格覆盖 / 未定价回调 / 审批决定给了就原样带上（否则子循环静默降级）', () => {
    const onUnpricedModel = (): void => undefined;
    const priceOverrides = { m: { input: 1 } } as unknown as ToolRunContext['priceOverrides'];
    const approval = { approved: true, decidedAt: 1 } as unknown as ToolRunContext['approval'];
    const c = buildToolRunContext({
      ...base,
      signal: ac.signal,
      priceOverrides,
      onUnpricedModel,
      approval,
    });
    assert.equal(c.signal, ac.signal);
    assert.equal(c.priceOverrides, priceOverrides, '漏了 ⇒ 子 agent 同模型退化成「未定价」');
    assert.equal(c.onUnpricedModel, onUnpricedModel, '漏了 ⇒ 子循环算不出成本却没人被告警');
    assert.equal(c.approval, approval, '批/拒的决定要带给工具体（审计与分级授权）');
  });
});
