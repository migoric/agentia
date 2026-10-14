/*
 * 「实测记分牌」的守卫 —— README 顶部那几个数字（2026-09-29，成熟度评审 P0-2）。
 *
 * ## 为什么需要它
 *
 * 本仓最锋利的差异化是「**安装面积极小 + 零运行时依赖**」——它正好回答外部检索里那条
 * 选型陷阱（「为了 50 行的问题上一个重型多层框架」，`star bias`）。可这个数字**一直没出现在
 * README 里**：`grep -nE "2\.7|1 个包" README.md` ⇒ 0 命中，README 里只有形容词「零依赖」。
 * **形容词不参与比较，数字才参与。**
 *
 * 但把数字写进 README 会立刻踩本仓的老病：**写死的读数会腐烂**（改对一次不够，追着改更贵）。
 * ⇒ 解法不是「不写数字」，而是**让数字可被机械复算**：本守卫现场把每个数字算出来，
 * 再断言 README 写的就是那个值。数字一漂，`npm test` 当场红。
 *
 * ## 四件刻意的事
 *
 * ① **给「会涨的数」用下限（`90+`）而不是精确值**：守卫条数只会随开发增加；写成 `94` 的话，
 *    每加一条守卫都要改 README —— 那种税会让人绕开守卫（本仓已知的失效模式）。
 *    下限是**可机械复算**的（`count >= 90`），且只在**掉下来**时咬人 —— 那才是真信号。
 *    而「不会涨」的不变量（0 依赖 / 1 个包 / ≈2 MB）用精确断言。
 * ② **`≈2 MB` 用「四舍五入到整数 MB」判定**，让数字**自带精度**：2.10 MB 与 2.31 MB 都是
 *    「≈2 MB」，涨到 2.6 MB 才红。写 `2.1 MB` 会因为每次几十 KB 的正常增长而红，那不是信号。
 * ③ **不把「§7 已知边界条数」搬上来**：那个数已经有专属守卫（`boundary-table.test.ts` 的
 *    行集合对拍 + 三处写死的读数断言）。在 README 再放一份 = 造**第二个会腐烂的副本**，
 *    而且两处口径必然分叉（§7 的首列是散文、归一化规则只为那张表定义）。
 * ④ **射程扩到 `docs/promotion.md`**（2026-09-29 ref-bench-numbers-public，评审 P1-2）：推广稿里写着「50+ invariants」，
 *    而 §1 实际是 90+ 条 ⇒ **自贬**，且是那种**没人会发现**的自贬（推广稿不是测试、没有门禁）。
 *    推广稿是最容易「抄一次就再也不更新」的文本（发完就没人回头核）⇒ 光改一次不够，一并纳入守卫。
 *    ⚠️ 只钉「守卫条数」这一个数：推广稿里其余数字（4 个装饰器 / Node 18+）是**结构性事实**，
 *    改了就是产品变了、不是腐烂 —— 把它们也钉住只会让文案改一个字就要改测试。
 *
 * ## 反向验证（2026-09-29，逐条摘掉，各恰好点名那条）
 *
 *   ① `README.md` 的 `90+ 条守卫` 改成 `80+` ⇒ 只红「中文 README」那条；
 *   ② `README.en.md` 的 `90+ guards` 改成 `80+` ⇒ 只红「英文 README」那条；
 *   ③ 把本文件的 `GUARDS_FLOOR` 抬到 `100` ⇒ 红自证那条**加**两份 README
 *      （同一次变异的两面：期望串里嵌着那个下限 —— 这不是冗余，是「下限真的在参与判定」）；
 *   ④ `README.md` 的 `≈2 MB` 改成 `≈9 MB` ⇒ 只红中文那条（英文串里的 MB 是独立字面量）；
 *   ⑤⑥⑦（射程扩到推广稿时补的）推广稿三处各改一处 ⇒ 每次只红「推广稿」那条。
 *   七条还原后 `sha256` 逐字节一致。
 *
 * ⚠️ ⑤ 的**第一版变异没咬住**，值得单独记：我在推广稿文件头加的那句说明**也写了同一个数字**，
 *    于是断言测的是「这个词还在这文件里」而不是「那句文案还写着它」—— 与 `stability.test.ts`
 *    那条「变异要摘干净」同源，只是这次污染源是我自己刚写的注释。⇒ 说明句改成**不写数字**：
 *    多写一处就多一处要同步，而它恰恰是会被守卫点名的字面量。
 *
 * ## 射程（刻意不做的部分）
 *
 * 守卫只钉**这几个数字的对外一致性**，不评价记分牌该不该放、放在哪、措辞好不好。
 * 它防的是「数字腐烂」，不是「排版不好」。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');

/** 记分牌上的「会涨的数」用的下限 —— 与 README 里那串字面量是同一件事，改一处必须改两处 */
const GUARDS_FLOOR = 90;

