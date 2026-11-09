import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamJanitorGroup } from '../../src/transport/stream-janitor.js';
import type {
  StreamJanitorGroupDeps,
  StreamJanitorRecord,
} from '../../src/transport/stream-janitor.js';
import { waitFor } from '../helpers.js';

/**
 * 跨进程 SSE 兜底收口（2026-11-07 深评 F5）。
 *
 * 2026-11-09 深评 P2-1 起，这件的粒度从「一条流一个 janitor（各建定时器）」变成
 * 「runner 一个组，一拍里每个任务只读一次 store」—— 所以下面的用例除了原有的收口语义，
 * 还钉住那条**读放大**不变量（同任务 N 个订阅仍然只 poll 一次）。
 */

const rec = (ownerId?: string): StreamJanitorRecord => (ownerId === undefined ? {} : { ownerId });

describe('createStreamJanitorGroup —— 跨进程 SSE 兜底收口', () => {
  it('终态 ⇒ 该任务的每个订阅各收一次 onTerminal；之后不再轮询', async () => {
    let calls = 0;
    let terminals = 0;
    const group = createStreamJanitorGroup({
      poll: async () => {
        calls++;
        return rec('me');
      },
      ownerId: 'me',
      pollMs: 5,
    });
    const target = () => ({
      isTerminal: () => true,
      onTerminal: () => terminals++,
      onClosed: () => assert.fail('不应发 closed'),
    });
    group.add('t1', target());
    group.add('t1', target()); // 同任务两个订阅：各自都要收到自己的终态回调
    await waitFor(() => terminals === 2, '两个订阅都看到终态');
    const n = calls;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls, n, '收口后停止轮询（timer 也停掉）');
    group.close();
  });

  it('记录消失 ⇒ onClosed；异步读失败 ⇒ 不炸，下一拍再试', async () => {
    let closed = 0;
    let n = 0;
    const group = createStreamJanitorGroup({
      poll: async () => {
        n++;
        if (n === 1) throw new Error('store 抖动'); // 异步 reject
        return undefined; // 之后记录被清（TTL / 外部删除）
      },
      ownerId: 'me',
      pollMs: 5,
    });
    group.add('t1', {
      isTerminal: () => false,
      onTerminal: () => assert.fail('不应发 terminal'),
      onClosed: () => closed++,
    });
    await waitFor(() => closed === 1, '记录消失后收口');
    assert.ok(n >= 2, '第一次读失败没有终止扫描');
    group.close();
  });

  it('同步 poll 抛错 ⇒ 定时器回调里不炸，下一拍再试', async () => {
    // 同步 store（已 close）的 poll 会**同步**抛：放进 setInterval 回调里逃出去就是
    // uncaughtException —— 那会把宿主按观测路径打死。
    let n = 0;
    let closed = 0;
    const poll: StreamJanitorGroupDeps['poll'] = () => {
      n++;
      if (n === 1) throw new Error('同步 store 已 close');
      return Promise.resolve(undefined);
    };
    const group = createStreamJanitorGroup({ poll, ownerId: 'me', pollMs: 5 });
    group.add('t1', {
      isTerminal: () => false,
      onTerminal: () => {},
      onClosed: () => closed++,
    });
    await waitFor(() => closed === 1, '同步抛之后仍能继续跑');
    assert.ok(n >= 2);
    group.close();
  });

  it('换了 owner（后续段在别的进程）⇒ onClosed', async () => {
    // 与「记录消失」是两条不同的收口理由，分别落在 checkOne 的两个分支上 ——
    // 2026-11-09 P2-3 的未覆盖行之一就是这里（原先只测了 undefined 那条）。
    let closed = 0;
    const group = createStreamJanitorGroup({
      poll: async () => rec('other-process'),
      ownerId: 'me',
      pollMs: 5,
    });
    group.add('t1', {
      isTerminal: () => false,
      onTerminal: () => assert.fail('换主不是终态，不该发 terminal'),
      onClosed: () => closed++,
    });
    await waitFor(() => closed === 1, '换主后收口');
    group.close();
  });

  it('记录没有 ownerId（旧记录 / 别的 store）⇒ 不判换主，继续轮询', async () => {
    // `ownerId === undefined` 与「换主」是两件事：没有归属信息只能当「还是我的」处理，
    // 否则老记录上的每条流都会被立刻收口。
    let closed = 0;
    let polls = 0;
    const group = createStreamJanitorGroup({
      poll: async () => {
        polls++;
        return {};
      },
      ownerId: 'me',
      pollMs: 5,
    });
    group.add('t1', {
      isTerminal: () => false,
      onTerminal: () => assert.fail('不该发 terminal'),
      onClosed: () => closed++,
    });
    await waitFor(() => polls >= 3, '继续轮询');
    assert.equal(closed, 0, '没有归属信息时不得判「换主」');
    group.close();
  });

  it('pollMs <= 0 ⇒ 不起定时器（整组关掉兜底）', async () => {
    let polls = 0;
    const group = createStreamJanitorGroup({
      poll: async () => {
        polls++;
        return rec('me');
      },
      ownerId: 'me',
      pollMs: 0,
    });
    group.add('t1', {
      isTerminal: () => false,
      onTerminal: () => {},
      onClosed: () => {},
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(polls, 0, 'pollMs:0 = 关掉定时器，一拍都不该跑');
    group.close();
  });

  it('收口回调自己抛错 ⇒ 被吞掉，且不耽误同任务其它订阅', async () => {
    let others = 0;
    const group = createStreamJanitorGroup({
      poll: async () => undefined,
      ownerId: 'me',
      pollMs: 5,
    });
    group.add('t1', {
      isTerminal: () => false,
      onTerminal: () => {},
      onClosed: () => {
        throw new Error('宿主的收口回调炸了');
      },
    });
    group.add('t1', {
      isTerminal: () => false,
      onTerminal: () => {},
      onClosed: () => others++,
    });
    await waitFor(() => others === 1, '另一个订阅照常收到 closed');
    group.close();
  });

  it('同任务 N 个订阅 ⇒ 一拍只读一次 store（2026-11-09 P2-1 的核心不变量）', async () => {
    // 这条是本次重构的**判据**：旧实现每个订阅各建定时器、各 poll 一次，
    // 3 + 2 个订阅一拍就是 5 次读；现在应当是 2 次（每个任务一次）。
    const polls: string[] = [];
    let release: Array<() => void> = [];
    const group = createStreamJanitorGroup({
      poll: (taskId) => {
        polls.push(taskId);
        // 挂住这一拍：正在跑的时候不再开下一拍（否则计数无法确定）
        return new Promise<StreamJanitorRecord>((resolve) => {
          release.push(() => resolve(rec('me')));
        });
      },
      ownerId: 'me',
      pollMs: 5,
    });
    // ⚠️ 每条订阅必须是**不同的对象**：登记表是 `Set<target>`，复用同一个对象会被去重成
    // 一条订阅 —— 第一版就是这么写的，于是「3 个订阅」实际只有 1 个，反向验证（改回
    // 每订阅一次 poll）照样全绿，等于一条假守卫。
    const target = () => ({
      isTerminal: () => false,
      onTerminal: () => {},
      onClosed: () => {},
    });
    group.add('a', target());
    group.add('a', target());
    group.add('a', target());
    group.add('b', target());
    group.add('b', target());
    await waitFor(() => release.length >= 2, '第一拍已经开始');
    assert.deepEqual([...polls].sort(), ['a', 'b'], '一拍里每个任务只读一次 store');
    for (const r of release) r();
    release = [];
    group.close();
  });

  it('注销幂等；所有订阅注销后不再轮询（timer 也停）', async () => {
    let n = 0;
    const group = createStreamJanitorGroup({
      poll: async () => {
        n++;
        return rec('me');
      },
      ownerId: 'me',
      pollMs: 5,
    });
    const off = group.add('t1', {
      isTerminal: () => false,
      onTerminal: () => {},
      onClosed: () => {},
    });
    off();
    off();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(n, 0, '注销之后不再 poll');
    group.close();
  });

  it('close 之后 add 得到空注销函数，且不再起定时器', async () => {
    let n = 0;
    const group = createStreamJanitorGroup({
      poll: async () => {
        n++;
        return rec('me');
      },
      ownerId: 'me',
      pollMs: 5,
    });
    group.close();
    const off = group.add('t1', {
      isTerminal: () => false,
      onTerminal: () => {},
      onClosed: () => {},
    });
    off();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(n, 0, 'close 之后不再轮询');
  });
});
