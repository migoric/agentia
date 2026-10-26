import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TraceRecorder, runAgent, subagentToTool, SystemPrompt } from '../../src/index.js';
import type {
  AgentTool,
  JsonSchema,
  ModelClient,
  SubAgentCapability,
  ToolRunContext,
} from '../../src/index.js';
import { mockClient, toolUseMsg, endTurnMsg } from '../helpers.js';

const TASK_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { task: { type: 'string' } },
  required: ['task'],
};

const RESULT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['answer', 'confidence'],
  additionalProperties: false,
};

function researcherCapability(over: Partial<SubAgentCapability['spec']> = {}): SubAgentCapability {
  const spec: SubAgentCapability['spec'] = {
    description: '调研子 agent',
    schema: TASK_SCHEMA,
    system: '你是调研员，完成后提交结构化结论。',
    ...over,
  };
  return {
    name: 'researcher',
    description: spec.description,
    inputSchema: spec.schema,
    spec,
  };
}

/** 模拟主 agent 运行中的调用现场（engine 注入的 ToolRunContext） */
function makeCtx(
  client: ToolRunContext['client'],
  over: Partial<ToolRunContext> = {},
): { ctx: ToolRunContext; recorder: TraceRecorder } {
  const recorder = new TraceRecorder();
  const rootId = recorder.begin('run', 'test.run', null);
  const ctx: ToolRunContext = { client, recorder, parentSpanId: rootId, ...over };
  return { ctx, recorder };
}

describe('子 agent typed 结果（SubAgentSpec.resultSchema）', () => {
  it('子 agent 调 submit_result：{ report, result } 结构化 tool_result 交回主 agent', async () => {
    const { seen, client } = mockClient([
      {
        ...toolUseMsg('submit_result', { answer: '42', confidence: 0.9 }, 'tu1'),
        content: [
          { type: 'text', text: '调研结论：答案是 42' },
          {
            type: 'tool_use',
            id: 'tu1',
            name: 'submit_result',
            input: { answer: '42', confidence: 0.9 },
          },
        ],
      },
    ]);
    const { ctx, recorder } = makeCtx(client);
    const tool = subagentToTool(researcherCapability({ resultSchema: RESULT_SCHEMA }), () => []);

    const out = await tool.run({ task: '调研答案' }, ctx);

    // 结构化交回：report = 子 agent 最终报告（可读性优先），result = typed 结果
    assert.deepEqual(out, {
      report: '调研结论：答案是 42',
      result: { answer: '42', confidence: 0.9 },
    });

    // 子 agent 循环拿到了隐藏 submit_result 工具（input_schema = resultSchema）
    const childTools = (seen[0] as { tools: Array<{ name: string; input_schema: unknown }> }).tools;
    assert.deepEqual(
      childTools.map((t) => t.name),
      ['submit_result'],
    );
    assert.equal(childTools[0].input_schema, RESULT_SCHEMA);

    // capability span 正常收尾
    const capability = recorder.snapshot('ok').spans.find((s) => s.kind === 'capability')!;
    assert.equal(capability.name, 'researcher');
    assert.equal(capability.status, 'ok');
    assert.equal(capability.attributes.stop_reason, 'end_turn');
  });

  it('resultSchema 已给但子 agent 未提交（纯文本 end_turn）：能力调用失败，不静默降级', async () => {
    const { client } = mockClient([endTurnMsg('只有文字结论')]);
    const { ctx, recorder } = makeCtx(client);
    const tool = subagentToTool(researcherCapability({ resultSchema: RESULT_SCHEMA }), () => []);

    await assert.rejects(async () => {
      await tool.run({ task: 't' }, ctx);
    }, /result_missing/);
    const capability = recorder
      .snapshot('error')
      .spans.find((s) => s.kind === 'capability' && s.name === 'researcher')!;
    assert.equal(capability.status, 'error');
    assert.equal(capability.error?.type, 'result_missing');
  });

  it('未设 resultSchema：交回最终文本（行为与现状一致），子循环无隐藏工具', async () => {
    const { seen, client } = mockClient([endTurnMsg('普通报告')]);
    const { ctx } = makeCtx(client);
    const tool = subagentToTool(researcherCapability(), () => []);

    const out = await tool.run({ task: 't' }, ctx);
    assert.equal(out, '普通报告');
    const params = seen[0] as { tools?: Array<{ name: string }> };
    assert.equal(params.tools, undefined); // 无工具菜单（resolveTools 空 + 无隐藏工具）
  });

  it('子 agent 未正常收尾（max_iterations）：is_error 语义不变（抛错）', async () => {
    const { client } = mockClient([toolUseMsg('echo', { text: 'x' })]);
    const { ctx } = makeCtx(client);
    const tool = subagentToTool(
      researcherCapability({ resultSchema: RESULT_SCHEMA, maxIterations: 1 }),
      () => [],
    );
    // 子 agent 死循环工具调用、超出 maxIterations → 抛错（engine 包成 is_error 回主 agent）
    await assert.rejects(async () => tool.run({ task: 't' }, ctx), /max_iterations/);
  });
});

