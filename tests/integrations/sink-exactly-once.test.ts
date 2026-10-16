import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createApp,
  jsonlTraceSink,
  registerDefaultTraceSink,
  SystemPrompt,
} from '../../src/index.js';
import { endTurnMsg, mockClient } from '../helpers.js';

/**
 * 「同一个落盘文件，一条 trace 恰好一行」（2026-10-16 ref-sink-exactly-once）。
 *
 * 为什么单独一个文件：这条用例必须**真跑一次 run**（只钉 `jsonlTraceSink` 的幂等还不够 ——
 * 「工厂幂等」与「收尾时真的只调一次 export」是两件事，中间还夹着 `AgentApp` 把
 * 应用级 sinks 与全局默认 sink **拼成一个数组**的那一行）。而它必须在自己这个文件里跑：
 * `registerDefaultTraceSink` 写的是**模块级全局数组**，混进别的文件会污染同进程的其它用例
 * （`node --test` 按文件分进程，所以本文件是它的最小隔离单元）。
 *
 * 撞到它的现实形状（就是本次的病根）：脚手架 `createApp({ sinks: [jsonlTraceSink(...)] })`
 * 与 `agentia dev` 的 `registerDefaultTraceSink(jsonlTraceSink(...))` 都往
 * `.agentia/traces.jsonl` 写 —— **两边各自都合理**，而不幂等的结果是同一个 traceId 落两行：
 * `report` / `diff` 把「一行 = 一次 run」当前提 ⇒ 一次 run 被数两次，且**不报错**
 * （比不落盘更难发现：不落盘是没数据，重复落盘是数据看着正常但错了）。
 */

describe('落盘 sink 的「恰好一次」', () => {
  it('应用级 sinks 与全局默认 sink 对口同一文件 ⇒ 一次 run 仍然只落一行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-sink-once-'));
    try {
      const file = join(dir, 'traces.jsonl');
      const { client } = mockClient([endTurnMsg('done')]);
      // dev 环那条（早于 app 创建，与 dev-runner 的时序一致）
      registerDefaultTraceSink(jsonlTraceSink({ path: file }));
      // 脚手架那条（应用级）
      const app = createApp({
        name: 'sink-once',
        system: new SystemPrompt().add('role', 'r', true),
        sinks: [jsonlTraceSink({ path: file })],
      });
      await app.run([{ role: 'user', content: 'hi' }], { client });

      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      assert.equal(
        lines.length,
        1,
        `一次 run 应恰好一行，实际 ${lines.length} 行 —— 两条 sink 写了同一个文件` +
          '（`report` 会把这次 run 数两次）',
      );
      assert.equal(typeof (JSON.parse(lines[0]!) as { traceId?: unknown }).traceId, 'string');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('不同文件 ⇒ 各写各的（去重只发生在同一路径内）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-sink-once-'));
    try {
      const a = join(dir, 'a.jsonl');
      const b = join(dir, 'b.jsonl');
      const { client } = mockClient([endTurnMsg('done')]);
      const app = createApp({
        name: 'two-files',
        system: new SystemPrompt().add('role', 'r', true),
        sinks: [jsonlTraceSink({ path: a }), jsonlTraceSink({ path: b })],
      });
      await app.run([{ role: 'user', content: 'hi' }], { client });

      assert.equal(readFileSync(a, 'utf8').split('\n').filter(Boolean).length, 1);
      assert.equal(readFileSync(b, 'utf8').split('\n').filter(Boolean).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
