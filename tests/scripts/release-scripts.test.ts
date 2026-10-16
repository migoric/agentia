/**
 * 发版工具的守卫测试。
 *
 * 为什么值得单独测：`scripts/release.mjs bump` 会一口气重写十几个文件，而它唯一的护栏就是
 * 「每项替换的计数断言」。护栏失灵一次的代价是**仓库被写坏**（而且是发版那天才发现），
 * 所以这里钉的就是护栏本身：
 *   1. 计数不符 ⇒ 中止，且**一个字节都不写盘**（用 `git status --porcelain` 为空来证明）
 *   2. 版本号只能往前走
 *   3. 替换后每个面都真的变成了新版本（含 lock 那种「同文件里还有几百个第三方版本号」的过滤）
 *   4. 闸门能逐项点出不同步的那一个面
 *
 * 夹具是**合成的**（不是当前树的快照）：这样本测试不依赖「此刻仓库正好自洽」——
 * 未发布窗口内 `AGENTIA_VERSION` 有意落后 package.json，那时快照夹具会假红。
 * 夹具的文件清单向 `release-surface.mjs --json` 要（清单是单源，测试不复制它的知识）；
 * 每个面的**内容**在下面手写 —— 形状必须与清单的正则一致，清单加了新面就要在这里补一条，
 * 漏补会当场失败（见 FIXTURE 完整性那条断言）。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = ['release-surface.mjs', 'check-release.mjs', 'release.mjs'];

interface Surface {
  file: string;
  count: number;
  why: string;
  pattern: string;
  flags: string;
}
const manifest: { surfaces: Surface[]; structural: { file: string; why: string }[] } = JSON.parse(
  spawnSync('node', [join(repoRoot, 'scripts/release-surface.mjs'), '--json'], {
    encoding: 'utf8',
  }).stdout,
);

const V0 = '1.0.0';
const V1 = '1.1.0';

/** 夹具内容：键必须覆盖清单里的每个 file，形状必须匹配该面的正则。 */
const FIXTURE: Record<string, string> = {
  'package.json': `{\n  "name": "@migor/agentia",\n  "version": "${V0}"\n}\n`,
  'packages/cli/package.json': `{\n  "name": "@migor/cli",\n  "version": "${V0}"\n}\n`,
  'packages/trace-view/package.json': `{\n  "name": "@migor/trace-view",\n  "version": "${V0}",\n  "private": true\n}\n`,
  'packages/website/package.json': `{\n  "name": "@migor/website",\n  "version": "0.0.0",\n  "dependencies": {\n    "@migor/trace-view": "${V0}"\n  }\n}\n`,
  'src/index.ts': `export const AGENTIA_VERSION = '${V0}';\n`,
  // 脚手架模板里有**两条**版本面：框架 pin 与 CLI pin（CLI 也装进新工程）。
  // 两面各 count:1 —— 只写一条会被 bump 的计数断言拦下（这正是它该有的反应）。
  'packages/cli/templates/package.json':
    `{\n  "dependencies": { "@migor/agentia": "^${V0}" },\n` +
    `  "devDependencies": { "@migor/cli": "^${V0}" }\n}\n`,
  '.github/ISSUE_TEMPLATE/bug_report.yml': `body:\n  - attributes:\n      placeholder: '${V0}'\n`,
  'README.md': `> **版本**：\`${V0}\`（两个包均已发布到 npm）。\n`,
  'docs/roadmap.md': `# Roadmap\n\n状态：v${V0} 已发布（框架 + CLI）。\n`,
  'docs/spec.md':
    `## 11. 开放项\n\n- 发布进度：v0.9.0（上一版）→ v${V0}（夹具初始态）；\n` +
    `  \`AGENTIA_VERSION = '${V0}'\`。决策均见 §10。\n`,
  'CHANGELOG.md':
    '# Changelog\n\n按 Keep a Changelog。\n\n' +
    `## [${V0}] - 2026-01-01\n\n### 变更\n\n` +
    '- 夹具初始态：这一节的正文足够长，好让「内容过短」那条结构要求也通过。\n\n' +
    `[Unreleased]: https://github.com/migoric/agentia/compare/v${V0}...HEAD\n` +
    `[${V0}]: https://github.com/migoric/agentia/releases/tag/v${V0}\n`,
  'examples/README.md': `用发布版就把这行换成 "@migor/agentia": "^${V0}"。\n`,
  'examples/complete/Dockerfile': `# 想改用发布版，依赖改成 ^${V0}，即可退回常规写法。\n`,
  'examples/complete/README.md':
    `想用发布版就把这一行换成 ^${V0}：\n\n` + `docker build 之后再改成 ^${V0} 也行。\n`,
  'examples/deploy/Dockerfile': `# 想改用发布版，依赖改成 ^${V0}，即可退回常规写法。\n`,
  'examples/deploy/README.md': `> 想改用发布版就把这一行换成 ^${V0}（与脚手架模板一致）。\n`,
  // lock 里除了我们那 4 个 version 字段，**故意**放一个第三方版本号：
  // 「同文件里还有几百个别处的版本号」正是这一面最容易改错的地方
  'package-lock.json':
    '{\n' +
    '  "name": "@migor/agentia",\n' +
    `  "version": "${V0}",\n` +
    '  "packages": {\n' +
    '    "": {\n' +
    '      "name": "@migor/agentia",\n' +
    `      "version": "${V0}"\n` +
    '    },\n' +
    '    "packages/cli": {\n' +
    '      "name": "@migor/cli",\n' +
    `      "version": "${V0}"\n` +
    '    },\n' +
    '    "packages/trace-view": {\n' +
    '      "name": "@migor/trace-view",\n' +
    `      "version": "${V0}"\n` +
    '    },\n' +
    '    "packages/website": {\n' +
    '      "name": "@migor/website",\n' +
    '      "version": "0.0.0",\n' +
    `      "dependencies": { "@migor/trace-view": "${V0}" }\n` +
    '    },\n' +
    // ⚠️ 同版本号的**第三方**依赖：裸 `"version"` 计数会把它算进网里（真发生过：
    // @grpc/proto-loader 恰好 @0.8.1）。清单按包名锚定 ⇒ 它既不该被替换、也不该被计数。
    '    "node_modules/@grpc/proto-loader": {\n' +
    `      "version": "${V0}"\n` +
    '    },\n' +
    '    "node_modules/left-pad": {\n' +
    '      "version": "1.3.0"\n' +
    '    }\n' +
    '  }\n' +
    '}\n',
};

