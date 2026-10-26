import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import type { Server } from 'node:http';
import { gracefulShutdown, serve } from '../../src/transport/serve.js';
import { waitFor } from '../helpers.js';

/**
 * `serve` / `gracefulShutdown` 的行为测试。
 *
 * 全部用**真实** `node:http` server 与真实 socket —— 这两个原语的全部价值就在
 * 「与 Node 的连接生命周期细节对齐」（idle keep-alive、close 回调时机、信号拦截），
 * 换成假 server 等于把被测的东西mock掉。
 *
 * 变异清单（改 src/transport/serve.ts 后本文件应红）：
 * - 删 `server.closeIdleConnections?.()` → 「Node 18 兼容契约」用例 red（行为断言抓不到，见该用例注）
 * - 删 `server.closeAllConnections?.()` → 旧版 Node 的「半开请求」/「裸连接」两例 HUNG
 * - 删 `server.off('error', onError)` → 「一次性 error 监听」用例 listenerCount 变 1
 * - `running ??=` 改成每次新建 → 「幂等」用例 drainCalls 变 2
 * - 二次信号分支改成 `return`（吞掉）→ 「没给 onSecondSignal」那例红（给了的那例走不到这行）
 * - `drain` catch 里改成不关服务器 → 「排空抛错」两例红（该例 + 「预算耗尽」因连接没被收）
 * - drain 等待不过总预算 → 「drain 永不返回」用例 HUNG
 * - 把 `closeServer` 提前到 `drain` 之前 → 「drain 期间仍在 listen」例红
 * - 删 `onShutdown?.(clean)` → 「onShutdown」例红
 */

const OPEN_SERVERS: Server[] = [];
const OPEN_SOCKETS: Socket[] = [];
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
/** Node 26 实测：close() 会在预算前收掉裸 TCP / 半开请求；旧版本需要 closeAllConnections 兜底。 */
const CLOSE_HANDLES_INCOMPLETE_EARLY = NODE_MAJOR >= 26;

afterEach(() => {
  for (const s of OPEN_SOCKETS.splice(0)) s.destroy();
  for (const s of OPEN_SERVERS.splice(0)) s.close();
});

/** 起一个只会 200 的 server（端口 0 = OS 分配，测试里从不占固定端口） */
async function serveEcho(): Promise<Awaited<ReturnType<typeof serve>>> {
  const served = await serve(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    },
    { port: 0 },
  );
  OPEN_SERVERS.push(served.server);
  return served;
}

/** 连一条 TCP 但不发请求 —— 对 http server 这就是一条 idle keep-alive 连接 */
function openIdleSocket(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect({ port, host: '127.0.0.1' });
    sock.once('error', reject);
    sock.once('connect', () => {
      OPEN_SOCKETS.push(sock);
      resolve(sock);
    });
  });
}

/** 给「本该很快结束」的 promise 一个明确上限 —— 卡住时报 HUNG，而不是等测试框架超时 */
function withHungGuard<T>(p: Promise<T>, ms: number, what: string): Promise<T | 'HUNG'> {
  return Promise.race([
    p,
    new Promise<'HUNG'>((resolve) => {
      const t = setTimeout(() => resolve('HUNG'), ms);
      t.unref?.();
    }),
  ]).then((v) => {
    assert.notEqual(v, 'HUNG', `${what}：卡住了（超过 ${ms}ms）—— 说明连接没收干净`);
    return v as T;
  });
}

