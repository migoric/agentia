import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { executeRun, runAgent, TraceRecorder } from '../../src/index.js';
import type { JsonSchema, MessageParam, Span } from '../../src/index.js';
import { mockClient, toolUseMsg, endTurnMsg, U } from '../helpers.js';
// 内部工具（刻意不进公共导出面，故不走 index.js）
import { replaceMessages } from '../../src/engine/turn.js';
// 真吐文本的脚本化 client（eval 公共面）：onText 链路按真实路径走
import { scriptedClient } from '../../src/eval/scripted.js';

const OBJ = { type: 'object', properties: {} } as const;

/** 自造 stop_reason 的响应：helpers 的 mock 只覆盖 end_turn / tool_use 两个常用形态 */
function rawMsg(stop_reason: string, text = 'part'): Record<string, unknown> {
  return {
    id: 'm-raw',
    model: 'claude-opus-5',
    stop_reason,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    content: [{ type: 'text', text }],
  };
}

const turnOf = (spans: Span[]): Span => spans.find((s) => s.kind === 'llm.turn')!;

describe('agentLoop 边界与失败路径', () => {
  it('stop_sequence：视为正常收尾（ok），文本保留', async () => {
    const { client } = mockClient([rawMsg('stop_sequence', '命中停止序列前的文本')]);
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
    });
    assert.equal(result.stopReason, 'stop_sequence');
    assert.equal(result.finalText, '命中停止序列前的文本');
    assert.equal(run.status, 'succeeded', 'stop_sequence 不是失败');
    assert.equal(result.error, undefined);
    assert.equal(result.trace.status, 'ok');
  });

  it('未识别的 stop_reason：保留文本但按失败收尾，并给出可诊断的 error', async () => {
    const { client } = mockClient([rawMsg('model_context_window_exceeded', '半截输出')]);
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
    });
    assert.equal(result.stopReason, 'unknown_stop_reason');
    assert.equal(result.finalText, '半截输出', '已产出的文本不该丢');
    assert.equal(run.status, 'failed');
    assert.match(result.error?.message ?? '', /model_context_window_exceeded/);
    assert.equal(result.trace.status, 'error');
  });

  it('stop_reason=tool_use 但无可执行块：tool_use_no_blocks + 保留文本 + 结构化 error', async () => {
    const { client } = mockClient([
      {
        ...rawMsg('tool_use', '想调工具但块是空的'),
        content: [{ type: 'text', text: '想调工具但块是空的' }],
      },
    ]);
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
    });
    assert.equal(result.stopReason, 'tool_use_no_blocks');
    assert.equal(result.finalText, '想调工具但块是空的');
    // 不变量（与 unknown_stop_reason / budget_exceeded / refusal / max_iterations 同口径）：
    // 「非正常收尾都带结构化 error」。此前这条分支的 result.error 是 undefined ——
    // run 以 status:'failed' 收尾，而 HTTP body / 任务记录里只看得到一句 stopReason
    // 字符串，看不出**为什么**失败。
    assert.equal(run.status, 'failed');
    assert.equal(result.trace.status, 'error');
    assert.equal(result.error?.type, 'agent_error');
    assert.equal(result.error?.retryable, false);
    assert.match(result.error?.message ?? '', /tool_use/);

    // 两条分支的原因不同，文案也必须不同：都写成「未识别的 stop_reason」等于把
    // 「模型吐了个畸形响应」误报成「框架不认识这个 stop_reason」
    const { client: other } = mockClient([rawMsg('model_context_window_exceeded', 'x')]);
    const { result: unknown } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client: other,
    });
    assert.equal(unknown.stopReason, 'unknown_stop_reason');
    assert.notEqual(result.error?.message, unknown.error?.message);
  });

  it('畸形 inputSchema：只废掉该工具调用（is_error 回模型），run 不因此失败', async () => {
    let ran = 0;
    // validateJsonSchema 对 required 非可迭代值会抛 TypeError —— 必须在 try 内被收成 is_error，
    // 否则整次 run 会以 error 收场（模型连自我修正的机会都没有）
    const { client, seen } = mockClient([toolUseMsg('broken', {}), endTurnMsg('ok')]);
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [
        {
          name: 'broken',
          description: 'd',
          inputSchema: { type: 'object', required: 5 } as unknown as JsonSchema,
          run: () => {
            ran++;
            return 'never';
          },
        },
      ],
      client,
    });
    assert.equal(ran, 0, 'schema 异常不该进方法体');
    assert.equal(run.status, 'succeeded');
    assert.equal(result.stopReason, 'end_turn');
    const toolResult = JSON.stringify(seen[1]);
    assert.match(toolResult, /"is_error":true/);
    assert.match(toolResult, /error\(/);
  });

  it('请求失败时的 iterations 报实际已发生的回合数（不被硬写成 0）', async () => {
    // 脚本只有一轮：第二回合 finalMessage 抛错 → run 失败在第 2 回合
    const { client } = mockClient([toolUseMsg('noop', {})]);
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [
        {
          name: 'noop',
          description: 'd',
          inputSchema: OBJ,
          run: () => 'ok',
        },
      ],
      client,
      rethrow: false,
    });
    assert.equal(run.status, 'failed');
    assert.equal(result.stopReason, 'error');
    assert.equal(result.iterations, 1, '已发生的 1 次模型往返必须如实报出');
  });

  it('trace 的 tool.input/tool.output 事件带 tool_use_id（重放按 id 配对的前提）', async () => {
    const { client } = mockClient([toolUseMsg('echo', { a: 1 }, 'tu_xyz'), endTurnMsg('ok')]);
    const { result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'echo', description: 'd', inputSchema: OBJ, run: () => 'echoed' }],
      client,
    });
    const turn = turnOf(result.trace.spans);
    const input = turn.events.find((e) => e.name === 'tool.input')!;
    const output = turn.events.find((e) => e.name === 'tool.output')!;
    assert.equal((input.body as { tool_use_id?: string }).tool_use_id, 'tu_xyz');
    assert.equal((output.body as { tool_use_id?: string }).tool_use_id, 'tu_xyz');
  });

  it('refusal：模型拒答 → stopReason=refusal + 保留文本 + 不可重试 error', async () => {
    const { client } = mockClient([rawMsg('refusal', '我不能帮你做这个')]);
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
      rethrow: false,
    });
    assert.equal(result.stopReason, 'refusal');
    assert.equal(result.finalText, '我不能帮你做这个', '已产出的文本不该丢');
    assert.equal(result.error?.type, 'refusal');
    assert.equal(result.error?.retryable, false);
    assert.equal(run.status, 'failed');
    assert.equal(result.trace.status, 'error');
  });

  it('max_tokens：截断收尾 → stopReason=max_tokens，文本保留 + 结构化 error', async () => {
    const { client } = mockClient([rawMsg('max_tokens', '被截断的开头')]);
    const { result } = await executeRun({ messages: [{ role: 'user', content: 'go' }], client });
    assert.equal(result.stopReason, 'max_tokens');
    assert.equal(result.finalText, '被截断的开头');
    // 与 budget_exceeded / refusal 同口径：非正常收尾都带结构化 error（run 根 span 有「为什么」）
    assert.equal(result.error?.type, 'max_tokens');
    assert.equal(result.error?.retryable, false);
    assert.equal(result.trace.status, 'error');
    const root = result.trace.spans.find((s) => s.kind === 'run')!;
    assert.equal(root.error?.type, 'max_tokens', 'run 根 span 必须带 error 对象');
  });

  it('pause_turn：无 server tools 时直接停 → stopReason=pause_turn（防死循环）+ 结构化 error', async () => {
    const { client } = mockClient([rawMsg('pause_turn', '暂停片段')]);
    const { result } = await executeRun({ messages: [{ role: 'user', content: 'go' }], client });
    assert.equal(result.stopReason, 'pause_turn');
    assert.equal(result.finalText, '暂停片段');
    assert.equal(result.error?.type, 'pause_turn');
    assert.equal(result.error?.retryable, false);
  });

  it('max_iterations：循环达上限 → stopReason=max_iterations，iterations 如实 + 结构化 error', async () => {
    // 每回合都回 tool_use、永不给终态；maxIterations=2 到底后兜底改判
    const { client } = mockClient([
      toolUseMsg('echo', {}, 't1'),
      toolUseMsg('echo', {}, 't2'),
      toolUseMsg('echo', {}, 't3'),
    ]);
    const { result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'echo', description: 'd', inputSchema: OBJ, run: () => 'ok' }],
      client,
      maxIterations: 2,
    });
    assert.equal(result.stopReason, 'max_iterations');
    assert.equal(result.iterations, 2, '上限内的 2 次模型往返都要记');
    assert.equal(result.error?.type, 'max_iterations');
    assert.match(result.error?.message ?? '', /maxIterations=2/);
    const root = result.trace.spans.find((s) => s.kind === 'run')!;
    assert.equal(root.error?.type, 'max_iterations', 'run 根 span 必须带 error 对象');
  });

  it('入口段抛错（配置错）：照常抛出，且 run 根 span 已合拢（error + 结构化 error + endedAt）', async () => {
    // 2026-10-13 深评 A2：入口段（menuSignature / resolveModelChain / validateLabels）
    // 抛错时 run 根已开却永不 end —— 交付 sink 的 trace 里 status='error' 而根 span 是
    // ok、无 endedAt、无结构化 error，违反「非正常收尾必带结构化 error」的不变量。
    // 两个真实触发点各打一条：labels 空键（validateLabels）、空壳 fallback client（resolveModelChain）。
    const badOptions = [
      { labels: { '': 'x' } },
      { fallbacks: [{ model: 'm2', client: {} as never }] },
    ];
    for (const bad of badOptions) {
      const recorder = new TraceRecorder();
      const { client, seen } = mockClient([endTurnMsg('不该被调用')]);
      await assert.rejects(
        () =>
          runAgent({
            messages: [{ role: 'user', content: 'go' }],
            client,
            recorder,
            ...bad,
          }),
        TypeError,
        '配置错必须照常响亮抛出（行为对外不变）',
      );
      assert.equal(seen.length, 0, '入口校验失败不该发出任何模型请求');
      const trace = recorder.snapshot('error'); // 模拟 runtime/run.ts fail() 的交付路径
      const root = trace.spans.find((s) => s.kind === 'run')!;
      assert.equal(root.status, 'error', '根 span 状态必须是 error（修前是 ok —— trace 在说谎）');
      assert.ok(root.endedAt !== undefined, '根 span 必须有 endedAt（修前永不合拢）');
      assert.ok(root.error, '根 span 必须带结构化 error');
      assert.equal(typeof root.error?.message, 'string');
    }
  });

  it('max_iterations：循环耗尽也保留已产出文本（与 max_tokens / refusal 同口径）', async () => {
    // 每回合都是「文本 + tool_use」：既有产出又永不给终态，maxIterations=2 耗尽
    const textToolUse = (text: string, id: string) => ({
      id: `m-${id}`,
      model: 'claude-opus-5',
      stop_reason: 'tool_use' as const,
      usage: U,
      content: [
        { type: 'text', text },
        { type: 'tool_use', id, name: 'echo', input: {} },
      ],
    });
    const { client } = mockClient([
      textToolUse('第一回合的话', 'tt1'),
      textToolUse('第二回合的话', 'tt2'),
    ]);
    const { result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'echo', description: 'd', inputSchema: OBJ, run: () => 'ok' }],
      client,
      maxIterations: 2,
    });
    assert.equal(result.stopReason, 'max_iterations');
    assert.equal(result.finalText, '第二回合的话', '耗尽出口不该把已产出文本丢成空串');
  });

  it('「消息已收、工具未跑」窗口内 abort ⇒ 整批工具不执行，aborted 收尾', async () => {
    // 与续跑入口（resumeUses 分支）「已取消不执行任何工具」同口径：
    // abort 若落在 streamTurn 成功返回之后、executeTurnTools 之前，
    // 这批 tool_use 的副作用一个都不该发生。
    const ac = new AbortController();
    let ran = 0;
    const client = {
      messages: {
        stream: () => ({
          on() {},
          finalMessage: async () => {
            ac.abort(); // 消息到手、尚未进循环体的最后一刻取消 ⇒ 必然落在那个窗口里
            return toolUseMsg('echo', {}, 'tu-win');
          },
        }),
      },
    } as never;
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      tools: [
        {
          name: 'echo',
          description: 'd',
          inputSchema: OBJ,
          run: () => {
            ran += 1;
            return 'ok';
          },
        },
      ],
      client,
      signal: ac.signal,
      rethrow: false,
    });
    assert.equal(result.stopReason, 'aborted');
    assert.equal(result.error?.type, 'aborted');
    assert.equal(ran, 0, '取消后整批工具的副作用都不该发生');
    assert.equal(run.status, 'failed');
  });

  it('signal 预先中止 → stopReason=aborted、run 失败，且不发起模型请求', async () => {
    const ac = new AbortController();
    ac.abort();
    const { client, seen } = mockClient([endTurnMsg('不该被调用')]);
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
      signal: ac.signal,
      rethrow: false,
    });
    assert.equal(result.stopReason, 'aborted');
    assert.equal(result.error?.type, 'aborted');
    assert.equal(run.status, 'failed');
    assert.equal(seen.length, 0, '已中止就不该再发请求');
  });

  it('回合中途 abort（stream 抛 AbortError）→ aborted 收尾，异常不冒泡', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const client = {
      messages: {
        stream: () => ({
          on() {},
          finalMessage: async () => {
            throw abortErr;
          },
        }),
      },
    } as never;
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
      rethrow: false,
    });
    assert.equal(result.stopReason, 'aborted');
    assert.equal(result.error?.type, 'aborted');
    assert.equal(run.status, 'failed');
  });

  it('可重试失败（429）自动重试：成功收尾、trace 两个 turn、onRetry 一次', async () => {
    const rate = new Anthropic.RateLimitError(429, undefined, 'slow down', new Headers());
    let n = 0;
    const client = {
      messages: {
        stream: () => ({
          on() {},
          finalMessage: async () => {
            n++;
            if (n === 1) throw rate;
            return endTurnMsg('重试后成功');
          },
        }),
      },
    } as never;
    const attempts: number[] = [];
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
      retry: {
        maxAttempts: 3,
        baseDelayMs: 1,
        jitter: 0,
        onRetry: (i) => attempts.push(i.attempt),
      },
    });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.finalText, '重试后成功');
    assert.equal(run.status, 'succeeded');
    assert.deepEqual(attempts, [1]);
    const turns = result.trace.spans.filter((s) => s.kind === 'llm.turn');
    assert.equal(turns.length, 2, '失败尝试与成功尝试各开一个 span');
    assert.equal(turns[0].status, 'error');
    assert.equal(turns[1].status, 'ok');
    assert.equal(turns[1].attributes['retry.attempt'], 2);
  });

  it('模型调用超时（DOMException TimeoutError）自动重试：成功收尾，且失败 turn 记 type=timeout', async () => {
    // 端到端钉住两件事：① 超时**缺省可重试**（与改动前一致 —— 那时它走 connection 分支）；
    // ② 它的 `span.error.type` 是 `timeout` 而不是 `connection`（2026-09-17 起，spec §10 同日 ②）。
    // 形态取自默认 client 的真实超时信号：`composeSignal` 用 `controller.abort(DOMException(...,'TimeoutError'))`。
    const timeout = new DOMException('Anthropic 请求超过 100ms', 'TimeoutError');
    let n = 0;
    const client = {
      messages: {
        stream: () => ({
          on() {},
          finalMessage: async () => {
            n++;
            if (n === 1) throw timeout;
            return endTurnMsg('重试后成功');
          },
        }),
      },
    } as never;
    const attempts: number[] = [];
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
      retry: {
        maxAttempts: 3,
        baseDelayMs: 1,
        jitter: 0,
        onRetry: (i) => attempts.push(i.attempt),
      },
    });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.finalText, '重试后成功');
    assert.equal(run.status, 'succeeded');
    assert.deepEqual(attempts, [1], '超时是可重试故障');
    const turns = result.trace.spans.filter((s) => s.kind === 'llm.turn');
    assert.equal(turns.length, 2, '失败尝试与成功尝试各开一个 span');
    assert.equal(turns[0].error?.type, 'timeout', '超时有自己的 errorType，不再混进 connection');
    assert.equal(turns[0].error?.retryable, true);
  });

  it('已吐出文本后失败 → 不重试（重试会重复输出）', async () => {
    const rate = new Anthropic.RateLimitError(429, undefined, 'slow down', new Headers());
    const client = {
      messages: {
        stream: () => ({
          on(ev: string, cb: (d: string) => void) {
            if (ev === 'text') cb('半截输出');
          },
          finalMessage: async () => {
            throw rate;
          },
        }),
      },
    } as never;
    let retried = 0;
    const { result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
      rethrow: false,
      retry: { maxAttempts: 3, baseDelayMs: 1, jitter: 0, onRetry: () => (retried += 1) },
    });
    assert.equal(retried, 0, '已产出文本就不该重试');
    assert.equal(result.stopReason, 'error');
  });

  it('retry:false → 429 直接失败，不重试', async () => {
    const rate = new Anthropic.RateLimitError(429, undefined, 'slow down', new Headers());
    let calls = 0;
    const client = {
      messages: {
        stream: () => ({
          on() {},
          finalMessage: async () => {
            calls++;
            throw rate;
          },
        }),
      },
    } as never;
    const { result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
      rethrow: false,
      retry: false,
    });
    assert.equal(calls, 1);
    assert.equal(result.stopReason, 'error');
  });
});