function sh(dir: string, cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8' });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const git = (dir: string, args: string[]) =>
  sh(dir, 'git', ['-c', 'user.email=fixture@test', '-c', 'user.name=fixture', ...args]);
const cli = (dir: string, args: string[]) =>
  sh(dir, 'node', [join(dir, 'scripts/release.mjs'), ...args]);
const gate = (dir: string, args: string[] = []) =>
  sh(dir, 'node', [join(dir, 'scripts/check-release.mjs'), '--offline', ...args]);
const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8');

/** 某一面里「正好等于 v」的命中数（与闸门同一口径：所有捕获组都得等于 v）。 */
function hitsFor(text: string, s: Surface, v: string): number {
  return [...text.matchAll(new RegExp(s.pattern, s.flags))].filter((m) =>
    m.slice(1).every((g) => g === v),
  ).length;
}

/** 造一个干净的夹具仓库（脚本从自身位置推仓库根 ⇒ 夹具就是它们的「仓库」）。 */
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentia-fixture-'));
  for (const [file, content] of Object.entries(FIXTURE)) {
    const p = join(dir, file);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  for (const s of SCRIPTS) cpSync(join(repoRoot, 'scripts', s), join(dir, 'scripts', s));
  git(dir, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'fixture']);
  return dir;
}

describe('发版工具：清单覆盖与夹具完整性', () => {
  it('夹具覆盖了清单里的每一个面（清单加面必须在这里补内容）', () => {
    const missing = manifest.surfaces.map((s) => s.file).filter((f) => !(f in FIXTURE));
    assert.deepEqual(missing, [], `夹具缺这些面的内容：${missing.join(' / ')}`);
  });

  it('清单指向的每个面在当前仓库里仍然**匹配得上**（正则没被格式改动架空）', () => {
    // 只断言「有匹配」，不断言「等于当前版本」：未发布窗口内部分面有意落后，
    // 那种状态是设计的一部分，不该让本测试假红。
    const empty = manifest.surfaces
      .filter(
        (s) => [...read(repoRoot, s.file).matchAll(new RegExp(s.pattern, s.flags))].length === 0,
      )
      .map((s) => s.file);
    assert.deepEqual(
      empty,
      [],
      `这些面的正则已经匹配不到东西（文件改过格式？）：${empty.join(' / ')}`,
    );
  });
});

