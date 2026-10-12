import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeoutError } from '../../src/core/timeout.js';
import {
  DEFAULT_CLIENT_INFO,
  brief,
  isJsonRpcResponse,
  jsonRpcError,
  toolsCallParams,
  unwrap,
  withDeadline,
} from '../../src/integrations/mcp-protocol.js';

/**
 * `integrations/mcp-protocol.ts` 的**协议口径**直测（2026-09-28）。
 *
 * 为什么单独配一份：这些 helper 是桥（`mcp.ts`）与两个连接器**共用**的协议面，此前只在
 * `mcp.test.ts` / `mcpConnector.test.ts` 里**顺路**被跑到 —— 走得通，但「返回什么、抛什么、
 * 文案长什么样」从没被正面钉过。抽到独立文件（断值环）后，按 `http-shapes.test.ts` 的先例
 * 配一份口径表：**每条断言对应一条规则**，不追覆盖率数字。
 *
 * 这里钉的是**契约**（使用者看得到的返回值与文案），不是实现细节 —— 改文案就该在这里改，
 * 而不是让某条集成用例偶然变红（那才是「守卫盯着会变的东西」）。
 */

describe('unwrap —— 从一条已解析报文里取结果', () => {
  it('有 result ⇒ 原值返回；判别是**键存在**，所以 `result: undefined` 也算「有」', () => {
    assert.deepEqual(unwrap({ result: { a: 1 } }, 'tools/call'), { a: 1 });
    // 别把它「修」成 `msg.result !== undefined` 判定：那会把「server 明确回了 null/undefined」
    // 误判成「malformed」，与「既没有 result 也没有 error」混成一类。
    assert.equal(unwrap({ result: undefined }, 'tools/call'), undefined);
    assert.equal(unwrap({ result: null }, 'tools/call'), null);
  });

  it('带 error ⇒ 抛 jsonRpcError 的文案（code 与 message 都进）', () => {
    assert.throws(
      () => unwrap({ error: { code: -32601, message: 'Method not found' } }, 'tools/list'),
      /MCP error -32601: Method not found/,
    );
  });

  it('既无 result 也无 error ⇒ 抛具名错误并点出是哪个方法 —— 不静默返回 undefined', () => {
    assert.throws(
      () => unwrap({}, 'tools/list'),
      /MCP tools\/list：响应里既没有 result 也没有 error/,
    );
  });
});

describe('jsonRpcError —— JSON-RPC 错误对象 → Error', () => {
  it('对象带 code/message ⇒ 两者都进文案', () => {
    assert.equal(
      jsonRpcError({ code: -32602, message: 'Invalid params' }).message,
      'MCP error -32602: Invalid params',
    );
  });

  it('对象缺字段 ⇒ 也拼出完整文案（undefined 直说，不抛二次错）', () => {
    assert.equal(jsonRpcError({}).message, 'MCP error undefined: undefined');
  });

  it('非对象（server 发了字符串 / 数字）⇒ 退回 brief 拼文案', () => {
    assert.equal(jsonRpcError('boom').message, 'MCP error: boom');
    assert.equal(jsonRpcError(42).message, 'MCP error: 42');
  });
});

describe('isJsonRpcResponse —— 判别式（server 混进 stdout / SSE 的非 JSON 行）', () => {
  it('id 是数字 ⇒ 认（含 id:0 —— 别用真值判定）', () => {
    assert.equal(isJsonRpcResponse({ id: 1, result: {} }), true);
    assert.equal(isJsonRpcResponse({ id: 0, error: { code: -1 } }), true);
  });

  it('id 不是数字 / 根本不是对象 ⇒ 不认', () => {
    assert.equal(isJsonRpcResponse({ id: '1' }), false);
    assert.equal(isJsonRpcResponse({}), false);
    assert.equal(isJsonRpcResponse(null), false);
    assert.equal(isJsonRpcResponse('not json'), false);
    assert.equal(isJsonRpcResponse(undefined), false);
  });
});

