import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { brief, jsonRpcError, mcpTools } from '../../src/integrations/mcp.js';
import type { McpClientLike, McpToolInfo } from '../../src/integrations/mcp.js';
import { parseTraceparent, wireSpanId, wireTraceId } from '../../src/core/trace.js';
import { createApp, runAgent, Tool } from '../../src/index.js';
import type { CapabilityMiddleware } from '../../src/index.js';
import { mockClient, toolUseMsg, endTurnMsg } from '../helpers.js';

/** 记录调用、可脚本化响应的假 MCP client（这里只验**桥**；连接器本身见 mcpConnector.test.ts） */
function fakeMcp(
  tools: McpToolInfo[],
  call: (name: string, args: Record<string, unknown>) => Promise<unknown> = async () => ({
    content: [{ type: 'text', text: 'ok' }],
  }),
): {
  client: McpClientLike;
  calls: Array<{
    name: string;
    args: Record<string, unknown>;
    opts: { abandoned?: AbortSignal; traceparent?: string } | undefined;
  }>;
  listed: () => number;
} {
  const calls: Array<{
    name: string;
    args: Record<string, unknown>;
    opts: { abandoned?: AbortSignal; traceparent?: string } | undefined;
  }> = [];
  let listed = 0;
  const client: McpClientLike = {
    async listTools() {
      listed++;
      return tools;
    },
    async callTool(name, args, opts) {
      calls.push({ name, args, opts });
      return call(name, args);
    },
  };
  return { client, calls, listed: () => listed };
}

/** 取 trace 里第一条 `tool.output` 事件正文（桥接进主循环后的账目） */
function toolOutput(trace: { spans: Array<{ events: Array<{ name: string; body: unknown }> }> }) {
  for (const s of trace.spans) {
    for (const e of s.events) {
      if (e.name === 'tool.output')
        return e.body as { ok?: boolean; errorKind?: string; content?: string };
    }
  }
  throw new Error('trace 里没有 tool.output 事件');
}

const OBJ = { type: 'object', properties: { tz: { type: 'string' } } } as const;