describe('预算护栏透传子 agent 循环（C1：预算是整条 run 的口径）', () => {
  it('子循环每回合同样检查：子 agent 超支即停、主循环不再发新请求', async () => {
    let noopRan = 0;
    const noop: AgentTool = {
      name: 'noop',
      description: 'd',
      inputSchema: { type: 'object', properties: {} },
      run: () => {
        noopRan++;
        return 'ok';
      },
    };
    // 主 turn（15）+ 子 turn×2（累计 45 ≤ 50）→ 子第 3 回合记账后 60 > 50 → 子循环停；
    // 修复前：子循环看不到预算，会一直跑满脚本（5 次子请求 + 主循环还会继续发请求）
    const { seen, client } = mockClient([
      toolUseMsg('researcher', { task: 't' }, 'tu_main'),
      toolUseMsg('noop', {}, 's1'),
      toolUseMsg('noop', {}, 's2'),
      toolUseMsg('noop', {}, 's3'),
      toolUseMsg('noop', {}, 's4'),
      endTurnMsg('不该被请求到'),
    ]);
    const tool = subagentToTool(researcherCapability({ tools: ['noop'] }), () => [noop]);
    const result = await runAgent({
      client,
      messages: [{ role: 'user', content: 'go' }],
      tools: [tool],
      maxTotalTokens: 50,
    });

    assert.equal(result.stopReason, 'budget_exceeded');
    assert.equal(result.error?.type, 'budget_exceeded');
    assert.equal(result.trace.status, 'error');
    assert.equal(seen.length, 4, '主 1 次 + 子 3 次；子超支后主循环不得再发请求');
    assert.equal(noopRan, 2, '子循环超支的那个回合不执行工具');

    // 子循环的收尾语义：capability span 记 stop_reason=budget_exceeded + budget.exceeded 事件
    const capability = result.trace.spans.find((s) => s.kind === 'capability')!;
    assert.equal(capability.status, 'error');
    assert.equal(capability.attributes.stop_reason, 'budget_exceeded');
    assert.equal(capability.error?.type, 'budget_exceeded');
    assert.ok(
      capability.events.some((e) => e.name === 'budget.exceeded'),
      '超限事件要记在子 agent 的 capability span 上（哪一级烧穿的看得见）',
    );
    // 交回主 agent 的是 is_error 的 tool_result（不是正常报告）
    const mainTurn = result.trace.spans.find((s) => s.kind === 'llm.turn')!;
    const toolOut = mainTurn.events.find((e) => e.name === 'tool.output')!;
    assert.equal((toolOut.body as { ok: boolean }).ok, false);
    // 主循环回合入口的再判也在 run 根留下痕迹
    const root = result.trace.spans.find((s) => s.kind === 'run')!;
    assert.ok(root.events.some((e) => e.name === 'budget.exceeded'));
  });

  it('工具超时口径透传子循环：子 agent 里的慢工具按超时记账，不得「永不超时」', async () => {
    // `toolTimeoutMs` 是 ToolRunContext 上唯一一件「主循环注入、嵌套能力必须往下交」的东西。
    // 漏了它不是「少一层保险」而是**反的**：子循环里 `args.toolTimeoutMs` 为 undefined
    // → `withTimeout(p, 0)` 直接返回原 promise（core/timeout.ts 的 `!(t > 0)`）= 永不超时；
    // 同时 MCP 桥找不到引擎预算，又起自己的 60s 兜底 = 双计时器 + 双账本。
    //
    // 直接喂一个带 toolTimeoutMs 的 ctx（engine 注入的现场）：这里要隔离的正是
    // 「ctx → 子循环」这一段，跑整条 run 的话外层那个 20ms 会先把 researcher 自己掐掉。
    let slowFinished = 0;
    const slow: AgentTool = {
      name: 'slow',
      description: 'd',
      inputSchema: { type: 'object', properties: {} },
      run: () =>
        new Promise((res) =>
          setTimeout(() => {
            slowFinished++;
            res('late');
          }, 200),
        ),
    };
    const { client } = mockClient([
      toolUseMsg('slow', {}, 's1'), // 子 agent 第一回合调慢工具
      endTurnMsg('调研报告'), // 超时不影响子循环跑完
    ]);
    const { ctx, recorder } = makeCtx(client, { toolTimeoutMs: 20 });
    const tool = subagentToTool(researcherCapability({ tools: ['slow'] }), () => [slow]);
    assert.equal(await tool.run({ task: 't' }, ctx), '调研报告');

    const capability = recorder.snapshot('ok').spans.find((s) => s.kind === 'capability')!;
    const subTurn = recorder
      .snapshot('ok')
      .spans.find((s) => s.kind === 'llm.turn' && s.parentSpanId === capability.spanId)!;
    const out = subTurn.events.find((e) => e.name === 'tool.output')!;
    assert.equal((out.body as { ok: boolean }).ok, false, '子 agent 里的超时必须记成失败');
    assert.equal((out.body as { errorKind: string }).errorKind, 'timeout');
    assert.equal(slowFinished, 0, '超时是硬的：慢工具不得事后把结果写回');
  });

  it('子循环不超支时照常交回报告（透传不影响正常路径）', async () => {
    const { client } = mockClient([
      toolUseMsg('researcher', { task: 't' }, 'tu_main'),
      endTurnMsg('调研报告'),
      endTurnMsg('汇总完毕'),
    ]);
    const tool = subagentToTool(researcherCapability(), () => []);
    const result = await runAgent({
      client,
      messages: [{ role: 'user', content: 'go' }],
      tools: [tool],
      maxTotalTokens: 1000,
    });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.finalText, '汇总完毕');
    assert.equal(result.trace.status, 'ok');
  });
});

