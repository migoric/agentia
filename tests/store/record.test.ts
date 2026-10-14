import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { FileTaskStore } from '../../src/store/fsStore.js';
import { SqliteTaskStore } from '../../src/store/sqliteStore.js';
import { RedisTaskStore } from '../../src/store/redisStore.js';
import type { RedisLike } from '../../src/store/redisStore.js';
import type { TaskRecord } from '../../src/store/store.js';
import { normalizeLegacyRecord, parseTaskRecord } from '../../src/store/record.js';

/**
 * 旧版本记录形状的**读时归一**（迁移垫片）。
 *
 * 为什么值得一个专门的文件：这类缺陷**不会**被类型检查拦住（`JSON.parse(raw) as TaskRecord` 里的
 * `as` 是对盘上数据的一句保证），也不会被任何一条「新记录」的用例拦住 —— 它只在**旧字节被新代码
 * 读回**的那一瞬间存在。所以本文件同时钉三件不同层次的东西：
 * ① 归一函数本身（纯，含阴性对照）；
 * ② 唯一入口的形状守卫（坏 JSON 照旧抛、非记录给 undefined）；
 * ③ **三条 store 的读回接缝**（文件 / SQLite / Redis）——一处漏了，那一处就是孤儿记录的生产者。
 */
const asRecord = (raw: Record<string, unknown>): TaskRecord => raw as unknown as TaskRecord;

let n = 0;
function rec(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: `task_${++n}`,
    status: 'queued',
    spec: { messages: [{ role: 'user', content: 'a' }] },
    createdAt: 1_000 + n,
    ...over,
  };
}

/**
 * 旧版本（2026-09-28 ref-suspend-state-reason 之前）落库的形状。
 *
 * ⚠️ 故意**不**标成 `TaskRecord`：那个状态值在现类型里根本不存在 —— 「这不是一条合法记录」
 * 正是本文件要对付的东西，用 `as TaskRecord` 一笔带过就等于把问题藏进夹具里。
 */
function legacyRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: `task_legacy_${++n}`,
    status: 'awaiting_approval',
    pendingApprovals: ['tu1'],
    approvalPendingSince: 1_700_000_000_000,
    spec: { messages: [{ role: 'user', content: '等审批' }] },
    createdAt: 1_600_000_000_000,
    ...over,
  };
}

function tmpFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agentia-legacy-'));
  return { dir, file: join(dir, 'tasks.jsonl') };
}

describe('normalizeLegacyRecord —— 旧记录的就地归一', () => {
  it('旧状态值 + 旧挂起时刻 ⇒ suspended + 原因 approval + 时刻搬过来、旧键删掉', () => {
    const before = legacyRecord();
    const r = asRecord(before);
    assert.equal(normalizeLegacyRecord(r), true, '动过了');
    assert.equal(r.status, 'suspended');
    assert.equal(
      r.suspendedReason,
      'approval',
      '原因必须**一起**补：两条闸（approvalExpired / approve）都按原因判',
    );
    assert.equal(
      r.suspendedSince,
      1_700_000_000_000,
      '挂起时刻搬过来（否则「已经等了 3 天」重新计时）',
    );
    assert.equal('approvalPendingSince' in r, false, '旧键必须删掉 —— 留着就是半新半旧的两个键');
    assert.deepEqual(r.pendingApprovals, ['tu1'], '其余字段原样');
    assert.notEqual(before.spec, undefined);
  });

  it('幂等：同一份记录再归一一次 ⇒ 什么都不动（返回 false）', () => {
    const r = asRecord(legacyRecord());
    assert.equal(normalizeLegacyRecord(r), true);
    const snapshot = JSON.stringify(r);
    assert.equal(normalizeLegacyRecord(r), false, '第二次应当无事可做');
    assert.equal(JSON.stringify(r), snapshot, '也不许改写任何字段');
  });

  it('阴性对照：新形状的记录一个字节都不动 —— 包括**缺原因**的那条（垫片不凭空补造）', () => {
    const ok = rec({ status: 'suspended', suspendedReason: 'approval', suspendedSince: 5 });
    assert.equal(normalizeLegacyRecord(ok), false);
    // 新形状但缺 suspendedReason：**不猜**。那是另一个缺陷（写出时丢了原因），
    // 垫片把它「补成 approval」等于替一个真实缺陷打掩护 —— 该红的地方要红。
    const noReason = rec({ status: 'suspended' });
    assert.equal(normalizeLegacyRecord(noReason), false);
    assert.equal(noReason.suspendedReason, undefined);
    // 非挂起的旧记录（例如 queued）同样不动
    const queued = rec();
    assert.equal(normalizeLegacyRecord(queued), false);
  });

  it('只有旧时刻字段（状态已是新值）⇒ 只搬时刻；两个键都在时保留新键、删掉旧键', () => {
    const onlySince = rec({ status: 'suspended', suspendedReason: 'approval' });
    (onlySince as unknown as Record<string, unknown>).approvalPendingSince = 42;
    assert.equal(normalizeLegacyRecord(onlySince), true);
    assert.equal(onlySince.suspendedSince, 42);
    assert.equal('approvalPendingSince' in onlySince, false);

    const both = rec({ status: 'suspended', suspendedReason: 'approval', suspendedSince: 7 });
    (both as unknown as Record<string, unknown>).approvalPendingSince = 42;
    assert.equal(normalizeLegacyRecord(both), true);
    assert.equal(both.suspendedSince, 7, '新键在场时以新键为准（旧键只是残留）');
    assert.equal('approvalPendingSince' in both, false);
  });
});

