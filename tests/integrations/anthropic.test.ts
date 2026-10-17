import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAnthropicClient } from '../../src/index.js';
import { AnthropicApiError } from '../../src/integrations/anthropic.js';
import { classifyError } from '../../src/index.js';
import { MAX_TIMER_DELAY_MS } from '../../src/core/timeout.js';
import { waitFor } from '../helpers.js';

/**
 * `createAnthropicClient` 是默认 ModelClient 的工厂 —— 2026-09-17 起为**手写 fetch + SSE**
 * 实现（不再包装 @anthropic-ai/sdk），所以这里的假端点也用手写 SSE 字节流
 * （不依赖 SDK 的任何行为假设）。
 *
 * 守的「缝」：① 返回值满足 `ModelClient` 结构面（构造期不触网）；
 * ② SSE 分片 → on('text') / finalMessage 的组装语义（text / tool_use / usage / stop_reason）；
 * ③ **signal 真到传输层**（abort 后在飞请求必须断开）；
 * ④ 重试语义与 SDK 缺省对齐（408/409/429/5xx 重试、400 不重试、retry-after 被尊重）；
 * ⑤ 上游把错误塞进 200 流（type=error 事件）必须抛出而不是组装成假成功。
 */

/** 把事件列表编成 SSE 字节流（`event:` 行照常写，但实现只认 `data:` payload 的 type） */
function sse(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

/** 标准文本流：两片 text_delta，usage 含 cache 计量，message_delta 给累计 output */
function textEvents(text1: string, text2: string): Array<Record<string, unknown>> {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'm',
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: 12,
          output_tokens: 1,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 7,
        },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text1 } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text2 } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 9 },
    },
    { type: 'message_stop' },
  ];
}

function writeSse(res: ServerResponse, events: Array<Record<string, unknown>>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(sse(events));
}

