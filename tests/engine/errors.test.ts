import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { classifyError, isAbortError } from '../../src/index.js';
import { TimeoutError } from '../../src/core/timeout.js';
import { AnthropicApiError } from '../../src/integrations/anthropic.js';

const headers = () => new Headers();

/**
 * classifyError 是**鸭子类型**分类（2026-09-17 起，engine 对 SDK 零运行时 import）：
 * 认数值 `status`、带 `cause` 的 TypeError、errno `code`、内建 DOMException 的 `name` ——
 * 一概不碰构造函数身份。下面两组分别钉「默认 client 自研实现抛的形态」与
 * 「第三方 SDK 错误（带 status 属性）同样适用」。
 */
describe('classifyError（鸭子类型分类 → SpanError）', () => {
  it('AbortError → aborted / 不可重试（中断不是可重试故障）', () => {
    const dom = new DOMException('The operation was aborted', 'AbortError');
    assert.equal(isAbortError(dom), true);
    assert.deepEqual(classifyError(dom), {
      type: 'aborted',
      message: 'run 已被取消',
      retryable: false,
    });

    const plain = Object.assign(new Error('x'), { name: 'AbortError' });
    assert.equal(isAbortError(plain), true, '普通 Error 靠 name 也能识别');

    assert.equal(isAbortError(new Error('普通错误')), false);
  });

  it('超时 → timeout / **可重试**（DOMException 与框架 TimeoutError 同一类账）', () => {
    // 此前 `name === 'TimeoutError'` 走 isConnectionError ⇒ 归成 connection：与「连不上」混在一起，
    // 看板 / trace-diff 分不出两者。⚠️ 那条行为**有**用例守着（本文件「无 status 的网络型错误」
    // 条目的最后一段断言 `TimeoutError → connection`）—— 本 PR 改坏了那条断言，属**有意行为变更**：
    // 错的契约被钉进了期望，改契约就得连期望一起改（spec §10 2026-09-17 ref-timeout-error-type）。
    const dom = new DOMException('Anthropic 请求超过 100ms', 'TimeoutError');
    assert.deepEqual(classifyError(dom), {
      type: 'timeout',
      message: 'Anthropic 请求超过 100ms',
      retryable: true,
    });

    // 框架自己判的超时（MCP 桥兜底）与「工具作者自报超时」同样归这类
    const own = new TimeoutError('MCP 工具 "x" 调用超时（超过 20ms）');
    assert.equal(classifyError(own).type, 'timeout');
    assert.deepEqual(classifyError(Object.assign(new Error('自报超时'), { code: 'timeout' })), {
      type: 'timeout',
      message: '自报超时',
      retryable: true,
    });
  });

  it('带数值 status 的仍优先按状态归类（超时判据不抢 status 的优先级）', () => {
    const e = Object.assign(new DOMException('x', 'TimeoutError'), { status: 429 });
    assert.equal(classifyError(e).type, 'rate_limit');
  });

  it('带数值 status：429 → rate_limit、5xx → server、其余 4xx → api（不可重试）', () => {
    const cases: Array<[number, string, boolean]> = [
      [400, 'api', false],
      [401, 'api', false],
      [404, 'api', false],
      [429, 'rate_limit', true],
      [500, 'server', true],
      [503, 'server', true],
      [529, 'server', true],
    ];
    for (const [status, type, retryable] of cases) {
      const e = new AnthropicApiError(status, `s=${status}`);
      const span = classifyError(e);
      assert.equal(span.type, type, `status=${status}`);
      assert.equal(span.retryable, retryable, `status=${status}`);
      assert.equal(span.message, e.message, 'message 透传');
    }
  });

  it('status 非数值（字符串/NaN/缺失）不参与分类，落不到 api 分支', () => {
    for (const status of ['429', Number.NaN, undefined]) {
      const e = Object.assign(new Error('x'), { status });
      assert.equal(classifyError(e).type, 'unknown', `status=${String(status)}`);
    }
  });

  it('无 status 的网络型错误 → connection / retryable', () => {
    // fetch 的网络失败：TypeError 带 cause（undici 形态）
    const fetchFail = new TypeError('fetch failed', {
      cause: Object.assign(new Error('conn reset'), { code: 'ECONNRESET' }),
    });
    assert.deepEqual(classifyError(fetchFail), {
      type: 'connection',
      message: 'fetch failed',
      retryable: true,
    });

    // Node 网络层直接抛的 errno 形态（带 code 的 Error）
    const errno = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    assert.equal(classifyError(errno).type, 'connection');
    assert.equal(classifyError(errno).retryable, true);

    // 注：`name === 'TimeoutError'` 的 DOMException **不再**归 connection —— 2026-09-17 起它有自己的
    // `type:'timeout'`（见上面「超时 → timeout」那条用例）。本条只钉「真的连不上」这两类形态。
  });

  it('裸 TypeError（无 cause）不是网络错误 → unknown（不误伤工具代码抛的普通 TypeError）', () => {
    assert.deepEqual(classifyError(new TypeError('bad type')), {
      type: 'unknown',
      message: 'bad type',
      retryable: false,
    });
  });

  it('第三方 SDK 错误（带 status 属性）同样适用 —— 鸭子类型不认构造函数身份', () => {
    // SDK 的错误类实例上带数值 status，与默认 client 的 AnthropicApiError 同判
    const rl = new Anthropic.RateLimitError(429, undefined, 'slow down', headers());
    assert.equal(classifyError(rl).type, 'rate_limit');
    assert.equal(classifyError(rl).retryable, true);

    const ise = new Anthropic.InternalServerError(500, undefined, 'boom', headers());
    assert.equal(classifyError(ise).type, 'server');
    assert.equal(classifyError(ise).retryable, true);

    const bad = new Anthropic.BadRequestError(400, undefined, 'bad', headers());
    assert.equal(classifyError(bad).type, 'api');
    assert.equal(classifyError(bad).retryable, false);

    // 已知边界：SDK 的 APIConnectionError 不带 status/code（name 恒 'Error'，
    // 鸭子类型无法与「普通 Error」区分）→ 落 unknown。默认 client 自研化后不再产生它
    // （连接错误以 fetch 的 TypeError+cause 形态出现），此分支只影响「使用者自装 SDK
    // 且让它抛到引擎」的场景。
    const conn = new Anthropic.APIConnectionError({ message: 'conn fail' });
    assert.equal(classifyError(conn).type, 'unknown');
  });

  it('普通 Error → unknown / 不可重试，message 保留', () => {
    assert.deepEqual(classifyError(new Error('plain')), {
      type: 'unknown',
      message: 'plain',
      retryable: false,
    });
  });

  it('非 Error 值 → String(e) 兜底', () => {
    assert.deepEqual(classifyError('boom'), {
      type: 'unknown',
      message: 'boom',
      retryable: false,
    });
    assert.equal(classifyError(42).message, '42');
    assert.equal(classifyError(null).message, 'null');
    assert.equal(classifyError(undefined).message, 'undefined');
    assert.equal(classifyError({ a: 1 }).message, '[object Object]');
  });
});
