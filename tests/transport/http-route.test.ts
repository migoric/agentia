/*
 * HTTP 路由判定的**表驱动**直测（src/transport/http-route.ts）—— http.ts 拆分第二步。
 *
 * 这张表就是路由矩阵本身。此前它散在 handler 的 if 链里，只有端到端覆盖 ——
 * 而端到端只能验「走得通的那几条」，验不了**顺序**：同一对 (路径, 方法) 在「先鉴权」
 * 与「先判方法」两种排法下结果不同，正是这里最容易被改错的地方。
 *
 * 三条顺序陷阱各配了断言（头注里逐条写了为什么）：
 *   ① 免鉴权组（/healthz、配了出口的 /metrics）连同它们的 405 都在鉴权之前 → preAuth
 *   ② 其余一律先鉴权（所以 405/404 这类「路径/方法判定」的 preAuth 必须是 false）
 *   ③ approve 先于通用 id 分支，且**方法检查先于解码**
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPreAuthRoute, routeRequest } from '../../src/transport/http-route.js';
import type { HttpRoute } from '../../src/transport/http-route.js';

/** 简化断言：只关心 kind（和个别字段）时用它读出可读的失败信息 */
const kind = (r: HttpRoute): string => r.kind;

describe('routeRequest —— 免鉴权组（陷阱 ①）', () => {
  it('GET /healthz 与 GET /metrics（配了出口）命中免鉴权组', () => {
    assert.equal(routeRequest('/healthz', 'GET', false).kind, 'healthz');
    assert.equal(routeRequest('/metrics', 'GET', true).kind, 'metrics');
    for (const r of [routeRequest('/healthz', 'GET', false), routeRequest('/metrics', 'GET', true)])
      assert.equal(isPreAuthRoute(r), true);
  });

  it('**没配 metrics 出口时 /metrics 不是免鉴权路径**（会先过鉴权，最后 404）', () => {
    const r = routeRequest('/metrics', 'GET', false);
    assert.equal(r.kind, 'notFound');
    assert.equal(isPreAuthRoute(r), false, '不是免鉴权组 ⇒ 必须先过鉴权');
  });

  it('免鉴权组自己的 405 也在鉴权之前（preAuth=true）—— 配了 authenticate 时 POST /healthz 回 405 不是 401', () => {
    for (const [path, hasMetrics] of [
      ['/healthz', false],
      ['/metrics', true],
    ] as const) {
      const r = routeRequest(path, 'POST', hasMetrics);
      assert.equal(r.kind, 'methodNotAllowed');
      assert.deepEqual(r, { kind: 'methodNotAllowed', allowed: 'GET', preAuth: true });
    }
  });
});

describe('routeRequest —— 先鉴权再判方法/路径（陷阱 ②）', () => {
  it('其余所有 405 / 404 的 preAuth 都是 false（鉴权失败时回 401，不泄露路径是否存在）', () => {
    const cases: HttpRoute[] = [
      routeRequest('/run', 'GET', false),
      routeRequest('/tasks', 'GET', false),
      routeRequest('/tasks/x', 'DELETE', false),
      routeRequest('/tasks/x/approve', 'GET', false),
      routeRequest('/nope', 'GET', false),
      routeRequest('/healthz/extra', 'GET', false), // 前缀不算：精确匹配
    ];
    for (const r of cases) {
      assert.equal(isPreAuthRoute(r), false, `不该是免鉴权组: ${JSON.stringify(r)}`);
      assert.notEqual(kind(r), 'healthz');
      assert.notEqual(kind(r), 'metrics');
    }
  });
});

describe('routeRequest —— 主路径', () => {
  it('POST /run → run；POST /tasks → submit', () => {
    assert.equal(routeRequest('/run', 'POST', false).kind, 'run');
    assert.equal(routeRequest('/tasks', 'POST', false).kind, 'submit');
  });

  it('方法不符 → 405 且带正确的 Allow', () => {
    assert.deepEqual(routeRequest('/run', 'GET', false), {
      kind: 'methodNotAllowed',
      allowed: 'POST',
      preAuth: false,
    });
    assert.deepEqual(routeRequest('/tasks', 'PUT', false), {
      kind: 'methodNotAllowed',
      allowed: 'POST',
      preAuth: false,
    });
    assert.deepEqual(routeRequest('/tasks/x', 'DELETE', false), {
      kind: 'methodNotAllowed',
      allowed: 'GET',
      preAuth: false,
    });
  });

  it('未知路径 → notFound（含 /healthz/extra 这种「看着像」的）', () => {
    for (const p of ['/', '/nope', '/healthz/extra', '/metrics/', '/Tasks/x', '/tasksx'])
      assert.equal(routeRequest(p, 'GET', true).kind, 'notFound', p);
  });
});