describe('serve', () => {
  it('listen 之后才 resolve，且返回 OS 实际分配的端口', async () => {
    const served = await serveEcho();
    assert.equal(served.server.listening, true);
    assert.ok(served.port > 0, `port=0 应被替换成实际端口，拿到 ${served.port}`);

    // 真的能连上才算「在听」
    const sock = await openIdleSocket(served.port);
    assert.equal(sock.destroyed, false);
  });

  it('端口冲突直接 reject（boot 阶段静默起不来比崩更难查）', async () => {
    const a = await serveEcho();
    const err = await serve(() => undefined, { port: a.port }).then(
      () => undefined,
      (e: NodeJS.ErrnoException) => e,
    );
    assert.ok(err, '同端口第二次监听应当 reject');
    assert.equal(err.code, 'EADDRINUSE');
  });

  it('resolve 前摘掉一次性 error 监听（运行时错误不该被 boot 的监听吃掉）', async () => {
    const served = await serveEcho();
    assert.equal(
      served.server.listenerCount('error'),
      0,
      'boot 用的 once(error) 必须在 resolve 前 off 掉 —— 否则它会在首个运行时错误时 ' +
        '被调用（且已 resolve 的 promise 收不到），等于吞掉一次错误上报',
    );
  });

  /**
   * ⚠️ 这条只能用**调用断言**钉，不能用行为断言：Node **19.0.0** 起 `server.close()` 自己
   * 就会收空闲连接（PR nodejs/node#43522），官方原话是「19.0.0 之后没必要再配合调
   * `closeIdleConnections()`，但调也无害，且对要支持 <19 的库有用」。本机跑的是 22 ⇒
   * 行为上删掉这行也绿。而 `engines` 写的是 `>=18` ⇒ **对声明的地板它是承重的**。
   */
  it('close() 显式调 closeIdleConnections（Node 18 兼容契约）', async () => {
    const served = await serveEcho();
    const calls: string[] = [];
    const orig = served.server.closeIdleConnections?.bind(served.server);
    assert.ok(orig, '本 Node 应支持 closeIdleConnections（>=18.2）');
    served.server.closeIdleConnections = () => {
      calls.push('idle');
      orig();
    };

    const clean = await withHungGuard(served.close({ timeoutMs: 300 }), 3000, 'close()');
    assert.equal(clean, true);

    // ≥19 时 `close()` 内部自己会调一次（所以这个 spy 会被打两次：Node 一次 + 我们一次）；
    // <19 时只有我们那次。期望值按运行时算，两个版本上删掉显式调用都会 red。
    const expected = Number(process.versions.node.split('.')[0]) >= 19 ? 2 : 1;
    assert.equal(calls.length, expected, 'close() 必须显式收一次空闲连接 —— 见用例上方的版本注');
  });

  it('裸 TCP 连接：新版 Node 提前干净收口，旧版由预算强收', async () => {
    const served = await serveEcho();
    const sock = await openIdleSocket(served.port);

    const clean = await withHungGuard(served.close({ timeoutMs: 200 }), 3000, 'close()');
    assert.equal(
      clean,
      CLOSE_HANDLES_INCOMPLETE_EARLY,
      'Node 26 起 close() 可提前干净收口；旧版必须等预算强收并如实报 false',
    );
    await waitFor(() => sock.destroyed, '裸连接最终必须被收掉');
  });
});

