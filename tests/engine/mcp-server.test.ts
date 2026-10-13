import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpServer } from '../../src/engine/mcp-server.js';
import type { McpServer, McpServerOptions } from '../../src/engine/mcp-server.js';
import { createStdioMcpConnector } from '../../src/integrations/mcp.js';
import type { AgentTool, ModelClient, ToolRunContext } from '../../src/core/tool.js';
import type { Span, Trace, TraceSink } from '../../src/core/trace.js';
import { DEFAULT_PROTOCOL_VERSION } from '../../src/integrations/mcp.js';
import { MAX_FRAME_CHARS } from '../../src/core/line-framing.js';

/**
 * MCP 反向桥（`createMcpServer`，R8-P5）的测试。
 *
 * 协议面大多走**真 HTTP**（in-process listen 127.0.0.1:0，零网络）：形状断言要穿过
 * 真实的序列化/反序列化才有意义。stdio 侧起**真子进程**（fixtures/mcp/reverse-server.ts，
 * 与连接器测试同一纪律：spawn / 分帧 / 握手顺序只存在于真子进程世界里），且夹具走
 * `createApp` + `@Tool` 真装配 —— 顺带钉住「真 AgentApp 满足鸭子类型入参」。
 */

const FIXTURE = fileURLToPath(new URL('../fixtures/mcp/reverse-server.ts', import.meta.url));

const hello: AgentTool = {
  name: 'say_hello',
  description: '打招呼',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
  run: (input) => `你好，${(input as { name: string }).name}`,
};

const echoObj: AgentTool = {
  name: 'echo_object',
  description: '回显对象',
  inputSchema: { type: 'object' },
  run: () => ({ ok: true, n: 7 }),
};

const failer: AgentTool = {
  name: 'fail_tool',
  description: '总是失败',
  inputSchema: { type: 'object' },
  run: () => {
    throw new Error('工具炸了');
  },
};

/** 收 trace 的测试 sink */
function collectTraces(): { sink: TraceSink; traces: Trace[] } {
  const traces: Trace[] = [];
  return { sink: { export: (t) => void traces.push(t) }, traces };
}

/** 本文件开过的 server：afterEach 统一收掉 */
const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close().catch(() => undefined)));
});

async function startHttp(
  tools: AgentTool[],
  opts: Partial<McpServerOptions> = {},
): Promise<McpServer> {
  const s = createMcpServer({ tools }, { transport: 'http', port: 0, ...opts });
  open.push(s);
  await s.ready;
  return s;
}

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

/** 裸 POST（不过连接器：要能看到状态码与头的原样） */
async function post(
  url: string,
  payload: unknown,
  init: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<RawResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...init.headers },
    body: JSON.stringify(payload),
    ...(init.signal !== undefined ? { signal: init.signal } : {}),
  });
  const text = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { status: res.status, headers, body: text === '' ? null : JSON.parse(text) };
}

const rpc = (id: number, method: string, params?: unknown): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params !== undefined ? { params } : {}),
});

describe('createMcpServer —— 构造期校验', () => {
  it('app 不是 { tools } 形状 / transport 非法 ⇒ 构造期抛 TypeError', () => {
    assert.throws(() => createMcpServer({} as never, { transport: 'stdio' }), /app 必须是鸭子类型/);
    assert.throws(
      () => createMcpServer({ tools: [] }, { transport: 'ws' as never }),
      /transport 只认/,
    );
  });
});