describe('routeRequest —— /tasks/<id>（陷阱 ③）', () => {
  it('GET /tasks/<id> → poll，taskId 已解码', () => {
    assert.deepEqual(routeRequest('/tasks/abc', 'GET', false), { kind: 'poll', taskId: 'abc' });
    assert.deepEqual(routeRequest('/tasks/%E4%B8%AD%E6%96%87', 'GET', false), {
      kind: 'poll',
      taskId: '中文',
    });
  });

  it('POST /tasks/<id>/approve → approve，taskId 已剥掉 /approve 再解码', () => {
    assert.deepEqual(routeRequest('/tasks/abc/approve', 'POST', false), {
      kind: 'approve',
      taskId: 'abc',
    });
    assert.deepEqual(routeRequest('/tasks/a%2Fb/approve', 'POST', false), {
      kind: 'approve',
      taskId: 'a/b',
    });
  });

  it('approve 先于通用 id 分支：GET /tasks/x/approve 回 **405（Allow: POST）**，不是 404、也不走轮询', () => {
    assert.deepEqual(routeRequest('/tasks/x/approve', 'GET', false), {
      kind: 'methodNotAllowed',
      allowed: 'POST',
      preAuth: false,
    });
  });

  it('方法检查先于解码：DELETE /tasks/%zz/approve 回 **405 而不是 400**', () => {
    assert.deepEqual(routeRequest('/tasks/%zz/approve', 'DELETE', false), {
      kind: 'methodNotAllowed',
      allowed: 'POST',
      preAuth: false,
    });
    assert.deepEqual(routeRequest('/tasks/%zz', 'DELETE', false), {
      kind: 'methodNotAllowed',
      allowed: 'GET',
      preAuth: false,
    });
  });

  it('残缺的 % 转义 → badTaskId（调用方 400，不是服务端 500）', () => {
    assert.equal(routeRequest('/tasks/%zz', 'GET', false).kind, 'badTaskId');
    assert.equal(routeRequest('/tasks/%zz/approve', 'POST', false).kind, 'badTaskId');
    assert.equal(routeRequest('/tasks/%E4%B8/approve', 'POST', false).kind, 'badTaskId');
  });

  it('空 taskId 照常交给 runner 去判（/tasks/ 与 /tasks//approve 都不在这里拦）', () => {
    assert.deepEqual(routeRequest('/tasks/', 'GET', false), { kind: 'poll', taskId: '' });
    assert.deepEqual(routeRequest('/tasks//approve', 'POST', false), {
      kind: 'approve',
      taskId: '',
    });
  });
});

describe('routeRequest —— 事件投入口（2026-09-28 ref-run-event-input，与 approve/cancel 同款排法）', () => {
  it('POST /tasks/<id>/events → taskEvent（id 剥掉 /events 再解码）', () => {
    assert.deepEqual(routeRequest('/tasks/abc/events', 'POST', false), {
      kind: 'taskEvent',
      taskId: 'abc',
    });
    assert.deepEqual(routeRequest('/tasks/a%2Fb/events', 'POST', false), {
      kind: 'taskEvent',
      taskId: 'a/b',
    });
  });

  it('先于通用 id 分支：GET /tasks/x/events 回 **405（Allow: POST）**，不是 404、也不走轮询', () => {
    assert.deepEqual(routeRequest('/tasks/x/events', 'GET', false), {
      kind: 'methodNotAllowed',
      allowed: 'POST',
      preAuth: false,
    });
  });

  it('方法检查先于解码：DELETE /tasks/%zz/events 回 **405 而不是 400**；POST + 坏 id 才轮到 badTaskId', () => {
    assert.deepEqual(routeRequest('/tasks/%zz/events', 'DELETE', false), {
      kind: 'methodNotAllowed',
      allowed: 'POST',
      preAuth: false,
    });
    assert.equal(routeRequest('/tasks/%zz/events', 'POST', false).kind, 'badTaskId');
  });
});

describe('isPreAuthRoute —— 免鉴权组的判定本身', () => {
  it('只有 healthz / metrics / preAuth 的 405 为真', () => {
    const yes: HttpRoute[] = [
      { kind: 'healthz' },
      { kind: 'metrics' },
      { kind: 'methodNotAllowed', allowed: 'GET', preAuth: true },
    ];
    const no: HttpRoute[] = [
      { kind: 'run' },
      { kind: 'submit' },
      { kind: 'approve', taskId: 'x' },
      { kind: 'cancel', taskId: 'x' },
      { kind: 'taskEvent', taskId: 'x' },
      { kind: 'poll', taskId: 'x' },
      { kind: 'badTaskId' },
      { kind: 'notFound' },
      { kind: 'methodNotAllowed', allowed: 'POST', preAuth: false },
    ];
    for (const r of yes) assert.equal(isPreAuthRoute(r), true, JSON.stringify(r));
    for (const r of no) assert.equal(isPreAuthRoute(r), false, JSON.stringify(r));
  });
});