describe('replaceMessages：原地替换没有展开实参上限', () => {
  it('超大数组也不抛（旧的 splice 展开写法在 ~12 万项以上会 RangeError）', () => {
    const big: MessageParam[] = Array.from({ length: 300_000 }, () => ({
      role: 'user' as const,
      content: '',
    }));

    // 先钉住「旧写法确实会炸」—— 否则这条修复被回退也没人发现
    assert.throws(() => {
      const t: unknown[] = [];
      (t as unknown[]).splice(0, t.length, ...big);
    }, RangeError);

    const target: MessageParam[] = [{ role: 'user', content: '旧内容' }];
    replaceMessages(target, big);
    assert.equal(target.length, big.length);
    assert.equal(target[big.length - 1].content, '');
  });

  it('原地替换保持数组引用不变（循环各处持有同一数组）', () => {
    const target: MessageParam[] = [{ role: 'user', content: 'a' }];
    const ref = target;
    replaceMessages(target, [{ role: 'assistant', content: 'b' }]);
    assert.equal(target, ref, '引用必须不变');
    assert.deepEqual(target, [{ role: 'assistant', content: 'b' }]);
  });

  it('清空后传入空数组 → 变空', () => {
    const target: MessageParam[] = [{ role: 'user', content: 'a' }];
    replaceMessages(target, []);
    assert.equal(target.length, 0);
  });
});

