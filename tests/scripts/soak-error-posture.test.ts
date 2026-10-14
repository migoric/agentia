import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_TYPES } from '../../src/engine/errors.js';
import {
  POSTURE_TYPES,
  SOAK_ERROR_POSTURE,
  soakErrorVerdict,
  tallyByType,
} from '../../scripts/soak-error-posture.js';

/**
 * soak 的**错误分类判据**（`scripts/soak-error-posture.ts`）—— 2026-09-29 ref-soak-error-taxonomy。
 *
 * 为什么这些断言值得存在：这轮 2 小时的 soak **整轮红了**，红的却不是被测的代码 ——
 * 是判据本体内手写的一份三名字白名单（`api` / `server` / `rate_limit`）漏了框架自己的
 * 合法类 `connection`，而 719 万 run 里它只出现 **1 次**（默认 60s 跑法永远撞不到）。
 * 所以本文件守的是两件事：
 *   ① **穷尽**：类别清单是单源（`ERROR_TYPES`），处置表用 `Record<ErrorType, …>` ——
 *      加一类不表态 ⇒ **`typecheck:tests`** 报 `TS2741`（编译期；⚠️ 不是 `typecheck`：
 *      `scripts/` 不在根 `tsconfig.json` 的 include 里。这条命令写错过一次，当场表现为
 *      「变异没咬人」的假绿 —— 见 `soak-error-posture.ts` 头注），本文件负责运行期那一半：双向一一对应；
 *   ② **不静默**：表里没有的类别一律判 `hard-red`（宁可响），且「允许」的那些会被
 *      **分类计数打印出来**（允许 ≠ 不看）。
 *
 * ⚠️ 本文件**不跑 soak 本体**（那要 60s 起步、调参后 2 小时）：就是把纯件拿出来单测，
 * 这样判据以后不用烧 2 小时才验得动。
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOAK_SOURCE = readFileSync(resolve(REPO_ROOT, 'scripts/e2e-soak.ts'), 'utf8');

describe('soak 的错误分类处置表', () => {
  it('表与 ERROR_TYPES **双向**一一对应（漏一类由 typecheck 抓，多一类由这里抓）', () => {
    const keys = Object.keys(SOAK_ERROR_POSTURE);
    assert.equal(keys.length, ERROR_TYPES.length, '表里的条目数与 ERROR_TYPES 不等');
    for (const t of ERROR_TYPES) {
      assert.ok(keys.includes(t), `ERROR_TYPES 里的 '${t}' 在处置表里没有表态`);
    }
    // 反向：表里不许有 ERROR_TYPES 之外的键（`as` 断言写错、或类别被改名后的残留）
    for (const k of keys) {
      assert.ok(
        (ERROR_TYPES as readonly string[]).includes(k),
        `处置表里的 '${k}' 不在 ERROR_TYPES 里 —— 分类器永远不会产出它`,
      );
    }
    assert.deepEqual(POSTURE_TYPES, ERROR_TYPES, 'POSTURE_TYPES 必须是 ERROR_TYPES 同一个源');
  });

  it('逐类驱动：soakErrorVerdict 的答案与表里的表态一致（防实现与表各说各话）', () => {
    for (const t of ERROR_TYPES) {
      assert.equal(soakErrorVerdict(t), SOAK_ERROR_POSTURE[t].posture, t);
    }
  });

  it('点名 hard-red 的四个方向：unknown / aborted / timeout / **表外一切**', () => {
    // `unknown` 是这条断言**原本想抓的东西**（分类器失手）
    assert.equal(soakErrorVerdict('unknown'), 'hard-red');
    // 这套跑法里没人取消任何 run ⇒ 出现 aborted 只能是别处把 run 掐了
    assert.equal(soakErrorVerdict('aborted'), 'hard-red');
    // 本地假端点毫秒级应答 + 适配器无默认超时 ⇒ 真超时是有信息量的事件
    assert.equal(soakErrorVerdict('timeout'), 'hard-red');
    // 表外一律红：拼错的、大小写不同的、契约破裂时 push 的 `THROWN:` 前缀、空串
    for (const bogus of ['connexion', 'Unknown', 'UNKNOWN', 'THROWN:boom', '']) {
      assert.equal(soakErrorVerdict(bogus), 'hard-red', `'${bogus}' 必须判红`);
    }
  });

  it('回归钉：`connection` 必须是 expected（2026-09-29 那轮红的就是它）', () => {
    // 这条用例的存在理由：`connection` 是框架的**合法**类（`errors.ts` 的 ERROR_TYPES 成员，
    // 判据是 errno 那些码 + 带 cause 的 TypeError），而 soak 自己的截断注入本来就会产生它。
    // 当初漏掉它不是「代码坏了」，是「手写清单没跟上类型」—— 所以这里钉住它被表过态。
    assert.equal(soakErrorVerdict('connection'), 'expected');
    assert.match(SOAK_ERROR_POSTURE.connection.why, /719\s?万|719|719万|1 次/);
    // 注入的四个类别都是 expected（数量受 ① 那条逐笔对账的 slack 约束，不是「不管」）
    for (const t of ['api', 'server', 'rate_limit'] as const) {
      assert.equal(soakErrorVerdict(t), 'expected', t);
    }
  });

  it('每条表态都必须写清**为什么**（加一类不解释 ⇒ 这里红）', () => {
    for (const t of ERROR_TYPES) {
      const why = SOAK_ERROR_POSTURE[t].why;
      assert.ok(why.length > 10, `'${t}' 的 why 太短（等于没表态）：${JSON.stringify(why)}`);
    }
  });

  it('防真空：两个方向都有条目，且类别数不少于已知的 7', () => {
    assert.ok(ERROR_TYPES.length >= 7, `类别只有 ${ERROR_TYPES.length} 个 —— 清单被削了？`);
    const postures = Object.values(SOAK_ERROR_POSTURE).map((r) => r.posture);
    assert.ok(postures.includes('expected'), '没有任何 expected ⇒ 表被一刀切成全红');
    assert.ok(postures.includes('hard-red'), '没有任何 hard-red ⇒ 判据失去牙齿');
    assert.ok(
      Object.values(SOAK_ERROR_POSTURE).every(
        (r) => r.posture === 'expected' || r.posture === 'hard-red',
      ),
      '出现了第三种处置 —— 消费方（soak 的 if 判断）不认它',
    );
  });

  it('tallyByType：分类计数按次数降序、同次数按名字（打印那一行的形状）', () => {
    assert.deepEqual(tallyByType([]), []);
    assert.deepEqual(tallyByType(['api', 'api', 'connection', 'api', 'connection']), [
      ['api', 3],
      ['connection', 2],
    ]);
    // 同次数按名字（稳定性不靠 Map 的插入序 —— 否则打印行会随扫描顺序抖）
    assert.deepEqual(tallyByType(['server', 'api']), [
      ['api', 1],
      ['server', 1],
    ]);
  });

  it('源码级：soak 本体不再手写白名单，且真的消费这张表', () => {
    // 判据「在哪表态」这件事一旦被改回去（又出现一份手写清单），这里红。
    assert.ok(
      !SOAK_SOURCE.includes("['api', 'server', 'rate_limit']"),
      'e2e-soak.ts 里又出现了手写的三名字白名单 —— 表态只许在 soak-error-posture.ts',
    );
    assert.ok(
      SOAK_SOURCE.includes('soakErrorVerdict('),
      'e2e-soak.ts 没有消费 soakErrorVerdict —— 判据与表脱钩了',
    );
    assert.ok(
      SOAK_SOURCE.includes('tallyByType('),
      'e2e-soak.ts 没有把分类计数打印出来 —— 「允许」的那几类必须看得见',
    );
    assert.ok(
      SOAK_SOURCE.includes('import { POSTURE_TYPES, soakErrorVerdict, tallyByType }'),
      '导入行变了 —— 上面两条断言可能靠别的路径蒙对',
    );
  });

  it('承重条件：`scripts/` 必须在 typecheck:tests 的射程里（否则编译期护栏会无声消失）', () => {
    // 这张表的编译期护栏（`TS2741`）只在「`scripts/` 被 tsc 编译」时存在，而提供射程的是
    // `tsconfig.tests.json` 的 include。两条都钉住：
    //   ① tests 的 include 里必须有 `scripts` —— 被拿掉不是「少跑一个命令」，是「这张表再没人守」；
    //   ② 根的 include 里**只有 `src`** —— 这正是文档里必须写 `typecheck:tests` 的原因
    //      （第一次跑变异就是拿 `typecheck` 验的 ⇒ 假绿，见 soak-error-posture.ts 头注）。
    const includeOf = (file: string): string[] => {
      const raw = JSON.parse(readFileSync(resolve(REPO_ROOT, file), 'utf8')) as {
        include?: string[];
      };
      return raw.include ?? [];
    };
    assert.ok(
      includeOf('tsconfig.tests.json').includes('scripts'),
      'tsconfig.tests.json 不再 include scripts ⇒ SOAK_ERROR_POSTURE 的 TS2741 护栏消失',
    );
    assert.deepEqual(
      includeOf('tsconfig.json'),
      ['src'],
      '根 tsconfig 的 include 变了 —— 若 scripts 进了它，本文件与 soak-error-posture.ts 的注释要一起改',
    );
  });
});