describe('parseTaskRecord —— 唯一入口的形状守卫', () => {
  it('正常记录原样返回；旧形状的记录经解析即已归一', () => {
    const fresh = rec();
    const parsed = parseTaskRecord(JSON.stringify(fresh));
    assert.equal(parsed?.taskId, fresh.taskId);
    assert.equal(parsed?.status, 'queued');

    const legacy = parseTaskRecord(JSON.stringify(legacyRecord()));
    assert.equal(legacy?.status, 'suspended');
    assert.equal(legacy?.suspendedReason, 'approval');
  });

  it('非记录（数组 / null / 数字 / 没有 taskId 的对象）⇒ undefined（「不是记录」≠「解析失败」）', () => {
    for (const raw of ['[]', 'null', '3', '"x"', '{}', '{"taskId":42}']) {
      assert.equal(parseTaskRecord(raw), undefined, `应当判成「不是记录」：${raw}`);
    }
  });

  it('坏 JSON 照旧**抛**（三条 store 对「坏了怎么办」的取舍各不相同，归一层不越权决定）', () => {
    assert.throws(() => parseTaskRecord('{ 半截'), SyntaxError);
  });
});

describe('读回接缝：三条 store 都必须归一（一处漏了就是孤儿记录的生产者）', () => {
  it('FileTaskStore：构造时读回即归一；盘上旧字面留到下一次 save（append-only 不回写）', () => {
    const { dir, file } = tmpFile();
    try {
      const writer = new FileTaskStore(file);
      const legacy = legacyRecord();
      writer.save(asRecord(legacy)); // 旧进程写下的那一行

      // 新进程读回（构造即 load）——这才是迁移真会发生的形态
      const reader = new FileTaskStore(file);
      const got = reader.get(String(legacy.taskId) as string);
      assert.equal(got?.status, 'suspended', '读回来必须是新形状');
      assert.equal(got?.suspendedReason, 'approval');
      assert.deepEqual(reader.list()[0]?.pendingApprovals, ['tu1']);

      // 诚实记下当前取舍：本 store 是 append-only 日志，**不**在读时回写 ⇒ 盘上那行字面仍是旧值。
      // 它不影响任何读（都归一遍），并且下一次 save 就会以新形状追加（last-wins 覆盖它）。
      assert.match(readFileSync(file, 'utf8'), /awaiting_approval/, '前提：盘上确实是旧字面');

      got!.status = 'running';
      reader.save(got!);
      const reloaded = new FileTaskStore(file);
      assert.equal(
        reloaded.get(String(legacy.taskId) as string)?.status,
        'running',
        'save 之后按新形状落盘',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('SqliteTaskStore：读回归一之外，还把 `status` **列**一并拉正（外部统计不再说谎）', () => {
    const { dir, file } = tmpFile();
    try {
      const store = new SqliteTaskStore(file);
      const legacy = legacyRecord();
      store.save(asRecord(legacy));

      const readColumn = (): string | undefined => {
        const db = new DatabaseSync(file);
        try {
          const row = db
            .prepare('SELECT status FROM tasks WHERE task_id = ?')
            .get(String(legacy.taskId)) as { status: string | null } | undefined;
          return row?.status ?? undefined;
        } finally {
          db.close();
        }
      };
      assert.equal(readColumn(), 'awaiting_approval', '前提：列里确实是旧值（否则证明不了自愈）');

      const got = store.get(String(legacy.taskId) as string);
      assert.equal(got?.status, 'suspended');
      assert.equal(got?.suspendedReason, 'approval');
      assert.equal(
        readColumn(),
        'suspended',
        '列必须被拉正 —— 只在读时归一 json，`GROUP BY status` 会继续报旧值',
      );

      // json 也回写成新形状（裸 json 读者 / json_extract 看到的是同一份事实）
      const db = new DatabaseSync(file);
      try {
        const row = db
          .prepare('SELECT json FROM tasks WHERE task_id = ?')
          .get(String(legacy.taskId)) as {
          json: string;
        };
        assert.equal(JSON.parse(row.json).status, 'suspended');
      } finally {
        db.close();
      }

      // list() 走同一条路（同一个自愈点）
      const second = legacyRecord();
      store.save(asRecord(second));
      assert.equal(
        store.list().find((r) => r.taskId === String(second.taskId))?.status,
        'suspended',
      );
      const db2 = new DatabaseSync(file);
      try {
        const row = db2
          .prepare('SELECT status FROM tasks WHERE task_id = ?')
          .get(String(second.taskId)) as { status: string };
        assert.equal(row.status, 'suspended', 'list() 也自愈了那一行');
      } finally {
        db2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('RedisTaskStore：单键读回来也是新形状', async () => {
    const fake = new FakeRedis();
    const store = new RedisTaskStore(fake, { prefix: 'test:' });
    const legacy = legacyRecord();
    await store.save(asRecord(legacy));
    const got = await store.get(String(legacy.taskId) as string);
    assert.equal(got?.status, 'suspended');
    assert.equal(got?.suspendedReason, 'approval');
    assert.equal(got?.suspendedSince, 1_700_000_000_000);
  });
});

/** 只实现单键读写的最小假客户端（list/clear 的 key 扫描在 redisStore.test.ts 里覆盖） */
class FakeRedis implements RedisLike {
  readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<string> {
    this.map.set(key, value);
    return 'OK';
  }
  async del(key: string): Promise<number> {
    return this.map.delete(key) ? 1 : 0;
  }
  async keys(pattern: string): Promise<string[]> {
    const re = new RegExp(
      `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '*' ? '.*' : `\\${c}`))}$`,
    );
    return [...this.map.keys()].filter((k) => re.test(k));
  }
  async *scanIterator(opts?: { MATCH?: string }): AsyncIterable<string> {
    for (const k of await this.keys(opts?.MATCH ?? '*')) yield k;
  }
}

describe('唯一入口守卫（静态）', () => {
  it('`src/store/*.ts` 里除 record.ts 外不得出现 JSON.parse —— 加第七个读回点必须走同一个入口', () => {
    const dir = fileURLToPath(new URL('../../src/store/', import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    // 抽词器下限：路径搬了 / 过滤条件退化成空集时，这条守卫会「真空变绿」
    assert.ok(files.length >= 5, `src/store 下应有 ≥5 个 .ts，实际 ${files.length}（路径变了？）`);
    const offenders = files
      .filter((f) => f !== 'record.ts')
      .filter((f) => readFileSync(join(dir, f), 'utf8').includes('JSON.parse'));
    assert.deepEqual(offenders, [], '这些文件绕过了唯一入口 ⇒ 读回来的旧记录不会被归一');
    // 阳性对照：入口自己**必须**在解析 —— 否则上面那句可能是靠「全仓都没有 JSON.parse」蒙对的
    assert.match(readFileSync(join(dir, 'record.ts'), 'utf8'), /JSON\.parse/);
  });
});