/** 起本地假端点（零 key、零外网），返回 baseURL 与请求计数 */
async function fakeEndpoint(
  handler: (hits: number, res: ServerResponse) => void,
): Promise<{ baseURL: string; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const server: Server = createServer((_req, res) => {
    hits += 1;
    handler(hits, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}`,
    hits: () => hits,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const BASE_PARAMS = {
  model: 'm',
  max_tokens: 16,
  messages: [{ role: 'user' as const, content: 'hi' }],
};

describe('createAnthropicClient（默认 ModelClient 工厂）', () => {
  it('返回满足 ModelClient 结构面的对象（构造期不触网）', () => {
    const client = createAnthropicClient({ apiKey: 'sk-test' });
    assert.equal(typeof client.messages.stream, 'function', '须提供 messages.stream');
  });

  it('自定义项（apiKey / baseURL / maxRetries / timeout）透传，构造不抛错', () => {
    const client = createAnthropicClient({
      apiKey: 'sk-test',
      baseURL: 'http://localhost:1',
      maxRetries: 0,
      timeout: 1000,
    });
    assert.equal(typeof client.messages.stream, 'function');
  });

  it('timeout 非法值构造期抛错（NaN/Infinity/超 2^31-1ms 会被 setTimeout 钳到 1ms，等于每请求立即超时）', () => {
    // 反向验证：摘掉构造期校验 ⇒ 这些值全不抛，本用例红。
    // 与 AsyncRunner 对 runTimeoutMs 的校验同款（要「不限」就不传 timeout）。
    // 最后一条是 2026-09-28 补的上界：`timeout: 30 天` 此前**合法**，但 composeSignal
    // 的 setTimeout 会把它钳到 1ms ⇒ 每个请求立即超时 —— 配置合法、行为相反。
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_TIMER_DELAY_MS + 1]) {
      assert.throws(
        () => createAnthropicClient({ apiKey: 'sk-test', timeout: bad }),
        /timeout|定时器延迟上限/,
        `timeout=${String(bad)} 必须构造期抛错`,
      );
    }
    // 阳性对照：边界内合法（构造期不触网，只校验）
    assert.doesNotThrow(() =>
      createAnthropicClient({ apiKey: 'sk-test', timeout: MAX_TIMER_DELAY_MS }),
    );
  });

  it('请求落在 {baseURL}/v1/messages，带 x-api-key / anthropic-version / stream:true，signal 不进 body', async () => {
    // `as` 防 TS 按初始值把 seen 窄化成 null（赋值发生在闭包里，控制流看不见）
    let seen = null as {
      url?: string | undefined;
      headers: Record<string, unknown>;
      body: string;
    } | null;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        seen = { url: req.url, headers: req.headers, body };
        writeSse(res, textEvents('你', '好'));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      const ac = new AbortController();
      const client = createAnthropicClient({
        apiKey: 'sk-test',
        baseURL: `http://127.0.0.1:${port}`,
      });
      const s = client.messages.stream({ ...BASE_PARAMS, signal: ac.signal });
      const final = await s.finalMessage();
      assert.ok(seen, '假端点应收到请求');
      assert.equal(seen.url, '/v1/messages');
      assert.equal(seen.headers['x-api-key'], 'sk-test');
      assert.equal(seen.headers['anthropic-version'], '2023-06-01');
      const parsed = JSON.parse(seen.body) as Record<string, unknown>;
      assert.equal(parsed.stream, true, 'body 必须带 stream:true');
      assert.equal('signal' in parsed, false, 'signal 是契约字段，不得进请求体');
      assert.equal(final.stop_reason, 'end_turn');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('SSE 组装：分片 → on(text) 与 finalMessage', () => {
  it("text 分片逐个触发 on('text')，拼接 == finalMessage 文本；usage 含 cache 计量；stop_reason 透传", async () => {
    const ep = await fakeEndpoint((_hits, res) => writeSse(res, textEvents('你好', '，世界')));
    try {
      const client = createAnthropicClient({ apiKey: 'sk-test', baseURL: ep.baseURL });
      const s = client.messages.stream(BASE_PARAMS);
      const deltas: string[] = [];
      s.on('text', (d) => deltas.push(d));
      const final = await s.finalMessage();

      assert.deepEqual(deltas, ['你好', '，世界'], '每个 text_delta 触发一次回调');
      const text = final.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('');
      assert.equal(text, '你好，世界');
      assert.equal(deltas.join(''), text, '分片拼接必须与 finalMessage 文本一致');
      assert.equal(final.stop_reason, 'end_turn');
      assert.equal(final.id, 'msg_1');
      assert.equal(final.usage.input_tokens, 12);
      assert.equal(final.usage.output_tokens, 9, 'message_delta 的累计 output_tokens 覆盖初始值');
      assert.equal(final.usage.cache_creation_input_tokens, 5, 'cache 计量必须透传');
      assert.equal(final.usage.cache_read_input_tokens, 7, 'cache 计量必须透传');
    } finally {
      await ep.close();
    }
  });

  it('message_delta 里的显式 null **不得**清掉 message_start 的真实计量（浅合并是错的）', async () => {
    // 网关/代理型端点的真实形态：message_start 报全量，随后的 message_delta 只带
    // output_tokens，input/cache 三项显式给 null。`{...base, ...delta}` 会把四项全清成 null，
    // 末尾的 `?? 0` 再归零 → 该回合 input/cache token 与 costEstimate 一起塌成 0，
    // maxCostUsd 护栏随之失效（花超了也不拦）。缺值的语义是「保持已有值」。
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'msg_3',
          type: 'message',
          role: 'assistant',
          model: 'm',
          content: [],
          stop_reason: null,
          usage: {
            input_tokens: 12,
            output_tokens: 1,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 7,
          },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: {
          output_tokens: 9,
          input_tokens: null,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      },
      { type: 'message_stop' },
    ];
    const ep = await fakeEndpoint((_h, res) => writeSse(res, events));
    try {
      const client = createAnthropicClient({ apiKey: 'sk-test', baseURL: ep.baseURL });
      const final = await client.messages.stream(BASE_PARAMS).finalMessage();
      assert.equal(final.usage.input_tokens, 12, 'null 不得覆盖 message_start 的真实值');
      assert.equal(final.usage.cache_creation_input_tokens, 5);
      assert.equal(final.usage.cache_read_input_tokens, 7);
      assert.equal(final.usage.output_tokens, 9, '真给了新值的字段照常覆盖');
    } finally {
      await ep.close();
    }
  });

  it('tool_use 块从 input_json_delta 分片（跨分片的半截 JSON）正确组装', async () => {
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'msg_2',
          type: 'message',
          role: 'assistant',
          model: 'm',
          content: [],
          usage: { input_tokens: 3, output_tokens: 1 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
      },
      // 工具入参被拆成三片，且切片点落在多字节字符中间之外的任意位置
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"city":"北' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '京","' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: 'n":1}' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 8 },
      },
      { type: 'message_stop' },
    ];
    const ep = await fakeEndpoint((_hits, res) => writeSse(res, events));
    try {
      const client = createAnthropicClient({ apiKey: 'sk-test', baseURL: ep.baseURL });
      const final = await client.messages.stream(BASE_PARAMS).finalMessage();
      assert.equal(final.stop_reason, 'tool_use');
      assert.equal(final.content.length, 1);
      const block = final.content[0] as { type: string; id: string; name: string; input: unknown };
      assert.equal(block.type, 'tool_use');
      assert.equal(block.id, 'toolu_1');
      assert.equal(block.name, 'get_weather');
      assert.deepEqual(block.input, { city: '北京', n: 1 }, '分片拼接后必须 parse 成对象');
    } finally {
      await ep.close();
    }
  });

  it('流走完都没见 message_start = 上游故障：抛出，不组装假成功', async () => {
    const ep = await fakeEndpoint((_hits, res) =>
      writeSse(res, [{ type: 'ping' }, { type: 'message_stop' }]),
    );
    try {
      const client = createAnthropicClient({ apiKey: 'sk-test', baseURL: ep.baseURL });
      await assert.rejects(
        client.messages.stream(BASE_PARAMS).finalMessage(),
        /未见 message_start/,
      );
    } finally {
      await ep.close();
    }
  });

  it('content_block_start 内联 tool_use.input 且不发 input_json_delta：用内联值（兼容端点形态）', async () => {
    // 官方端点在 start 事件里恒给 `input: {}`、完整入参走 input_json_delta；
    // 个别兼容端点把完整 input 内联在 start 且不发 delta —— 不收下它，工具会拿 {} 静默执行。
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'msg_inline',
          type: 'message',
          role: 'assistant',
          model: 'm',
          content: [],
          usage: { input_tokens: 3, output_tokens: 1 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_inline',
          name: 'get_weather',
          input: { city: 'sf' },
        },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 8 },
      },
      { type: 'message_stop' },
    ];
    const ep = await fakeEndpoint((_hits, res) => writeSse(res, events));
    try {
      const client = createAnthropicClient({ apiKey: 'sk-test', baseURL: ep.baseURL });
      const final = await client.messages.stream(BASE_PARAMS).finalMessage();
      assert.equal(final.stop_reason, 'tool_use');
      assert.equal(final.content.length, 1);
      const block = final.content[0] as { type: string; id: string; name: string; input: unknown };
      assert.equal(block.type, 'tool_use');
      assert.equal(block.id, 'toolu_inline');
      assert.equal(block.name, 'get_weather');
      assert.deepEqual(block.input, { city: 'sf' }, 'start 事件内联的完整 input 不得被丢成 {}');
    } finally {
      await ep.close();
    }
  });

  it('上游把错误塞进 200 流（type=error 事件）：抛出 AnthropicApiError 且按类型映射 status', async () => {
    const events = [
      {
        type: 'message_start',
        message: { id: 'msg_3', type: 'message', role: 'assistant', model: 'm', content: [] },
      },
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    ];
    const ep = await fakeEndpoint((_hits, res) => writeSse(res, events));
    try {
      const client = createAnthropicClient({ apiKey: 'sk-test', baseURL: ep.baseURL });
      const err = await client.messages
        .stream(BASE_PARAMS)
        .finalMessage()
        .then(
          () => null,
          (e: unknown) => e,
        );
      assert.ok(err instanceof AnthropicApiError, `应抛 AnthropicApiError，实际：${String(err)}`);
      assert.equal(err.status, 529, 'overloaded_error → 529（classifyError 归为 server/可重试）');
      const span = classifyError(err);
      assert.equal(span.type, 'server');
      assert.equal(span.retryable, true);
    } finally {
      await ep.close();
    }
  });

  it('流内 invalid_request_error → 400：classifyError 归 api / 不可重试（与 openai.ts 同口径）', async () => {
    // 反向验证：摘掉 statusOfStreamError 的 4xx 档 ⇒ 默认落 500（server/可重试），
    // 本用例红在「竟然可重试」—— 改配置才有救的病因会让引擎白重试三轮。
    for (const type of [
      'invalid_request_error',
      'authentication_error',
      'permission_error',
      'not_found_error',
    ]) {
      const events = [
        {
          type: 'message_start',
          message: { id: 'msg_e', type: 'message', role: 'assistant', model: 'm', content: [] },
        },
        { type: 'error', error: { type, message: 'bad request' } },
      ];
      const ep = await fakeEndpoint((_hits, res) => writeSse(res, events));
      try {
        const client = createAnthropicClient({
          apiKey: 'sk-test',
          baseURL: ep.baseURL,
          maxRetries: 0,
        });
        const err = await client.messages
          .stream(BASE_PARAMS)
          .finalMessage()
          .then(
            () => null,
            (e: unknown) => e,
          );
        assert.ok(err instanceof AnthropicApiError, `${type} 应抛 AnthropicApiError`);
        assert.equal(err.status, 400, `${type} → 400（对齐 openai.ts 的 4xx 档）`);
        const info = classifyError(err);
        assert.equal(info.type, 'api', `${type} 应归 api（不是 server）`);
        assert.equal(info.retryable, false, `${type} 不可重试 —— 改配置才有救`);
      } finally {
        await ep.close();
      }
    }
  });

  it('content_block_start 的畸形 index（超大）⇒ 响亮抛错，不造稀疏数组拖垮组装', async () => {
    // 反向验证：摘掉 index 上限守卫 ⇒ blocks[1e9] = acc 造出长度十亿的稀疏数组，
    // 末尾 `for (const b of blocks)` 按 length 空转 —— 本用例红在「竟然正常返回」。
    const events = [
      {
        type: 'message_start',
        message: { id: 'msg_b', type: 'message', role: 'assistant', model: 'm', content: [] },
      },
      { type: 'content_block_start', index: 1_000_000_000, content_block: { type: 'text' } },
      { type: 'message_stop' },
    ];
    const ep = await fakeEndpoint((_hits, res) => writeSse(res, events));
    try {
      const client = createAnthropicClient({
        apiKey: 'sk-test',
        baseURL: ep.baseURL,
        maxRetries: 0,
      });
      await assert.rejects(
        () => client.messages.stream(BASE_PARAMS).finalMessage(),
        (e: unknown) => {
          assert.ok(e instanceof AnthropicApiError);
          assert.match(e.message, /index 非法/);
          return true;
        },
      );
    } finally {
      await ep.close();
    }
  });
});