describe('createMcpServer —— trace 闸（traceLimits / maxEventChars 透传到每次 tools/call 的那棵 trace）', () => {
  const chatty: AgentTool = {
    name: 'chatty',
    description: '在 ctx.recorder 上记一串事件',
    inputSchema: { type: 'object' },
    run: (_input, ctx) => {
      // 桥内 ctx 恒在场（callTool 装配），这里只多记几条事件
      for (let i = 0; i < 5; i++) ctx?.recorder.event(ctx.parentSpanId, 'chat', i);
      return 'done';
    },
  };
  const long: AgentTool = {
    name: 'long_output',
    description: '回一段长文本',
    inputSchema: { type: 'object' },
    run: () => 'x'.repeat(5000),
  };

  it('traceLimits 坏值在构造期抛 TypeError（与 run 入口同一个判定器）', () => {
    for (const bad of [Number.NaN, -1, 1.5]) {
      assert.throws(
        () =>
          createMcpServer({ tools: [] }, { transport: 'http', traceLimits: { maxEvents: bad } }),
        TypeError,
        `坏值没拦住：${String(bad)}`,
      );
    }
  });

  it('traceLimits.maxEvents 生效：超限停记 + run 根两笔 trace.truncated（计数如实）', async () => {
    const { sink, traces } = collectTraces();
    const s = await startHttp([chatty], { sinks: [sink], traceLimits: { maxEvents: 2 } });
    const r = await post(s.url as string, rpc(1, 'tools/call', { name: 'chatty', arguments: {} }));
    assert.equal(r.status, 200);
    assert.equal(traces.length, 1, '每次 tools/call 一棵 trace');
    const events = traces[0]!.spans.flatMap((sp) => sp.events);
    // 记录事件恰好停在配额：tool.input + 第 1 条 chat（其余 4 条 chat 与 tool.output 被丢弃）
    assert.equal(
      events.filter((e) => e.name !== 'trace.truncated').length,
      2,
      '事件数闸没透传进桥内的 recorder',
    );
    assert.deepEqual(
      events.filter((e) => e.name === 'trace.truncated').map((e) => e.body),
      [{ limit: 2 }, { droppedEvents: 5, limit: 2 }],
      '截断必须留痕且计数如实（4 条 chat + tool.output）',
    );
  });

  it('maxEventChars 透传到 tool.input/tool.output 载荷；false = 不截断', async () => {
    const outputOf = (t: Trace): string => {
      const ev = t.spans.flatMap((sp) => sp.events).find((e) => e.name === 'tool.output')!;
      return (ev.body as { content: string }).content;
    };
    const full = 'x'.repeat(5000);
    {
      const { sink, traces } = collectTraces();
      const s = await startHttp([long], { sinks: [sink], maxEventChars: 50 });
      await post(s.url as string, rpc(1, 'tools/call', { name: 'long_output', arguments: {} }));
      assert.equal(
        outputOf(traces[0]!),
        `${'x'.repeat(50)}…(+4950)`,
        'trace 事件正文应按 maxEventChars 截断（MCP 应答本身不截断，只影响账目）',
      );
    }
    {
      const { sink, traces } = collectTraces();
      const s = await startHttp([long], { sinks: [sink], maxEventChars: false });
      await post(s.url as string, rpc(1, 'tools/call', { name: 'long_output', arguments: {} }));
      assert.equal(outputOf(traces[0]!), full, 'false = 不截断（与引擎同款语义）');
    }
  });
});