describe('brief —— 把可能很大的值截成能进日志的一句话', () => {
  it('短字符串原样（不套引号 —— 文案里多一层引号就不像人话）', () => {
    assert.equal(brief('hello'), 'hello');
  });

  it('非字符串 ⇒ JSON 化', () => {
    assert.equal(brief({ a: 1 }), '{"a":1}');
  });

  it('超 max ⇒ 截断 + 省略号（长度 = max + 1）', () => {
    const out = brief('x'.repeat(50), 10);
    assert.equal(out, `${'x'.repeat(10)}…`);
    assert.equal(out.length, 11);
  });

  it('循环引用 ⇒ JSON 化会抛，退化成 String(value) —— 不让「处理错误」本身变成错误', () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    assert.equal(brief(cyc), '[object Object]');
  });

  it('undefined ⇒ 退化成 "undefined"（JSON.stringify(undefined) 返回的是 undefined 而非字符串）', () => {
    assert.equal(brief(undefined), 'undefined');
  });
});

describe('withDeadline —— 桥的超时（core/timeout 硬判定的薄封装）', () => {
  it('及时完成 ⇒ 原值透传', async () => {
    assert.equal(await withDeadline(Promise.resolve('ok'), 5_000, 'x'), 'ok');
  });

  it('超时 ⇒ 抛 core 的 TimeoutError（code=timeout ⇒ 引擎记 errorKind=timeout），文案点出工具与预算', async () => {
    await assert.rejects(
      () => withDeadline(new Promise<never>(() => {}), 20, 'get-time'),
      (err: unknown) => {
        // 必须是**类型化**超时：桥若抛普通 Error，引擎会记成 threw/unknown —— 同一事件两种账
        // （spec §10 2026-09-17 ① 就是把这件事单源化的那次）。
        assert.ok(err instanceof TimeoutError, '必须抛 core/timeout 的 TimeoutError');
        assert.equal(err.code, 'timeout');
        assert.match(err.message, /MCP 工具 "get-time" 调用超时（超过 20ms）/);
        return true;
      },
    );
  });
});

describe('协议常量 —— 口径不许漂', () => {
  it('DEFAULT_CLIENT_INFO 刻意写 0.0.0，不是框架版本（写成真版本会让 release-surface 计数失配）', () => {
    // integrations 层不 import 公共面（AGENTIA_VERSION 在 src/index.ts），而发版面按**精确
    // 版本串**计数 —— 这里多一处真版本字面量就会让 scripts/release-surface.mjs 的 count 断言炸。
    // 谁想「顺手修好这个 0.0.0」，先看 mcp-protocol.ts 那条注释。
    assert.equal(DEFAULT_CLIENT_INFO.name, 'agentia');
    assert.equal(DEFAULT_CLIENT_INFO.version, '0.0.0');
  });
});

describe('toolsCallParams —— tools/call 的 params（SEP-414 的 `_meta` 形状单源）', () => {
  const TP = '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01';

  it('带 traceparent ⇒ params 多一个**裸键** `_meta.traceparent`；`arguments` 是同一引用（一个字节不被碰）', () => {
    // 反向验证：摘掉 `_meta` 展开 ⇒ 第一条断言红；把 traceparent 挪进 `arguments` ⇒
    // 「同一引用」与深比较两条都红（纪律②：trace 上下文绝不进工具签名）。
    const args = { tz: 'UTC' };
    const params = toolsCallParams('get-time', args, TP);
    assert.deepEqual(params, { name: 'get-time', arguments: args, _meta: { traceparent: TP } });
    assert.equal(
      params.arguments,
      args,
      'arguments 必须原样透传（同一引用），trace 上下文不许进工具签名',
    );
  });

  it('不带 traceparent ⇒ **不落 `_meta` 键**（不是空对象：「没有上下文」≠「空上下文」）', () => {
    // 反向验证：恒落 `_meta: {}` ⇒ `'_meta' in params` 为真，本用例红（纪律③：不造空上下文）。
    const params = toolsCallParams('get-time', {}, undefined);
    assert.deepEqual(params, { name: 'get-time', arguments: {} });
    assert.equal('_meta' in params, false, '没有 traceparent 时不许落 _meta 键');
  });
});