describe('release.mjs bump', () => {
  let dir = '';
  before(() => {
    dir = makeFixture();
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('初始夹具就是自洽的：闸门绿（结构面也绿，因为 CHANGELOG 正文已填）', () => {
    const r = gate(dir);
    assert.equal(r.code, 0, `夹具本身没过闸门：\n${r.out}`);
    assert.match(r.out, /发布面 \+ 3 项结构面一致/);
  });

  it('bump 逐项替换，每个面都变成新版本；lock 里的第三方版本号不动', () => {
    const r = cli(dir, ['bump', V1, '--offline']);
    assert.equal(r.code, 0, `bump 失败：\n${r.out}`);

    for (const s of manifest.surfaces) {
      const text = read(dir, s.file);
      assert.equal(hitsFor(text, s, V1), s.count, `${s.file} 里 ${V1} 的命中数不对`);
      if (s.file === 'package-lock.json')
        assert.equal(hitsFor(text, s, V0), 0, 'lock 里还留着旧版本号');
    }
    assert.match(
      read(dir, 'package-lock.json'),
      /"version": "1\.3\.0"/,
      'lock 的第三方版本号被改坏了',
    );
    // ⚠️ 与本次发布**同版本号**的第三方依赖：既不该被替换、也不该被算进发布面。
    // 这条守的是「裸 `"version"` 计数」那个坑（真发生过：@grpc/proto-loader@0.8.1 让
    // 闸门报「4 处应为 0.8.1，实际命中 5 处」）。
    assert.match(
      read(dir, 'package-lock.json'),
      new RegExp(`"node_modules/@grpc/proto-loader": \\{\\n\\s+"version": "${V0}"`),
      '同版本号的第三方依赖被 bump 改掉了（或清单退回成裸 version 计数被它撞网）',
    );

    // 三个散文位：脚本只插骨架，正文留给人
    const changelog = read(dir, 'CHANGELOG.md');
    assert.match(changelog, new RegExp(`^## \\[${V1}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'));
    assert.match(changelog, new RegExp(`^\\[${V1}\\]: .*/releases/tag/v${V1}$`, 'm'));
    assert.match(changelog, /TODO\(发版\)/);
    assert.match(read(dir, 'docs/spec.md'), new RegExp(`→ v${V1}（`));
    assert.match(read(dir, 'docs/roadmap.md'), new RegExp(`状态：v${V1} 已发布`));

    // 骨架未填 ⇒ 闸门严格模式该红、宽松模式该只给警告
    const strict = gate(dir);
    assert.equal(strict.code, 1, '未填的 CHANGELOG 骨架应该让严格闸门变红');
    assert.match(strict.out, /TODO/);
    const loose = gate(dir, ['--allow-pending']);
    assert.equal(loose.code, 0, `宽松闸门应当只警告：\n${loose.out}`);
    assert.match(loose.out, /⚠/);
  });

  it('bump 后工作树有改动（确实写了盘）', () => {
    assert.notEqual(git(dir, ['status', '--porcelain']).out.trim(), '');
  });
});

describe('release.mjs bump 的护栏', () => {
  let dir = '';
  before(() => {
    dir = makeFixture();
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('计数不符 ⇒ 中止，且**一个字节都没写**', () => {
    // 把 examples/complete/README.md 的第二处 pin 拿掉：该面期望 2 处，现在只剩 1 处
    const target = 'examples/complete/README.md';
    writeFileSync(join(dir, target), `想用发布版就把这一行换成 ^${V0}：\n`);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', '打破一处计数']);

    const before = read(dir, 'package.json');
    const r = cli(dir, ['bump', V1, '--offline']);
    assert.equal(r.code, 1, '计数不符时 bump 必须失败');
    assert.match(r.out, /examples\/complete\/README\.md/);
    assert.match(r.out, /期望替换 2 处，实际命中 1 处/);
    assert.match(r.out, /一个字节都没写/);

    // 硬证据：树保持干净 ⇒ 没有任何文件被写入
    assert.equal(git(dir, ['status', '--porcelain']).out.trim(), '', '中止后竟然有文件被改了');
    assert.equal(read(dir, 'package.json'), before, 'package.json 被改了一半');
    assert.doesNotMatch(read(dir, 'CHANGELOG.md'), new RegExp(`\\[${V1}\\]`));
  });

  it('版本号不往前走 ⇒ 拒绝', () => {
    const r = cli(dir, ['bump', V0, '--offline']);
    assert.equal(r.code, 1);
    assert.match(r.out, /只能往前走/);

    const lower = cli(dir, ['bump', '0.9.9', '--offline']);
    assert.equal(lower.code, 1);
    assert.match(lower.out, /只能往前走/);
  });

  it('工作树脏 ⇒ 拒绝（不让 bump 和别的改动混在一起）', () => {
    writeFileSync(join(dir, 'README.md'), `> **版本**：\`${V0}\`（脏改动）。\n`);
    const r = cli(dir, ['bump', V1, '--offline']);
    assert.equal(r.code, 1);
    assert.match(r.out, /工作树不干净/);
    git(dir, ['checkout', '--', 'README.md']);
  });
});

describe('闸门能点出不同步的那一个面', () => {
  let dir = '';
  before(() => {
    dir = makeFixture();
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('只有 AGENTIA_VERSION 落后时，报的就是它，别的面不背锅', () => {
    const before = read(dir, 'src/index.ts');
    writeFileSync(join(dir, 'src/index.ts'), "export const AGENTIA_VERSION = '0.9.9';\n");
    const r = gate(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /src\/index\.ts/);
    assert.match(r.out, /谎报旧版/);
    assert.doesNotMatch(r.out, /README\.md/);
    assert.doesNotMatch(r.out, /package-lock\.json/);
    writeFileSync(join(dir, 'src/index.ts'), before);
  });

  it('CHANGELOG 缺本版条目也拦得住', () => {
    const before = read(dir, 'CHANGELOG.md');
    writeFileSync(join(dir, 'CHANGELOG.md'), before.replace(`## [${V0}] - `, '## [0.0.1] - '));
    const r = gate(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /CHANGELOG\.md/);
    writeFileSync(join(dir, 'CHANGELOG.md'), before);
  });
});
