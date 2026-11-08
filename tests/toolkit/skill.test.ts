import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Skill, collectSkills, skillToTool, TraceRecorder, runAgent } from '../../src/index.js';
import type {
  AgentTool,
  ModelClient,
  SkillContext,
  SkillCapability,
  ToolRunContext,
} from '../../src/index.js';
import { mockClient, endTurnMsg, toolUseMsg, U } from '../helpers.js';

/** 自造 stop_reason：让受限子运行以「未识别的 stop_reason」失败（loop.error 由 engine 挂） */
function rawMsg(stop_reason: string, text = 'part'): Record<string, unknown> {
  return {
    id: 'm-raw',
    model: 'claude-opus-5',
    stop_reason,
    usage: U,
    content: [{ type: 'text', text }],
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

/** 取容器实例上的唯一 skill 能力 */
function onlySkill(instance: object): SkillCapability {
  const capabilities = collectSkills(instance);
  assert.equal(capabilities.length, 1);
  return capabilities[0];
}

describe('Skill 能力（ctx.llm 受限子运行）', () => {
  it('方法体调 ctx.llm 拿到文本；capability span 正常收尾且 llm.turn 递归其下', async () => {
    class Summarizer {
      @Skill({ description: 'd' })
      async summarize(input: { text: string }, ctx: SkillContext): Promise<string> {
        const out = await ctx.llm({ prompt: `总结：${input.text}` });
        return `[${out.stopReason}] ${out.text}`;
      }
    }
    const { client } = mockClient([endTurnMsg('摘要内容')]);
    const { ctx, recorder } = makeCtx(client);
    const tool = skillToTool(onlySkill(new Summarizer()), () => []);

    const out = await tool.run({ text: 't' }, ctx);
    assert.equal(out, '[end_turn] 摘要内容');

    const trace = recorder.snapshot('ok');
    const capability = trace.spans.find((s) => s.kind === 'capability')!;
    assert.equal(capability.status, 'ok');
    // 受限子运行的回合挂在 capability 下（不双开 run 根）
    const turn = trace.spans.find((s) => s.kind === 'llm.turn')!;
    assert.equal(turn.parentSpanId, capability.spanId);
  });

  it('受限子运行失败：capability span 挂的是 engine 的丰富 error（type/retryable），不是新造的 Error', async () => {
    class Fragile {
      @Skill({ description: 'd' })
      async go(_input: unknown, ctx: SkillContext): Promise<string> {
        const out = await ctx.llm({ prompt: 'q' });
        return out.text;
      }
    }
    const { client } = mockClient([rawMsg('mystery_stop_reason', '半截')]);
    const { ctx, recorder } = makeCtx(client);
    const tool = skillToTool(onlySkill(new Fragile()), () => []);

    // 对主 agent 仍是 is_error 语义（抛错 → engine 包成 tool_result）
    await assert.rejects(async () => tool.run({}, ctx), /unknown_stop_reason/);

    const capability = recorder.snapshot('error').spans.find((s) => s.kind === 'capability')!;
    assert.equal(capability.status, 'error');
    // loop.error 是 { type:'agent_error', retryable:false }（engine 判定的语义）；
    // 若走外层 catch 的 classifyError(new Error(report)) 会退化成 type:'unknown'，
    // 「不可重试的模型侧异常」这个信息就丢了
    assert.equal(capability.error?.type, 'agent_error');
    assert.equal(capability.error?.retryable, false);
    assert.match(capability.error?.message ?? '', /mystery_stop_reason/);
  });

  it('预算护栏透传 ctx.llm 子循环（C1）：子循环超支即停，主 run 以 budget_exceeded 收尾', async () => {
    class Searcher {
      @Skill({ description: 'd', tools: ['noop'] })
      async go(_input: unknown, ctx: SkillContext): Promise<string> {
        const out = await ctx.llm({ prompt: 'q' });
        return out.text;
      }
    }
    const noop: AgentTool = {
      name: 'noop',
      description: 'd',
      inputSchema: { type: 'object', properties: {} },
      run: () => 'ok',
    };
    // 主 turn（15）+ 子 turn×2（45 ≤ 50）→ 子第 3 回合后 60 > 50 → 子循环 budget_exceeded
    const { seen, client } = mockClient([
      toolUseMsg('go', {}, 'tu_main'),
      toolUseMsg('noop', {}, 's1'),
      toolUseMsg('noop', {}, 's2'),
      toolUseMsg('noop', {}, 's3'),
      toolUseMsg('noop', {}, 's4'),
      endTurnMsg('不该被请求到'),
    ]);
    const tool = skillToTool(onlySkill(new Searcher()), () => [noop]);
    const result = await runAgent({
      client,
      messages: [{ role: 'user', content: 'go' }],
      tools: [tool],
      maxTotalTokens: 50,
    });

    assert.equal(result.stopReason, 'budget_exceeded');
    assert.equal(seen.length, 4, '主 1 次 + 子 3 次；子循环超支后主循环不得再发请求');
    const capability = result.trace.spans.find((s) => s.kind === 'capability')!;
    assert.equal(capability.status, 'error');
    assert.equal(capability.error?.type, 'budget_exceeded');
  });

  it('工具超时口径透传 ctx.llm 子循环：子循环里的慢工具按超时记账，不得「永不超时」', async () => {
    // 同 subagent.ts 的那条：`toolTimeoutMs` 是 ToolRunContext 上唯一一件「主循环注入、
    // 嵌套能力必须往下交」的东西。漏了它不是「少一层保险」而是**反的** —— 子循环里
    // `withTimeout(p, 0)` 直接返回原 promise（`core/timeout.ts` 的 `!(t > 0)`）= 永不超时，
    // 同时 MCP 桥找不到引擎预算又起自己的 60s 兜底 = 双计时器 + 双账本。
    class Runner {
      @Skill({ description: 'd', tools: ['slow'] })
      async go(_input: unknown, ctx: SkillContext): Promise<string> {
        const out = await ctx.llm({ prompt: 'q' });
        return out.text;
      }
    }
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
    const { client } = mockClient([toolUseMsg('slow', {}, 's1'), endTurnMsg('跑完了')]);
    // 直接喂带 toolTimeoutMs 的 ctx（engine 注入的现场）：要隔离的是「ctx → 子循环」这一段
    const { ctx, recorder } = makeCtx(client, { toolTimeoutMs: 20 });
    const out = await skillToTool(onlySkill(new Runner()), () => [slow]).run({}, ctx);
    assert.equal(out, '跑完了', '工具超时不杀子循环');

    const capability = recorder.snapshot('ok').spans.find((s) => s.kind === 'capability')!;
    const subTurn = recorder
      .snapshot('ok')
      .spans.find((s) => s.kind === 'llm.turn' && s.parentSpanId === capability.spanId)!;
    const toolOut = subTurn.events.find((e) => e.name === 'tool.output')!;
    assert.equal((toolOut.body as { ok: boolean }).ok, false, '子循环里的超时必须记成失败');
    assert.equal((toolOut.body as { errorKind: string }).errorKind, 'timeout');
    assert.equal(slowFinished, 0, '超时是硬的：慢工具不得事后把结果写回');
  });
});

describe('Skill 方法体捕获 llm 失败并降级（span 不得误标 error）', () => {
  it('用户代码 try/catch 掉 ctx.llm 的失败、正常返回 ⇒ capability span 记 ok', async () => {
    // 回归（2026-09-19 复审）：旧实现在 llm 闭包里先 close({status:'error'}) 再 throw ——
    // 方法体 catch 住继续时，close 的幂等守卫让后来的 ok 写不进去，一次**整体成功**
    // 的调用被永久误标 error。
    class Resilient {
      @Skill({ description: 'd' })
      async tryLlm(_input: unknown, ctx: SkillContext): Promise<string> {
        try {
          await ctx.llm({ prompt: '会失败' });
          return '不应到达';
        } catch {
          return '降级结果';
        }
      }
    }
    // llm 子运行的模型请求直接抛（请求级失败）→ 子运行非成功收尾 → llm 闭包 throw
    const client = {
      messages: {
        stream: () => ({
          on() {},
          finalMessage: async () => {
            throw new Error('upstream boom');
          },
        }),
      },
    } as unknown as ToolRunContext['client'];
    const { ctx, recorder } = makeCtx(client);
    const tool = skillToTool(onlySkill(new Resilient()), () => []);
    const out = await tool.run({}, ctx);
    assert.equal(out, '降级结果', '方法体降级路径应正常返回');
    const trace = recorder.snapshot('ok');
    const capSpan = trace.spans.find((s) => s.kind === 'capability');
    assert.ok(capSpan);
    assert.equal(capSpan.status, 'ok', '整体成功的调用不得被误标成 error');
  });

  it('llm 失败未被捕获 ⇒ span 记 error 且带子运行的丰富错误（type/retryable）', async () => {
    class Fragile {
      @Skill({ description: 'd' })
      async tryLlm(_input: unknown, ctx: SkillContext): Promise<string> {
        const out = await ctx.llm({ prompt: '会失败' });
        return out.text;
      }
    }
    const client = {
      messages: {
        stream: () => ({
          on() {},
          finalMessage: async () => {
            throw new Error('upstream boom');
          },
        }),
      },
    } as unknown as ToolRunContext['client'];
    const { ctx, recorder } = makeCtx(client);
    const tool = skillToTool(onlySkill(new Fragile()), () => []);
    await assert.rejects(async () => tool.run({}, ctx), /upstream boom|error/);
    const trace = recorder.snapshot('ok');
    const capSpan = trace.spans.find((s) => s.kind === 'capability');
    assert.ok(capSpan);
    assert.equal(capSpan.status, 'error', '未捕获的失败仍须记 error');
  });
});

describe('未定价告警回调透传 ctx.llm 子循环（F2）', () => {
  it('skill 的受限子运行用了未定价模型：宿主的 onUnpricedModel 被调（带 model/spanId）', async () => {
    // 同 subagent 那条：旧实现里 ToolRunContext 没有 onUnpricedModel 通道，
    // 子循环的「算不出成本」只剩 usage.unpriced 事件，宿主的告警回调静默缺席。
    class Pricer {
      @Skill({ description: 'd', model: 'unpriced-model-y' })
      async go(_input: unknown, ctx: SkillContext): Promise<string> {
        const out = await ctx.llm({ prompt: 'q' });
        return out.text;
      }
    }
    const { client } = mockClient([
      toolUseMsg('go', {}, 'tu_main'),
      endTurnMsg('摘要内容'), // 子循环（未定价模型）
      endTurnMsg('汇总完毕'), // 主循环收尾
    ]);
    const tool = skillToTool(onlySkill(new Pricer()), () => []);
    const unpricedCalls: Array<{ model: string; spanId: string }> = [];
    const result = await runAgent({
      client, // 主循环走缺省模型 claude-opus-5（在价格表内）
      messages: [{ role: 'user', content: 'go' }],
      tools: [tool],
      onUnpricedModel: (info) => unpricedCalls.push(info),
    });

    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.finalText, '汇总完毕');
    assert.equal(unpricedCalls.length, 1, '只有子循环的未定价模型触发一次回调');
    assert.equal(unpricedCalls[0].model, 'unpriced-model-y');
    // spanId 指向子循环自己的 llm.turn（挂在 capability span 下）
    const capability = result.trace.spans.find((s) => s.kind === 'capability')!;
    const subTurn = result.trace.spans.find(
      (s) => s.kind === 'llm.turn' && s.parentSpanId === capability.spanId,
    )!;
    assert.equal(unpricedCalls[0].spanId, subTurn.spanId);
  });
});

describe('Skill 陈旧 llmError 不得给无关异常贴标签', () => {
  it('方法体 catch 掉 llm 失败（降级）后又因别的原因抛错 ⇒ span 记真实异常的分类', async () => {
    // 回归（2026-09-19 复审）：旧实现外层 catch 用 `llmError ?? classifyError(e)`，
    // llmError 从不清空 —— 降级路径吞掉的那次 llm 失败残留着，方法体随后抛出的
    // **无关**异常被记成那次 llm 失败的分类（type/retryable 全错、真实分类被丢弃）。
    class FallbackThenBoom {
      @Skill({ description: 'd' })
      async go(_input: unknown, ctx: SkillContext): Promise<string> {
        try {
          await ctx.llm({ prompt: '会失败' });
        } catch {
          // 降级：吞掉 llm 失败，继续走脚本
        }
        throw new Error('boom'); // 与 llm 失败无关的另一处故障
      }
    }
    // 子运行以「未识别的 stop_reason」非成功收尾（loop.error 是 engine 判定的丰富错误）
    const { client } = mockClient([rawMsg('mystery_stop_reason', '半截')]);
    const { ctx, recorder } = makeCtx(client);
    const tool = skillToTool(onlySkill(new FallbackThenBoom()), () => []);

    await assert.rejects(async () => tool.run({}, ctx), /boom/);

    const capability = recorder.snapshot('error').spans.find((s) => s.kind === 'capability')!;
    assert.equal(capability.status, 'error');
    // 必须是 boom 的分类（classifyError 对普通 Error 给 unknown/不可重试），
    // 不是残留 llmError 的 agent_error
    assert.equal(capability.error?.type, 'unknown');
    assert.equal(capability.error?.retryable, false);
    assert.match(capability.error?.message ?? '', /boom/);
    assert.doesNotMatch(capability.error?.message ?? '', /mystery_stop_reason/);
  });

  it('主路径不回归：方法体不 catch llm 失败 ⇒ span 仍记 llmError 的丰富分类', async () => {
    class Fragile {
      @Skill({ description: 'd' })
      async go(_input: unknown, ctx: SkillContext): Promise<string> {
        const out = await ctx.llm({ prompt: '会失败' });
        return out.text;
      }
    }
    const { client } = mockClient([rawMsg('mystery_stop_reason', '半截')]);
    const { ctx, recorder } = makeCtx(client);
    const tool = skillToTool(onlySkill(new Fragile()), () => []);

    await assert.rejects(async () => tool.run({}, ctx), /unknown_stop_reason/);

    const capability = recorder.snapshot('error').spans.find((s) => s.kind === 'capability')!;
    assert.equal(capability.status, 'error');
    // llm 闭包抛出的对象被外层按引用相等认领 ⇒ 用 engine 判定的丰富错误收尾
    assert.equal(capability.error?.type, 'agent_error');
    assert.equal(capability.error?.retryable, false);
    assert.match(capability.error?.message ?? '', /mystery_stop_reason/);
  });
});

describe('Skill 被引擎超时放弃等待（ToolRunContext.abandoned）', () => {
  it('capability span 立刻以 error(timeout) 收尾 + llm 子循环被中止（与 subagent 同款）', async () => {
    // 反向验证：摘掉 onAbandoned 的 close ⇒ 交付的 trace 里 capability span 永远没有
    // endedAt、status 停在缺省 ok（与同回合 tool.output 的 timeout 矛盾），本用例红；
    // 摘掉合成 signal ⇒ subAborted 为 false，子循环在后台继续烧 token。
    // 这是「span 超时后立刻收尾」修复的承重路径，形态同 subagent.test.ts 的既有用例。
    class Slow {
      @Skill({ description: 'd' })
      async go(_input: unknown, ctx: SkillContext): Promise<string> {
        const out = await ctx.llm({ prompt: 'q' });
        return out.text;
      }
    }
    let subAborted = false;
    let calls = 0;
    const client = {
      messages: {
        stream: (params: unknown) => ({
          on() {},
          finalMessage: async () => {
            calls++;
            if (calls === 1) return toolUseMsg('go', {}, 'tu1'); // 主循环调 skill
            if (calls === 2) {
              // llm 子循环的模型请求：挂住直到 signal 中止（慢 skill 的形态）
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

    const tool = skillToTool(onlySkill(new Slow()), () => []);
    const result = await runAgent({
      model: 'test-model',
      maxTokens: 1024,
      client,
      messages: [{ role: 'user', content: 'go' }],
      tools: [tool],
      toolTimeoutMs: 30,
    });

    assert.equal(result.stopReason, 'end_turn', 'skill 超时不该中断主 run');
    assert.ok(subAborted, 'llm 子循环必须收到中止信号 —— 否则它在后台继续烧 token');
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

describe('Skill 防御分支', () => {
  it('手动直调 run(input)（无 ctx）⇒ 抛可读错误（engine 才会注入 ToolRunContext）', async () => {
    // 反向验证：摘掉 `if (!ctx) throw` ⇒ 下一步 `ctx.recorder` 炸裸 TypeError，
    // 本用例红在「报文不可读」。
    class Bare {
      @Skill({ description: 'd' })
      async go(): Promise<string> {
        return 'x';
      }
    }
    const tool = skillToTool(onlySkill(new Bare()), () => []);
    await assert.rejects(async () => tool.run({}), /只能在主 agent 运行中被调用/);
  });

  it('ctx.llm({})（无 prompt 无 messages）⇒ 抛错，不拿空消息列表去调模型', async () => {
    // 反向验证：摘掉 messages.length === 0 的拦 ⇒ 空 messages 进子循环，本用例红在「不抛」。
    class Empty {
      @Skill({ description: 'd' })
      async go(_input: unknown, ctx: SkillContext): Promise<string> {
        await ctx.llm({});
        return '不应到达';
      }
    }
    // 模型根本不该被调到（拦在发请求之前）—— 空脚本被触发即证明守卫失效
    const { client } = mockClient([]);
    const { ctx } = makeCtx(client);
    const tool = skillToTool(onlySkill(new Empty()), () => []);
    await assert.rejects(async () => tool.run({}, ctx), /需要 prompt 或 messages/);
  });

  it('llm 子运行挂起（suspended）且 loop.error 为 undefined ⇒ 兜底 agent_error 收尾', async () => {
    // 反向验证：摘掉 `loop.error ??` 的兜底 ⇒ llmError 是 undefined，capability span 记成
    // error 却没有原因（「非正常收尾必带结构化 error」破缺），本用例红在 error?.type 为空。
    // 构造：skill 子循环里有一个 approval:'required' 的工具、没有任何审批决定 ⇒
    // 子循环挂起（stopReason='suspended'，suspendedResult 的 error 恒为 undefined）——
    // 这是「非成功收尾 + loop.error 为 undefined」唯一能从公共面构造的形态。
    class Approving {
      @Skill({ description: 'd', tools: ['danger'] })
      async go(_input: unknown, ctx: SkillContext): Promise<string> {
        const out = await ctx.llm({ prompt: 'q' });
        return out.text;
      }
    }
    const danger: AgentTool = {
      name: 'danger',
      description: 'd',
      inputSchema: { type: 'object', properties: {} },
      approval: 'required',
      run: () => '不应执行',
    };
    const { client } = mockClient([toolUseMsg('danger', {}, 'd1')]);
    const { ctx, recorder } = makeCtx(client);
    const tool = skillToTool(onlySkill(new Approving()), () => [danger]);

    await assert.rejects(async () => tool.run({}, ctx), /suspended/);

    const capability = recorder.snapshot('error').spans.find((s) => s.kind === 'capability')!;
    assert.equal(capability.status, 'error');
    // 兜底分支的产物：type='agent_error'、retryable=true，message 是那份 report
    assert.equal(capability.error?.type, 'agent_error');
    assert.equal(capability.error?.retryable, true);
    assert.match(capability.error?.message ?? '', /suspended/);
  });
});