describe('thinking 与未知块型（收拼 + signature 累积 + 原样透传）', () => {
  const MESSAGE_START = {
    type: 'message_start',
    message: {
      id: 'msg_t',
      type: 'message',
      role: 'assistant',
      model: 'm',
      content: [],
      usage: { input_tokens: 5, output_tokens: 1 },
    },
  };
  const MESSAGE_END = [
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 6 },
    },
    { type: 'message_stop' },
  ];

  it('thinking 块：thinking_delta 收拼、signature_delta 累积进 signature', async () => {
    const events = [
      MESSAGE_START,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '先想' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '再想' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig-1' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: '-2' },
      },
      { type: 'content_block_stop', index: 0 },
      ...MESSAGE_END,
    ];
    const ep = await fakeEndpoint((_hits, res) => writeSse(res, events));
    try {
      const client = createAnthropicClient({ apiKey: 'sk-test', baseURL: ep.baseURL });
      const final = await client.messages.stream(BASE_PARAMS).finalMessage();
      assert.equal(final.content.length, 1);
      const block = final.content[0] as { type: string; thinking: string; signature: string };
      assert.equal(block.type, 'thinking');
      assert.equal(block.thinking, '先想再想');
      assert.equal(block.signature, 'sig-1-2', 'signature_delta 分片必须累积拼接');
    } finally {
      await ep.close();
    }
  });

  it('redacted_thinking 块（数据在 data 字段）原样透出，不丢成空文本块', async () => {
    const events = [
      MESSAGE_START,
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'redacted_thinking', data: 'EmwKAhgBEgy3Hc' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '答' } },
      { type: 'content_block_stop', index: 1 },
      ...MESSAGE_END,
    ];
    const ep = await fakeEndpoint((_hits, res) => writeSse(res, events));
    try {
      const client = createAnthropicClient({ apiKey: 'sk-test', baseURL: ep.baseURL });
      const final = await client.messages.stream(BASE_PARAMS).finalMessage();
      assert.equal(final.content.length, 2);
      assert.deepEqual(
        final.content[0],
        { type: 'redacted_thinking', data: 'EmwKAhgBEgy3Hc' },
        'redacted_thinking 必须原样在 finalMessage 里',
      );
      assert.deepEqual(final.content[1], { type: 'text', text: '答' });
    } finally {
      await ep.close();
    }
  });

  it('未知新块型（假想的 web_search_result）原样透传，额外字段不丢', async () => {
    const events = [
      MESSAGE_START,
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'web_search_result',
          url: 'https://example.com',
          snippets: ['a', 'b'],
        },
      },
      { type: 'content_block_stop', index: 0 },
      ...MESSAGE_END,
    ];
    const ep = await fakeEndpoint((_hits, res) => writeSse(res, events));
    try {
      const client = createAnthropicClient({ apiKey: 'sk-test', baseURL: ep.baseURL });
      const final = await client.messages.stream(BASE_PARAMS).finalMessage();
      assert.deepEqual(
        final.content[0],
        { type: 'web_search_result', url: 'https://example.com', snippets: ['a', 'b'] },
        '未知块型与其全部字段必须原样透传',
      );
    } finally {
      await ep.close();
    }
  });
});

