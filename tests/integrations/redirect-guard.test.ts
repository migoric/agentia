import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAnthropicClient } from '../../src/integrations/anthropic.js';

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('fetch 不跟随重定向（2026-11-07 深评）', () => {
  it('307 不会把 x-api-key / prompt body 发到另一个 origin', async () => {
    let targetHits = 0;
    const target = await listen((req, res) => {
      targetHits++;
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    const redirector = await listen((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(307, { location: `${target.url}/v1/messages` });
        res.end();
      });
    });
    try {
      const client = createAnthropicClient({ apiKey: 'secret', baseURL: redirector.url });
      const stream = client.messages.stream({
        model: 'claude-opus-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hello' }],
      });
      await assert.rejects(stream.finalMessage(), (e: unknown) => {
        assert.equal((e as { status?: number }).status, 307);
        return true;
      });
      assert.equal(targetHits, 0, '目标 origin 一个字节都不该收到');
    } finally {
      await redirector.close();
      await target.close();
    }
  });
});