describe('mcpTools —— MCP 桥（D1）', () => {
  it('把 tools/list 映射成 AgentTool[]：前缀 + 归一化名，schema 原样透传', async () => {
    const mcp = fakeMcp([
      { name: 'get-time', description: '取当前时间', inputSchema: OBJ },
      { name: 'read.file', inputSchema: { type: 'object' } },
    ]);
    const tools = await mcpTools(mcp.client, { server: 'time' });

    assert.equal(tools.length, 2);
    assert.deepEqual(
      tools.map((t) => t.name),
      ['mcp_time_get_time', 'mcp_time_read_file'],
      '`-` / `.` 一律归一化成 `_`（LLM API 对工具名不友好）',
    );
    assert.equal(tools[0].description, '取当前时间');
    assert.deepEqual(
      tools[0].inputSchema,
      OBJ,
      'MCP 的 inputSchema 已是 JSON Schema，原样当 input_schema',
    );
    assert.equal(tools[1].description, 'MCP 工具 read.file', '没描述时给一个可读兜底');
  });

  it('prefix / server / prefix:"" 三种前缀形态', async () => {
    const one: McpToolInfo[] = [{ name: 'ping', inputSchema: OBJ }];
    assert.equal((await mcpTools(fakeMcp(one).client)).at(0)!.name, 'mcp_ping');
    assert.equal(
      (await mcpTools(fakeMcp(one).client, { server: 'fs' })).at(0)!.name,
      'mcp_fs_ping',
    );
    assert.equal((await mcpTools(fakeMcp(one).client, { prefix: 'x-' })).at(0)!.name, 'x-ping');
    assert.equal(
      (await mcpTools(fakeMcp(one).client, { server: 'fs', prefix: '' })).at(0)!.name,
      'ping',
      'prefix:"" = 不加前缀',
    );
  });

  it('inputSchema 缺失/非对象 → 回落 { type: "object" }（否则 engine 的校验器无从校验）', async () => {
    const tools = await mcpTools(
      fakeMcp([{ name: 'a' }, { name: 'b', inputSchema: 'nope' as never }]).client,
    );
    assert.deepEqual(tools[0].inputSchema, { type: 'object' });
    assert.deepEqual(tools[1].inputSchema, { type: 'object' });
  });

  it('归一化后撞名 → 装配期直接抛错（不静默留两条同名工具）', async () => {
    const tools = [
      { name: 'a-b', inputSchema: OBJ },
      { name: 'a.b', inputSchema: OBJ },
    ];
    await assert.rejects(() => mcpTools(fakeMcp(tools).client, { server: 's' }), /撞名/);
  });

  it('归一化后为空名 / 超长 → 抛错，不静默改名', async () => {
    await assert.rejects(() => mcpTools(fakeMcp([{ name: '  ' }]).client), /空工具名/);
    await assert.rejects(
      () => mcpTools(fakeMcp([{ name: 'x'.repeat(80) }]).client, { server: 'srv' }),
      /不满足 \^\[A-Za-z0-9_-\]\{1,64\}\$/,
    );
  });

  it('原名全非 ASCII（"🔥🔥"、"获取时间"）→ 归一化产物为空串，带原名上下文抛错', async () => {
    // 旧的校验对 prefix+cleaned 整体做：cleaned 为空时最终名只剩前缀（如 mcp_）也能通过
    // —— 注册出一个调用不回去的名字。必须在撞名检查之前拦下。
    await assert.rejects(
      () => mcpTools(fakeMcp([{ name: '🔥🔥' }]).client),
      (e: Error) => {
        assert.match(e.message, /归一化后为空/);
        assert.ok(e.message.includes('🔥🔥'), '错误信息要带原名上下文');
        return true;
      },
    );
    await assert.rejects(
      () => mcpTools(fakeMcp([{ name: '获取时间' }]).client, { server: 'time' }),
      (e: Error) => {
        assert.match(e.message, /归一化后为空/);
        assert.ok(e.message.includes('获取时间'), '错误信息要带原名上下文');
        return true;
      },
    );
  });

  it('listTools 抛错 → 冒泡（装配期就该炸，不拖到运行时）', async () => {
    await assert.rejects(
      () =>
        mcpTools({
          listTools: async () => {
            throw new Error('server 挂了');
          },
          callTool: async () => null,
        }),
      /server 挂了/,
    );
  });
});

