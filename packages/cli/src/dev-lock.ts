/**
 * dev 环的**写者锁**：同一工程里开两个 `agentia dev` 时，两个 runner 会往同一个
 * `.agentia/traces.jsonl` 追加。
 *
 * 为什么必须有这件东西：`dev-runner.ts` 挂落盘 sink 时写着「单进程写者前提天然满足 ——
 * dev 环只有 runner 这一个写者」，而那条前提**只在一次 dev 会话内成立**。开两个终端跑
 * 同一个工程（一个正常实例 + 一个只看不跑的实例，或忘了关旧的）前提就破了：
 * 两份 trace 交错进同一个文件，`agentia view` / `report` / `diff` 会读到半条 JSON ——
 * 而 `jsonlTraceSink` 的契约明写「多进程写同一文件会交错」，它本身不管这件事。
 *
 * 只出声、不拒绝启动：只读实例（只想看，不点运行）是合法用法，锁住它会把人挡在门外。
 * 判据因此是「**有人可能正在写**」这个事实，而不是「不许有第二个进程」。
 *
 * ⚠️ 三条边界（如实写）：
 * - pid 活着 ≠ 它此刻真在写。这里报的是**可能性** —— 「点运行」这个动作发生在之后，
 *   事前问不出来。
 * - 只在启动期判一次：另一个实例后来退出、或后来才进来，本进程的告警**不会自己更新**
 *   （重启本进程即重新判定）。不做 `fs.watch`：这条提示的代价是「看一眼」，不是「必须实时」。
 * - 锁文件建不出来（目录只读 / 磁盘满）⇒ **静默返回**。同一目录下的 trace 也写不进去，
 *   那件事 `jsonlTraceSink` 自己会出声；在这里再报一次只会让人去找一个不存在的原因。
 *
 * 为什么单独一个文件而不是塞进 `dev-runner.ts`：`dev-runner` 被 import 就会
 * `void main()`（它是子进程入口），逻辑放那儿一行都测不动。
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 锁文件的内容（人可读：出问题时 `cat` 一下就知道是谁占着） */
export interface WriterLock {
  pid: number;
  /** 那个实例的面板端口；没起面板记 0 */
  port: number;
  /** 拿到锁的时刻（epoch ms） */
  since: number;
}

export interface ClaimOptions {
  lockPath: string;
  /** 缺省 `process.pid`。只有测试要装成「另一个实例」时才传 */
  pid?: number;
  port?: number;
  /** 缺省 `pidAlive`。测试注入，避免依赖真实进程表 */
  isAlive?: (pid: number) => boolean;
  now?: number;
}

export interface ClaimResult {
  /** 本进程拿到了写权（拿到 ⇒ 退出时要 `releaseWriterLock`） */
  owned: boolean;
  /** 非 null ⇒ 有别的**活着的**实例占着锁（面板告警条照原样显示它） */
  warning: string | null;
}

/**
 * pid 是否还活着。
 *
 * `EPERM` 算活着：进程在，只是不归我（同机不同用户）。只有 `ESRCH`（查无此 pid）
 * 才是真没了 —— 把 EPERM 当死会让「别人的实例」被接管，那比误报更糟。
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 读锁；半条 / 空文件 / 不是 JSON 一律当「没有可用信息」（下面会接管并重写） */
function readLock(lockPath: string): WriterLock | null {
  try {
    const raw = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<WriterLock>;
    const pid = Number(raw.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const port = Number(raw.port);
    const since = Number(raw.since);
    return {
      pid,
      port: Number.isFinite(port) ? port : 0,
      since: Number.isFinite(since) ? since : 0,
    };
  } catch {
    return null;
  }
}

function overlapWarning(lockPath: string, other: WriterLock): string {
  const who = other.port > 0 ? `pid ${other.pid} · 端口 ${other.port}` : `pid ${other.pid}`;
  return (
    `另一个 agentia dev（${who}）正在用同一个工程：两个 runner 会往同一份 ${lockPath} 追加，` +
    '交错的行会让 agentia view / report 读到半条记录。这边照样能启动 —— ' +
    '只是别在两个实例里都点运行；只想看的话就只看不跑。' +
    '（那个实例退出后本条不会自动消失，重启这个实例即可）'
  );
}

/**
 * 抢锁。`openSync(..., 'wx')` 是原子的「要么我建、要么别人已建」，所以两个实例同时
 * 启动不会双双自认主人。
 */
export function claimWriterLock(opts: ClaimOptions): ClaimResult {
  const pid = opts.pid ?? process.pid;
  const port = opts.port ?? 0;
  const isAlive = opts.isAlive ?? pidAlive;
  // 两轮：第一轮的 EEXIST 若是**死实例**留下的就删掉重来；再撞就是活人，认了。
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dirname(opts.lockPath), { recursive: true });
      const fd = openSync(opts.lockPath, 'wx');
      try {
        const body: WriterLock = { pid, port, since: opts.now ?? Date.now() };
        writeFileSync(fd, `${JSON.stringify(body)}\n`);
      } finally {
        closeSync(fd);
      }
      return { owned: true, warning: null };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return { owned: false, warning: null };
      const other = readLock(opts.lockPath);
      // 同一个 pid = **自己上一次**留下的（父进程 restart 子进程时旧世代还没走到 exit，
      // 或上一世被 SIGKILL）。直接接管，否则热重载会一直警告「另一个实例」，而那就是自己。
      if (other !== null && other.pid !== pid && isAlive(other.pid)) {
        return { owned: false, warning: overlapWarning(opts.lockPath, other) };
      }
      try {
        unlinkSync(opts.lockPath);
      } catch {
        /* 别人刚删掉 / 刚抢到：下一轮再说 */
      }
    }
  }
  return { owned: false, warning: null };
}

/** 释放**自己的**那把锁。pid 不是自己的就一个字都不动 —— 删掉等于替别人把门打开。 */
export function releaseWriterLock(lockPath: string, pid: number = process.pid): void {
  const other = readLock(lockPath);
  if (other === null || other.pid !== pid) return;
  try {
    unlinkSync(lockPath);
  } catch {
    /* 已经没了 */
  }
}
