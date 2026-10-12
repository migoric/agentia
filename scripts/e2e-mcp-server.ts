/**
 * R8-P5 反向桥的端到端证明：**方向与 `e2e-mcp.ts` 相反** —— 那边是「真 MCP server →
 * 出厂连接器 → 进框架菜单」，这边是「带 @Tool 的 app → `createMcpServer` 暴露成 MCP
 * server → 我们自己的连接器（真协议客户端）打过去」。
 *
 * 两轮传输都验（离线、零网络）：
 * - **stdio**：夹具子进程（`tests/fixtures/mcp/reverse-server.ts`，走 createApp + @Tool
 *   真装配 —— 顺带钉住「真 AgentApp 满足鸭子类型入参」）⇐ `createStdioMcpConnector`；
 * - **StreamableHTTP**：in-process 起 server（127.0.0.1，端口 0）⇐
 *   `createStreamableHttpMcpConnector`，外加裸 fetch 验 GET → 405 / DELETE → 200。
 *
 * trace 侧的证据：夹具把每次 tools/call 的 trace 经 `jsonlTraceSink` 落盘，本脚本
 * 逐条核对（run 根 `mcp.tools/call` + capability span + 成败状态 + SEP-414 的跨进程 link）。
 *
 * 跑法：npm run e2e:mcp:server（**不进** verify-all，与 e2e:mcp 同档）
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createApp,
  createMcpServer,
  createStdioMcpConnector,
  createStreamableHttpMcpConnector,
  SystemPrompt,
  Tool,
} from '../src/index.js';
import type { Trace } from '../src/index.js';

// 夹具是 TS（tests/fixtures/mcp/reverse-server.ts，走 createApp + @Tool 真装配）——
// 子进程经 tsx 跑它，与本仓测试同纪律
const FIXTURE_TS = fileURLToPath(
  new URL('../tests/fixtures/mcp/reverse-server.ts', import.meta.url),
);

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

// ───────────────────────────── stdio 一轮 ─────────────────────────────
async function stdioRound(): Promise<void> {
  console.log(
    '\n== 1. stdio：夹具 app（createApp + @Tool）→ createMcpServer ⇐ 出厂 stdio 连接器 ==',
  );
  const dir = mkdtempSync(join(tmpdir(), 'agentia-mcp-server-e2e-'));
  const traceFile = join(dir, 'trace.jsonl');
  const conn = createStdioMcpConnector([process.execPath, '--import', 'tsx', FIXTURE_TS], {
    env: { MCP_REVERSE_TRACE_FILE: traceFile },
    stderr: 'ignore',
    timeoutMs: 30_000,
  });
  try {
    const tools = await conn.listTools(); // 内含 initialize 握手
    check(
      '菜单 = 夹具 app 的装配菜单',
      tools
        .map((t) => t.name)
        .sort()
        .join(',') === 'echo_object,fail_tool,say_hello',
      tools.map((t) => t.name).join(', '),
    );

    const hello = (await conn.callTool('say_hello', { name: '端到端' })) as {
      content: Array<{ type: string; text: string }>;
    };
    check(
      'callTool 拿到真结果（string → text 块）',
      hello.content[0]?.text === '你好，端到端',
      hello.content[0]?.text,
    );

    const obj = (await conn.callTool('echo_object', { n: 42 })) as {
      content: Array<{ text: string }>;
    };
    check(
      '非 string 结果 JSON 化进 text',
      obj.content[0]?.text === JSON.stringify({ ok: true, n: 42 }),
      obj.content[0]?.text,
    );

    const failed = await conn.callTool('fail_tool', {}).then(
      () => '竟然成功了',
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    check(
      '工具抛错 → isError → 连接器转成抛错（方向对称）',
      /isError/.test(failed) && failed.includes('夹具工具炸了'),
      failed,
    );

    // SEP-414 跨进程链路：连接器把 traceparent 放进 params._meta（裸键）发出，
    // 反向桥提取后记成那棵 trace run 根的一条 link —— 对账在下面的落盘 trace 上
    const linked = (await conn.callTool(
      'say_hello',
      { name: '链路' },
      { traceparent: '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01' },
    )) as { content: Array<{ type: string; text: string }> };
    check(
      '带 _meta.traceparent 的调用照常返回（对端宽容）',
      linked.content[0]?.text === '你好，链路',
      linked.content[0]?.text,
    );
  } finally {
    await conn.close();
  }

  // trace 叙事不破：四次调用各一棵，落盘逐条可对账
  const traces = readFileSync(traceFile, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Trace);
  check('每次 tools/call 一棵 trace（4 次调用 4 棵）', traces.length === 4);
  check(
    'run 根名都是 mcp.tools/call',
    traces.every((t) => t.spans.find((s) => s.spanId === t.rootSpanId)?.name === 'mcp.tools/call'),
  );
  check(
    'capability span 名字 = 工具名，失败那棵 status=error',
    traces.map((t) => t.spans.find((s) => s.kind === 'capability')?.name).join(',') ===
      'say_hello,echo_object,fail_tool,say_hello' && traces[2]?.status === 'error',
  );
  const linkedRoot = traces[3]?.spans.find((s) => s.spanId === traces[3].rootSpanId);
  check(
    'SEP-414：跨进程 link 真出现在落盘 trace 的 run 根上',
    linkedRoot?.links?.[0]?.traceId === '0af7651916cd43dd8448eb211c80319c' &&
      linkedRoot.links[0].spanId === '00f067aa0ba902b7',
    JSON.stringify(linkedRoot?.links),
  );
}

// ───────────────────────────── http 一轮 ─────────────────────────────
async function httpRound(): Promise<void> {
  console.log('\n== 2. StreamableHTTP：in-process server ⇐ 出厂 HTTP 连接器 + 裸 fetch ==');

  class Echo {
    @Tool({
      description: '回显文本',
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    })
    echo(input: { text: string }): string {
      return `回声：${input.text}`;
    }
  }
  const app = createApp({
    name: 'mcp-server-e2e',
    system: new SystemPrompt().add('role', 'e2e', true),
    providers: [{ provide: 'echo', useClass: Echo }],
  });

  const server = createMcpServer(app, { transport: 'http', port: 0, name: 'e2e-reverse' });
  await server.ready;
  const url = server.url as string;
  try {
    check(
      'url 形如 http://127.0.0.1:<port>/mcp',
      /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(url),
      url,
    );

    const conn = createStreamableHttpMcpConnector(url, { timeoutMs: 10_000 });
    try {
      const tools = await conn.listTools(); // 内含握手 + 会话头记忆
      check('菜单经 HTTP 回来', tools.map((t) => t.name).join(',') === 'echo');
      const r = (await conn.callTool('echo', { text: 'ping' })) as {
        content: Array<{ text: string }>;
      };
      check('HTTP callTool 拿到真结果', r.content[0]?.text === '回声：ping', r.content[0]?.text);
    } finally {
      await conn.close();
    }

    // 裸 fetch 验协议面细节（连接器够不着的那些）
    const get = await fetch(url);
    check('GET（server→client 流）→ 405', get.status === 405);
    await get.text();
    const del = await fetch(url, { method: 'DELETE' });
    check('DELETE → 200', del.status === 200);
    await del.text();
    const init = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    check(
      'initialize 响应铸 mcp-session-id 头（uuid）',
      /^[0-9a-f-]{36}$/.test(init.headers.get('mcp-session-id') ?? ''),
    );
    const initBody = (await init.json()) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    check(
      'serverInfo.name 走 opts.name',
      initBody.result.serverInfo.name === 'e2e-reverse',
      initBody.result.serverInfo.name,
    );
  } finally {
    await server.close();
  }
}

await stdioRound();
await httpRound();

console.log(`\n${failures === 0 ? '✅ MCP 反向桥端到端证明全绿' : `❌ ${failures} 项失败`}\n`);
if (failures > 0) process.exitCode = 1;