describe('重试 parity（SDK 缺省语义：408/409/429/5xx/连接错误，尊重 retry-after）', () => {
  // 408/409 与 SDK 缺省对齐：client 内重试；耗尽后才轮到引擎分类（408/409 落 api/不可重试）
  for (const status of [408, 409] as const) {
    it(`${status}（带 retry-after: 0）→ 重试后成功`, async () => {
      const ep = await fakeEndpoint((hits, res) => {
        if (hits === 1) {
          res.writeHead(status, { 'retry-after': '0', 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'request_failed', message: `HTTP ${status}` } }));
        } else {
          writeSse(res, textEvents('好', '了'));
        }
      });
      try {
        const client = createAnthropicClient({ apiKey: 'sk-test', baseURL: ep.baseURL });
        const final = await client.messages.stream(BASE_PARAMS).finalMessage();
        assert.equal(ep.hits(), 2, `第一次 ${status} 后必须重试一次`);
        assert.equal(final.stop_reason, 'end_turn');
      } finally {
        await ep.close();
      }
    });
  }

  it('429（带 retry-after: 0）→ 重试后成功', async () => {
    const ep = await fakeEndpoint((hits, res) => {
      if (hits === 1) {
        res.writeHead(429, { 'retry-after': '0', 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } }));
      } else {
        writeSse(res, textEvents('好', '了'));
      }
    });
    try {
      const client = createAnthropicClient({ apiKey: 'sk-test', baseURL: ep.baseURL });
      const final = await client.messages.stream(BASE_PARAMS).finalMessage();
      assert.equal(ep.hits(), 2, '第一次 429 后必须重试一次');
      assert.equal(final.stop_reason, 'end_turn');
    } finally {
      await ep.close();
    }
  });

  it('500 → 重试后成功', async () => {
    const ep = await fakeEndpoint((hits, res) => {
      if (hits === 1) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"boom"}');
      } else {
        writeSse(res, textEvents('恢', '复'));
      }
    });
    try {
      const client = createAnthropicClient({ apiKey: 'sk-test', baseURL: ep.baseURL });
      const final = await client.messages.stream(BASE_PARAMS).finalMessage();
      assert.equal(ep.hits(), 2);
      assert.equal(final.stop_reason, 'end_turn');
    } finally {
      await ep.close();
    }
  });

  it('400 → 不重试，直接抛 AnthropicApiError(status=400)（classifyError → api/不可重试）', async () => {
    const ep = await fakeEndpoint((_hits, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad' } }));
    });
    try {
      const client = createAnthropicClient({ apiKey: 'sk-test', baseURL: ep.baseURL });
      const err = await client.messages
        .stream(BASE_PARAMS)
        .finalMessage()
        .then(
          () => null,
          (e: unknown) => e,
        );
      assert.ok(err instanceof AnthropicApiError);
      assert.equal(err.status, 400);
      assert.equal(ep.hits(), 1, '确定性 4xx 不得重试');
      const span = classifyError(err);
      assert.equal(span.type, 'api');
      assert.equal(span.retryable, false);
    } finally {
      await ep.close();
    }
  });

  it('maxRetries: 0 → 429 也直接抛（重试可关闭）', async () => {
    const ep = await fakeEndpoint((_hits, res) => {
      res.writeHead(429, { 'retry-after': '0' });
      res.end('{}');
    });
    try {
      const client = createAnthropicClient({
        apiKey: 'sk-test',
        baseURL: ep.baseURL,
        maxRetries: 0,
      });
      await assert.rejects(client.messages.stream(BASE_PARAMS).finalMessage(), (e: unknown) => {
        assert.ok(e instanceof AnthropicApiError);
        assert.equal(e.status, 429);
        return true;
      });
      assert.equal(ep.hits(), 1);
    } finally {
      await ep.close();
    }
  });
});