describe('createMcpServer —— StreamableHTTP 协议面', () => {
  it('initialize 回 protocolVersion / capabilities.tools / serverInfo，并铸 mcp-session-id 头', async () => {
    const s = await startHttp([hello]);
    const r = await post(
      s.url as string,
      rpc(1, 'initialize', {
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'x', version: '0' },
      }),
    );
    assert.equal(r.status, 200);
    const result = r.body!.result as Record<string, unknown>;
    assert.equal(result.protocolVersion, DEFAULT_PROTOCOL_VERSION);
    assert.deepEqual(result.capabilities, { tools: {} });
    assert.deepEqual(result.serverInfo, { name: 'agentia', version: '0.0.0' });
    // 会话头是 uuid 形状（无状态 server：只发不校验）
    assert.match(
      r.headers['mcp-session-id'] ?? '',
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('serverInfo.name 可配（opts.name）', async () => {
    const s = await startHttp([hello], { name: 'my-tools' });
    const r = await post(s.url as string, rpc(1, 'initialize', {}));
    assert.equal((r.body!.result as { serverInfo: { name: string } }).serverInfo.name, 'my-tools');
  });

  it('initialize 响应带 mcp-session-id；后续**不带**该头的请求照常服务（无状态宽容）', async () => {
    // 反向验证：若实现改成「校验会话头、缺失即拒」，本用例红在 listTools/callTool 被拒。
    const s = await startHttp([hello]);
    const init = await post(s.url as string, rpc(1, 'initialize', {}));
    assert.ok(init.headers['mcp-session-id'], 'initialize 必须铸会话头');
    // 后续请求故意不带会话头 —— 宽容选择：无状态 server 不该因此拒客
    const list = await post(s.url as string, rpc(2, 'tools/list', {}));
    assert.equal(list.status, 200);
    const call = await post(
      s.url as string,
      rpc(3, 'tools/call', { name: 'say_hello', arguments: { name: 'MCP' } }),
    );
    assert.equal(call.status, 200);
  });

  it('tools/list 回完整菜单（name/description/inputSchema），且不建 trace', async () => {
    const { sink, traces } = collectTraces();
    const s = await startHttp([hello, echoObj], { sinks: [sink] });
    await post(s.url as string, rpc(1, 'initialize', {}));
    const r = await post(s.url as string, rpc(2, 'tools/list', {}));
    const tools = (r.body!.result as { tools: Array<Record<string, unknown>> }).tools;
    assert.deepEqual(
      tools.map((t) => t.name),
      ['say_hello', 'echo_object'],
    );
    assert.equal(tools[0]?.description, '打招呼');
    assert.deepEqual(tools[0]?.inputSchema, hello.inputSchema);
    assert.equal(traces.length, 0, 'initialize / tools/list 不建 trace（菜单查询不是能力调用）');
  });

  it('tools/call：string 结果原样进 text 块；trace 一棵（run 根 + capability span + 两个事件）投递 sinks', async () => {
    const { sink, traces } = collectTraces();
    const s = await startHttp([hello], { sinks: [sink] });
    const r = await post(
      s.url as string,
      rpc(1, 'tools/call', { name: 'say_hello', arguments: { name: 'MCP' } }),
    );
    const result = r.body!.result as { content: Array<{ type: string; text: string }> };
    assert.deepEqual(result.content, [{ type: 'text', text: '你好，MCP' }]);
    assert.equal((r.body!.result as { isError?: unknown }).isError, undefined);

    assert.equal(traces.length, 1, '一次 tools/call = 一棵 trace');
    const trace = traces[0]!;
    assert.equal(trace.status, 'ok');
    const root = trace.spans.find((sp) => sp.spanId === trace.rootSpanId)!;
    assert.equal(root.kind, 'run');
    assert.equal(root.name, 'mcp.tools/call');
    const cap = trace.spans.find((sp) => sp.kind === 'capability')!;
    assert.equal(cap.name, 'say_hello');
    assert.equal(cap.parentSpanId, root.spanId);
    assert.equal(cap.status, 'ok');
    // 账目形状与引擎一致：capability span 上记 tool.input / tool.output（同名同口径）
    const input = cap.events.find((e) => e.name === 'tool.input')!;
    assert.equal((input.body as { tool: string }).tool, 'say_hello');
    const output = cap.events.find((e) => e.name === 'tool.output')!;
    const outBody = output.body as { ok: boolean; tool: string; durationMs: number };
    assert.equal(outBody.ok, true);
    assert.equal(outBody.tool, 'say_hello');
    assert.ok(outBody.durationMs >= 0);
  });

  it('tools/call：非 string 结果 JSON 化进 text', async () => {
    const s = await startHttp([echoObj]);
    const r = await post(
      s.url as string,
      rpc(1, 'tools/call', { name: 'echo_object', arguments: {} }),
    );
    const result = r.body!.result as { content: Array<{ text: string }> };
    assert.deepEqual(JSON.parse(result.content[0]!.text), { ok: true, n: 7 });
  });

  it('工具抛错 → 协议层成功 + isError:true（MCP 惯例）；trace 里 span status=error 带结构化 error', async () => {
    // 反向验证（M1）：摘掉 isError 映射（错误也回成功形状）⇒ 本用例红在
    // `result.isError === true` 与「trace 记成 error」两处。
    const { sink, traces } = collectTraces();
    const s = await startHttp([failer], { sinks: [sink] });
    const r = await post(
      s.url as string,
      rpc(1, 'tools/call', { name: 'fail_tool', arguments: {} }),
    );
    const result = r.body!.result as { isError?: unknown; content: Array<{ text: string }> };
    assert.equal(result.isError, true, '工具抛错必须回 isError（正向桥那头把它转回抛错）');
    assert.match(result.content[0]!.text, /工具炸了/);

    assert.equal(traces.length, 1);
    const cap = traces[0]!.spans.find((sp) => sp.kind === 'capability')!;
    assert.equal(cap.status, 'error');
    assert.equal(cap.error?.message.includes('工具炸了'), true);
    const output = cap.events.find((e) => e.name === 'tool.output')!;
    assert.equal((output.body as { ok: boolean; errorKind?: string }).ok, false);
    assert.equal((output.body as { errorKind?: string }).errorKind, 'threw');
  });

  it('协议面之外的意外 → 200 + JSON-RPC -32603，宿主不退出（此前冒泡成 unhandled rejection）', async () => {
    // 与上一条对照：工具**自己**抛错是「工具失败了」（回 isError，协议层仍是成功）；这里要的是
    // **框架内部**的意外 —— 取一个真实可达的例子：菜单里某条 `inputSchema` 是个带 getter 的
    // 对象（`validateJsonSchema` 一读就抛）。它发生在 `callTool` 之前，所以 `callTool` 里那层
    // catch 兜不住 ⇒ 此前会一路冒泡出 async handler：unhandled rejection ⇒ Node ≥15 默认
    // **终止进程**（stdio 那条传输有 `.catch` 兜着，只有 HTTP 这条漏了）。
    const poison = {
      name: 'poison_schema',
      description: 'd',
      inputSchema: new Proxy(
        {},
        {
          get() {
            throw new Error('schema getter 炸了');
          },
        },
      ),
      run: () => 'never',
    } as unknown as AgentTool;
    const s = await startHttp([hello, poison]);
    const url = s.url as string;

    const r = await post(url, rpc(7, 'tools/call', { name: 'poison_schema', arguments: {} }), {
      // 反向验证：摘掉那个 catch ⇒ 这里不会应答（请求挂着），fetch 到点 reject ⇒ 本用例红
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(r.status, 200, 'JSON-RPC 的错误应答走 200（与 stdio 侧同形状）');
    assert.deepEqual(r.body, {
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32603, message: '内部错误（详见服务端日志）' },
    });

    // 真正的判据：**宿主还活着** —— 同一个 server 继续服务正常请求
    const ok = await post(
      url,
      rpc(8, 'tools/call', { name: 'say_hello', arguments: { name: 'x' } }),
    );
    assert.equal(ok.status, 200);
    const result = (ok.body as { result: { content: Array<{ text: string }> } }).result;
    assert.equal(result.content[0]!.text, '你好，x');
  });

  it('未知 method → -32601；params 形状坏 → -32602；未知工具 → -32602', async () => {
    const s = await startHttp([hello]);
    const unknown = await post(s.url as string, rpc(1, 'resources/list', {}));
    assert.equal((unknown.body!.error as { code: number }).code, -32601);

    const noName = await post(s.url as string, rpc(2, 'tools/call', { arguments: {} }));
    assert.equal((noName.body!.error as { code: number }).code, -32602);
    const badArgs = await post(
      s.url as string,
      rpc(3, 'tools/call', { name: 'say_hello', arguments: '不是对象' }),
    );
    assert.equal((badArgs.body!.error as { code: number }).code, -32602);
    const noTool = await post(
      s.url as string,
      rpc(4, 'tools/call', { name: 'nope', arguments: {} }),
    );
    const err = noTool.body!.error as { code: number; message: string };
    assert.equal(err.code, -32602);
    assert.match(err.message, /未知工具/);
  });

  it('入参不满足 inputSchema → -32602 且方法体零调用（与引擎同一份校验器）', async () => {
    // 反向验证：摘掉 dispatch 里那两行 validateJsonSchema ⇒ 本用例红两处 ——
    // 「缺必填项却回了 result」与「方法体被调了」（实测修前返回 `你好，undefined`）。
    let called = 0;
    const strict: AgentTool = {
      name: 'say_hello',
      description: '需要 name',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      run: (input) => {
        called += 1;
        return `你好，${(input as { name: string }).name}`;
      },
    };
    const s = await startHttp([strict]);
    const missing = await post(
      s.url as string,
      rpc(1, 'tools/call', { name: 'say_hello', arguments: {} }),
    );
    const err = missing.body!.error as { code: number; message: string };
    assert.equal(err.code, -32602, '入参不合法是协议错误（Invalid params）');
    assert.match(err.message, /inputSchema/);
    assert.equal(missing.body!.result, undefined, '不许既报错又给 result');
    assert.equal(called, 0, '入参不合法时方法体一次都不许进（同引擎的 invalid_input）');

    // 口径与引擎一致：多余字段不拦（子集校验器只查声明的部分）
    const extra = await post(
      s.url as string,
      rpc(2, 'tools/call', { name: 'say_hello', arguments: { name: 'x', extra: 1 } }),
    );
    const result = extra.body!.result as { content: Array<{ text: string }> };
    assert.equal(result.content[0]!.text, '你好，x');
    assert.equal(called, 1);
  });

  it('notifications/initialized → 202 空体；ping → 空 result', async () => {
    const s = await startHttp([hello]);
    const n = await post(s.url as string, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    });
    assert.equal(n.status, 202);
    assert.equal(n.body, null);
    const p = await post(s.url as string, rpc(1, 'ping'));
    assert.deepEqual(p.body!.result, {});
  });

  it('GET → 405（server→client 流不做）；DELETE → 200；别的路径 → 404；body 非法 JSON → 400', async () => {
    const s = await startHttp([hello]);
    const url = s.url as string;
    const get = await fetch(url);
    assert.equal(get.status, 405);
    await get.text();
    const del = await fetch(url, { method: 'DELETE' });
    assert.equal(del.status, 200);
    await del.text();
    const wrongPath = await fetch(`${url}-nope`, { method: 'POST', body: '{}' });
    assert.equal(wrongPath.status, 404);
    await wrongPath.text();
    const badJson = await fetch(url, { method: 'POST', body: '{ 不是 json' });
    assert.equal(badJson.status, 400);
    await badJson.text();
  });

  it('未鉴权先于方法判定：GET/DELETE 一律 401（不泄露 endpoint 存在性）', async () => {
    // 宿主纪律（transport/http-route.ts）：其余一律先鉴权再判方法/路径；此前这里把
    // DELETE/405 摆在鉴权前面 ⇒ 未鉴权能拿到 `405 allow` 与 `DELETE → 200`。
    const s = await startHttp([hello], {
      auth: (req) => {
        if (req.headers['x-key'] !== 'ok') throw new Error('denied');
      },
    });
    const url = s.url as string;
    const get = await fetch(url);
    assert.equal(get.status, 401, '未鉴权 GET 不得回 405（那是泄露 endpoint 存在）');
    await get.text();
    const del = await fetch(url, { method: 'DELETE' });
    assert.equal(del.status, 401, '未鉴权 DELETE 不得回 200');
    await del.text();

    // 通过鉴权后语义一字不变：GET → 405、DELETE → 200
    const okGet = await fetch(url, { headers: { 'x-key': 'ok' } });
    assert.equal(okGet.status, 405);
    await okGet.text();
    const okDel = await fetch(url, { method: 'DELETE', headers: { 'x-key': 'ok' } });
    assert.equal(okDel.status, 200);
    await okDel.text();
  });

  it('鉴权钩子抛错 → 401（原文不进响应）；通过则正常服务', async () => {
    const s = await startHttp([hello], {
      auth: (req) => {
        if (req.headers['x-key'] !== 'ok') throw new Error('内部拓扑细节不该外泄');
      },
    });
    const denied = await post(s.url as string, rpc(1, 'initialize', {}));
    assert.equal(denied.status, 401);
    assert.equal(JSON.stringify(denied.body).includes('内部拓扑细节'), false);
    const allowed = await post(s.url as string, rpc(1, 'initialize', {}), {
      headers: { 'x-key': 'ok' },
    });
    assert.equal(allowed.status, 200);
  });

  it('toolTimeoutMs 超时 → isError + errorKind timeout，且 abandoned 信号被 abort（放弃等待 ≠ 取消）', async () => {
    let gate: () => void = () => {};
    let seenAbandoned: AbortSignal | undefined;
    const slow: AgentTool = {
      name: 'slow',
      description: '永不自己完成',
      inputSchema: { type: 'object' },
      run: (_input, ctx?: ToolRunContext) => {
        seenAbandoned = ctx?.abandoned;
        return new Promise<string>((resolvePromise) => {
          gate = () => resolvePromise('迟到');
        });
      },
    };
    const { sink, traces } = collectTraces();
    const s = await startHttp([slow], { sinks: [sink], toolTimeoutMs: 30 });
    const r = await post(s.url as string, rpc(1, 'tools/call', { name: 'slow', arguments: {} }));
    const result = r.body!.result as { isError?: unknown; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /error\(timeout\)/);
    assert.equal(seenAbandoned?.aborted, true, '放弃等待时必须通知工具（abandoned）');
    const cap = traces[0]!.spans.find((sp) => sp.kind === 'capability')!;
    assert.equal(cap.status, 'error');
    assert.equal(cap.error?.type, 'timeout');
    gate(); // 收尾，别让永不 settle 的 Promise 吊着
  });

  it('opts.client 原样进 ToolRunContext（自定义 client 的接缝）', async () => {
    const marker = {
      messages: { stream: () => Promise.reject(new Error('不该被调')) },
    } as unknown as ModelClient;
    let seen: ModelClient | undefined;
    const probe: AgentTool = {
      name: 'probe',
      description: '读 ctx.client',
      inputSchema: { type: 'object' },
      run: (_input, ctx?: ToolRunContext) => {
        seen = ctx?.client;
        return 'ok';
      },
    };
    const s = await startHttp([probe], { client: marker });
    await post(s.url as string, rpc(1, 'tools/call', { name: 'probe', arguments: {} }));
    assert.equal(seen, marker, 'opts.client 必须原样透传，不是被包一层');
  });

  it('sink 抛错被吞（观测不击穿业务）：调用照常成功', async () => {
    const s = await startHttp([hello], {
      sinks: [
        {
          export: () => {
            throw new Error('sink 挂了');
          },
        },
      ],
    });
    const r = await post(
      s.url as string,
      rpc(1, 'tools/call', { name: 'say_hello', arguments: { name: 'x' } }),
    );
    assert.equal(
      (r.body!.result as { content: Array<{ text: string }> }).content[0]!.text,
      '你好，x',
    );
  });

  it('客户端断连 → 在飞工具调用的 signal 被中止；server 随后照常服务', async () => {
    let started: () => void = () => {};
    const toolStarted = new Promise<void>((r) => {
      started = r;
    });
    let aborted: (v: boolean) => void = () => {};
    const abortedSeen = new Promise<boolean>((r) => {
      aborted = r;
    });
    let gate: () => void = () => {};
    const slow: AgentTool = {
      name: 'slow',
      description: '挂在闸门上',
      inputSchema: { type: 'object' },
      run: (_input, ctx?: ToolRunContext) => {
        started();
        ctx?.signal?.addEventListener('abort', () => aborted(true));
        return new Promise<string>((resolvePromise) => {
          gate = () => resolvePromise('迟到');
        });
      },
    };
    const s = await startHttp([slow, hello]);
    const fetchAc = new AbortController();
    const pending = post(s.url as string, rpc(1, 'tools/call', { name: 'slow', arguments: {} }), {
      signal: fetchAc.signal,
    }).then(
      () => 'resolved',
      () => 'aborted',
    );
    await toolStarted;
    fetchAc.abort();
    assert.equal(await pending, 'aborted');
    assert.equal(
      await Promise.race([
        abortedSeen,
        new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
      ]),
      true,
      '客户端断连必须中止该次调用的 signal',
    );
    gate();
    // server 随后照常服务（换快工具验 —— slow 的闸门已经没人放了）
    const again = await post(
      s.url as string,
      rpc(2, 'tools/call', { name: 'say_hello', arguments: { name: '回来' } }),
    );
    assert.equal(again.status, 200);
  });

  it('挂进既有 http.Server：close() 只摘本 handler，不关宿主的 server', async () => {
    // Node 对**每个**请求调**所有** request 监听器：共享时宿主那边必须在桥挂着期间
    // 忽略 /mcp（真实共托管就是这么路由的），摘掉之后才回落给宿主自己的 handler。
    let bridgeAttached = true;
    const host = createServer((req, res) => {
      if (bridgeAttached && (req.url ?? '').startsWith('/mcp')) return; // 让给反向桥
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('host');
    });
    await new Promise<void>((r) => host.listen(0, '127.0.0.1', r));
    const port = (host.address() as { port: number }).port;
    open.push({ close: () => new Promise<void>((r) => host.close(() => r())) });

    const s = createMcpServer(
      { tools: [hello] },
      { transport: 'http', server: host, path: '/mcp' },
    );
    open.push(s);
    await s.ready;

    const mcpUrl = `http://127.0.0.1:${port}/mcp`;
    const before = await post(mcpUrl, rpc(1, 'initialize', {}));
    assert.equal(before.status, 200, '挂上后 /mcp 由反向桥服务');
    const other = await fetch(`http://127.0.0.1:${port}/other`);
    assert.equal(await other.text(), 'host', '别的路径不受反向桥影响');

    await s.close();
    bridgeAttached = false;
    const after = await fetch(mcpUrl, { method: 'POST', body: '{}' });
    assert.equal(await after.text(), 'host', 'close 后 /mcp 回落给宿主自己的 handler');
  });

  it('close() 幂等；自有 server 关闭后端口不再服务', async () => {
    const s = await startHttp([hello]);
    await s.close();
    await s.close();
    await assert.rejects(fetch(s.url as string, { method: 'POST', body: '{}' }));
  });
});

describe('createMcpServer —— SEP-414 入站（`params._meta.traceparent` → run 根 link）', () => {
  // SEP-414 非规范示例里的那串值（带 `-01` flags —— 解析侧不读 flags，与 W3C 一致）
  const UPSTREAM = '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01';

  const rootOf = (t: Trace): Span => t.spans.find((sp) => sp.spanId === t.rootSpanId)!;

  it('合法 traceparent ⇒ run 根记一条指向上游的 link；arguments 一个字节不被碰', async () => {
    // 反向验证：摘掉 dispatch 里的 metaTraceContext 接线 ⇒ links 缺席，本用例红；
    // 把 _meta 塞进 arguments ⇒ 探针看到的入参多出键，本用例红（纪律②）。
    let seenArgs: unknown;
    const probe: AgentTool = {
      name: 'probe',
      description: '记下收到的入参',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      run: (input) => {
        seenArgs = input;
        return 'ok';
      },
    };
    const { sink, traces } = collectTraces();
    const s = await startHttp([probe], { sinks: [sink] });
    const r = await post(
      s.url as string,
      rpc(1, 'tools/call', {
        name: 'probe',
        arguments: { name: 'MCP' },
        _meta: { traceparent: UPSTREAM },
      }),
    );
    assert.equal(r.status, 200);
    assert.equal(r.body!.error, undefined, '合法 _meta 不得改变调用的成败');
    assert.deepEqual(seenArgs, { name: 'MCP' }, '_meta 绝不进 arguments（模型/工具看不见它）');

    assert.equal(traces.length, 1);
    assert.deepEqual(rootOf(traces[0]!).links, [
      { traceId: '0af7651916cd43dd8448eb211c80319c', spanId: '00f067aa0ba902b7' },
    ]);
  });

  it('`_meta` 缺失 / 非对象 / traceparent 畸形 ⇒ 与今天逐字一致：孤立根、不报错、调用正常完成', async () => {
    // 反向验证：解析失败时造一个空 TraceContext / 把坏 _meta 打成 -32602 ⇒
    // 「孤立根」与「200 无 error」两类断言红（纪律①③）。
    const { sink, traces } = collectTraces();
    const s = await startHttp([hello], { sinks: [sink] });
    const url = s.url as string;
    const cases: Array<Record<string, unknown>> = [
      { name: 'say_hello', arguments: { name: '甲' } }, // 无 _meta（既有行为锚）
      { name: 'say_hello', arguments: { name: '乙' }, _meta: {} }, // 空 _meta
      { name: 'say_hello', arguments: { name: '丙' }, _meta: 5 }, // _meta 非对象
      { name: 'say_hello', arguments: { name: '丁' }, _meta: { traceparent: 42 } }, // 非字符串
      { name: 'say_hello', arguments: { name: '戊' }, _meta: { traceparent: 'garbage' } }, // 畸形
      // 版本 ff 是 W3C 保留的非法值（parseTraceparent 拒）
      {
        name: 'say_hello',
        arguments: { name: '己' },
        _meta: { traceparent: 'ff-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01' },
      },
    ];
    for (let i = 0; i < cases.length; i++) {
      const r = await post(url, rpc(i + 1, 'tools/call', cases[i]));
      assert.equal(r.status, 200, `case ${i} 不应被拒`);
      assert.equal(r.body!.error, undefined, `case ${i} 不应回协议错误`);
    }
    assert.equal(traces.length, cases.length);
    for (const [i, t] of traces.entries()) {
      assert.equal(t.status, 'ok');
      assert.equal('links' in rootOf(t), false, `case ${i} 的 run 根必须保持孤立根（无 links 键）`);
    }
  });
});

describe('createMcpServer —— stdio（真子进程，夹具走 createApp + @Tool 真装配）', () => {
  it('stdio 的 stdout error 监听随 close 摘除：多次 create 不累积（进程级监听）', async () => {
    // stdout 是进程级对象：监听器只挂不摘 ⇒ 多次 createMcpServer 累积（Node 到 10 条起告警）。
    // 本用例在**本进程**直接起 stdio 传输（不走子进程 —— 这里量的是 listenerCount，不需要协议面）。
    const before = process.stdout.listenerCount('error');
    const servers = [0, 1, 2].map(() => createMcpServer({ tools: [] }, { transport: 'stdio' }));
    open.push(...servers);
    assert.equal(
      process.stdout.listenerCount('error'),
      before + servers.length,
      '每个 stdio server 应各挂一条 EPIPE 吞错监听',
    );
    await Promise.all(servers.map((s) => s.close()));
    assert.equal(
      process.stdout.listenerCount('error'),
      before,
      'close 后必须全部摘掉（只挂不摘就是泄漏）',
    );
  });

  it('连接器握手 → listTools → callTool → isError 转抛错；每次调用一棵 trace 落盘', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-mcp-server-'));
    const traceFile = join(dir, 'trace.jsonl');
    const c = createStdioMcpConnector([process.execPath, '--import', 'tsx', FIXTURE], {
      env: { MCP_REVERSE_TRACE_FILE: traceFile },
      stderr: 'ignore',
      timeoutMs: 30_000,
    });
    open.push(c);
    try {
      const tools = await c.listTools(); // 内含 initialize 握手
      assert.deepEqual(
        tools.map((t) => t.name).sort(),
        ['echo_object', 'fail_tool', 'say_hello'],
        '真 AgentApp 的装配菜单（鸭子类型成立）',
      );

      const r = (await c.callTool('say_hello', { name: 'MCP' })) as {
        content: Array<{ text: string }>;
      };
      assert.deepEqual(r.content, [{ type: 'text', text: '你好，MCP' }]);

      const obj = (await c.callTool('echo_object', { n: 3 })) as {
        content: Array<{ text: string }>;
      };
      assert.deepEqual(JSON.parse(obj.content[0]!.text), { ok: true, n: 3 });

      // 协议层 isError → 连接器转成抛错（正向桥纪律，方向对称）
      await assert.rejects(() => c.callTool('fail_tool', {}), /isError.*夹具工具炸了/);
    } finally {
      await c.close();
    }

    // trace 叙事不破：两次成功 + 一次失败各一棵，落盘文件里逐条可查
    const lines = readFileSync(traceFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3, '三次 tools/call 各一棵 trace');
    const traces = lines.map((l) => JSON.parse(l) as Trace);
    const rootNames = traces.map(
      (t) => t.spans.find((sp: Span) => sp.spanId === t.rootSpanId)?.name,
    );
    assert.deepEqual(rootNames, ['mcp.tools/call', 'mcp.tools/call', 'mcp.tools/call']);
    const capNames = traces.map((t) => t.spans.find((sp: Span) => sp.kind === 'capability')?.name);
    assert.deepEqual(capNames, ['say_hello', 'echo_object', 'fail_tool']);
    const failed = traces[2]!;
    assert.equal(failed.status, 'error');
    assert.equal(
      failed.spans
        .find((sp: Span) => sp.kind === 'capability')
        ?.error?.message.includes('夹具工具炸了'),
      true,
    );
  });

  it('宿主先关读端（EPIPE）不打崩 server：stdout 的 error 被吞，子进程存活', async () => {
    // 反向验证：摘掉 mcp-server-stdio.ts 里 `process.stdout.on('error', …)` 那两行 ⇒ 本用例红在
    // 「exitCode 变 1」。实测修前：栈顶 `write EPIPE` at mcp-server-stdio.ts 的应答写入，exit 1。
    // （2026-09-28：那两行随 stdio 传输自 mcp-server.ts 切出，注释同步 —— 旧写「mcp-server.ts」已失真。）
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.resume(); // 夹具的日志别把管道堵住
    // 子进程崩掉后再写 stdin 会在**本进程**报 EPIPE —— 那是被测对象的症状，测试自己别跟着炸
    child.stdin.on('error', () => {
      /* 子进程已死：断言那边会看到 exitCode */
    });
    try {
      // 先正常握一次手：确认它已经在读 stdin（不靠 sleep 猜就绪）
      const firstLine = new Promise<void>((resolve) => {
        child.stdout.setEncoding('utf8');
        let buf = '';
        child.stdout.on('data', (c: string) => {
          buf += c;
          if (buf.includes('\n')) resolve();
        });
      });
      child.stdin.write(`${JSON.stringify(rpc(1, 'initialize', {}))}\n`);
      await firstLine;

      child.stdout.destroy(); // 宿主关读端，stdin 仍开着 ⇒ 下一次应答必然 EPIPE
      child.stdin.write(`${JSON.stringify(rpc(2, 'ping'))}\n`);
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(
          child.exitCode,
          null,
          `关读端后 server 崩了（exit ${String(child.exitCode)}）`,
        );
      }
    } finally {
      child.kill('SIGKILL');
      // ⚠️ 不能直接 await 'close'：子进程若已死（正是变异时的形态）该事件早已发过，
      // 再等就是永久挂起 —— 测试会从「红」变成「挂住」，那是最难查的一种假信号。
      await new Promise((r) => {
        if (child.exitCode !== null || child.signalCode !== null) r(undefined);
        else child.once('close', r);
      });
    }
  });
});