describe('mcpTools 接进主循环（D1 e2e 单进程版）', () => {
  it('模型调归一化名 → 桥回调用**原名** → 结果回模型，且原名落进 turn attribute', async () => {
    const mcp = fakeMcp(
      [{ name: 'get-time', description: '取当前时间', inputSchema: OBJ }],
      async (name, args) => {
        assert.equal(name, 'get-time', '回调 server 必须用原名（归一化名 server 不认识）');
        assert.deepEqual(args, { tz: 'Asia/Shanghai' });
        return { content: [{ type: 'text', text: '2026-09-12T07:30+08:00' }] };
      },
    );
    const tools = await mcpTools(mcp.client, { server: 'time' });

    const { client, seen } = mockClient([
      toolUseMsg('mcp_time_get_time', { tz: 'Asia/Shanghai' }),
      endTurnMsg('现在是 07:30'),
    ]);
    const result = await runAgent({
      messages: [{ role: 'user', content: '几点？' }],
      tools,
      client,
    });

    assert.equal(result.stopReason, 'end_turn');
    assert.equal(mcp.calls.length, 1);

    // tool_result 真的带着 MCP 的返回内容回到模型
    // （注意：mockClient 的 seen 存的是 params **引用**，而主循环全程复用同一个
    //  messages 数组 —— 所以收尾后它含全部 4 条，不能取 at(-1)，要按类型找。）
    const second = seen[1] as { messages: Array<{ role: string; content: unknown }> };
    const carrier = second.messages.find(
      (m) =>
        Array.isArray(m.content) &&
        (m.content as Array<{ type?: string }>)[0]?.type === 'tool_result',
    )!;
    const toolResult = carrier.content as Array<{ content: string; is_error: boolean }>;
    assert.match(toolResult[0].content, /2026-09-12T07:30\+08:00/);
    assert.equal(toolResult[0].is_error, false);

    // 原名落进发起调用的 turn attribute（审计 / 回放靠它还原成 server 认识的名字）
    const turn = result.trace.spans.find((s) => s.kind === 'llm.turn')!;
    assert.equal(turn.attributes['mcp.tool'], 'get-time');
  });

  it('MCP 调用抛错 → tool_result 记 is_error，run 继续（与本地工具抛错同语义）', async () => {
    const mcp = fakeMcp([{ name: 'boom', inputSchema: OBJ }], async () => {
      throw new Error('server 内部错误');
    });
    const tools = await mcpTools(mcp.client, { server: 's' });
    const { client } = mockClient([toolUseMsg('mcp_s_boom', {}), endTurnMsg('换路')]);
    const result = await runAgent({ messages: [{ role: 'user', content: 'go' }], tools, client });

    assert.equal(result.stopReason, 'end_turn', 'MCP 失败不该杀 run');
    const turn = result.trace.spans.find((s) => s.kind === 'llm.turn')!;
    const out = turn.events.find((e) => e.name === 'tool.output')!;
    assert.equal((out.body as { ok: boolean }).ok, false);
    assert.match(String((out.body as { content: string }).content), /server 内部错误/);
  });

  it('兜底超时（引擎未设 toolTimeoutMs）→ is_error + errorKind=timeout，不杀 run', async () => {
    const mcp = fakeMcp([{ name: 'hang', inputSchema: OBJ }], () => new Promise(() => {}));
    const tools = await mcpTools(mcp.client, { server: 's', timeoutMs: 20 });
    const { client } = mockClient([toolUseMsg('mcp_s_hang', {}), endTurnMsg('放弃')]);
    const result = await runAgent({ messages: [{ role: 'user', content: 'go' }], tools, client });

    assert.equal(result.stopReason, 'end_turn');
    const out = toolOutput(result.trace);
    assert.equal(out.ok, false);
    assert.match(String(out.content), /调用超时（超过 20ms）/);
    // 账目必须与引擎自己判的超时同类：此前是 errorKind='threw' + error(unknown)（同一事件两种账）
    assert.equal(out.errorKind, 'timeout');
  });

  it('单一裁判：引擎设了 toolTimeoutMs ⇒ 桥的 timeoutMs 不参与判定（更短也不抢）', async () => {
    const mcp = fakeMcp([{ name: 'slow', inputSchema: OBJ }], async () => {
      await new Promise((r) => setTimeout(r, 60));
      return { content: [{ type: 'text', text: 'late-but-ok' }] };
    });
    const tools = await mcpTools(mcp.client, { server: 's', timeoutMs: 20 }); // 桥 20ms「更短」
    const { client } = mockClient([toolUseMsg('mcp_s_slow', {}), endTurnMsg('done')]);
    const result = await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      tools,
      client,
      toolTimeoutMs: 5000,
    });

    const out = toolOutput(result.trace);
    assert.equal(out.ok, true, '引擎设了预算 ⇒ 桥不得再判一次超时（旧行为：20ms 抛错记 threw）');
    assert.equal(out.errorKind, undefined);
  });

  it('单一裁判：引擎显式设 toolTimeoutMs:0（不限）⇒ 桥也不得自作主张判 60s', async () => {
    // 判据是 `!= null` 而不是 `> 0`：`0` 的文档语义是「引擎不设超时」，那同样是引擎的
    // **表态**。用 `> 0` 的话，用户显式写下不限、桥却拿自己的 timeoutMs 判一次
    // —— 与「一次调用只有一个裁判」正相反，也把「说了不限」变成假的。
    const mcp = fakeMcp([{ name: 'slow', inputSchema: OBJ }], async () => {
      await new Promise((r) => setTimeout(r, 150)); // 远超桥的 20ms
      return { content: [{ type: 'text', text: 'late-but-ok' }] };
    });
    const tools = await mcpTools(mcp.client, { server: 's', timeoutMs: 20 });
    const { client } = mockClient([toolUseMsg('mcp_s_slow', {}), endTurnMsg('done')]);
    const result = await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      tools,
      client,
      toolTimeoutMs: 0, // 引擎表态：不限
    });

    const out = toolOutput(result.trace);
    assert.equal(out.ok, true, '说了不限就该不限（旧行为：桥拿自己的 20ms 判超时）');
    assert.equal(out.errorKind, undefined);
    assert.match(String(out.content), /late-but-ok/);
    assert.equal(result.stopReason, 'end_turn');
  });

  it('单一裁判：超的是引擎预算时，记的是引擎的账（timeout 文案也是引擎的）', async () => {
    const mcp = fakeMcp([{ name: 'hang', inputSchema: OBJ }], () => new Promise(() => {}));
    const tools = await mcpTools(mcp.client, { server: 's', timeoutMs: 5000 }); // 桥更长，同样不该抢
    const { client } = mockClient([toolUseMsg('mcp_s_hang', {}), endTurnMsg('放弃')]);
    const result = await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      tools,
      client,
      toolTimeoutMs: 60,
    });

    const out = toolOutput(result.trace);
    assert.equal(out.ok, false);
    assert.equal(out.errorKind, 'timeout');
    assert.match(String(out.content), /工具执行超过 60ms/, '账目文案属于裁判（引擎）');
  });

  it('兜底路径同样不靠竞速：resolve 后同步阻塞越过截止 ⇒ 必须记超时，不得记成功', async () => {
    // 与 spec §10 ② 证明 withTimeout 有病的是同一构造：**确定性**，不拿余量赌概率。
    // 微任务已排入但要等本轮回调跑完 ⇒ 下游先看见工具的返回值，而已到期的截止计时器
    // 只能等下一轮 timers 阶段 —— 纯竞速实现会在这里放行（实测旧实现记 ok:true）。
    const mcp = fakeMcp(
      [{ name: 'blocked', inputSchema: OBJ }],
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({ content: [{ type: 'text', text: 'late' }] });
            const t = Date.now();
            while (Date.now() - t < 60) {
              /* 同步阻塞越过 20ms 截止 */
            }
          }, 5);
        }),
    );
    const tools = await mcpTools(mcp.client, { server: 's', timeoutMs: 20 });
    const { client } = mockClient([toolUseMsg('mcp_s_blocked', {}), endTurnMsg('done')]);
    const result = await runAgent({ messages: [{ role: 'user', content: 'go' }], tools, client });

    const out = toolOutput(result.trace);
    assert.equal(out.ok, false, '超预算的调用不得因赢下竞速被记成成功');
    assert.equal(out.errorKind, 'timeout');
  });

  it('timeoutMs 非正数 = 不限（旧行为）', async () => {
    const mcp = fakeMcp([{ name: 'slow', inputSchema: OBJ }], async () => ({ ok: true }));
    const tools = await mcpTools(mcp.client, { server: 's', timeoutMs: 0 });
    const { client } = mockClient([toolUseMsg('mcp_s_slow', {}), endTurnMsg('done')]);
    const result = await runAgent({ messages: [{ role: 'user', content: 'go' }], tools, client });
    assert.equal(result.stopReason, 'end_turn');
  });

  it('MCP 工具与 @Tool 同处一个命名空间：撞名由装配期查重拦下（同一套规则，不另立机制）', async () => {
    const mcp = fakeMcp([{ name: 'echo', inputSchema: OBJ }], async () => 'mcp');
    const tools = await mcpTools(mcp.client, { prefix: '' }); // 不加前缀 → 与本地 echo 撞名

    class Local {
      @Tool({ name: 'echo', description: '本地的 echo', schema: OBJ })
      echo(): string {
        return 'local';
      }
    }
    const providers = [{ provide: 'local', useClass: Local }];
    assert.equal(createApp({ system: 'x', providers }).tools.length, 1, '单独装配正常');

    assert.throws(
      () => createApp({ system: 'x', providers, tools }),
      /菜单能力重名.*echo/,
      'MCP 工具与本地 @Tool 同名 → 装配期就炸，不留歧义菜单',
    );
  });

  it('AppOptions.tools 走同一套中间件链（裸工具不是旁路）', async () => {
    const mcp = fakeMcp([{ name: 'ping', inputSchema: OBJ }], async () => 'pong');
    const tools = await mcpTools(mcp.client, { server: 's' });
    const seen: string[] = [];
    const spy: CapabilityMiddleware = async (call, next) => {
      seen.push(call.capability.name);
      return next();
    };
    const app = createApp({ system: 'x', tools, middleware: [spy] });

    const out = await app.tools[0].run({});
    assert.deepEqual(seen, ['mcp_s_ping'], '中间件必须看到 MCP 工具');
    assert.equal(out, 'pong');
  });

  it('裸工具与 provider 能力同池后，重名查重也管它们（两方向都拦）', async () => {
    const mcp = fakeMcp([{ name: 'dup', inputSchema: OBJ }], async () => 1);
    const tools = await mcpTools(mcp.client, { prefix: '' });
    class P {
      @Tool({ name: 'dup', description: 'd', schema: OBJ })
      dup(): number {
        return 2;
      }
    }
    assert.throws(
      () => createApp({ system: 'x', providers: [{ provide: 'p', useClass: P }], tools }),
      /重名/,
    );
  });
});