describe('观测回调是辅助动作：抛错不得杀死 run', () => {
  it('onText 抛错：run 照常完成，文本照收', async () => {
    // scriptedClient 会真的逐块吐文本（helpers 的 mockClient 忽略 on('text')，测不到这条路径）
    const client = scriptedClient([endTurnMsg('完整文本')]);
    let calls = 0;
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
      onText: () => {
        calls++;
        throw new Error('UI 渲染炸了');
      },
    });
    assert.ok(calls > 0, 'onText 确实被调用过（且抛了错）');
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.finalText, '完整文本');
    assert.equal(run.status, 'succeeded');
  });

  it('onRetry 抛错：重试照常进行并最终成功', async () => {
    const rate = new Anthropic.RateLimitError(429, undefined, 'slow down', new Headers());
    let n = 0;
    const client = {
      messages: {
        stream: () => ({
          on() {},
          finalMessage: async () => {
            n++;
            if (n === 1) throw rate;
            return endTurnMsg('重试后成功');
          },
        }),
      },
    } as never;
    let calls = 0;
    const { run, result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client,
      retry: {
        maxAttempts: 3,
        baseDelayMs: 1,
        jitter: 0,
        onRetry: () => {
          calls++;
          throw new Error('告警管道炸了');
        },
      },
    });
    assert.equal(calls, 1, 'onRetry 确实被调用过（且抛了错）');
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.finalText, '重试后成功');
    assert.equal(run.status, 'succeeded');
    assert.equal(n, 2, '重试没有被回调异常打断');
  });
});

describe('run 根 attribute：promptVersions / sessionId（R7）', () => {
  it('promptVersions 拼成排序后的 name@ver 落 run 根 prompts.versions；空表不记', async () => {
    const { result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client: mockClient([endTurnMsg('ok')]).client,
      promptVersions: { zebra: '2', alpha: '1.0' },
    });
    const root = result.trace.spans.find((s) => s.spanId === result.trace.rootSpanId)!;
    assert.equal(root.attributes['prompts.versions'], 'alpha@1.0,zebra@2');

    const { result: r2 } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client: mockClient([endTurnMsg('ok')]).client,
      promptVersions: {},
    });
    const root2 = r2.trace.spans.find((s) => s.spanId === r2.trace.rootSpanId)!;
    assert.equal('prompts.versions' in root2.attributes, false);
  });
});
