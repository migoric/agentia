import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpHandler } from '../../src/transport/http.js';
import type { AppCallable } from '../../src/transport/async.js';

describe('HTTP drain：读 body 的窗口里不能放行新的同步 /run（2026-11-07 深评 F3）', () => {
  it('drain 返回 true 之后到达的 body 尾巴 ⇒ 503，且 app.run 一次都不跑', async () => {
    let runs = 0;
    const app: AppCallable = {
      name: 'app',
      async run() {
        runs++;
        return {
          run: { runId: 'r1', status: 'succeeded' },
          result: {
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
          },
        } as never;
      },
    };
    const handler = createHttpHandler(app, { maxBodyBytes: 1024 * 1024 });
    const server = createServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const body = JSON.stringify({ input: 'hello' });
    try {
      const response = new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port,
            path: '/run',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'content-length': String(Buffer.byteLength(body)),
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', reject);
        // 先只发一半 body，让 handleRun 停在 await parseJsonBody
        req.write(body.slice(0, 5));
        setTimeout(() => {
          void (async () => {
            assert.equal(await handler.drain({ timeoutMs: 200 }), true, '此刻没有在飞 run');
            req.end(body.slice(5));
          })();
        }, 20);
      });
      assert.equal(await response, 503);
      assert.equal(runs, 0, 'drain 之后到达的请求不得起 run');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
