import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTaskStore } from '../../src/store/fsStore.js';
import { DROPPED_REFS_KEY, droppedRuntimeRefsOf } from '../../src/store/record.js';
import { buildRunCallOptions } from '../../src/transport/run-call-options.js';
import { combineSignals } from '../../src/core/abort.js';
import type { TaskRecord } from '../../src/store/store.js';
import type { AgentTool } from '../../src/core/tool.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('TaskRecord 落库前的可序列化清洗（2026-11-07 深评）', () => {
  it('signal / client / tools / fallback client 不落盘；读回后 combineSignals 不炸', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-serialize-'));
    dirs.push(dir);
    const file = join(dir, 'tasks.jsonl');
    const signal = new AbortController().signal;
    const tool: AgentTool = {
      name: 't',
      description: 'd',
      inputSchema: { type: 'object' },
      run: () => 'ok',
    };
    const rec: TaskRecord = {
      taskId: 't1',
      status: 'queued',
      spec: {
        messages: [{ role: 'user', content: 'go' }],
        options: {
          signal,
          client: {} as never,
          tools: [tool],
          fallbacks: [{ model: 'backup', client: {} as never }],
        },
      },
      createdAt: 1,
    };
    new FileTaskStore(file).save(rec);
    const restored = new FileTaskStore(file).get('t1')!;
    assert.equal(restored.spec.options?.signal, undefined);
    assert.equal(restored.spec.options?.client, undefined);
    assert.equal(restored.spec.options?.tools, undefined);
    assert.equal(restored.spec.options?.fallbacks?.[0]?.client, undefined);
    assert.equal(restored.spec.options?.fallbacks?.[0]?.model, 'backup');
    assert.doesNotThrow(() => combineSignals(restored.spec.options?.signal, signal));
  });

  it('剥掉的可执行选项留下可读标记（跨进程恢复据此出声）', () => {
    // 2026-11-09 深评 P1：`serializeTaskRecord` 剥掉主 client 与 tools，而恢复段的
    // `buildRunCallOptions` 无从区分「本来没传」与「传了但被剥掉了」—— 没有标记就会
    // 静默退回 runner client / 装配菜单。标记只用来出声，不改变装配结果。
    const dir = mkdtempSync(join(tmpdir(), 'agentia-serialize-'));
    dirs.push(dir);
    const file = join(dir, 'tasks.jsonl');
    const tool: AgentTool = {
      name: 't',
      description: 'd',
      inputSchema: { type: 'object' },
      run: () => 'ok',
    };
    new FileTaskStore(file).save({
      taskId: 't2',
      status: 'suspended',
      spec: {
        messages: [{ role: 'user', content: 'go' }],
        options: {
          client: {} as never,
          tools: [tool],
          fallbacks: [{ model: 'backup', client: {} as never }],
        },
      },
      createdAt: 1,
    });
    const restored = new FileTaskStore(file).get('t2')!;
    const dropped = droppedRuntimeRefsOf(restored.spec.options);
    assert.equal(dropped?.client, true, '主 client 被剥 ⇒ 必须留标记');
    assert.equal(dropped?.tools, true, '任务级 tools 被剥 ⇒ 必须留标记');
    assert.equal(dropped?.fallbacks, true, 'fallback client 被剥 ⇒ 必须留标记');

    // 阴性对照：只带 signal（每条任务都有）不该产生标记 —— 那会变成「人人都在报警」
    new FileTaskStore(join(dir, 'b.jsonl')).save({
      taskId: 't3',
      status: 'queued',
      spec: {
        messages: [{ role: 'user', content: 'go' }],
        options: { signal: new AbortController().signal },
      },
      createdAt: 1,
    });
    const plain = new FileTaskStore(join(dir, 'b.jsonl')).get('t3')!;
    assert.equal(droppedRuntimeRefsOf(plain.spec.options), undefined, '只剥 signal ⇒ 不留标记');
  });

  it('恢复段看到标记时出声一次，且内部标记不透传给引擎', () => {
    // 模拟「从 store 读回」的记录：client / tools 已不在，只剩标记
    const restored = (taskId: string): TaskRecord => ({
      taskId,
      status: 'suspended',
      spec: {
        messages: [{ role: 'user', content: 'go' }],
        options: { [DROPPED_REFS_KEY]: ['client', 'tools'] } as never,
      },
      createdAt: 1,
    });
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    };
    try {
      const opts = buildRunCallOptions({
        rec: restored('task_warn_1'),
        isResume: true,
        sessionStore: undefined,
        client: undefined,
        signal: new AbortController().signal,
        bridgeTraceEvents: undefined,
      });
      // 内部标记不能进引擎（它不是 RunInvocationOptions 的字段）
      assert.equal(
        (opts as unknown as Record<string, unknown>)[DROPPED_REFS_KEY],
        undefined,
        '内部标记必须在装配时剔除',
      );
      assert.equal(opts.client, undefined, '剥掉的主 client 不会凭空回来');
      const hit = warns.filter((w) => w.includes('可执行选项在落库时被剥离'));
      assert.equal(hit.length, 1, '同一任务只出声一次');
      assert.ok(hit[0]!.includes('task_warn_1'));
      assert.ok(hit[0]!.includes('runner'));

      // 去重：同一任务再装配一次不该重复刷日志
      buildRunCallOptions({
        rec: restored('task_warn_1'),
        isResume: true,
        sessionStore: undefined,
        client: undefined,
        signal: new AbortController().signal,
        bridgeTraceEvents: undefined,
      });
      assert.equal(
        warns.filter((w) => w.includes('可执行选项在落库时被剥离')).length,
        1,
        '第二段（approve / signal / 到期唤醒都可能再装配一次）不再重复告警',
      );
    } finally {
      console.warn = orig;
    }
  });
});
