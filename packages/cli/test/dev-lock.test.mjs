/* dev 环的写者锁（dev-lock.ts）。
 *
 * 为什么这个文件存在：`dev-runner.ts` 落盘 trace 时写着「单进程写者前提天然满足」，
 * 而那条前提只在一次 dev 会话内成立。两个 `agentia dev` 开在同一个工程里，两个 runner
 * 会往同一个 `.agentia/traces.jsonl` 追加 —— 交错的行让 `agentia view` / `report`
 * 读到半条 JSON，且**不报错**。
 *
 * 判据全部用**注入的 pid / isAlive**，不碰真实进程表：靠真进程会让用例变成
 * 「机器上恰好没有那个 pid」这种运气测试。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { distReadyOrLoud } from './dist-guard.mjs';

const DIST = fileURLToPath(new URL('../dist/dev-lock.js', import.meta.url));
let D = null;
if (existsSync(DIST)) D = await import(new URL('../dist/dev-lock.js', import.meta.url).href);
const SKIP = !D ? '未构建 packages/cli/dist —— 先跑 npm run build:cli' : false;
if (SKIP) distReadyOrLoud(DIST, 'CLI 构建产物');

/** 一个干净的临时目录 + 锁路径；用完删掉（不碰用户工程里的 .agentia） */
function withLockPath(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agentia-dev-lock-'));
  try {
    return fn(join(dir, 'traces.jsonl.lock'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const readLock = (lockPath) => JSON.parse(readFileSync(lockPath, 'utf8'));

describe('dev 写者锁', { skip: SKIP }, () => {
  it('没人占 ⇒ 拿到写权，锁里写着自己的 pid 与端口', () => {
    withLockPath((lockPath) => {
      const r = D.claimWriterLock({ lockPath, pid: 1001, port: 63161, now: 42 });
      assert.deepEqual(r, { owned: true, warning: null });
      assert.deepEqual(readLock(lockPath), { pid: 1001, port: 63161, since: 42 });
    });
  });

  it('锁被另一个活着的实例占着 ⇒ 不抢、出声，且原锁一个字不动', () => {
    withLockPath((lockPath) => {
      D.claimWriterLock({ lockPath, pid: 1001, port: 51654 });
      const r = D.claimWriterLock({
        lockPath,
        pid: 2002,
        port: 63161,
        isAlive: (p) => p === 1001, // 1001 活着，2002 是「我」
      });
      assert.equal(r.owned, false, '有人占着就不许抢');
      assert.ok(r.warning, '必须出声 —— 静默共用就是这条锁要防的那件事');
      assert.match(r.warning, /1001/, '告警里要能对上「是哪个实例」');
      assert.match(r.warning, /51654/, '端口是最快的辨认方式');
      assert.match(r.warning, /交错|半条/, '要说清后果（增量的是行会交错）');
      // 关键：不能覆盖别人的锁 —— 覆盖等于把门替人打开
      assert.equal(readLock(lockPath).pid, 1001);
    });
  });

  it('锁是死实例（pid 不在了）留下的 ⇒ 接管并重写', () => {
    withLockPath((lockPath) => {
      D.claimWriterLock({ lockPath, pid: 1001, port: 51654 });
      const r = D.claimWriterLock({
        lockPath,
        pid: 2002,
        port: 63161,
        isAlive: () => false, // 1001 已经没了（SIGKILL / 拔电源）
      });
      assert.deepEqual(r, { owned: true, warning: null }, '死锁必须能接管，否则 dev 再也起不来');
      assert.equal(readLock(lockPath).pid, 2002);
    });
  });

  it('同一个 pid 占着 ⇒ 接管（那是「自己的上一世」，不是另一个实例）', () => {
    withLockPath((lockPath) => {
      // 场景：runner 被 SIGKILL，父进程重启它之前没走到 exit 清理
      D.claimWriterLock({ lockPath, pid: 2002, port: 63161 });
      const r = D.claimWriterLock({ lockPath, pid: 2002, port: 63161, isAlive: () => true });
      assert.deepEqual(r, { owned: true, warning: null }, '把自己认成「另一个实例」比不报更坏');
    });
  });

  it('锁文件是半条 JSON ⇒ 当没有可用信息，接管', () => {
    withLockPath((lockPath) => {
      writeFileSync(lockPath, '{"pid": '); // 上一世在写一半时被杀
      const r = D.claimWriterLock({ lockPath, pid: 2002, port: 0 });
      assert.deepEqual(r, { owned: true, warning: null });
      assert.equal(readLock(lockPath).pid, 2002);
    });
  });

  it('释放只认自己那把：pid 对不上就一个字都不动', () => {
    withLockPath((lockPath) => {
      D.claimWriterLock({ lockPath, pid: 1001 });
      D.releaseWriterLock(lockPath, 2002);
      assert.ok(existsSync(lockPath), '删掉别人的锁会替它把门打开 —— 两个写者就都进来了');
      D.releaseWriterLock(lockPath, 1001);
      assert.equal(existsSync(lockPath), false, '自己的锁要能删掉，否则下次启动误报');
    });
  });

  it('pidAlive 的边界：非正整数一律「不在」', () => {
    assert.equal(D.pidAlive(process.pid), true, '自己一定活着（这条也防「永远返回 false」）');
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.equal(D.pidAlive(bad), false, `${bad} 不是合法 pid，不许当成活人`);
    }
  });
});
