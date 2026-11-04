import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createHttpHandler,
  HttpException,
  type AgentRunResult,
  type AppCallable,
  type HttpHandler,
  type TaskControlAction,
} from '../../src/index.js';

function result(): AgentRunResult {
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

const app: AppCallable = {
  name: 'authz',
  run: async () => ({ run: { runId: 'run-1', status: 'succeeded' }, result: result() }),
};

async function setup(): Promise<{
  server: Server;
  handler: HttpHandler;
  base: string;
  seen: TaskControlAction[];
}> {
  const seen: TaskControlAction[] = [];
  const handler = createHttpHandler(app, {
    authenticate: (req) => ({ tenant: String(req.headers['x-tenant'] ?? '') }),
    resolveRunOptions: (_req, { principal }) => ({
      blackboard: { tenant: (principal as { tenant: string }).tenant },
    }),
    authorizeTask: (_req, { action, task, principal }) => {
      seen.push(action);
      return task.spec.options?.blackboard?.tenant === (principal as { tenant: string }).tenant;
    },
  });
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { server, handler, base: `http://127.0.0.1:${port}`, seen };
}

function close(server: Server): Promise<void> {
  return new Promise((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });
}

async function submit(base: string, tenant: string): Promise<string> {
  const res = await fetch(`${base}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant': tenant },
    body: JSON.stringify({ input: 'hi' }),
  });
  assert.equal(res.status, 202);
  return ((await res.json()) as { taskId: string }).taskId;
}

describe('任务控制面的对象级授权', () => {
  it('poll / approve / cancel / event / stream 都按 task 租户 + principal 判定', async () => {
    const { server, handler, base, seen } = await setup();
    try {
      const taskId = await submit(base, 'acme');
      const calls: Array<[string, 'GET' | 'POST', unknown?]> = [
        [`/tasks/${taskId}`, 'GET'],
        [`/tasks/${taskId}/approve`, 'POST', { decisions: {} }],
        [`/tasks/${taskId}/cancel`, 'POST'],
        [`/tasks/${taskId}/events`, 'POST', { type: 'x', payload: 'x' }],
        [`/tasks/${taskId}/stream`, 'GET'],
      ];
      for (const [path, method, body] of calls) {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: { 'content-type': 'application/json', 'x-tenant': 'other' },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        assert.equal(res.status, 403, `${method} ${path}`);
        assert.equal(((await res.json()) as { error: string }).error, '无权操作该任务');
      }
      assert.deepEqual(seen, ['poll', 'approve', 'cancel', 'event', 'stream']);
      assert.equal((await handler.runner.poll(taskId))?.status, 'succeeded');

      const own = await fetch(`${base}/tasks/${taskId}`, { headers: { 'x-tenant': 'acme' } });
      assert.equal(own.status, 200);
    } finally {
      await close(server);
    }
  });

  it('不存在的任务不调用授权钩子；HttpException 保留宿主状态码与响应体', async () => {
    const { server, base } = await setup();
    try {
      const missing = await fetch(`${base}/tasks/nope`, { headers: { 'x-tenant': 'acme' } });
      assert.equal(missing.status, 404);
    } finally {
      await close(server);
    }

    const handler = createHttpHandler(app, {
      authorizeTask: () => {
        throw new HttpException(451, { error: 'policy' });
      },
    });
    const server2 = createServer(handler);
    await new Promise<void>((r) => server2.listen(0, '127.0.0.1', r));
    const { port } = server2.address() as AddressInfo;
    try {
      const submitRes = await fetch(`http://127.0.0.1:${port}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'hi' }),
      });
      const { taskId } = (await submitRes.json()) as { taskId: string };
      const res = await fetch(`http://127.0.0.1:${port}/tasks/${taskId}`);
      assert.equal(res.status, 451);
      assert.deepEqual(await res.json(), { error: 'policy' });
    } finally {
      await close(server2);
    }
  });
});