describe('未定价告警回调透传子 agent 循环（F2）', () => {
  it('子 agent 用了未定价模型：宿主的 onUnpricedModel 被调（带 model/spanId），主循环不重复触发', async () => {
    // 回归（2026-09-19 复审）：ToolRunContext 没有 onUnpricedModel 通道，turn.ts 装配
    // toolCtx 时也不放 —— 子循环的「算不出成本」只剩 usage.unpriced 事件，
    // 宿主注册的告警回调静默缺席（maxCostUsd 在子循环里失效了却没人知道）。
    const { client } = mockClient([
      toolUseMsg('researcher', { task: 't' }, 'tu_main'),
      endTurnMsg('调研报告'), // 子循环（未定价模型）
      endTurnMsg('汇总完毕'), // 主循环收尾
    ]);
    const tool = subagentToTool(researcherCapability({ model: 'unpriced-model-x' }), () => []);
    const unpricedCalls: Array<{ model: string; spanId: string }> = [];
    const result = await runAgent({
      client, // 主循环走缺省模型 claude-opus-5（在价格表内）
      messages: [{ role: 'user', content: 'go' }],
      tools: [tool],
      onUnpricedModel: (info) => unpricedCalls.push(info),
    });

    assert.equal(result.stopReason, 'end_turn');
    assert.equal(unpricedCalls.length, 1, '只有子循环的未定价模型触发一次回调');
    assert.equal(unpricedCalls[0].model, 'unpriced-model-x');
    // spanId 指向子循环自己的 llm.turn（挂在 capability span 下）
    const capability = result.trace.spans.find((s) => s.kind === 'capability')!;
    const subTurn = result.trace.spans.find(
      (s) => s.kind === 'llm.turn' && s.parentSpanId === capability.spanId,
    )!;
    assert.equal(unpricedCalls[0].spanId, subTurn.spanId);
  });
});

