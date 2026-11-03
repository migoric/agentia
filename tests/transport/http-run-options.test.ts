import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AppCallable } from '../../src/transport/async.js';
import { HttpException, createHttpHandler } from '../../src/transport/http.js';
import type { HttpHandler, RunOptionOverrides } from '../../src/index.js';
import type { AgentRunResult } from '../../src/engine/types.js';
import type { RunInvocationOptions } from '../../src/engine/spec.js';

/**
 * **run 选项的可信边界**（2026-11-04 run-options-trust-boundary）。
 *
 * 修之前的事实（实测过，不是推断）：`POST /tasks` 的 `body.options` 整体透传 ⇒ 任何能调它的人
 * 都能自填 `blackboard: { tenant: '别人的租户' }`，而 usage-guide §6.6 的多租户配额配方
 * 正是「用黑板存 tenant」。同一件事在 `POST /run` 上却是死路（压根没有 options 入口）——
 * 需要身份的那条拿不到，拿得到的那条不可信。
 *
 * 这里钉四件事：
 * ① 客户端设黑名单键（`blackboard` / `tools`）⇒ **400 且一个任务都不许受理**；
 * ② 拼错的键（`maxCostUSD`）也 400 —— 静默忽略会让人以为花销已封顶；
 * ③ 宿主 `resolveRunOptions` 注入的 blackboard / labels 对 `/run` 与 `/tasks` **都**生效，
 *    且 `authenticate` 的返回值真的作为 `principal` 传到了钩子里；
 * ④ 预算取**更严者**：客户端不能把服务端上限抬高。
 */

function fakeResult(): AgentRunResult {
  return {
    trace: {
      traceId: 'trace-1',
      rootSpanId: 'span-1',
      spans: [],
      status: 'ok',
      totalUsage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    },
    stopReason: 'end_turn',
    finalText: 'ok',
    iterations: 1,
    error: undefined,
    typed: undefined,
    suspendedMessages: undefined,
    pendingApprovals: undefined,
    suspendedReason: undefined,
    wakeAt: undefined,
    eventsDelivered: false,
  };
}

/** 记录每次 run 拿到的选项 —— 断言的是「宿主把它交到了 app.run」这一跳 */
function capture(seen: RunInvocationOptions[]): AppCallable {
  return {
    name: 'capture',
    async run(_messages, opts) {
      seen.push(opts ?? {});
      return { run: { runId: `r-${seen.length}`, status: 'succeeded' }, result: fakeResult() };
    },
  };
}

async function start(
  app: AppCallable,
  opts: Parameters<typeof createHttpHandler>[1] = {},
): Promise<{ handler: HttpHandler; server: Server; base: string }> {
  const handler = createHttpHandler(app, opts);
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { handler, server, base: `http://127.0.0.1:${port}` };
}

function close(server: Server): Promise<void> {
  return new Promise((r) => server.close(() => r()));
}

// biome-ignore lint/suspicious/noExplicitAny: 端点回的是运行时数据，逐字段断言时不必每个字段先窄化 unknown
async function readJson(res: Response): Promise<any> {
  return res.json();
}

function submit(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /tasks 的 options：客户端只能设白名单键', () => {
  it('options.blackboard（冒充租户）→ 400，且一个任务都没受理', async () => {
    const seen: RunInvocationOptions[] = [];
    const { handler, server, base } = await start(capture(seen));
    try {
      const res = await submit(base, {
        input: 'hi',
        options: { blackboard: { tenant: 'evil-tenant' } },
      });
      assert.equal(res.status, 400);
      const body = await readJson(res);
      assert.match(body.error, /blackboard/);
      assert.deepEqual(await handler.runner.list(), [], '被拒的提交不许落进任务表');
      assert.deepEqual(seen, [], '更不许真跑');
    } finally {
      await close(server);
    }
  });

  it('options.tools（换掉整个工具菜单）→ 400', async () => {
    const { server, base } = await start(capture([]));
    try {
      const res = await submit(base, { input: 'hi', options: { tools: [] } });
      assert.equal(res.status, 400);
      assert.match((await readJson(res)).error, /tools/);
    } finally {
      await close(server);
    }
  });

  it('拼错的键（maxCostUSD）→ 400，不静默丢弃', async () => {
    const { server, base } = await start(capture([]));
    try {
      const res = await submit(base, { input: 'hi', options: { maxCostUSD: 1 } });
      assert.equal(res.status, 400, '静默忽略会让人以为花销已封顶');
      assert.match((await readJson(res)).error, /maxCostUSD/);
    } finally {
      await close(server);
    }
  });

  it('白名单内的 traceContext / maxCostUsd 照常落进 TaskRecord.spec.options', async () => {
    const { server, base } = await start(capture([]));
    try {
      const res = await submit(base, {
        input: 'hi',
        options: { traceContext: { traceId: 'a'.repeat(32) }, maxCostUsd: 0.5 },
      });
      assert.equal(res.status, 202);
      const rec = await readJson(res);
      assert.equal(rec.spec.options.maxCostUsd, 0.5);
      assert.equal(rec.spec.options.traceContext.traceId, 'a'.repeat(32));
    } finally {
      await close(server);
    }
  });
});

