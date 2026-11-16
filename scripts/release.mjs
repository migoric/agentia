#!/usr/bin/env node
/**
 * 发版工具 —— 把「一次发布」里**机械且易漏**的部分做成命令，把**不可逆**的部分留给人。
 *
 *   node scripts/release.mjs bump  0.6.2    # 逐项 bump 全部发布面（带计数断言；不符即中止且不写盘）
 *   node scripts/release.mjs tag   0.6.2    # 发布后：核对 registry 产物 ↔ 仓库树，再打 **annotated** tag + 建 Release
 *   node scripts/release.mjs retag 0.6.1    # 把已存在的 lightweight tag 就地改成 annotated（默认只演练）
 *
 * 为什么 `npm publish` **不在**这个脚本里：它是唯一不可逆的一步 —— 版本号一旦花掉就收不回，
 * 而它在同一脚本里与「重写十几个文件」相邻，等于把一次笔误的爆炸半径放到最大。它仍然是三条
 * 逐包显式命令，由 `bump` 打印（顺序**刻意**是 发布 → 合并 → 打 tag，理由一并打印）。
 *
 * 为什么 tag 消息走 `-F <文件>` 而不是 `-m "<消息>"`：消息里全是反引号与星号，而
 * \`git tag -a v1.2.3 -m "…<反引号>@migor/agentia<反引号>…"\` 里的反引号会被 shell 当**命令替换**
 * 执行 —— 消息里的词当场消失、bash 还会先打一行 “No such file or directory”，
 * 而 tag 照样创建成功（本仓库真踩过）。所以：消息写文件、`-F` 传入、创建后 `git cat-file tag` 回读。
 *
 * 为什么打完 tag 还要有 `retag`：历史上这仓库前四个 tag 是 annotated、后三个退成了
 * lightweight（`git for-each-ref --format='%(refname:short) %(objecttype)' refs/tags`）。
 * annotated 能记下 tagger / 日期 / 原因，lightweight 不能。`retag` 只在**显式调用**时才动
 * 已推送的 tag（默认演练、`--apply` 才真改）—— 不自动修，因为它是外部可见的历史改写。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPO,
  SURFACES,
  changelogSection,
  compareSemver,
  esc,
  isSemver,
  readSurface,
} from './release-surface.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_BRANCH = 'main';
const REGISTRY = 'https://registry.npmjs.org/';
const PACKAGES = ['@migor/agentia', '@migor/cli', '@migor/agentia-pg'];

const say = (s) => console.log(s);
const ok = (s) => console.log(`  ✓ ${s}`);
const note = (s) => console.log(`  · ${s}`);
const warn = (s) => console.warn(`  ⚠ ${s}`);

/** 函数内部一律 `fail`（抛），由入口统一打印 —— 这样 finally 里的临时目录清理照常跑。 */
class Fail extends Error {}
const fail = (s) => {
  throw new Fail(s);
};
const die = (s) => {
  console.error(`\n✗ ${s}\n`);
  process.exit(1);
};

// ────────────────────────────── 基础工具 ──────────────────────────────