/** 从 `## <标题>` 抠到下一个同级标题（或文末）。找不到就抛，别返回空串让断言静默通过 */
function section(md: string, headingPrefix: string): string {
  const start = md.indexOf(headingPrefix);
  assert.notEqual(start, -1, `找不到标题「${headingPrefix}」—— 守卫的解析锚点没了`);
  return md.slice(start + headingPrefix.length);
}

// ───────────────────────── 现算：安装面积 ─────────────────────────

/** 运行时依赖数（`dependencies` 才是运行时 —— peer / optional 不算，本仓也一个都没有） */
function runtimeDependencies(): string[] {
  const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string> };
  return Object.keys(pkg.dependencies ?? {});
}

/**
 * 装一个 `@migor/agentia` 会往 `node_modules` 里放几个包 —— 零运行时依赖 ⇒ 就它自己一个。
 * ⚠️ 这是**由 `dependencies` 推出**的，不是数盘上的 `node_modules`（那是全仓 devDeps，
 * 与「使用者的安装面积」是两回事 —— 这个区分错了，记分牌就会变成一句假话）。
 */
function installedPackages(): number {
  return 1 + runtimeDependencies().length;
}

/**
 * 发布产物解包后多大（MB，四舍五入到整数）。
 *
 * 用它而不是 `du -sh node_modules`：后者受文件系统块分配影响（333 个文件每个至少占一块），
 * 报出来偏大且随机器变；`npm pack` 的 `unpackedSize` 是 **npm 自己在 npm 页上显示的那个数**，
 * 也是与竞品可比的口径。
 *
 * ⚠️ 量的是**盘上当前的 `dist`**：没构建过就会量到一个空包。所以先断言 `dist/index.js` 在场，
 * 并把「先跑 `npm run build`」写进失败信息 —— 否则读者会以为记分牌写错了。
 *
 * ⚠️ 为什么用 `npm pack` 而不是自己遍历 `dist` 把字节加起来（实测过）：自己数**能**得到
 * 1.86 MB + CHANGELOG ≈ 2.08 MB，与 npm 的 2.10 MB 差 ~1.5%（npm 还会捎上 package.json /
 * README / LICENSE）。差这一点点对「≈2 MB」无所谓，但**自己复刻 npm 的选文件规则**
 * （`files` + `.npmignore`/`.gitignore` 的交互）是一件会静默失准的事 —— 权威值就一个来源，
 * 拿它。代价是 `npm pack` 在本机约 11s（I/O 为主，`--offline` / 关 notifier 都压不动），
 * 所以下面**记忆化**：整轮只真跑一次。
 */
let sizeCache: number | undefined;
function packageSizeMb(): number {
  if (sizeCache !== undefined) return sizeCache;
  assert.ok(
    existsSync(join(repoRoot, 'dist/index.js')),
    'dist/index.js 不在场 —— 量不了发布体积。先跑 `npm run build`（记分牌量的是**发布产物**）',
  );
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    // npm 会在 JSON 之前吐 notice / warn：从第一个 `[` 开始解析，别要求整段都是 JSON
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const start = out.indexOf('[');
  assert.notEqual(start, -1, `npm pack --dry-run --json 没吐出 JSON：${out.slice(0, 200)}`);
  const entries = JSON.parse(out.slice(start)) as Array<{ unpackedSize?: number }>;
  const bytes = entries[0]?.unpackedSize;
  assert.ok(bytes, 'npm pack 的输出里读不到 unpackedSize —— 解析锚点坏了（npm 换过字段名吗）');
  const mb = bytes / 1024 / 1024;
  assert.ok(
    mb >= 1,
    `解包体积只算到 ${mb.toFixed(2)} MB —— 大概率 dist 是空的（先 npm run build）`,
  );
  sizeCache = Math.round(mb);
  return sizeCache;
}