describe('中止在飞请求（零 key、零外网：本地假端点）', () => {
  it('timeout 到点 ⇒ 在飞请求以 TimeoutError 中止（composeSignal 的计时器路径）', async () => {
    // 反向验证：摘掉 composeSignal 的 setTimeout（或 abort 不带 TimeoutError 语义）⇒
    // 本用例红在「3s 都没收场 / 收场的不是 TimeoutError」。#75 只加了构造期校验，
    // 「timeout 到点真中止请求」这条链此前没有自己的用例。
    let hits = 0;
    const server = createServer((_req, _res) => {
      hits += 1; // 收到即可，永不写响应
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      const client = createAnthropicClient({
        apiKey: 'sk-test',
        baseURL: `http://127.0.0.1:${port}`,
        // 300ms 而不是 30ms（plan 2026-10-17 §2.2）：并发跑时 30ms 短于**连接建立本身**
        // ⇒ 超时发生在请求出门口之前、hits 停在 0，而本文要验的是「请求到了、然后超时」。
        timeout: 300,
      });
      const t0 = Date.now();
      const pending = client.messages
        .stream(BASE_PARAMS)
        .finalMessage()
        .then(
          () => null,
          (e: unknown) => e,
        );
      // 「30ms 内必然到达」换成「到达是等出来的」—— 与下方「abort 后请求必须断开」那条同款。
      await waitFor(() => hits >= 1, '假端点应收到在飞请求', 5_000);
      const err = await pending;
      const dt = Date.now() - t0;
      assert.ok(err instanceof Error, `应抛错，实际：${String(err)}`);
      assert.equal(err.name, 'TimeoutError', '超时必须以 TimeoutError 语义收场（不是 AbortError）');
      // 下界不贴边（200 < 300）：证明真等到了计时器到点，而不是别的理由立刻失败；
      // 上界证明它没有挂死。abort 后走「signal.aborted ⇒ 原样向上」，不得再重试。
      assert.ok(dt >= 200, `应真等到超时（300ms），${dt}ms 就收场 = 计时器没走`);
      assert.ok(dt < 5_000, `到点后必须收场，实际等了 ${dt}ms`);
      assert.equal(hits, 1, '超时中止不得再触发重试');
      const span = classifyError(err);
      assert.equal(span.type, 'timeout', 'TimeoutError 由引擎归 timeout 一类账');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('abort 后请求必须断开（signal 直接进 fetch，不进 body）', async () => {
    // 假端点**故意不响应**：请求就此挂在飞 —— 正是「调用方想中止在飞 run」的场景。
    let hits = 0;
    const server = createServer((_req, _res) => {
      hits += 1; // 收到即可，不写响应、不结束
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      const client = createAnthropicClient({
        apiKey: 'sk-test',
        baseURL: `http://127.0.0.1:${port}`,
        maxRetries: 0, // 别让重试掩盖「没断」这件事
      });
      const ac = new AbortController();
      const s = client.messages.stream({
        model: 'm',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
        signal: ac.signal,
      });
      // 触发点用**假端点真收到请求**，不用 sleep 猜时间（确定性）
      await waitFor(() => hits > 0, '假端点收到请求', 5_000);
      ac.abort();

      const outcome = await Promise.race([
        s.finalMessage().then(
          () => 'resolved',
          (e: unknown) => `rejected:${(e as Error).name}`,
        ),
        new Promise<string>((r) => setTimeout(() => r('hung'), 3_000)),
      ]);
      assert.notEqual(
        outcome,
        'hung',
        'abort 之后 3s 仍未结束 ⇒ signal 没被转发到传输层（在飞 run 无法中止）',
      );
      assert.equal(outcome, 'rejected:AbortError', 'abort 必须以 AbortError 语义收场');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

/**
 * A（2026-09-18 第七轮复审）：流被截断 / 空流 **都必须抛带 status 的错误**。
 *
 * 此前这两处抛裸 `Error` ⇒ `classifyError` 判 `unknown` + `retryable:false`：
 * ① 上游故障被记成「模型的协议问题」，排障方向被带偏；
 * ② 引擎层那 3 次重试**一次都不会发生**（同 `otlp.ts` / `openai.ts` 被新守卫抓到的那一类）。
 * 而「已吐半句后断流」更糟：内容非空 ⇒ 旧判据不触发 ⇒ `stop_reason: null` 落
 * `unknown_stop_reason`，同样不可重试。
 */
describe('A：流截断 / 空流按上游故障抛错（带 status、可重试）', () => {
  const expectUpstreamFailure = (e: unknown, re: RegExp): boolean => {
    const c = classifyError(e);
    assert.equal(
      (e as { status?: number }).status,
      500,
      '必须带数值 status（否则 classifyError 判 unknown）',
    );
    assert.equal(c.type, 'server');
    assert.equal(
      c.retryable,
      true,
      '上游故障必须可重试（此前裸 Error 判不可重试 → 引擎一次都不重试）',
    );
    assert.match(String((e as Error).message), re);
    return true;
  };

  it('空流（未见 message_start）→ 500 + 可重试，不再判 unknown', async () => {
    const ep = await fakeEndpoint((_hits, res) => writeSse(res, []));
    try {
      const client = createAnthropicClient({
        apiKey: 'sk-test',
        baseURL: ep.baseURL,
        maxRetries: 0,
      });
      await assert.rejects(
        () => client.messages.stream(BASE_PARAMS).finalMessage(),
        (e: unknown) => expectUpstreamFailure(e, /为空|未见 message_start/),
      );
    } finally {
      await ep.close();
    }
  });

  it('截断（已吐出半句、无 message_delta / message_stop）→ 500 + 可重试，不报成成功', async () => {
    const full = textEvents('你', '好');
    // 砍掉终止证据：`message_delta`（携带 stop_reason）与 `message_stop`
    const truncated = full.slice(0, full.length - 2);
    const ep = await fakeEndpoint((_hits, res) => writeSse(res, truncated));
    try {
      const client = createAnthropicClient({
        apiKey: 'sk-test',
        baseURL: ep.baseURL,
        maxRetries: 0,
      });
      await assert.rejects(
        () => client.messages.stream(BASE_PARAMS).finalMessage(),
        (e: unknown) => expectUpstreamFailure(e, /截断/),
      );
    } finally {
      await ep.close();
    }
  });

  it('正常流（带 message_stop）不受影响 —— 判据不误伤', async () => {
    const ep = await fakeEndpoint((_hits, res) => writeSse(res, textEvents('你', '好')));
    try {
      const client = createAnthropicClient({
        apiKey: 'sk-test',
        baseURL: ep.baseURL,
        maxRetries: 0,
      });
      const msg = await client.messages.stream(BASE_PARAMS).finalMessage();
      assert.equal(msg.stop_reason, 'end_turn');
    } finally {
      await ep.close();
    }
  });
});

/**
 * 非 SSE 回落路径（端点忽略 stream:true、直接回整份 JSON）的形态校验。
 *
 * 修复前这里是 `(await res.json()) as Message` 的裸强转：「HTTP 200 裹错误」
 * （{"error":{...}}）会让 message.content 为 undefined → textOf 的 .filter() 抛裸
 * TypeError → classifyError 判 unknown/不可重试；而**同一个事件**走流式路径
 * （type=error 事件）会被认成带 status 的可重试错误 —— 同一故障两本账。
 */
describe('非 SSE 回落路径的形态校验（200 裹错误 / 缺 content）', () => {
  it('200 裹错误 {"error":{"type":"rate_limit_error"}}：抛 AnthropicApiError(429)，classifyError 判可重试', async () => {
    const ep = await fakeEndpoint((_hits, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } }));
    });
    try {
      const client = createAnthropicClient({
        apiKey: 'sk-test',
        baseURL: ep.baseURL,
        maxRetries: 0,
      });
      const err = await client.messages
        .stream(BASE_PARAMS)
        .finalMessage()
        .then(
          () => null,
          (e: unknown) => e,
        );
      assert.ok(err instanceof AnthropicApiError, `应抛 AnthropicApiError，实际：${String(err)}`);
      assert.equal(err.status, 429, 'rate_limit_error → 429（与流式 error 事件同款映射）');
      const span = classifyError(err);
      assert.equal(span.type, 'rate_limit');
      assert.equal(span.retryable, true);
    } finally {
      await ep.close();
    }
  });

  it('200 但无 content 数组（{}）：抛带 status 的可读错误，不是裸 TypeError', async () => {
    const ep = await fakeEndpoint((_hits, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    try {
      const client = createAnthropicClient({
        apiKey: 'sk-test',
        baseURL: ep.baseURL,
        maxRetries: 0,
      });
      const err = await client.messages
        .stream(BASE_PARAMS)
        .finalMessage()
        .then(
          () => null,
          (e: unknown) => e,
        );
      assert.ok(
        err instanceof AnthropicApiError,
        `应抛 AnthropicApiError 而非裸 TypeError，实际：${String(err)}`,
      );
      assert.equal(err.status, 500);
      assert.match(err.message, /content/);
      const span = classifyError(err);
      assert.equal(span.type, 'server');
      assert.equal(span.retryable, true);
    } finally {
      await ep.close();
    }
  });
});

describe('防御分支：畸形分片与网络失败', () => {
  it('流里混入非 JSON 的 data 行：跳过它，后续正常事件照常组装', async () => {
    // 反向验证：摘掉 `JSON.parse 失败 ⇒ continue` ⇒ 半截分片抛 SyntaxError 毁掉整个流，
    // 本用例红在「竟然抛错」。sse() helper 只写合法事件，这里必须手写原始帧。
    const raw =
      'data: {"type":"message_start","message":{"id":"m","model":"m","usage":{"input_tokens":1,"output_tokens":1}}}\n\n' +
      'data: {这行不是 JSON（半截/畸形分片）\n\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"活下来了"}}\n\n' +
      'data: {"type":"content_block_stop","index":0}\n\n' +
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}\n\n' +
      'data: {"type":"message_stop"}\n\n';
    const ep = await fakeEndpoint((_hits, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(raw);
    });
    try {
      const client = createAnthropicClient({ apiKey: 'sk-test', baseURL: ep.baseURL });
      const final = await client.messages.stream(BASE_PARAMS).finalMessage();
      assert.equal(final.stop_reason, 'end_turn');
      const text = final.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('');
      assert.equal(text, '活下来了', '畸形行之后的事件必须照常组装');
    } finally {
      await ep.close();
    }
  });

  it('tool_use 块既无 input_json_delta 也无内联 input ⇒ input 回落 {}（空入参工具）', async () => {
    // 反向验证：摘掉 `b.inlineInput ?? {}` 的回落 ⇒ input 是 undefined，本用例红。
    const events = [
      {
        type: 'message_start',
        message: { id: 'msg_e', type: 'message', role: 'assistant', model: 'm', content: [] },
      },
      // 刻意不给 input 字段（连官方形态的 {} 都没有），也不发任何 delta
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_e', name: 'ping' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 2 },
      },
      { type: 'message_stop' },
    ];
    const ep = await fakeEndpoint((_h, res) => writeSse(res, events));
    try {
      const client = createAnthropicClient({ apiKey: 'sk-test', baseURL: ep.baseURL });
      const final = await client.messages.stream(BASE_PARAMS).finalMessage();
      const block = final.content[0] as { type: string; input: unknown };
      assert.equal(block.type, 'tool_use');
      assert.deepEqual(block.input, {}, '空入参必须落成 {}，不是 undefined');
    } finally {
      await ep.close();
    }
  });

  it('tool_use 的 input_json_delta 拼出非法 JSON ⇒ 原样透传字符串（交下游 schema 校验）', async () => {
    // 反向验证：摘掉 parseToolInput 的 catch ⇒ JSON.parse 抛出、整条流报废，本用例红。
    const events = [
      {
        type: 'message_start',
        message: { id: 'msg_j', type: 'message', role: 'assistant', model: 'm', content: [] },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_j', name: 'ping', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"bad":' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 2 },
      },
      { type: 'message_stop' },
    ];
    const ep = await fakeEndpoint((_h, res) => writeSse(res, events));
    try {
      const client = createAnthropicClient({ apiKey: 'sk-test', baseURL: ep.baseURL });
      const final = await client.messages.stream(BASE_PARAMS).finalMessage();
      const block = final.content[0] as { type: string; input: unknown };
      assert.equal(block.type, 'tool_use');
      assert.equal(block.input, '{"bad":', '非法 JSON 原样透传（不吞成 {}、不抛）');
    } finally {
      await ep.close();
    }
  });

  it('网络失败（连接被掐）重试耗尽后抛出：总调用次数 = 1 + maxRetries', async () => {
    // 反向验证：摘掉 catch 里的 `continue`（或把 `attempt >= maxRetries` 改错）⇒
    // 要么不重试（hits=1）、要么无限重试（挂住），本用例红。
    let hits = 0;
    const server = createServer((req) => {
      hits += 1;
      req.socket.destroy(); // 接受后立刻掐断 ⇒ fetch reject（undici TypeError: fetch failed）
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      const client = createAnthropicClient({
        apiKey: 'sk-test',
        baseURL: `http://127.0.0.1:${port}`,
        maxRetries: 1,
      });
      const err = await client.messages
        .stream(BASE_PARAMS)
        .finalMessage()
        .then(
          () => null,
          (e: unknown) => e,
        );
      assert.ok(err instanceof Error, `重试耗尽后必须抛出，实际：${String(err)}`);
      assert.equal(hits, 2, '首次 + maxRetries(1) = 2 次请求');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
