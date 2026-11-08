import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTaskStore } from '../../src/store/fsStore.js';
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
});