/** 跑一条命令并返回 stdout。`raw: true` 返回 Buffer（哈希要用原始字节，不能 trim）。 */
function run(cmd, args, { raw = false, cwd = root } = {}) {
  try {
    return execFileSync(cmd, args, {
      cwd,
      ...(raw ? {} : { encoding: 'utf8' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const detail = String(e?.stderr || e?.stdout || e)
      .trim()
      .split('\n')
      .slice(-6)
      .join('\n');
    throw new Fail(`\`${cmd} ${args.join(' ')}\` 失败：\n${detail}`);
  }
}
const runText = (cmd, args, opts) => String(run(cmd, args, opts)).trim();
const tryRun = (cmd, args, opts) => {
  try {
    return runText(cmd, args, opts);
  } catch {
    return null;
  }
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const read = (p) => readFileSync(join(root, p), 'utf8');
const pkgVersion = () => JSON.parse(read('package.json')).version;
const today = () => new Date().toISOString().slice(0, 10);

/** 某个文件的内容（Buffer）：`HEAD` / `v0.6.1` 这类 git ref，或 'worktree'。 */
function blob(ref, path) {
  return ref === 'worktree'
    ? readFileSync(join(root, path))
    : run('git', ['show', `${ref}:${path}`], { raw: true });
}

// ────────────────────────────── bump ──────────────────────────────

/**
 * 逐项替换：一个匹配里的**所有**捕获组都必须等于 `from` 才算命中（lock 那种「同文件里还有
 * 几百个第三方版本号」就靠这条过滤），命中处按精确字符区间改写。
 * 返回实际改写处数，由调用方对着清单里的 `count` 断言。
 */
function substitute(text, pattern, from, to) {
  const re = new RegExp(pattern.source, [...new Set(`${pattern.flags}d`)].join(''));
  const edits = [];
  let m = re.exec(text);
  while (m !== null) {
    if (m[0] === '') {
      re.lastIndex += 1; // 零宽匹配防死循环
    } else if (m.slice(1).every((g) => g === from)) {
      for (let i = 1; i < m.length; i++) edits.push([m.indices[i][0], m.indices[i][1]]);
    }
    m = re.exec(text);
  }
  let out = text;
  for (const [s, e] of edits.sort((a, b) => b[0] - a[0])) {
    out = `${out.slice(0, s)}${to}${out.slice(e)}`;
  }
  return { text: out, count: edits.length };
}

/** 每版**新增**（而非替换）的东西。只插骨架，正文由人填 —— 闸门会把未填的骨架拦下来。 */
const INSERT_OPS = [
  {
    id: 'CHANGELOG 本版条目（骨架，正文待填）',
    file: 'CHANGELOG.md',
    apply(text, to, date) {
      if (changelogSection(text, to)) return { text }; // 重跑：已有这一节
      const at = text.search(/^## \[/m);
      if (at < 0) {
        return {
          problem: 'CHANGELOG.md：找不到第一个版本段头（`## [x.y.z] - 日期`），无法插入本版条目',
        };
      }
      const block =
        `## [${to}] - ${date}\n\n### 变更\n\n` +
        'TODO(发版)：写本版变更 —— 对外可见的改动；有破坏性变更就写清使用者要做什么动作。\n\n';
      return { text: text.slice(0, at) + block + text.slice(at) };
    },
  },
  {
    id: 'CHANGELOG 版本链接引用',
    file: 'CHANGELOG.md',
    apply(text, to) {
      if (new RegExp(`^\\[${esc(to)}\\]: `, 'm').test(text)) return { text };
      const m = text.match(/^\[Unreleased\]: [^\n]*$/m);
      if (!m) {
        return { problem: 'CHANGELOG.md：找不到 `[Unreleased]:` 链接行，无法在其后插入本版引用' };
      }
      const line = `[${to}]: https://github.com/${REPO}/releases/tag/v${to}`;
      return { text: text.replace(m[0], () => `${m[0]}\n${line}`) };
    },
  },
  {
    id: 'spec §11 发布进度链（说明待填）',
    file: 'docs/spec.md',
    apply(text, to) {
      if (new RegExp(`→ v${esc(to)}（`).test(text)) return { text };
      const m = text.match(/^ {2}`AGENTIA_VERSION = '[^']+'`。决策均见 §10。$/m);
      if (!m) {
        return {
          problem:
            'docs/spec.md：找不到 §11 进度链的收尾行（`  `AGENTIA_VERSION = …`。决策均见 §10。`），无法接入本版',
        };
      }
      const line = `  → v${to}（TODO(发版)：一句话概括本版 + 有无破坏性变更）；`;
      return { text: text.replace(m[0], () => `${line}\n${m[0]}`) };
    },
  },
];

/** 只算不写：返回 `{ files, report, problems }`。任何一项计数不符都进 problems（全部列完再决定）。 */
function planBump(from, to, date) {
  const files = new Map();
  const report = [];
  const problems = [];
  const text = (f) => {
    if (!files.has(f)) files.set(f, readSurface(root, f));
    return files.get(f);
  };

  for (const s of SURFACES) {
    const { text: after, count } = substitute(text(s.file), s.pattern, from, to);
    if (count !== s.count) {
      problems.push(
        `${s.file}：${s.why} —— 期望替换 ${s.count} 处，实际命中 ${count} 处` +
          '（有人手工改过？还是这一项已被别的改动带走？先看清楚再 bump）',
      );
      continue;
    }
    files.set(s.file, after);
    report.push({ file: s.file, what: s.why, count });
  }

  for (const op of INSERT_OPS) {
    const res = op.apply(text(op.file), to, date);
    if (res.problem) {
      problems.push(res.problem);
      continue;
    }
    if (res.text !== text(op.file)) report.push({ file: op.file, what: op.id, count: 1 });
    files.set(op.file, res.text);
  }

  return { files, report, problems };
}

function cmdBump(to, { dryRun, offline }) {
  if (!isSemver(to)) fail(`版本号要写成 x.y.z（收到 ${to}）`);
  const from = pkgVersion();
  if (compareSemver(to, from) <= 0) {
    fail(
      `要 bump 到 ${to}，但当前已经是 ${from} —— 版本号只能往前走（0.x 阶段破坏性变更走 minor）`,
    );
  }
  const dirty = runText('git', ['status', '--porcelain']);
  if (dirty) {
    fail(
      `工作树不干净（${dirty.split('\n').length} 项）—— bump 会重写十几个文件，` +
        '先提交或 stash，别把两件事混在一起',
    );
  }
  if (!offline) {
    const published = tryRun('npm', [
      'view',
      '@migor/agentia',
      'version',
      '--registry=https://registry.npmjs.org',
    ]);
    if (published && compareSemver(to, published) <= 0) {
      fail(`${to} 不高于 npm 已发布的 ${published} —— 这个版本号已经花掉了`);
    }
    note(`registry 上最新是 ${published ?? '（E404：从未发布）'}`);
  }

  const date = today();
  const { files, report, problems } = planBump(from, to, date);
  if (problems.length) {
    console.error(`\n✗ ${from} → ${to} 中止，一个字节都没写：`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error(
      '\n（计数断言是故意的：发布面清单在 scripts/release-surface.mjs，' +
        '不在预期内的命中数是它在提醒你去看一眼）\n',
    );
    process.exit(1);
  }

  say(
    `\n${from} → ${to}（${files.size} 个文件，${report.length} 处）${dryRun ? '  [--dry-run]' : ''}`,
  );
  for (const r of report) ok(`${r.file}  ·${r.count}  ${r.what}`);
  if (dryRun) {
    say('\n--dry-run：没有写盘。去掉该参数才真写。\n');
    return;
  }
  for (const [f, t] of files) writeFileSync(join(root, f), t);
  ok(`已写入 ${files.size} 个文件`);

  // 机械面自检：此时 CHANGELOG 正文还是骨架，所以用 --allow-pending 把它降级为警告
  const gate = tryRun('node', ['scripts/check-release.mjs', '--offline', '--allow-pending']);
  say(`\n${gate ?? '（自检未通过 —— 见上）'}`);

  say(`
接下来（顺序**不能换**，理由在每步后面）：

  1. 填掉两个 TODO —— CHANGELOG 里 [${to}] 一节、spec §11 的链说明
     （roadmap.md 的状态行已同步；想让状态行也累计本轮摘要，照 “+ **v0.6.1**（…）” 的样子补一句）
  2. bash scripts/verify-all.sh                                   # 8 步全绿
  3. 开 PR 并等必需检查全绿（分支保护：线性历史 + squash）
  4. **先发布**：npm publish --registry https://registry.npmjs.org/
              npm publish -w @migor/cli --registry https://registry.npmjs.org/
              npm publish -w @migor/agentia-pg --registry https://registry.npmjs.org/
     —— 顺序是「发布 → 合并 → 打 tag」：反过来（先合并）的话，main 上会挂着
        「已发布」而 registry 还没有；这条链唯一不撒谎的顺序就是先发。
  5. 合并 PR（squash）
  6. node scripts/release.mjs tag ${to} --title '一句话概括本版'
     —— 它会先核对 registry 产物 ↔ 仓库树（单源文档哈希对拍），再打 annotated tag + 建 Release
`);
}

// ────────────────────────────── 产物核对 ──────────────────────────────

/**
 * 核对「registry 上发出去的产物」与「仓库树」是不是同一样东西。
 * 判据取**单源文档**：`docs/usage-guide.md` 在构建期被拷成包内 `dist/AGENTS.md`，
 * 所以哈希相等就说明产物出自这棵树（不是逐文件 diff，但它串起了这份文档被消费的四个面）。
 * 另核对：产物里的版本常量、CLI 包没有反向依赖私有兄弟包、inspector 拷贝在场。
 * 返回 `{ hash }` 作为证据（tag 消息与 Release 正文都引用它）。
 */
function verifyArtifacts(version, { docFrom = 'worktree' } = {}) {
  for (const p of PACKAGES) {
    const url = `https://registry.npmjs.org/${p.replace('/', '%2f')}`;
    const packument = JSON.parse(runText('curl', ['-sS', url]));
    const latest = packument['dist-tags']?.latest;
    if (latest !== version) {
      fail(
        `${p} 的 dist-tags.latest 是 ${latest}，不是 ${version} —— 发布还没落地。` +
          'npm 的 PUT 是异步的（202 已接受 ≠ 立即可读），等 1–2 分钟再来；别怀疑发布失败。',
      );
    }
    ok(`${p}  dist-tags.latest = ${version}（直读 packument，绕开 npm 客户端缓存）`);
  }

  const tmp = mkdtempSync(join(tmpdir(), 'agentia-release-'));
  try {
    const unpacked = {};
    for (const p of PACKAGES) {
      const out = runText('npm', [
        'pack',
        `${p}@${version}`,
        `--registry=${REGISTRY}`,
        `--pack-destination=${tmp}`,
      ]);
      const tgz = out.split('\n').filter(Boolean).pop().trim();
      const dir = join(tmp, p.replace(/[@/]/g, '_'));
      mkdirSync(dir, { recursive: true });
      runText('tar', ['-xzf', join(tmp, tgz), '-C', dir]);
      unpacked[p] = join(dir, 'package');
    }

    const want = sha256(blob(docFrom, 'docs/usage-guide.md'));
    const got = sha256(readFileSync(join(unpacked['@migor/agentia'], 'dist/AGENTS.md')));
    const where = docFrom === 'worktree' ? '工作树' : docFrom;
    if (want !== got) {
      fail(
        `产物里的 dist/AGENTS.md 与 ${where} 的 docs/usage-guide.md 哈希不同：\n` +
          `      ${where} ${want.slice(0, 16)}  vs  tarball ${got.slice(0, 16)}\n` +
          '      ⇒ 这棵树不是 registry 上那版（或发布后又改过文档）—— 别打 tag',
      );
    }
    ok(`单源文档哈希一致  ${want.slice(0, 16)}  （docs/usage-guide.md ↔ dist/AGENTS.md）`);

    const indexJs = readFileSync(join(unpacked['@migor/agentia'], 'dist/index.js'), 'utf8');
    if (!indexJs.includes(`AGENTIA_VERSION = '${version}'`)) {
      fail(`产物 dist/index.js 里没有 AGENTIA_VERSION = '${version}' —— 发出去的是别的版本`);
    }
    ok(`产物常量  AGENTIA_VERSION = '${version}'`);

    const cliPkg = JSON.parse(readFileSync(join(unpacked['@migor/cli'], 'package.json'), 'utf8'));
    const leaked = Object.keys(cliPkg.dependencies ?? {}).filter((d) => d.startsWith('@migor/'));
    if (leaked.length) {
      fail(
        `CLI 包竟然依赖 ${leaked.join(', ')} —— trace-view 是 private（不发布），装不上；` +
          '它只能靠构建期拷贝消费，不能 import',
      );
    }
    ok('CLI 包零 @migor/* 依赖（trace-view 确实靠拷贝消费，不是 import）');

    const inspector = join(unpacked['@migor/cli'], 'dist/inspector');
    if (!existsSync(inspector) || readdirSync(inspector).length === 0) {
      fail('CLI 产物里 dist/inspector/ 缺失或为空 —— trace-view 的构建产物没被拷进来');
    }
    ok('CLI 产物里 dist/inspector/ 在场（渲染器拷贝成功）');

    const pgPkg = JSON.parse(
      readFileSync(join(unpacked['@migor/agentia-pg'], 'package.json'), 'utf8'),
    );
    if (pgPkg.version !== version) {
      fail(`PG 包 tarball 版本是 ${pgPkg.version}，不是 ${version}`);
    }
    const pgIndex = readFileSync(join(unpacked['@migor/agentia-pg'], 'dist/index.js'), 'utf8');
    if (!pgIndex.includes('PgTaskStore') || !pgIndex.includes('PgSessionStore')) {
      fail('PG 包产物 dist/index.js 缺少 PgTaskStore / PgSessionStore 导出');
    }
    ok('PG 包产物版本与两个 store 导出在场');

    return { hash: want };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ────────────────────────────── tag 消息 ──────────────────────────────

function tagMessage(version, { sha, hash, title }) {
  const sec = changelogSection(read('CHANGELOG.md'), version);
  const lines = [`v${version}${title ? ` —— ${title}` : ''}`, ''];
  lines.push(
    `${PACKAGES.map((p) => `\`${p}@${version}\``).join(' / ')} 已发布到 registry.npmjs.org。`,
    '',
  );
  if (sec) lines.push('本版变更（CHANGELOG 原文）：', '', sec.body, '');
  lines.push(
    `本 tag 打在 ${sha} 上，发布产物与它同源 —— 单源文档 \`docs/usage-guide.md\` 与 registry 上`,
    `tarball 内 \`dist/AGENTS.md\` 的 sha256 一致（${hash.slice(0, 16)}），且产物里`,
    `\`AGENTIA_VERSION = '${version}'\`。证据与决策见 \`docs/spec.md\` §10。`,
    '',
    '`@migor/trace-view` 不单独发布（`private: true` 是有意的：产物在构建期被拷进 CLI 的',
    '`dist/inspector/`，随 CLI 一起交付）；它跟着 bump 只是保持 workspace 内版本一致。',
  );
  return `${lines.join('\n')}\n`;
}

/** 用 `-F` 建 annotated tag，再 `git cat-file tag` 回读 —— 不信退出码，看内容。 */
function createAnnotatedTag(ref, message, commit) {
  const msgFile = join(mkdtempSync(join(tmpdir(), 'agentia-tagmsg-')), 'msg.txt');
  writeFileSync(msgFile, message);
  run('git', ['tag', '-a', ref, '-F', msgFile, commit]);
  const body = runText('git', ['cat-file', 'tag', ref]);
  const name = body
    .split('\n')
    .find((l) => l.startsWith('tag '))
    ?.slice(4)
    .trim();
  const firstLine = body.slice(body.indexOf('\n\n') + 2).split('\n')[0] ?? '';
  if (name !== ref || !firstLine.includes(ref.replace(/^v/, ''))) {
    fail(
      `tag ${ref} 的消息回读不正常（tag 名 “${name}”，首行 “${firstLine}”）—— ` +
        `用 git tag -d ${ref} 删掉重来`,
    );
  }
  return { msgFile, firstLine };
}

// ────────────────────────────── tag ──────────────────────────────

function cmdTag(version, { dryRun, offline, title, notesFile }) {
  if (!isSemver(version)) fail(`版本号要写成 x.y.z（收到 ${version}）`);
  const cur = pkgVersion();
  if (cur !== version) fail(`package.json 是 ${cur}，要打的是 v${version} —— 先把 bump 合并进来`);

  const dirty = runText('git', ['status', '--porcelain']);
  if (dirty) fail(`工作树不干净（${dirty.split('\n').length} 项）—— 打 tag 前先提交`);
  runText('git', ['fetch', 'origin', RELEASE_BRANCH, '--quiet']);
  const head = runText('git', ['rev-parse', 'HEAD']);
  const remote = runText('git', ['rev-parse', `origin/${RELEASE_BRANCH}`]);
  if (head !== remote) {
    fail(
      `HEAD（${head.slice(0, 7)}）≠ origin/${RELEASE_BRANCH}（${remote.slice(0, 7)}）—— ` +
        '发版顺序是「发布 → 合并 → 打 tag」，先确认合并已完成、本地已同步',
    );
  }
  ok(`HEAD = origin/${RELEASE_BRANCH} = ${head.slice(0, 7)}，工作树干净`);

  const ref = `v${version}`;
  if (tryRun('git', ['rev-parse', '-q', '--verify', `refs/tags/${ref}`])) {
    const type = runText('git', ['cat-file', '-t', ref]);
    const kind = type === 'tag' ? 'annotated' : 'lightweight';
    if (!dryRun) {
      fail(
        `tag ${ref} 已存在（${kind}）。\n` +
          `      想把它改成 annotated：node scripts/release.mjs retag ${version}\n` +
          '      想挪动它：那是外部可见的历史改写 —— 自己看清楚再手动做，脚本不替你决定',
      );
    }
    warn(`${ref} 已存在（${kind}）—— 演练照跑，真打会被这里拦住`);
  }

  let evidence = { hash: '(未核对：--offline)' };
  if (offline) warn('--offline：跳过 registry 产物核对（只在你明知产物已核对时用）');
  else evidence = verifyArtifacts(version);

  const message = tagMessage(version, { sha: head.slice(0, 7), hash: evidence.hash, title });
  const releaseTitle = `${ref}${title ? ` —— ${title}` : ''}`;
  const notes = notesFile
    ? readFileSync(notesFile, 'utf8')
    : `${message.split('\n').slice(2).join('\n').trim()}\n`;

  say(`\n将要执行（${ref} → ${head.slice(0, 7)}）：\n`);
  say(
    `  git tag -a ${ref} -F <消息文件> ${head.slice(0, 7)}      ← 消息写文件、-F 传入，不走 -m "…"`,
  );
  say(`  git push origin ${ref}`);
  say(`  gh release create ${ref} --title '${releaseTitle}' --notes-file <文件>`);
  say('\n── tag 消息全文 ──\n');
  say(message.trimEnd());
  say('\n──────\n');

  if (dryRun) {
    say('--dry-run：什么都没做。去掉该参数才真打。\n');
    return;
  }

  const { msgFile, firstLine } = createAnnotatedTag(ref, message, head);
  ok(`annotated tag 已建并回读通过：${firstLine}`);
  runText('git', ['push', 'origin', ref]);
  ok(`已推送 ${ref}（annotated ⇒ ls-remote 会看到 tag 对象 + ^{} 两个 ref）`);

  if (tryRun('which', ['gh'])) {
    const notesPath = join(dirname(msgFile), 'release.md');
    writeFileSync(notesPath, notes);
    runText('gh', [
      'release',
      'create',
      ref,
      '--title',
      releaseTitle,
      '--notes-file',
      notesPath,
      '-R',
      REPO,
    ]);
    const body = runText('gh', [
      'release',
      'view',
      ref,
      '--json',
      'body',
      '-q',
      '.body',
      '-R',
      REPO,
    ]);
    if (!body.includes(version))
      fail(`Release 正文回读不含 ${version} —— 看 gh release view ${ref}`);
    ok(`GitHub Release 已建，正文回读 ${body.length} 字符`);
  } else {
    warn('没找到 gh —— Release 请手动建（正文已在上面打印）');
  }

  say(`\n发版收尾审计（都是「读」，所以留在脚本外，你自己跑）：
  npm view @migor/agentia time --registry https://registry.npmjs.org/ | tail -3   # 发布时点
  git ls-remote --tags origin | grep ${ref}                                       # tag 对象 + ^{} 都在
  gh release list --limit 3                                                       # Latest 是不是本版
  curl -sS https://agentia-web.pages.dev/llms.txt | head -3                       # 官网站点（本版若动了网站）
`);
}

// ────────────────────────────── retag ──────────────────────────────

function cmdRetag(version, { apply, title }) {
  const ref = `v${version}`;
  const type = tryRun('git', ['cat-file', '-t', ref]);
  if (!type) fail(`tag ${ref} 不存在`);
  if (type === 'tag') {
    say(`${ref} 已经是 annotated，无需转换：`);
    say(body_head(ref));
    return;
  }
  const sha = runText('git', ['rev-parse', `${ref}^{commit}`]);
  note(`${ref} 目前是 lightweight（指向 ${sha.slice(0, 7)}）—— 先核对它是不是当初发出去的那版`);

  const { hash } = verifyArtifacts(version, { docFrom: ref });
  const message = tagMessage(version, { sha: sha.slice(0, 7), hash, title });

  say('\n将要执行（只换 annotation，**不换提交**）：\n');
  say(`  git tag -d ${ref}`);
  say(`  git tag -a ${ref} -F <消息文件> ${sha}`);
  say(`  git push --force origin ${ref}`);
  say('\n── 新消息全文 ──\n');
  say(message.trimEnd());
  say('\n──────\n');
  warn(
    'force-push 一个已推送的 tag 是外部可见动作；而且 GitHub Release 对象之后可能出现\n' +
      '    createdAt > publishedAt（force-push 会重置 createdAt、publishedAt 保留原日期）—— ' +
      '提一句，别当成 bug',
  );

  if (!apply) {
    say('\n默认只演练：核对无误后加 --apply 才真改。\n');
    return;
  }
  runText('git', ['tag', '-d', ref]);
  const { firstLine } = createAnnotatedTag(ref, message, sha);
  runText('git', ['push', '--force', 'origin', ref]);
  ok(`已重建并强制推送：${firstLine}`);
  const ls = runText('git', ['ls-remote', '--tags', 'origin'])
    .split('\n')
    .filter((l) => l.includes(`refs/tags/${ref}`))
    .join('\n');
  ok(`ls-remote 里 ${ref} 现在是 tag 对象 + ^{} 两行 ⇒ annotated`);
  say(ls);
}

const body_head = (ref) =>
  runText('git', ['cat-file', 'tag', ref]).split('\n').slice(0, 6).join('\n');

// ────────────────────────────── 入口 ──────────────────────────────

const USAGE = `
发版工具（发布面清单在 scripts/release-surface.mjs，闸门是 scripts/check-release.mjs）

  node scripts/release.mjs bump  <x.y.z> [--dry-run] [--offline]
      逐项 bump 全部发布面 + 插入 CHANGELOG/spec 骨架。任何计数不符即中止，且一个字节都不写。

  node scripts/release.mjs tag   <x.y.z> [--title '一句话'] [--notes-file <文件>] [--dry-run] [--offline]
      发布后使用。先核对 registry 产物 ↔ 仓库树（单源文档哈希对拍），再打 **annotated** tag
      并建 GitHub Release；tag 消息走 -F 文件、建完回读。

  node scripts/release.mjs retag <x.y.z> [--title '一句话'] [--apply]
      把已存在的 lightweight tag 就地改成 annotated（同一提交，只换 annotation）。默认只演练。
`;

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = new Set(argv.filter((a) => a.startsWith('--')));
/** 取值型开关：它后面那个词是值，不是位置参数。 */
const VALUE_FLAGS = new Set(['--title', '--notes-file']);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = [];
for (let i = 1; i < argv.length; i++) {
  if (VALUE_FLAGS.has(argv[i])) {
    i += 1;
  } else if (!argv[i].startsWith('--')) {
    positional.push(argv[i]);
  }
}

try {
  if (cmd === 'bump' && positional[0]) {
    cmdBump(positional[0], { dryRun: flags.has('--dry-run'), offline: flags.has('--offline') });
  } else if (cmd === 'tag' && positional[0]) {
    cmdTag(positional[0], {
      dryRun: flags.has('--dry-run'),
      offline: flags.has('--offline'),
      title: arg('title'),
      notesFile: arg('notes-file'),
    });
  } else if (cmd === 'retag' && positional[0]) {
    cmdRetag(positional[0], { apply: flags.has('--apply'), title: arg('title') });
  } else {
    say(USAGE);
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  die(e instanceof Fail ? e.message : (e?.stack ?? String(e)));
}
