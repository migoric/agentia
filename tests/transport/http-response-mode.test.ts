import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AsyncRunner,
  InMemorySessionStore,
  createHttpHandler,
  type AgentRunResult,
  type AppCallable,
  type HttpHandler,
  type HttpHandlerOptions,
  type TaskRecord,
} from '../../src/index.js';

function fakeResult(): AgentRunResult {
  return {
    trace: {
      traceId: 'trace-secret',
      rootSpanId: 'span-1',
      spans: [],
      status: 'ok',
      totalUsage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    },
    stopReason: 'end_turn',
    finalText: 'ok',
    iterations: 1,
    error: undefined,
    typed: { answer: 'ok' },
    suspendedMessages: [{ role: 'assistant', content: 'internal-history' }],
    pendingApprovals: undefined,
    suspendedReason: undefined,
    wakeAt: undefined,
    eventsDelivered: false,
  };
}

const app: AppCallable = {
  name: 'public-response',
  async run(_messages, opts) {
    opts?.onText?.('ok');
    opts?.onTraceEvent?.({
      seq: 1,
      type: 'span.attribute',
      spanId: 'span-1',
      key: 'secret',
      value: 'tool-payload',
    });
    return { run: { runId: 'run-1', status: 'succeeded' }, result: fakeResult() };
  },
};

async function start(
  opts: HttpHandlerOptions,
  appOverride: AppCallable = app,
): Promise<{
  server: Server;
  handler: HttpHandler;
  base: string;
}> {
  const handler = createHttpHandler(appOverride, opts);
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { server, handler, base: `http://127.0.0.1:${port}` };
}

function close(server: Server): Promise<void> {
  return new Promise((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });
}

describe('HTTP responseMode=public', () => {
  it('/run 与任务记录去掉 trace、消息、挂起历史和 ownerId，存储仍保留完整记录', async () => {
    const { server, handler, base } = await start({ responseMode: 'public' });
    try {
      const run = await fetch(`${base}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'customer-secret' }),
      });
      const runBody = (await run.json()) as Record<string, unknown>;
      assert.equal(runBody.status, 'succeeded');
      assert.deepEqual(runBody.typed, { answer: 'ok' });
      assert.ok(!('trace' in runBody));

      const submitted = await fetch(`${base}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'customer-secret' }),
      });
      const task = (await submitted.json()) as Record<string, unknown>;
      const taskId = String(task.taskId);
      assert.ok(!('spec' in task));
      assert.ok(!('ownerId' in task));
      await handler.runner.awaitTask(taskId);

      const polled = await fetch(`${base}/tasks/${taskId}`);
      const body = (await polled.json()) as {
        result?: Record<string, unknown>;
      };
      assert.ok(body.result);
      assert.ok(!('trace' in body.result));
      assert.ok(!('suspendedMessages' in body.result));

      const stored = await handler.runner.store.get(taskId);
      assert.equal(stored?.spec.messages[0]?.content, 'customer-secret');
      assert.equal(stored?.result?.trace.traceId, 'trace-secret');
      assert.ok(stored?.result?.suspendedMessages);

      const stream = await fetch(`${base}/tasks/${taskId}/stream`);
      assert.equal(stream.status, 404);
    } finally {
      await close(server);
    }
  });

  it('HITL 挂起 × sessionStore：公共响应不带 sessionInput 原始输入，库内快照仍保留', async () => {
    const suspendingApp: AppCallable = {
      name: 'public-suspension',
      async run() {
        return {
          run: { runId: 'run-suspended', status: 'suspended' },
          result: {
            ...fakeResult(),
            stopReason: 'suspended',
            finalText: '',
            suspendedMessages: [
              { role: 'user', content: 'customer-secret' },
              {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'tu1', name: 'danger', input: {} }],
              },
            ],
            pendingApprovals: ['tu1'],
            suspendedReason: 'approval',
          },
        };
      },
    };
    const runner = new AsyncRunner(suspendingApp, {
      sessionStore: new InMemorySessionStore(),
    });
    const { server, base } = await start({ responseMode: 'public', runner }, suspendingApp);
    try {
      const task = runner.submit('customer-secret', { options: { sessionId: 's1' } });
      let stored: TaskRecord | undefined;
      const deadline = Date.now() + 2_000;
      while (stored?.status !== 'suspended') {
        assert.ok(Date.now() < deadline, '任务应进入挂起态');
        await new Promise((resolve) => setTimeout(resolve, 5));
        stored = await runner.store.get(task.taskId);
      }
      assert.deepEqual(stored.sessionInput, [{ role: 'user', content: 'customer-secret' }]);

      const response = await fetch(`${base}/tasks/${task.taskId}`);
      const text = await response.text();
      assert.equal(response.status, 200);
      assert.equal(text.includes('customer-secret'), false, '任何公共字段都不得带出原始输入');
      assert.equal('sessionInput' in (JSON.parse(text) as Record<string, unknown>), false);
      assert.deepEqual((await runner.store.get(task.taskId))?.sessionInput, [
        { role: 'user', content: 'customer-secret' },
      ]);
    } finally {
      await close(server);
      await runner.drain({ timeoutMs: 100 });
    }
  });

  it('SSE 默认不发 trace.event、run.end 也不带 trace；文本帧不受影响', async () => {
    const { server, base } = await start({ responseMode: 'public' });
    try {
      const res = await fetch(`${base}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify('hi'),
      });
      const text = await res.text();
      assert.match(text, /event: text\.delta/);
      assert.match(text, /event: run\.end/);
      assert.ok(!text.includes('event: trace.event'));
      assert.ok(!text.includes('trace-secret'));
    } finally {
      await close(server);
    }
  });

  it('exposeTraceEvents:true 可单独开帧，但不会把 trace 加回公共 run.end', async () => {
    const { server, base } = await start({ responseMode: 'public', exposeTraceEvents: true });
    try {
      const res = await fetch(`${base}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify('hi'),
      });
      const text = await res.text();
      assert.match(text, /event: trace\.event/);
      const end = text.split('event: run.end\n')[1];
      assert.ok(end && !end.includes('trace-secret'));
    } finally {
      await close(server);
    }
  });

  it('未知 responseMode 构造期响亮失败', () => {
    assert.throws(
      () => createHttpHandler(app, { responseMode: 'private' as 'public' }),
      /responseMode/,
    );
  });
});