describe('子 agent 被引擎超时放弃等待（ToolRunContext.abandoned）', () => {
  it('capability span 立刻以 error 收尾（不留永不闭合的半截 span）+ 子循环被中止（不再后台烧 token）', async () => {
    // 回归（2026-09-19 复审）：旧实现里超时只是「不等了」—— 交付的 trace 里 capability
    // span 永远没有 endedAt、status 停在缺省 ok（与同回合 tool.output 的 timeout 矛盾），
    // 且子循环在后台继续跑模型请求，花费不进任何观测面。
    let subAborted = false;
    let calls = 0;
    const client = {
      messages: {
        stream: (params: unknown) => ({
          on() {},
          finalMessage: async () => {
            calls++;
            if (calls === 1) return toolUseMsg('researcher', { task: 'x' }, 'tu1');
            if (calls === 2) {
              // 子循环的模型请求：挂住直到 signal 中止（慢子 agent 的形态）
              await new Promise<never>((_, reject) => {
                const sig = (params as { signal?: AbortSignal }).signal;
                sig?.addEventListener(
                  'abort',
                  () => {
                    subAborted = true;
                    reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                  },
                  { once: true },
                );
              });
            }
            return endTurnMsg('主循环收尾');
          },
        }),
      },
    } as unknown as ModelClient;

    const tool = subagentToTool(researcherCapability(), () => []);
    const result = await runAgent({
      model: 'test-model',
      maxTokens: 1024,
      client,
      messages: [{ role: 'user', content: '调研一下' }],
      tools: [tool],
      toolTimeoutMs: 30,
    });

    assert.equal(result.stopReason, 'end_turn', '子 agent 超时不该中断主 run');
    assert.ok(subAborted, '子循环必须收到中止信号 —— 否则它在后台继续烧 token');
    const capSpan = result.trace.spans.find((s) => s.kind === 'capability');
    assert.ok(capSpan, 'trace 里应有 capability span');
    assert.notEqual(
      capSpan.endedAt,
      undefined,
      '交付的 trace 里 capability span 必须已收尾（浅拷交付后迟到的 close 进不去）',
    );
    assert.equal(capSpan.status, 'error');
    assert.equal(capSpan.error?.type, 'timeout');
  });
});

describe('子 agent 防御分支', () => {
  it('手动直调 run(input)（无 ctx）⇒ 抛可读错误（engine 才会注入 ToolRunContext）', async () => {
    // 反向验证：摘掉 `if (!ctx) throw` ⇒ 下一步 `ctx.recorder` 炸裸 TypeError，
    // 本用例红在「报文不可读」。
    const tool = subagentToTool(researcherCapability(), () => []);
    await assert.rejects(async () => tool.run({ task: 't' }), /只能在主 agent 运行中被调用/);
  });

  it('spec.system 传 SystemPrompt 实例：子循环收到缓存块数组，末尾追加 REPORT_HINT', async () => {
    // 反向验证：摘掉 resolveSubSystem 的 `instanceof SystemPrompt` 分支 ⇒ 实例落进
    // 字符串模板（system 变成 "[object Object]…"），本用例红在「不是块数组 / 没有 HINT」。
    const { seen, client } = mockClient([endTurnMsg('报告')]);
    const { ctx } = makeCtx(client);
    const tool = subagentToTool(
      researcherCapability({
        system: new SystemPrompt().add('role', '你是实例化提示词的调研员', true),
      }),
      () => [],
    );

    const out = await tool.run({ task: 't' }, ctx);
    assert.equal(out, '报告');

    const params = seen[0] as {
      system: Array<{ type: string; text: string; cache_control?: unknown }>;
    };
    assert.ok(Array.isArray(params.system), 'SystemPrompt 实例应 build 成块数组（不是拼字符串）');
    assert.equal(params.system[0]!.text, '你是实例化提示词的调研员');
    assert.ok(
      params.system[0]!.cache_control !== undefined,
      '稳定段应带缓存 breakpoint（build({cache:true})）',
    );
    assert.match(
      params.system[params.system.length - 1]!.text,
      /运行提示/,
      'REPORT_HINT 必须追加在末尾（最终回复即交回主 agent 的报告）',
    );
  });

  it('spec.system 传函数：(task) 收到主 agent 填的任务对象、返回值直接作为 system，框架不追加 REPORT_HINT', async () => {
    // spec.system 是**三态**联合（string / SystemPrompt 实例 / 函数）；前两态各有用例，
    // 函数态此前一次都没走过 —— 而它是**唯一**「框架不插手」的形态（作者全权，见
    // subagent.ts 的 JSDoc：函数形态按任务动态拼，框架不附加）。
    // 反向验证：摘掉 `resolveSubSystem` 的 `typeof spec === 'function'` ⇒ 函数落到末尾的
    // 字符串模板（被 toString 成 "function …"）⇒ 本用例红在「system 不是函数返回的那句」。
    let gotTask: Record<string, unknown> | undefined;
    const { seen, client } = mockClient([endTurnMsg('报告')]);
    const { ctx } = makeCtx(client);
    const tool = subagentToTool(
      researcherCapability({
        system: (task) => {
          gotTask = task;
          return `动态角色：${String(task.task)}`;
        },
      }),
      () => [],
    );

    const out = await tool.run({ task: '查一下' }, ctx);
    assert.equal(out, '报告');
    assert.deepEqual(gotTask, { task: '查一下' }, '函数形态应收到主 agent 填的任务对象');
    const params = seen[0] as { system: unknown };
    assert.equal(params.system, '动态角色：查一下', '函数形态的返回值应原样作为子循环的 system');
    assert.doesNotMatch(
      JSON.stringify(params.system),
      /运行提示/,
      '函数形态由作者全权 —— 框架不得追加 REPORT_HINT（只有 string / 实例两态才追加）',
    );
  });

  it('子运行挂起（suspended）且 loop.error 为 undefined ⇒ 兜底 agent_error 收尾', async () => {
    // 与 skill 同款兜底分支：子循环里 approval:'required' 的工具无决定 ⇒ 挂起
    // （suspendedResult 的 error 恒为 undefined）⇒ `loop.error ??` 兜底必须给出结构化原因。
    const danger: AgentTool = {
      name: 'danger',
      description: 'd',
      inputSchema: { type: 'object', properties: {} },
      approval: 'required',
      run: () => '不应执行',
    };
    const { client } = mockClient([toolUseMsg('danger', {}, 'd1')]);
    const { ctx, recorder } = makeCtx(client);
    const tool = subagentToTool(researcherCapability({ tools: ['danger'] }), () => [danger]);

    await assert.rejects(async () => tool.run({ task: 't' }, ctx), /suspended/);

    const capability = recorder.snapshot('error').spans.find((s) => s.kind === 'capability')!;
    assert.equal(capability.status, 'error');
    assert.equal(capability.error?.type, 'agent_error');
    assert.equal(capability.error?.retryable, true);
    assert.match(capability.error?.message ?? '', /suspended/);
  });
});