describe('gracefulShutdown', () => {
  it('不传 signals 就不订阅（框架不做进程级决策）', async () => {
    const served = await serveEcho();
    const before = process.listenerCount('SIGTERM');
    gracefulShutdown({ server: served.server, drain: () => true });
    assert.equal(
      process.listenerCount('SIGTERM'),
      before,
      '不传 signals 时一个 listener 都不许加 —— 与 Nest 的 enableShutdownHooks() 同构（那边默认也不订阅）',
    );
  });

  it('信号触发一次停机，且 stop() 幂等（并发调用共用同一个 in-flight promise）', async () => {
    const served = await serveEcho();
    let drainCalls = 0;
    const before = process.listeners('SIGTERM');

    const stop = gracefulShutdown({
      server: served.server,
      drain: () => {
        drainCalls += 1;
        return true;
      },
      signals: ['SIGTERM'],
      timeoutMs: 500,
    });

    const added = process.listeners('SIGTERM').filter((f) => !before.includes(f));
    assert.equal(added.length, 1, 'signals 里每个信号挂一个 listener');
    try {
      // 直接调用 listener 而不是 process.kill：kill 是异步投递且会触发「第二次信号」的
      // 默认行为分支，这里要测的是「一次信号 → 一次停机」的配对关系。
      (added[0] as (s: NodeJS.Signals) => void)('SIGTERM');

      const [a, b] = await Promise.all([stop(), stop()]);
      assert.equal(a, true);
      assert.equal(b, true, '第二次调用必须返回同一个结果，而不是「排不干净」');
      assert.equal(drainCalls, 1, 'drain 只能跑一次');
      assert.equal(served.server.listening, false);
    } finally {
      for (const f of added) process.off('SIGTERM', f as never);
    }
  });

  it('第二次信号：给了 onSecondSignal 就交还调用方', async () => {
    const served = await serveEcho();
    const before = process.listeners('SIGTERM');
    const seen: NodeJS.Signals[] = [];

    gracefulShutdown({
      server: served.server,
      drain: () => true,
      signals: ['SIGTERM'],
      timeoutMs: 200,
      onSecondSignal: (s) => seen.push(s),
    });

    const added = process.listeners('SIGTERM').filter((f) => !before.includes(f));
    try {
      const fire = added[0] as (s: NodeJS.Signals) => void;
      fire('SIGTERM');
      fire('SIGTERM');
      assert.deepEqual(seen, ['SIGTERM'], '第二次信号必须被看见 —— 吞掉它 K8s 里就 kill 不掉');
    } finally {
      for (const f of added) process.off('SIGTERM', f as never);
    }
  });

  it('第二次信号：没给 onSecondSignal 就摘掉监听，把默认行为交还 Node', async () => {
    const served = await serveEcho();
    const before = process.listeners('SIGTERM');

    gracefulShutdown({
      server: served.server,
      drain: () => true,
      signals: ['SIGTERM'],
      timeoutMs: 200,
    });

    const added = process.listeners('SIGTERM').filter((f) => !before.includes(f));
    try {
      const fire = added[0] as (s: NodeJS.Signals) => void;
      fire('SIGTERM');
      fire('SIGTERM');
      // 关键：此时不能再有本原语的 listener —— 否则信号被拦截而默认行为不会发生，
      // 进程永远退不掉（参考宿主里那句 `if (stopping) return;` 就是这个 bug）。
      const stillOurs = process.listeners('SIGTERM').filter((f) => added.includes(f));
      assert.equal(stillOurs.length, 0, '第二次信号后必须解除监听，让 Node 默认行为接管');
    } finally {
      for (const f of added) process.off('SIGTERM', f as never);
    }
  });

  it('drain 跑的时候 server 还在 listen（顺序反了就把排空保护作废）', async () => {
    const served = await serveEcho();
    let listeningDuringDrain: boolean | undefined;
    const stop = gracefulShutdown({
      server: served.server,
      drain: () => {
        listeningDuringDrain = served.server.listening;
        return true;
      },
      timeoutMs: 300,
    });
    await withHungGuard(stop(), 3000, 'stop()');
    assert.equal(
      listeningDuringDrain,
      true,
      'drain 期间必须仍在 listen —— 先 close 再 drain 等于把「等在飞请求写完」这层保护直接作废',
    );
  });

  it('drain 返回 false：整体算失败，但服务器照样关掉', async () => {
    const served = await serveEcho();
    const stop = gracefulShutdown({
      server: served.server,
      drain: () => false,
      timeoutMs: 300,
    });
    const ok = await withHungGuard(stop(), 3000, 'stop()');
    assert.equal(ok, false, 'drain 说没排干净 ⇒ 整体 false');
    assert.equal(served.server.listening, false, '排空失败不该让监听继续挂着');
  });

  it('drain 抛错：按 false 处理，服务器照样关掉', async () => {
    const served = await serveEcho();
    const stop = gracefulShutdown({
      server: served.server,
      drain: () => {
        throw new Error('boom');
      },
      timeoutMs: 300,
    });
    const ok = await withHungGuard(stop(), 3000, 'stop()');
    assert.equal(ok, false);
    assert.equal(served.server.listening, false);
  });

  it('半开请求连接：新版 Node 提前干净收口，旧版预算强收报 false', async () => {
    const served = await serveEcho();
    const sock = await openIdleSocket(served.port);
    sock.write('GET / HTTP/1.1\r\nHost: localhost\r\n');

    const stop = gracefulShutdown({
      server: served.server,
      drain: () => true,
      timeoutMs: 120,
    });
    const ok = await withHungGuard(stop(), 4000, 'stop()');
    assert.equal(ok, CLOSE_HANDLES_INCOMPLETE_EARLY);
    assert.equal(served.server.listening, false);
    await waitFor(() => sock.destroyed, '半开请求连接最终必须被收掉');
  });

  it('drain 永不返回也不能绕过总预算：到期关服务器并回报 false', async () => {
    const served = await serveEcho();
    const seen: boolean[] = [];
    const stop = gracefulShutdown({
      server: served.server,
      drain: () => new Promise(() => {}),
      timeoutMs: 40,
      onShutdown: (clean) => seen.push(clean),
    });

    const ok = await withHungGuard(stop(), 1000, 'drain 永不返回时的 stop()');
    assert.equal(ok, false);
    assert.equal(served.server.listening, false, 'drain 卡死也不能让监听永远挂着');
    assert.deepEqual(seen, [false]);
  });

  it('onShutdown 收到最终结论、只调一次（这是留给 process.exit 的缝）', async () => {
    const served = await serveEcho();
    const seen: boolean[] = [];
    const stop = gracefulShutdown({
      server: served.server,
      drain: () => false,
      timeoutMs: 300,
      onShutdown: (clean) => seen.push(clean),
    });
    await withHungGuard(stop(), 3000, 'stop()');
    await stop(); // 幂等 ⇒ 不该再调一次
    assert.deepEqual(
      seen,
      [false],
      'onShutdown 只调一次，且传的是**真实**结论（drain 说没排干净）',
    );
  });

  it('timeoutMs <= 0 表示不设时限（不是「立刻超时」）', async () => {
    const served = await serveEcho();
    const stop = gracefulShutdown({
      server: served.server,
      drain: () => true,
      timeoutMs: 0,
    });
    const ok = await withHungGuard(stop(), 3000, 'stop()');
    assert.equal(ok, true, '<= 0 必须读作「不限」，读成 0ms 会什么都来不及排空');
  });
});