describe('S6：分帧上限 —— 宿主往 stdin 写一条不带换行的巨型报文', () => {
  it('回一条协议错并**重新同步**到下一个换行（其后的请求照常被应答，不是一路丢下去）', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    const lines: string[] = [];
    let buf = '';
    let settle: () => void = () => {};
    const answered = new Promise<void>((r) => {
      settle = r;
    });
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl < 0) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() === '') continue;
        lines.push(line);
        if (line.includes('"id":7')) settle();
      }
    });
    // 子进程没了之后的 EPIPE 是被测对象的症状，别让测试自己炸
    child.stdin!.on('error', () => {});

    try {
      // 一条 (上限 + 1 KiB) 且**全程没有换行**的「报文」：分帧缓冲若不封顶就是无界增长。
      // 对端不必是恶意方 —— stdout 混进一条不换行的日志行就够（连接器那边同一形态）。
      child.stdin!.write('x'.repeat(MAX_FRAME_CHARS + 1024));
      child.stdin!.write('\n'); // 唯一能重新对齐帧边界的地方
      // 换行之后这条是**完整的一帧**：重新同步必须继续服务
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' })}\n`);

      await Promise.race([
        answered,
        new Promise((_r, rej) =>
          setTimeout(() => rej(new Error('30s 内没等到应答 —— 说明超限之后服务没恢复')), 30_000),
        ),
      ]);

      const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      const errFrame = parsed.find((m) => m.error) as
        | { error: { code: number; message: string } }
        | undefined;
      assert.ok(errFrame, `必须回一条错误帧（不许静默丢），实际收到：${lines.join(' | ')}`);
      assert.equal(errFrame.error.code, -32700, '走传输层既有的「这条帧不可用」码');
      assert.match(String(errFrame.error.message), /分帧上限/, '文案要说清是超限，不是坏 JSON');

      const answeredFrame = parsed.find((m) => m.id === 7);
      assert.ok(answeredFrame, '重新同步之后那条请求必须被正常应答');
      assert.ok(!answeredFrame.error, 'ping 不该得到错误应答');
    } finally {
      child.kill('SIGKILL');
    }
  });
});
