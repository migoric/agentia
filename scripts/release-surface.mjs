/**
 * 发布面清单 —— 「一次发版要动哪些文件的哪个值」的**唯一真源**。
 *
 * 为什么需要它：发版面不是「两个 package.json」。真实的一次 bump 动了 **17 个文件**，而
 * 仓库文档里曾写「bump 四处」—— 漏掉的那些（`examples/` 的 pin、issue 模板的版本占位、
 * 官网对渲染器的精确 pin、`package-lock.json` 的 version 字段）每一处都是
 * 「使用者拿到错东西」的漏点。历史教训：`^旧版` 这种 pin 只改了 README、没改 Dockerfile
 * 注释，示例就再也装不上；lock 的 version 被整轮跳过而全链全绿。
 *
 * 两个消费者：
 *   - `scripts/check-release.mjs` —— 发布闸门（挂两包 `prepublishOnly`）：逐项断言「== 包版本」
 *   - `scripts/release.mjs`       —— `bump`：逐项替换，每项都带**计数断言**；计数不符即中止，
 *     且**一个字节都不写盘**（先算完全部文件的新内容，再统一落盘）
 *
 * ⚠️ 不要把它换成「全仓 grep 旧版本号再替换」：版本号也活在**历史**里（CHANGELOG 旧条目、
 *    `spec.md` §10 决策记录、`AGENTS.md` 的轶事）与**第三方规格**里（lock 内嵌依赖的
 *    `"node": "^8.16.0 || ^10.6.0"`）。全仓替换会把这些历史改坏。所以这里是逐项白名单。
 *
 * 每项的形状：
 *   file     相对仓库根
 *   pattern  带捕获组的正则（**只捕获版本号本身**）；一个匹配里所有捕获组必须都等于版本号
 *            才算命中 —— 这正是 lock 那种「同文件里还有几百个第三方版本号」的过滤方式
 *   count    期望命中数。少于它是「漏改」，多于它是「有不认识的东西也叫这个版本号」，
 *            两种都不该让发版继续
 *   why      这一项漏了会怎样 —— 出错信息里原样打给操作者
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const REPO = 'migoric/agentia';

export const SURFACES = [
  {
    file: 'package.json',
    pattern: /"version": "(\d+\.\d+\.\d+)"/g,
    count: 1,
    why: '发布版本唯一真源',
  },
  {
    file: 'packages/cli/package.json',
    pattern: /"version": "(\d+\.\d+\.\d+)"/g,
    count: 1,
    why: '两包版本必须同步（AGENTS.md 硬约定）',
  },
  {
    file: 'packages/trace-view/package.json',
    pattern: /"version": "(\d+\.\d+\.\d+)"/g,
    count: 1,
    why: 'workspace 内版本一致（不单独发布，构建期拷进 CLI 的 dist/inspector）',
  },
  {
    file: 'packages/website/package.json',
    pattern: /"@migor\/trace-view": "(\d+\.\d+\.\d+)"/g,
    count: 1,
    why: '官网 playground 用的渲染器版本（**精确 pin**，不是 ^）',
    // ⚠️ website 自己的 "version" 是 `0.0.0` 且**有意不动**（官网不进发版），所以这里只钉这一条 pin。
  },
  {
    file: 'src/index.ts',
    pattern: /AGENTIA_VERSION = '(\d+\.\d+\.\d+)'/g,
    count: 1,
    why: '使用者能读到的框架版本（漏 bump 就对外谎报旧版）',
  },
  {
    file: 'packages/cli/templates/package.json',
    pattern: /"@migor\/agentia": "\^(\d+\.\d+\.\d+)"/g,
    count: 1,
    why: '脚手架生成的新项目装到的框架版本（漏 bump 则新项目装旧框架）',
  },
  {
    file: 'packages/cli/templates/package.json',
    pattern: /"@migor\/cli": "\^(\d+\.\d+\.\d+)"/g,
    count: 1,
    why: '脚手架装进新项目的 CLI 版本（漏 bump 则新项目 pin 着旧 CLI，与框架版本漂开）',
  },
  {
    file: '.github/ISSUE_TEMPLATE/bug_report.yml',
    pattern: /placeholder: '(\d+\.\d+\.\d+)'/g,
    count: 1,
    why: 'issue 模板的版本占位（`.yml`，任何按扩展名过滤的扫描都扫不到）',
  },
  {
    file: 'README.md',
    pattern: /> \*\*版本\*\*：`(\d+\.\d+\.\d+)`/g,
    count: 1,
    why: 'README 版本行（对外「已发布」声明）',
  },
  {
    file: 'docs/roadmap.md',
    pattern: /状态：v(\d+\.\d+\.\d+) 已发布/g,
    count: 1,
    why: 'roadmap 状态行',
  },
  {
    file: 'docs/spec.md',
    pattern: /`AGENTIA_VERSION = '(\d+\.\d+\.\d+)'`/g,
    count: 1,
    why: 'spec §11 发布进度链尾部的常量',
  },
  {
    file: 'CHANGELOG.md',
    pattern:
      /^\[Unreleased\]: https:\/\/github\.com\/migoric\/agentia\/compare\/v(\d+\.\d+\.\d+)\.\.\.HEAD$/gm,
    count: 1,
    why: 'CHANGELOG 的 compare 基线（旧基线 = 链接里那个版本）',
  },
  {
    file: 'examples/README.md',
    pattern: /\^(\d+\.\d+\.\d+)/g,
    count: 1,
    why: '示例 README 的「改用发布版」pin',
  },
  {
    file: 'examples/complete/Dockerfile',
    pattern: /\^(\d+\.\d+\.\d+)/g,
    count: 1,
    why: 'Dockerfile 注释里的 pin（构建上下文凭它退回常规单包写法）',
  },
  {
    file: 'examples/complete/README.md',
    pattern: /\^(\d+\.\d+\.\d+)/g,
    count: 2,
    why: '示例 README 的 pin（正文 + Docker 段各一处）',
  },
  {
    file: 'examples/deploy/Dockerfile',
    pattern: /\^(\d+\.\d+\.\d+)/g,
    count: 1,
    why: 'Dockerfile 注释里的 pin',
  },
  {
    file: 'examples/deploy/README.md',
    pattern: /\^(\d+\.\d+\.\d+)/g,
    count: 1,
    why: '示例 README 的 pin（「与 agentia create 脚手架模板一致」那句）',
  },
  {
    file: 'package-lock.json',
    // ⚠️ **按包名锚定**，不要退回裸 `"version"` 计数：那种写法会被**恰好同版本号的第三方依赖**
    // 撞上 —— 真发生过：`@grpc/proto-loader` 恰好 @0.8.1，发布 0.8.1 时闸门报「4 处应为 0.8.1，
    // 实际命中 5 处」，读起来像清单漏项。锚定后 4 处各带自己的包名，第三方版本再撞也不进网
    // （`@migor/website` 是 `private: true`、版本恒 0.0.0，本就不在网里 —— 它不出现在下面的
    // 备选里是有意的）。
    pattern: /"name": "@migor\/(?:agentia|cli|trace-view)",\n\s+"version": "(\d+\.\d+\.\d+)"/g,
    count: 4,
    why: 'lock 的 4 个 version 字段（顶层 + 根 + packages/cli + packages/trace-view）—— 手改 manifest 却漏 lock 真的发生过；按包名锚定防同版本第三方依赖撞网',
  },
  {
    file: 'package-lock.json',
    pattern: /"@migor\/trace-view": "(\d+\.\d+\.\d+)"/g,
    count: 1,
    why: 'lock 里官网对渲染器的精确 pin',
  },
];

/** 正则元字符转义（版本号进正则前过一遍）。 */
export const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 取出 CHANGELOG 里某一版的段落：`{ at, head, body }`；找不到返回 null。
 * `head` 是段头行（`## [x.y.z] - YYYY-MM-DD`），`body` 是到下一个 `## [` 之前的正文。
 * 闸门（要求本版有条目）与 tag 消息生成（正文直接进 tag annotation）共用这一份，
 * 免得「闸门认一种格式、消息生成认另一种」。
 */
