import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsonlTraceSink } from '../../src/index.js';
import type { Trace } from '../../src/index.js';
// 内部纯函数（刻意不进公共导出面，故不走 index.js）
import { dailyArchivePath, dayKeyOf } from '../../src/integrations/file-sink.js';

/** 造一条 JSON 干净（无 undefined 字段）的最小 trace —— 落盘往返要逐字相等 */
function makeTrace(traceId: string, startedAt = 1000): Trace {
  return {
    traceId,
    rootSpanId: `${traceId}-root`,
    status: 'ok',
    totalUsage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
    spans: [
      {
        spanId: `${traceId}-root`,
        traceId,
        parentSpanId: null,
        kind: 'run',
        name: 'agent.run',
        startedAt,
        endedAt: startedAt + 300,
        status: 'ok',
        attributes: {},
        events: [],
      },
    ],
  };
}

describe('jsonlTraceSink（CLI report/diff/harvest 的输入格式）', () => {
  it('三次 export 三行，每行可解析且逐字等于投入的 trace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-jsonl-'));
    try {
      const file = join(dir, 'trace.jsonl');
      const sink = jsonlTraceSink({ path: file });
      const traces = [makeTrace('run-1'), makeTrace('run-2'), makeTrace('run-3')];
      for (const t of traces) sink.export(t);

      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      assert.equal(lines.length, 3);
      for (const [i, line] of lines.entries()) {
        assert.deepEqual(JSON.parse(line), traces[i], `第 ${i + 1} 行应逐字等于投入的 trace`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('父目录不存在时构造期递归创建', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-jsonl-'));
    try {
      const file = join(dir, 'a', 'b', 'trace.jsonl');
      const sink = jsonlTraceSink({ path: file }); // 不抛即建好了
      const trace = makeTrace('run-1');
      sink.export(trace);
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), trace);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('追加不覆盖：文件已有内容时接着写', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-jsonl-'));
    try {
      const file = join(dir, 'trace.jsonl');
      writeFileSync(file, `${JSON.stringify(makeTrace('old'))}\n`, 'utf8');
      jsonlTraceSink({ path: file }).export(makeTrace('new'));

      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      assert.deepEqual(
        lines.map((l) => (JSON.parse(l) as Trace).traceId),
        ['old', 'new'],
        '旧行必须保留，新行追加在后',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 2026-10-16 ref-sink-exactly-once：脚手架的 `sinks` 与 `agentia dev` 的
  // `registerDefaultTraceSink` **各自都合理**，但都往 `.agentia/traces.jsonl` 写 ⇒
  // 不幂等就是「一条 trace 两行」，而 `report` 的前提是「一行 = 一次 run」。
  it('同一路径注册两次 ⇒ 同一个 sink（进程内幂等，不是两个写者）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-jsonl-'));
    try {
      const file = join(dir, 'trace.jsonl');
      const a = jsonlTraceSink({ path: file });
      const b = jsonlTraceSink({ path: file });
      assert.equal(a, b, '同一路径必须复用同一个 sink —— 两个写者 = 一条 trace 落两行');

      // 反例钉住「去重去过头」：不同路径仍是两个独立 sink（都写各自的）
      const other = jsonlTraceSink({ path: join(dir, 'other.jsonl') });
      assert.notEqual(a, other);
      a.export(makeTrace('run-1'));
      other.export(makeTrace('run-2'));
      assert.deepEqual(
        readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l).traceId),
        ['run-1'],
        '幂等只发生在同一路径内，不同文件互不影响',
      );
      assert.deepEqual(
        readFileSync(join(dir, 'other.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l).traceId),
        ['run-2'],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('写失败抛给调用方（flushSinks 会吞 —— sink 自己不藏）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-jsonl-'));
    try {
      const asDir = join(dir, 'not-a-file');
      mkdirSync(asDir);
      // path 指向一个目录：mkdir 父目录没问题，append 时才炸（EISDIR）
      const sink = jsonlTraceSink({ path: asDir });
      assert.throws(() => sink.export(makeTrace('run-1')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fsync:true ⇒ 走同步落盘分支（内容仍是一行一条）', () => {
    // 覆盖 opt-in 持久性那条分支：不加这条，`fsyncSync` 那几行只在类型检查里「存在」。
    const dir = mkdtempSync(join(tmpdir(), 'agentia-jsonl-'));
    try {
      const file = join(dir, 'fsync.jsonl');
      const sink = jsonlTraceSink({ path: file, fsync: true });
      sink.export(makeTrace('run-1'));
      sink.export(makeTrace('run-2'));
      const lines = readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l).traceId);
      assert.deepEqual(lines, ['run-1', 'run-2']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('同路径第二次请求的 fsync 与既有 sink 不一致 ⇒ 出声一次，且仍是同一个 sink', () => {
    // 2026-11-09 深评 P3-1：键若带上 `fsync`，同一文件就有两个写者 ⇒ 一次 run 落两行
    // （比静默忽略更贵的错）。所以保持「同路径一个 sink」，但**不一致时要出声** ——
    // 否则「我明明开了 fsync」这类耐久性承诺会无声失效。
    const dir = mkdtempSync(join(tmpdir(), 'agentia-jsonl-'));
    const file = join(dir, 'trace.jsonl');
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args.join(' '));
    try {
      const first = jsonlTraceSink({ path: file });
      const second = jsonlTraceSink({ path: file, fsync: true });
      assert.equal(first, second, '同路径必须只有一个 sink（否则一次 run 落两行）');
      assert.equal(warned.length, 1, 'fsync 口径不一致必须出声');
      assert.match(warned[0]!, /fsync=true 不会生效/);
      // 同路径只提醒一次：别按 run / 按连接刷屏
      jsonlTraceSink({ path: file, fsync: true });
      assert.equal(warned.length, 1, '同路径的不一致只报一次');
    } finally {
      console.warn = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('jsonlTraceSink 的按天轮转（2026-11-13 ref-checklist-four）', () => {
  const D = (day: number): number => Date.UTC(2026, 10, day, 12, 0, 0);
  const ids = (file: string): string[] =>
    readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l).traceId);
  const withWarn = async (fn: (warned: string[]) => void): Promise<string[]> => {
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args.join(' '));
    try {
      fn(warned);
    } finally {
      console.warn = original;
    }
    return warned;
  };

  it('dayKeyOf 按 UTC 自然日取根起点，缺时间戳回退写盘时刻；dailyArchivePath 保留扩展名', () => {
    assert.equal(dayKeyOf(makeTrace('x', D(11)), D(13)), '2026-11-11');
    assert.equal(dayKeyOf(makeTrace('x', Date.UTC(2026, 10, 11, 23, 59, 59)), D(13)), '2026-11-11');
    assert.equal(dayKeyOf(makeTrace('x', Date.UTC(2026, 10, 12, 0, 0, 0)), D(11)), '2026-11-12');
    // 手写 trace 没有 startedAt ⇒ 不猜，回退写盘时刻
    const bare = makeTrace('x');
    delete (bare.spans[0] as { startedAt?: number }).startedAt;
    assert.equal(dayKeyOf(bare, D(13)), '2026-11-13');
    assert.equal(dailyArchivePath('/a/traces.jsonl', '2026-11-11'), '/a/traces.2026-11-11.jsonl');
    assert.equal(dailyArchivePath('/a/traces', '2026-11-11'), '/a/traces.2026-11-11');
  });

  it('缺省不轮转：跨天的 trace 仍写进同一个文件，不产生任何归档', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-jsonl-'));
    try {
      const file = join(dir, 'traces.jsonl');
      const sink = jsonlTraceSink({ path: file });
      sink.export(makeTrace('a', D(11)));
      sink.export(makeTrace('b', D(13)));
      assert.deepEqual(ids(file), ['a', 'b']);
      assert.ok(!existsSync(join(dir, 'traces.2026-11-11.jsonl')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('跨天把旧内容按日归档，path 仍是「当前文件」（消费侧固定路径不用改）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-jsonl-'));
    try {
      const file = join(dir, 'traces.jsonl');
      const sink = jsonlTraceSink({ path: file, rotate: 'daily' });
      sink.export(makeTrace('a', D(11)));
      sink.export(makeTrace('b', D(11)));
      sink.export(makeTrace('c', D(12)));
      sink.export(makeTrace('d', D(13)));
      assert.deepEqual(ids(join(dir, 'traces.2026-11-11.jsonl')), ['a', 'b']);
      assert.deepEqual(ids(join(dir, 'traces.2026-11-12.jsonl')), ['c']);
      assert.deepEqual(ids(file), ['d'], 'report / dev 面板读的还是这个固定路径');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('乱序 / 回放的旧 trace 不触发归档（日期单调推进，不把今天归档成昨天）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-jsonl-'));
    try {
      const file = join(dir, 'traces.jsonl');
      const sink = jsonlTraceSink({ path: file, rotate: 'daily' });
      sink.export(makeTrace('a', D(11)));
      sink.export(makeTrace('b', D(13)));
      sink.export(makeTrace('late', D(11)));
      assert.deepEqual(ids(join(dir, 'traces.2026-11-11.jsonl')), ['a']);
      assert.deepEqual(ids(file), ['b', 'late'], '迟到的旧 trace 落在当前文件，不丢');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('进程重启后 path 里还留着前一天的内容 ⇒ 按 mtime 认出来，先把旧的归档', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-jsonl-'));
    try {
      const file = join(dir, 'traces.jsonl');
      writeFileSync(file, `${JSON.stringify(makeTrace('old', D(11)))}\n`);
      const when = new Date(D(11));
      utimesSync(file, when, when);
      const sink = jsonlTraceSink({ path: file, rotate: 'daily' });
      sink.export(makeTrace('new', D(12)));
      assert.deepEqual(ids(join(dir, 'traces.2026-11-11.jsonl')), ['old']);
      assert.deepEqual(ids(file), ['new'], '不把两天混进同一个文件');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('归档目标已存在 ⇒ 不覆盖、不删除，出一次声并继续追加 path（宁可混日期不丢历史）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-jsonl-'));
    try {
      const file = join(dir, 'traces.jsonl');
      const archive = join(dir, 'traces.2026-11-11.jsonl');
      writeFileSync(file, `${JSON.stringify(makeTrace('old', D(11)))}\n`);
      writeFileSync(archive, `${JSON.stringify(makeTrace('hand-archive', D(11)))}\n`);
      const when = new Date(D(11));
      utimesSync(file, when, when);
      const warned = await withWarn(() => {
        const sink = jsonlTraceSink({ path: file, rotate: 'daily' });
        sink.export(makeTrace('new', D(12)));
      });
      assert.deepEqual(ids(archive), ['hand-archive'], '已有归档不许被覆盖');
      assert.deepEqual(ids(file), ['old', 'new'], '当前文件的数据不许被删');
      assert.equal(warned.length, 1);
      assert.match(warned[0]!, /不覆盖也不删除/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('同路径第二次请求的 rotate 不一致 ⇒ 出声一次，且仍是同一个 sink', async () => {
    // 与 fsync 那条同一个理由：键带上选项就会回到「同一文件两个写者」；
    // 但轮转会改写入目标，静默忽略比 fsync 更容易让人以为自己开了归档。
    const dir = mkdtempSync(join(tmpdir(), 'agentia-jsonl-'));
    const file = join(dir, 'trace.jsonl');
    try {
      const warned = await withWarn(() => {
        const first = jsonlTraceSink({ path: file });
        const second = jsonlTraceSink({ path: file, rotate: 'daily' });
        assert.equal(first, second, '同路径必须只有一个 sink');
        jsonlTraceSink({ path: file, rotate: 'daily' });
      });
      assert.equal(warned.length, 1, '同路径只提醒一次');
      assert.match(warned[0]!, /rotate=daily 不会生效/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