describe('MCP 桥的健壮性与记账', () => {
  it('server 的 description 不是 string（数字）→ 装配期不炸，回落默认描述', async () => {
    // tools/list 是**外部输入**：同一循环里 name / inputSchema 都有类型防御，description 曾漏了。
    const mcp = fakeMcp(
      [{ name: 'get_time', description: 123 as unknown as string, inputSchema: OBJ }],
      async () => 'ok',
    );
    const tools = await mcpTools(mcp.client, { server: 's' });
    assert.equal(tools[0]!.description, 'MCP 工具 get_time');
  });

  it('同回合并行调两个 MCP 工具 → 原名按菜单名分键留存（单值 mcp.tool 会被覆盖）', async () => {
    const mcp = fakeMcp(
      [
        { name: 'get-time', inputSchema: OBJ },
        { name: 'fetch-weather', inputSchema: OBJ },
      ],
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    );
    const tools = await mcpTools(mcp.client, { server: 's' });
    const U = {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const { client } = mockClient([
      {
        id: 'm1',
        model: 'claude-opus-5',
        stop_reason: 'tool_use',
        usage: U,
        content: [
          { type: 'tool_use', id: 'tu1', name: 'mcp_s_get_time', input: {} },
          { type: 'tool_use', id: 'tu2', name: 'mcp_s_fetch_weather', input: {} },
        ],
      },
      endTurnMsg('done'),
    ]);
    const result = await runAgent({ messages: [{ role: 'user', content: 'go' }], tools, client });
    const turn = result.trace.spans.find((s) => s.kind === 'llm.turn')!;
    // 键按**菜单名**分（含 server 前缀，全局唯一），值为 server 认识的**原名**
    assert.equal(turn.attributes['mcp.tool.mcp_s_get_time'], 'get-time');
    assert.equal(turn.attributes['mcp.tool.mcp_s_fetch_weather'], 'fetch-weather');
  });
});

describe('SEP-414 出站传播（桥把 traceparent 交给连接器）', () => {
  const W3C = /^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/;

  it('在 run 内调用 ⇒ callTool 的第三参带 traceparent（回合粒度，与 currentTraceparent() 同一投影）', async () => {
    // 反向验证：摘掉 mcp.ts 里 traceparent 的装配 ⇒ `opts.traceparent` 是 undefined，本用例红。
    const mcp = fakeMcp([{ name: 'get-time', inputSchema: OBJ }]);
    const tools = await mcpTools(mcp.client, { server: 'time' });
    const { client } = mockClient([
      toolUseMsg('mcp_time_get_time', { tz: 'Asia/Shanghai' }),
      endTurnMsg('done'),
    ]);
    const result = await runAgent({ messages: [{ role: 'user', content: 'go' }], tools, client });

    const tp = mcp.calls[0]?.opts?.traceparent;
    assert.match(tp ?? '', W3C, 'traceparent 必须是 W3C 形状（flags 恒 00：不替下游声明已采样）');
    // 逐字还原：它指向**本次 run 的这条 trace** 与**发起调用的那个 llm.turn span**
    const parsed = parseTraceparent(tp);
    const turn = result.trace.spans.find((s) => s.kind === 'llm.turn')!;
    assert.equal(parsed?.traceId, wireTraceId(result.trace.traceId));
    assert.equal(parsed?.spanId, wireSpanId(turn.spanId));
    // 纪律②：trace 上下文绝不进工具签名 —— 交给 server 的 arguments 一个字不被碰
    assert.deepEqual(mcp.calls[0]?.args, { tz: 'Asia/Shanghai' });
  });

  it('引擎设了 toolTimeoutMs 的那条路径同样带（两条裁判路径都要过）', async () => {
    // 反向验证：只往兜底路径装、漏了引擎裁判路径 ⇒ 本用例红（`engineBudget != null` 分支）。
    const mcp = fakeMcp([{ name: 'get-time', inputSchema: OBJ }]);
    const tools = await mcpTools(mcp.client, { server: 'time' });
    const { client } = mockClient([toolUseMsg('mcp_time_get_time', {}), endTurnMsg('done')]);
    await runAgent({
      messages: [{ role: 'user', content: 'go' }],
      tools,
      client,
      toolTimeoutMs: 5000,
    });
    assert.match(mcp.calls[0]?.opts?.traceparent ?? '', W3C);
  });

  it('脱离引擎单用（无 ctx）⇒ 不带 traceparent（没有上下文可传时不造空值）', async () => {
    // 反向验证：缺上下文时编一个（如全零 trace id）⇒ `in` 判定为真，本用例红（纪律③）。
    const mcp = fakeMcp([{ name: 'get-time', inputSchema: OBJ }]);
    const tools = await mcpTools(mcp.client, { server: 'time' });
    await tools[0]!.run({});
    const opts = mcp.calls[0]?.opts;
    assert.equal(
      opts !== undefined && 'traceparent' in opts,
      false,
      '无 ctx ⇒ 不得带 traceparent 键',
    );
  });
});

describe('桥共享 helper 的防御分支（brief / jsonRpcError）', () => {
  it('brief() 收到循环引用（JSON.stringify 抛）⇒ 走 String() 兜底，不把报错路径自己搞炸', () => {
    // 反向验证：摘掉 brief 的 try/catch ⇒ 循环引用让 JSON.stringify 抛出，
    // 「报告错误」这个动作本身炸了（错误消息进不了日志），本用例红在「抛 TypeError」。
    const circular: { self?: unknown } = {};
    circular.self = circular;
    assert.equal(brief(circular), String(circular), 'stringify 失败时回落 String(value)');
  });

  it('jsonRpcError 收到非对象（server 回了畸形 error 字段）⇒ 走 `MCP error: ...` 分支', () => {
    // 反向验证：摘掉非对象分支 ⇒ `err as {...}` 解构出 undefined code/message，
    // 报文变成「MCP error undefined: undefined」（病因全丢），本用例红在报文。
    const e = jsonRpcError('boom');
    assert.equal(e.message, 'MCP error: boom');
    const n = jsonRpcError(42);
    assert.equal(n.message, 'MCP error: 42');
  });
});