export function changelogSection(text, version) {
  const at = text.search(new RegExp(`^## \\[${esc(version)}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'));
  if (at < 0) return null;
  const rest = text.slice(at);
  const nl = rest.indexOf('\n');
  const head = rest.slice(0, nl);
  const after = rest.slice(nl + 1);
  const next = after.indexOf('\n## [');
  return { at, head, body: (next < 0 ? after : after.slice(0, next)).trim() };
}

/**
 * 结构要求 —— 这些不是「替换旧值」，而是「本版**必须新增**的东西」，所以只在闸门里查，
 * 不能靠替换产生。每项 `test(text, version)` 返回问题字符串或 null。
 */
export const STRUCTURAL = [
  {
    file: 'CHANGELOG.md',
    why: '本版必须有 CHANGELOG 条目（使用者靠它知道本版改了什么、要不要升）',
    test(text, v) {
      const sec = changelogSection(text, v);
      if (!sec) return `找不到 \`## [${v}] - YYYY-MM-DD\` 这一节`;
      // ⚠️ 锚必须是 bump 插的**那串**骨架标记（`TODO(发版)：写本版变更…`），不能是裸 `TODO`：
      // v0.10.0 那一节正文里合法地写着「十二、发版流程文档里的两个必填 TODO、四步顺序」——
      // 裸 `TODO` 判据会把它判成「骨架没填」，把已经写完的版本节当场拦下来（真实发生过）。
      // bump 的骨架集中生成于 release.mjs 的 INSERT_OPS，标记永远带 `(发版)`。
      if (sec.body.includes('TODO(发版)')) {
        return `\`[${v}]\` 一节还是 bump 时插的骨架（含 TODO(发版)）—— 把本版变更与迁移口径写进去`;
      }
      // 去掉标题行与空行之后，正文不该是空的（防「有节无内容」）
      const prose = sec.body
        .split('\n')
        .filter((l) => l.trim() && !l.trim().startsWith('#'))
        .join('\n')
        .trim();
      if (prose.length < 30) return `\`[${v}]\` 一节内容过短（${prose.length} 字符）—— 像是没写`;
      return null;
    },
  },
  {
    file: 'CHANGELOG.md',
    why: '本版要有链接引用（块底部），否则版本号在渲染后变成死文本',
    test(text, v) {
      const re = new RegExp(
        `^\\[${esc(v)}\\]: https://github\\.com/${REPO}/releases/tag/v${esc(v)}$`,
        'm',
      );
      return re.test(text) ? null : `链接块里缺 \`[${v}]: …/releases/tag/v${v}\``;
    },
  },
  {
    file: 'docs/spec.md',
    why: 'spec §11 的发布进度链要接上本版（这是「发布史」的仓库内版本）',
    test(text, v) {
      const re = new RegExp(`→ v${esc(v)}（`);
      return re.test(text) ? null : `§11 的进度链里没有 \`→ v${v}（…）\` 这一段`;
    },
  },
];

