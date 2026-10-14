/**
 * 基准：**redis 上的「到期索引」要不要做**（spec §10 2026-09-28 ref-due-index-measure 复审补记留下的那个缺口：
 * redis 那一档**没有量**）。
 *
 * ⚠️ 这台机器**没有 redis 服务**（无 `redis-server` / 无 docker）⇒ 本脚本量的是**形状**，不是延迟：
 *
 * - 用**零延迟计数夹具**量 `RedisTaskStore.list()` 的**往返次数**与**纯 CPU**（JSON.parse + 排序）
 *   —— 这两项与「有没有真 redis」无关；
 * - 延迟按 `往返 × RTT` **外推**，表里逐档写明「外推」，**不写成读数**。
 *
 * 夹具的数不当全局证据（这条边界是 §10 2026-09-28 ref-due-index-measure 自己立的：file store 那一档的教训）。
 * 所以它回答的是**「换个实现（辅助 ZSET）能省下多少次往返」**，不是「redis 有多慢」。
 *
 * 为什么值得量：`RedisTaskStore` 不实现 `listDue` ⇒ `resumePending()` 的到期唤醒那一半在 redis 上
 * 每一轮都要「枚举全部 key + 逐条 GET + 逐条 JSON.parse」= **O(N) 次往返**（比 sqlite 那条单次
 * 真查询更贵）。触发条件（§11）在 redis 上今天就已经满足。
 *
 * 跑法：`npx tsx scripts/bench-redis-due.ts [N...]`（缺省 1000 10000 100000）
 * 可调：`PAYLOAD_CHARS`（每条记录的负载规模，缺省 4000 ≈ 带一小段 trace）、`RTTS`
 * 不进 verify-all / CI（与 `bench:trace` / `bench-resume-scan` 同档）。
 */
import { RedisTaskStore } from '../src/index.js';
import type { RedisLike, TaskRecord } from '../src/index.js';

const args = process.argv
  .slice(2)
  .map(Number)
  .filter((n) => Number.isFinite(n) && n > 0);
const SIZES = args.length > 0 ? args : [1_000, 10_000, 100_000];

/** 每条记录的负载规模（模拟「记录里带一段 trace」的真实体积） */
const PAYLOAD_CHARS = Number(process.env.PAYLOAD_CHARS ?? 4000);
/** 外推用的 RTT 档（毫秒）：本机 loopback / 同机房 / 跨可用区 */
const RTTS = [0.1, 0.2, 1];

function rec(i: number, suspended: boolean): TaskRecord {
  const spec = {
    messages: [{ role: 'user' as const, content: 'x'.repeat(200) }],
    options: {},
    source: 'async' as const,
  };
  const base: TaskRecord = {
    taskId: `task_${String(i).padStart(6, '0')}`,
    status: suspended ? 'suspended' : 'succeeded',
    ...(suspended
      ? {
          suspendedReason: 'timer' as const,
          suspendedSince: Date.now() - 60_000,
          wakeAt: Date.now() + 3_600_000, // 未来 ⇒ 不该被唤醒的那一类
          pendingApprovals: ['tu1'],
          spec,
        }
      : { spec, finishedAt: Date.now() - 1_000 }),
    createdAt: Date.now() - 3_600_000,
  };
  // 明文负载：让「解析 N 条记录」这件事有真实的字节量（trace 那部分的替身）
  return { ...base, result: { finalText: 'y'.repeat(PAYLOAD_CHARS) } } as TaskRecord;
}

/**
 * 零延迟计数夹具：`get` / `keys` 都是同进程 Map 操作，**没有网络** ——
 * 于是「往返次数」是纯结构量，「耗时」只剩解析与排序（CPU）。
 */
class CountingRedis implements RedisLike {
  readonly map = new Map<string, string>();
  calls = { enum: 0, get: 0 };

  async get(key: string): Promise<string | null> {
    this.calls.get++;
    return this.map.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<unknown> {
    this.map.set(key, value);
    return 'OK';
  }

  async del(key: string): Promise<unknown> {
    return this.map.delete(key) ? 1 : 0;
  }

  async keys(pattern: string): Promise<string[]> {
    this.calls.enum++;
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    return [...this.map.keys()].filter((k) => k.startsWith(prefix));
  }
}

console.log('redis 侧到期索引：list() 的**形状**（往返次数 / 纯 CPU / 外推延迟）');
console.log(
  `口径：零延迟夹具（同进程 Map）⇒ 时间是 CPU（parse + 排序），不含网络；负载 ${PAYLOAD_CHARS} 字符/条；1/10 是 interrupted 挂起`,
);
console.log('');

for (const n of SIZES) {
  const fake = new CountingRedis();
  const store = new RedisTaskStore(fake);
  // 直接灌夹具的 map：N 次 SET 不是被测对象（save 是 O(1) 单键写）
  for (let i = 0; i < n; i++) {
    fake.map.set(`agentia:task:task_${i}`, JSON.stringify(rec(i, i % 10 === 0)));
  }
  const bytes = [...fake.map.values()].reduce((a, v) => a + v.length, 0);
  fake.calls = { enum: 0, get: 0 };

  const t0 = process.hrtime.bigint();
  const recs = await store.list();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  const trips = fake.calls.enum + fake.calls.get;
  console.log(
    `N=${n}  往返 ${trips}（keys ${fake.calls.enum} + GET ${fake.calls.get}）  解析 ${(bytes / 1048576).toFixed(1)} MB  纯 CPU ${ms.toFixed(1)} ms  读出 ${recs.length} 条`,
  );
  console.log(
    `      外推（往返 × RTT，**不含**上面那笔 CPU）：${RTTS.map((rtt) => `RTT ${rtt}ms → ${((trips * rtt) / 1000).toFixed(2)} s`).join('   ')}`,
  );
  const due = Math.ceil(n / 10);
  console.log(
    `      有索引的形状（辅助 ZSET，score = wakeAt）：ZRANGEBYSCORE 一次取到期 1 往返 + 每个到期记录 1 GET（${due} 条）⇒ 往返 ${1 + due}`,
  );
}

console.log('');
console.log('结论口径：往返次数是**结构量**（换实现能省掉的就是它）；延迟是外推 ——');
console.log(
  '这台机器没有 redis 服务，真读数需要一个本地实例（brew install redis / docker run redis）。',
);