describe('G7 交接属性（agentia.handoff.from / .to）', () => {
  /** 造一个最小子 agent 能力（可选带自己的菜单） */
  const subCap = (name: string, tools: string[] = []): SubAgentCapability => ({
    name,
    description: name,
    inputSchema: TASK_SCHEMA,
    spec: {
      description: name,
      schema: TASK_SCHEMA,
      system: `你是 ${name}。`,
      ...(tools.length > 0 ? { tools } : {}),
    },
  });

  it('嵌套交接：外层 from = 应用名，内层 from = 外层子 agent（作用域逐层换名）', async () => {
    const inner = subagentToTool(subCap('inner'), () => []);
    const outer = subagentToTool(subCap('outer', ['inner']), () => [inner]);
    const { client } = mockClient([
      toolUseMsg('outer', { task: 'a' }) as never,
      toolUseMsg('inner', { task: 'b' }) as never,
      endTurnMsg('inner 完成') as never,
      endTurnMsg('outer 完成') as never,
      endTurnMsg('主完成') as never,
    ]);

    const result = await runAgent({
      client,
      messages: [{ role: 'user', content: 'go' }],
      tools: [outer],
      runName: 'my-app',
    });

    const caps = result.trace.spans.filter((s) => s.kind === 'capability');
    const outerSpan = caps.find((s) => s.name === 'outer')!;
    const innerSpan = caps.find((s) => s.name === 'inner')!;
    // 外层：调用方是主 agent —— 名字取 run 根的 `runName`（与 OTLP 的 gen_ai.agent.name 同源）
    assert.equal(outerSpan.attributes['agentia.handoff.from'], 'my-app');
    assert.equal(outerSpan.attributes['agentia.handoff.to'], 'outer');
    // 内层：调用方是**外层子 agent**，不是应用 —— 这一条正是「作用域逐层换名」的判据；
    // 若 withCurrentSpan 是整条替换而不是合并，这里会退化成 undefined（拿不到名字）。
    assert.equal(innerSpan.attributes['agentia.handoff.from'], 'outer');
    assert.equal(innerSpan.attributes['agentia.handoff.to'], 'inner');
  });

  it('不在场：没有调用期作用域（宿主手搓 recorder + ctx 直调）⇒ 两个键都不写，不编造', async () => {
    const { client } = mockClient([endTurnMsg('结论') as never]);
    const { ctx, recorder } = makeCtx(client);
    await subagentToTool(subCap('researcher'), () => []).run({ task: 'go' }, ctx);

    const span = recorder.snapshot('ok').spans.find((s) => s.kind === 'capability')!;
    assert.equal('agentia.handoff.from' in span.attributes, false);
    assert.equal('agentia.handoff.to' in span.attributes, false);
  });
});