/** 读某个发布面文件的当前内容。 */
export function readSurface(root, file) {
  return readFileSync(join(root, file), 'utf8');
}

/**
 * 闸门本体：逐项断言发布面 == `version`。
 * 返回 `{ problems, warnings }`（messages 已带文件与「漏了会怎样」）。
 * `allowPending` 把 CHANGELOG 正文未填降级为警告（`release.mjs bump` 刚跑完时是这种状态）。
 */
export function checkSurfaces(root, version, { allowPending = false } = {}) {
  const problems = [];
  const warnings = [];
  const cache = new Map();
  const text = (file) => {
    if (!cache.has(file)) cache.set(file, readSurface(root, file));
    return cache.get(file);
  };

  for (const s of SURFACES) {
    const t = text(s.file);
    const all = [...t.matchAll(s.pattern)];
    const hits = all.filter((m) => m.slice(1).every((g) => g === version));
    if (hits.length === s.count) continue;
    const seen = [...new Set(all.flatMap((m) => m.slice(1)))].join(' / ') || '（无匹配）';
    const detail =
      all.length === 0
        ? '这一项在整个文件里找不到（模式无匹配）'
        : `${s.count} 处应为 ${version}，实际命中 ${hits.length} 处；文件里出现的是 ${seen}`;
    problems.push(`${s.file}：${s.why} —— ${detail}`);
  }

  for (const c of STRUCTURAL) {
    const msg = c.test(text(c.file), version);
    if (!msg) continue;
    const line = `${c.file}：${c.why} —— ${msg}`;
    // 同上：`--allow-pending` 只放「骨架未填」这种情况，普通提到 TODO 的正文不算 pending
    if (allowPending && c.file === 'CHANGELOG.md' && msg.includes('TODO(发版)'))
      warnings.push(line);
    else problems.push(line);
  }

  return { problems, warnings };
}

/** 版本号比较（a<b ⇒ 负数）。只认 x.y.z 三段。 */
export function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

export const isSemver = (s) => /^\d+\.\d+\.\d+$/.test(s);

// ── CLI：清单本身可查询（`--json` 给测试 / 工具用，默认打表格给人看）──
if (process.argv[1]?.endsWith('release-surface.mjs')) {
  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          surfaces: SURFACES.map((s) => ({
            file: s.file,
            count: s.count,
            why: s.why,
            pattern: s.pattern.source,
            flags: s.pattern.flags,
          })),
          structural: STRUCTURAL.map((s) => ({ file: s.file, why: s.why })),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`发布面清单：${SURFACES.length} 项替换面 + ${STRUCTURAL.length} 项结构面\n`);
    for (const s of SURFACES) console.log(`  ${s.file.padEnd(40)} ×${s.count}  ${s.why}`);
    for (const s of STRUCTURAL) console.log(`  ${s.file.padEnd(40)} 结构  ${s.why}`);
    console.log(
      '\n闸门：node scripts/check-release.mjs      bump：node scripts/release.mjs bump <x.y.z>',
    );
  }
}