/** `docs/guards.md` §1「已挂守卫」的表行数（每行一条守卫） */
function guardCount(): number {
  const seg = section(read('docs/guards.md'), '\n## 1.').split('\n## 2.')[0];
  return seg.split('\n').filter((l) => /^\|\s*[`"]/.test(l)).length;
}

// ───────────────────────── 断言：README（中 / 英）与现算值一致 ─────────────────────────

describe('README 顶部的实测记分牌：每个数字都可被脚本现算', () => {
  it('现算器本身没有退化（防「扫了个空」的假绿）', () => {
    assert.equal(runtimeDependencies().length, 0, '运行时依赖不再是 0 —— 记分牌那句要重写');
    assert.equal(installedPackages(), 1, '安装包数不再是 1 —— 记分牌那句要重写');
    const guards = guardCount();
    assert.ok(
      guards >= GUARDS_FLOOR,
      `§1 只数到 ${guards} 条守卫（下限 ${GUARDS_FLOOR}）—— 解析锚点坏了，或者守卫真被删了`,
    );
  });

  it('中文 README 顶部那行 == 现算值', () => {
    const mb = packageSizeMb();
    const expect = `**${installedPackages()} 个包 · ≈${mb} MB · 0 运行时依赖 · ${GUARDS_FLOOR}+ 条守卫**`;
    assert.ok(
      read('README.md').includes(expect),
      `README.md 顶部缺这行（或数字已经腐烂）：\n  ${expect}\n` +
        '数字一律现算，别手改文案 —— 命令：npm pack --dry-run --json / 数 docs/guards.md §1 的表行',
    );
  });

  it('英文 README 顶部那行 == 现算值（两份 README 不许各说各话）', () => {
    const mb = packageSizeMb();
    const expect = `**${installedPackages()} package · ≈${mb} MB · 0 runtime dependencies · ${GUARDS_FLOOR}+ guards**`;
    assert.ok(
      read('README.en.md').includes(expect),
      `README.en.md 顶部缺这行（或数字已经腐烂）：\n  ${expect}`,
    );
  });

  /**
   * `docs/promotion.md` 是**第四个写这个数的地方**（2026-09-29 评审 P1-2 补的）。
   *
   * 它此前写的是 `50+`，而 §1 实际有 90+ 条 —— **自贬**，而且是那种没人会发现的自贬
   * （推广稿不是测试，没有门禁）。⇒ 改成与记分牌同源的下限，并**一并纳入本守卫**：
   * 推广稿是最容易「抄一次就再也不更新」的那种文本（发完就没人回头核），光改一次不够。
   *
   * ⚠️ 只钉「守卫条数」这一个数：推广稿里其余数字（4 个装饰器 / Node 18+）是**结构性事实**，
   * 改了就是产品变了，不是腐烂 —— 把它们也钉住只会让文案改一个字就要改测试。
   */
  it('docs/promotion.md 里的守卫条数 == 同一个下限（推广稿最容易抄一次就再也不更新）', () => {
    const promo = read('docs/promotion.md');
    for (const needle of [
      `${GUARDS_FLOOR}+ invariants`,
      `${GUARDS_FLOOR}+ registered invariants`,
      `${GUARDS_FLOOR}+ 条守卫`,
    ]) {
      assert.ok(
        promo.includes(needle),
        `docs/promotion.md 里找不到「${needle}」—— 推广稿与记分牌各说各话了。\n` +
          `  §1 现算 ${guardCount()} 条；下限是 ${GUARDS_FLOOR}。\n` +
          '  这个数以前写的是 50+（自贬且没人会发现）⇒ 改数时改这里，别改下限。',
      );
    }
  });
});