describe('宿主注入（resolveRunOptions）：身份只从这一条进', () => {
  it('POST /run 拿到注入的 blackboard —— 修好「需要身份的那条路是死路」', async () => {
    const seen: RunInvocationOptions[] = [];
    const { server, base } = await start(capture(seen), {
      resolveRunOptions: () => ({ blackboard: { tenant: 'acme' }, labels: { tenant: 'acme' } }),
    });
    try {
      const res = await fetch(`${base}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(seen[0]?.blackboard, { tenant: 'acme' });
      assert.deepEqual(seen[0]?.labels, { tenant: 'acme' });
    } finally {
      await close(server);
    }
  });

  it('POST /tasks 也拿到注入（白名单没把它一起挡掉）', async () => {
    const { server, base } = await start(capture([]), {
      resolveRunOptions: () => ({ blackboard: { tenant: 'acme' } }),
    });
    try {
      const res = await submit(base, { input: 'hi' });
      assert.equal(res.status, 202);
      assert.deepEqual((await readJson(res)).spec.options.blackboard, { tenant: 'acme' });
    } finally {
      await close(server);
    }
  });

  it('authenticate 的返回值作为 principal 传进钩子（身份链闭合）', async () => {
    const seenPrincipal: unknown[] = [];
    const { server, base } = await start(capture([]), {
      authenticate: (req: IncomingMessage) => ({ userId: req.headers['x-user'] ?? 'anon' }),
      resolveRunOptions: (_req, info) => {
        seenPrincipal.push(info.principal);
        return { labels: { user: (info.principal as { userId: string }).userId } };
      },
    });
    try {
      const res = await fetch(`${base}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user': 'u-42' },
        body: JSON.stringify({ text: 'hi' }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(seenPrincipal, [{ userId: 'u-42' }]);
    } finally {
      await close(server);
    }
  });

  it('预算取更严者：客户端 5 与服务端 2 ⇒ 2；客户端 0.5 ⇒ 0.5（不许放宽）', async () => {
    const seen: RunInvocationOptions[] = [];
    const overrides: RunOptionOverrides[] = [{ maxCostUsd: 2 }];
    const { server, base } = await start(capture(seen), {
      resolveRunOptions: () => overrides[0],
    });
    try {
      const loose = await submit(base, { input: 'hi', options: { maxCostUsd: 5 } });
      assert.equal((await readJson(loose)).spec.options.maxCostUsd, 2);

      overrides[0] = { maxCostUsd: 10 };
      const tight = await submit(base, { input: 'hi', options: { maxCostUsd: 0.5 } });
      assert.equal((await readJson(tight)).spec.options.maxCostUsd, 0.5);
    } finally {
      await close(server);
    }
  });

  it('钩子抛 HttpException(403) → 按其状态码回（校验失败不必走 500）', async () => {
    const { server, base } = await start(capture([]), {
      resolveRunOptions: () => {
        throw new HttpException(403, { error: '租户未开通' });
      },
    });
    try {
      const res = await submit(base, { input: 'hi' });
      assert.equal(res.status, 403);
      assert.deepEqual(await readJson(res), { error: '租户未开通' });
    } finally {
      await close(server);
    }
  });
});
