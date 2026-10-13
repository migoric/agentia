/**
 * 元守卫 —— **工具链对自己说的话**必须与 `ci.yml` 一致。
 *
 * 为什么需要它：`scripts/verify-all.sh` 顶部那条规矩（「本脚本的**步骤数**写在 CI 的 job 名里，
 * 加/减一步都得同时改 workflow 的 job name **和** 分支保护，否则 PR 会卡死等一个永不出现的
 * 检查」）此前**只有人记得，没有任何门禁**。而这条约定一旦漂移，症状是**所有 PR 永久卡住**
 * —— 不是某个测试红了，而是没人能合并。
 *
 * 起因是 2026-09-26 收尾时抓到的一处同类缺陷：脚本收尾注释里那句「另有 3 个 CI 独有必需检查」
 * 与紧随其后的清单（只列了 2 个）自相矛盾，而**上一行**的注释恰好还在讲「计数**算出来**而不是
 * 写死」。⇒ 本仓已重复五次的教训（「计数只能靠数」）之所以重复，是因为它只活在文档里。
 * 这个文件把它变成判据。
 *
 * 与本仓既有两条元守卫的分工：
 *   - `tests/docs/guards-registry.test.ts`：`docs/guards.md` 里列出的路径**存在**（清单 → 盘）；
 *   - `tests/docs/commit-refs.test.ts`：`docs/**` 引用的提交**在主干祖先链上**；
 *   - 本文件：**工具链的自我描述与 `ci.yml` 互为真值**（谁都不能各说各话）。
 *
 * ## 判据
 *
 * **第一组：工具链的内部一致（`verify-all.sh` ↔ `ci.yml`）**
 *
 * 1. `verify-all.sh` 的 `steps` 条数 **==** `ci.yml` 的 `verify` job 名里写死的那个数字；
 * 2. `ci.yml` 的每个 job 都要被交代：要么是跑本脚本的那个、要么在脚本的 `ci_only` 清单里、
 *    要么在下面的 `EXEMPT` 表里**带理由**豁免（且豁免理由本身要被核对）；
 * 3. `ci_only` 里不能有**幽灵 id**（`ci.yml` 里不存在的 job）；
 * 4. `ci_only` 的每条都要是 `<job id>|<说明>` 形状（否则第 2/3 条无从核对）；
 * 5. 脚本收尾消息**不得写死计数**（必须从清单长度算出来）。
 *
 * **第二组：同一句话在别处的抄写（见文件下半部分）**
 *
 * 6. 「本链一共几步」的**每一处抄写**（`CONTRIBUTING.md` ×2 · `AGENTS.md` ×5 · PR 模板 ×2）
 *    都必须等于真值 —— 这句话此前只有 CI job 名那一份被机器核过；
 * 7. `CONTRIBUTING.md` 的「# N 步：…」枚举要与脚本的步骤**一一对应**（第三份步骤清单）；
 * 8. `CONTRIBUTING.md` 的「CI 必须全绿才能合并」括号列表 == 真实必需检查集合；
 * 9. `CONTRIBUTING.md` 坑表那行要点名**每一个** CI 独有检查；
 * 10. `AGENTS.md` 的 CI 段落要点名每一个 job，且**圈码数 == job 数**；
 * 11. **兜底扫描**：任何同时点名 3 个以上 CI job 的 markdown 都必须登记（或带理由豁免）。
 *
 * ⚠️ 第 6–11 条的共同前提是「**抄写会过期**」：本仓的规矩是「加检查一律折进已有步骤」，
 * 所以步数本该恒定；但正因为它恒定，一旦有人真加了第 9 步，这 9 处抄写会**同时**变成假话。
 *
 * ## 为什么解析是手写的
 *
 * 本仓**零运行时依赖**，测试侧也没有 YAML 解析器（`npm ls yaml` 为空）。所以这里用**窄正则**
 * 解析 `ci.yml` 与 `verify-all.sh` —— 代价是解析锚点本身可能失效，故每条断言都带**防真空**
 * 下限（解析出 0 个 job / 0 个步骤时红，而不是空转绿）。改 `ci.yml` 的缩进风格前先看这里。
 *
 * ## 固有盲区（点名，不收尾）
 *
 * 「CI 独有必需检查共 N 个」这句话的另一半真值在**仓外**：GitHub 分支保护的实际配置
 * 不在仓库里，任何仓内守卫都够不着它 —— 若 GitHub 上某个检查其实没被设为必需，
 * 本文件会全绿地错下去。这里核的是「仓内各处的抄写互为一致」；仓外那一侧只能在
 * 动分支保护时人工对一眼（2026-09-27 评审指出，登记在此免得被当成「已守住」）。
 *
 * ## 反向验证
 *
 * 21 条变异（M54–M74）各**恰好**点名对应断言；其中 **2 条第一次跑是绿的**（M57 幽灵条目被
 * 解析器吃掉、M73 新文档不在 `git ls-files` 里）—— 两处都改的是**量具**，不是断言。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = readFileSync(join(repoRoot, 'scripts', 'verify-all.sh'), 'utf8');
const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');

const readRel = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');

/** `AGENTS.md` 把 job 写成 npm script 的拼法（`e2e:mcp`），核之前统一成 id 拼法。 */
const norm = (s: string): string =>
  s.replace(/e2e:mcp:server/g, 'e2e-mcp-server').replace(/e2e:mcp/g, 'e2e-mcp');

/**
 * 按 job id 点名：边界要排除连字符延续（`(?<![\w-])` / `(?![\w-])`），不能只靠 `\b` ——
 * `\b` 把 `-` 当边界，`e2e-mcp` 会匹配进 `e2e-mcp-server` 里（一个 job 被数成两个）。
 */
const idRe = (id: string): RegExp => new RegExp(`(?<![\\w-])${id}(?![\\w-])`);

/**
 * 仓库里的 markdown：**已入库的 ∪ 未入库但未被 `.gitignore` 的**。
 *
 * ⚠️ 为什么不是只取 `git ls-files`（第一版就是那样，被变异电池当场证伪）：新写的文档在 `git add`
 * 之前**不在索引里** ⇒ 兜底扫描看不见它 ⇒ 本地绿、提交后 CI 才红。取并集后本地与 CI 同口径。
 * `.workbuddy-ai/` 这类被 ignore 的路径由 `--exclude-standard` 挡掉。
 */
function markdownInTree(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean);
}

/** 从 `NAME=(` 到独立的 `)` 行之间，抽出所有**整行就是一个双引号字符串**的条目。 */
function bashArray(src: string, name: string): string[] {
  const lines = src.split('\n');
  const at = lines.findIndex((l) => l.includes(`${name}=(`));
  assert.notEqual(
    at,
    -1,
    `verify-all.sh 里找不到 \`${name}=(\` —— 解析锚点没了，先改这里的解析再跑`,
  );
  const out: string[] = [];
  let closed = false;
  for (const l of lines.slice(at + 1)) {
    if (/^\s*\)\s*$/.test(l)) {
      closed = true;
      break;
    }
    const t = l.trim();
    if (t === '' || t.startsWith('#')) continue;
    // ⚠️ 认不出的写法**必须响亮失败，不能跳过**。这条是变异电池逼出来的：第一版只认
    //    「整行就是引号字符串」，于是往里加一条 `'ghost|…',`（**多了个尾逗号** —— bash 完全
    //    合法、且真的会成为一个条目）会被**静默忽略**，幽灵条目整条隐形、断言照样绿。
    //    ⇒ 解析器有盲区时，「漏掉一条」与「本来就没那条」不可区分；这正是本文件要防的漂移。
    const m = /^(?:"([^"]+)"|'([^']+)')\s*,?$/.exec(t);
    assert.ok(
      m,
      `\`${name}=(\` 里这行看不懂，而它**不能被静默跳过**：「${t}」\n` +
        '  ⇒ 数组条目只认整行的 `"…"` / `\'…\'`（尾逗号可选，行内注释不支持）。\n' +
        '     放宽解析前先想清楚：跳过的条目 = 清单里悄悄少一条。',
    );
    out.push(m[1] ?? m[2]);
  }
  assert.ok(closed, `\`${name}=(\` 之后找不到独立的 \`)\` 行 —— 数组收尾锚点没了`);
  return out;
}

/**
 * `ci.yml` 的 job：`jobs:` 之下**恰好两空格缩进**的 `id:` 行。
 * ⚠️ 两空格缩进的注释（`  # …`）不在字符类里，不会被误当成 job。
 */
function workflowJobs(src: string): Array<{ id: string; name: string; body: string }> {
  const lines = src.split('\n');
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.notEqual(jobsAt, -1, 'ci.yml 里找不到顶层的 `jobs:` —— 解析锚点没了');
  const raw: Array<{ id: string; lines: string[] }> = [];
  for (const l of lines.slice(jobsAt + 1)) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l);
    if (m) {
      raw.push({ id: m[1], lines: [l] });
      continue;
    }
    if (raw.length > 0) raw[raw.length - 1].lines.push(l);
  }
  return raw.map((j) => {
    const body = j.lines.join('\n');
    const n = /^ {4}name:\s*(.+?)\s*$/m.exec(body);
    return { id: j.id, name: n ? n[1] : '', body };
  });
}

const steps = bashArray(script, 'steps');
const ciOnly = bashArray(script, 'ci_only');
const jobs = workflowJobs(workflow);

const verifyJob = jobs.find((j) => j.body.includes('scripts/verify-all.sh'));
assert.ok(
  verifyJob,
  'ci.yml 里没有任何 job 跑 `scripts/verify-all.sh` —— 本守卫靠这一句定位「本链 = 哪个 job」，' +
    '找不到就说明 CI 与本地链的接线断了（或那句话被改写了）',
);

/**
 * 故意**不**列进 `ci_only` 的 job。豁免不是免检：`mustMatch` 是「豁免理由本身」的可执行形式，
 * 理由不成立了就得重新决定（而不是继续豁免下去）。
 */
const EXEMPT: Array<{ id: string; mustMatch: RegExp; why: string }> = [
  {
    id: 'deploy-website',
    mustMatch: /if:\s*github\.ref == 'refs\/heads\/main'/,
    why:
      '只在 main 上跑（PR 上 skip）⇒ **不是**必需状态检查，故意不列进任何清单：' +
      'ci.yml 自己的注释写着「加进分支保护会让 PR 永远等一个不会跑的检查 → 卡死」',
  },
  {
    id: 'docker-image',
    mustMatch: /docker build/,
    why:
      '**非必需检查**：本机没有 docker、本地链无法等价复现 ⇒ 它只作 CI 侧的构建证据，' +
      '不阻塞合并（首次绿就是它的验证）。⚠️ 若将来本地能等价复现（或补了替代验证），' +
      '应把它挪进 `ci_only` —— 这条豁免理由到那时就不成立了。',
  },
];

describe('verify-all.sh ↔ ci.yml：工具链的自我描述必须互为真值', () => {
  it('解析锚点还活着（防真空：解析出 0 个 job / 0 个步骤时不能空转绿）', () => {
    assert.ok(jobs.length >= 4, `从 ci.yml 只解析出 ${jobs.length} 个 job —— 解析锚点大概率失效了`);
    assert.ok(
      steps.length >= 5,
      `从 verify-all.sh 只解析出 ${steps.length} 个步骤 —— 解析锚点失效了`,
    );
    assert.ok(ciOnly.length >= 1, '`ci_only` 解析出 0 条 —— 要么清单被删空了，要么解析失效');
  });

  it('步骤数 == CI 的 verify job 名里写死的那个数字', () => {
    const m = /verify-all\s*(\d+)\s*步/.exec(verifyJob?.name ?? '');
    assert.ok(
      m,
      `从 verify job 的 name 里读不出步数（实际是「${verifyJob?.name}」）。` +
        '这个数字是分支保护依赖的必需检查名的一部分，格式别改；要改步数就两处一起改。',
    );
    assert.equal(
      steps.length,
      Number(m[1]),
      `verify-all.sh 有 ${steps.length} 步，而 CI 的 job 名写着 ${m[1]} 步。\n` +
        '  二者是**同一个约定**：名字里的数字就是分支保护里那条必需检查。\n' +
        '  ⇒ 本仓的规矩是**加检查一律折进已有步骤**（见脚本顶部注释）；真要加第 9 步，\n' +
        '     必须同时改 ci.yml 的 job name **和** 分支保护配置，否则所有 PR 会永久卡死。',
    );
  });

  it('ci.yml 里那条「逐步枚举」注释与脚本的步骤一一对应', () => {
    const arrows = (verifyJob?.body ?? '')
      .split('\n')
      .filter((l) => /^\s*#/.test(l) && l.includes('→'));
    assert.equal(
      arrows.length,
      1,
      `verify job 里应当恰好有一条用 \`→\` 逐步枚举本链的注释（它是对外说明的单源），实际 ${arrows.length} 条`,
    );
    const named = arrows[0]
      .replace(/^\s*#\s*/, '')
      .split('→')
      .map((s) => s.trim())
      .filter(Boolean);
    assert.equal(
      named.length,
      steps.length,
      `注释枚举了 ${named.length} 项（${named.join(' → ')}），而脚本有 ${steps.length} 步 —— ` +
        '注释里的清单与计数一样会过期，改步骤时一起改',
    );
    named.forEach((token, i) => {
      assert.ok(
        steps[i].includes(token),
        `注释说第 ${i + 1} 步是「${token}」，而脚本那一步是「${steps[i]}」—— 顺序或名字对不上`,
      );
    });
  });

  it('ci.yml 的每个 job 都被交代过（本链 / ci_only / 带理由豁免）', () => {
    const covered = new Set<string>([verifyJob?.id ?? '', ...ciOnly.map((e) => e.split('|')[0])]);
    const exemptIds = new Set(EXEMPT.map((e) => e.id));
    const unexplained = jobs
      .filter((j) => !covered.has(j.id) && !exemptIds.has(j.id))
      .map((j) => j.id);
    assert.deepEqual(
      unexplained,
      [],
      `这些 CI job 没人交代：${unexplained.join(' · ')}。\n` +
        '  ⇒ 新加一个 CI job 时**必须做一次判断**，别让它默默存在：\n' +
        '     · 它是必需检查 ⇒ 加进 verify-all.sh 的 `ci_only`（带 `<job id>|说明`，并写清本机怎么跑）；\n' +
        '     · 它不是必需检查 ⇒ 加进本文件的 `EXEMPT` 表，**并给出可执行的理由**（见下一条用例）。',
    );
  });

  it('豁免理由本身也要成立（豁免不是免检）', () => {
    for (const e of EXEMPT) {
      const job = jobs.find((j) => j.id === e.id);
      assert.ok(job, `EXEMPT 里的 \`${e.id}\` 在 ci.yml 里不存在 —— 幽灵豁免，请删掉`);
      assert.match(
        job.body,
        e.mustMatch,
        `\`${e.id}\` 的豁免理由已不成立：${e.why}\n` +
          '  ⇒ 它不再是原来那个形状了（比如不再只在 main 上跑），请重新决定它该不该进 `ci_only`。',
      );
    }
  });

  it('ci_only 里不能有幽灵 id，且每条都要带 job id', () => {
    const ids = new Set(jobs.map((j) => j.id));
    for (const entry of ciOnly) {
      assert.match(
        entry,
        /^[A-Za-z0-9_-]+\|.+/,
        `ci_only 的这条不是 \`<job id>|<说明>\` 形状：「${entry}」—— 前两半截是给机器核对用的`,
      );
      const id = entry.split('|')[0];
      assert.ok(
        ids.has(id),
        `ci_only 里的 \`${id}\` 在 ci.yml 里不存在 —— 幽灵条目（job 被改名或删掉了？）：「${entry}」`,
      );
    }
  });

  it('收尾消息不得写死计数（必须从清单长度算出来）', () => {
    assert.ok(
      !/另有\s*[0-9]+\s*个/.test(script),
      'verify-all.sh 的收尾消息里出现了写死的计数（`另有 N 个`）。\n' +
        '  ⇒ 这里曾写「3 个」而清单只列了 2 个 —— 计数与清单分居两处就迟早各说各话。\n' +
        '     用数组长度展开（见脚本上一行注释）算出来 —— 数字和清单分居两处就迟早各说各话。',
    );
  });

  // ── 「等新版本上线」的判据必须绑在**本次运行的身份**上（2026-10-08）─────────────
  //
  // 修的是一条真缺陷：那条轮询原本判「`robots.txt` 里出现 `Sitemap: ` 行」，注释写着
  // 「它是本轮新增的产物，只有新版才可能有」—— 而那一行自 PR #119 起**每一版都有**
  // ⇒ 条件恒为真、从不等待。实测：第 1 次探测就报「已在线上」，而 AFDocs 同时读到
  // **旧的 sitemap**，刷出两条假 FAIL（llms-txt-links-resolve / llms-txt-coverage）。
  // ⇒ **「只有新版才有的字面量」会随版本变旧、然后恒真**；不会腐烂的判据只有
  //   「本次运行自己的身份」。这条守卫钉的是那个性质，不是某个具体字符串。
  it('「等新版本上线」的判据要绑 $GITHUB_SHA，且站点真按它输出构建标记', async () => {
    const job = jobs.find((j) => j.id === 'deploy-website');
    assert.ok(job, 'ci.yml 里没有 `deploy-website` job —— 解析锚点坏了，或 job 被改名');

    // ① 判据侧：必须是「**轮询**里拿本次提交去比」。
    //    ⚠️ 形状不能再松，两个理由都是变异当场打出来的（第一版两处都假绿）：
    //      · 只匹配 `${GITHUB_SHA}` → 同一个 job 里**构建期自证**那行也有它，
    //        轮询退回旧的 `Sitemap: ` 形态照样能匹配；
    //      · 不锚 `curl … |` → 说明注释里那句「`# build: <sha>` == 本次运行的 ${GITHUB_SHA}」也算数。
    const m = /curl[^\n|]*\|[^\n]*grep -qF "([^"$]*)\$\{GITHUB_SHA\}"/.exec(job.body);
    assert.ok(
      m,
      'deploy-website 里找不到「按本次提交判新鲜度」的轮询 —— 期望的形状是 `curl … | grep -qF "<标记>"`，\n' +
        '     而「本次提交」是 **shell 变量展开**（不是写死的字面量）。\n' +
        '  ⇒ 判据必须是「本次运行要部署的那个提交」；固定字面量会随版本变旧、然后恒真' +
        ' —— 这正是它腐烂过一次的形态（旧版等的是 `Sitemap: ` 行）。\n' +
        '     改写法时这条守卫要跟着改，但**别删掉它**：它守的是那个性质，不是那个字符串。',
    );
    const marker = m[1];
    assert.ok(marker.length > 0, '轮询匹配到了，但标记是空串 —— 那样下游的核验会空转成绿');

    // ② 生产侧：**真跑** robots.txt.ts，看它按 $GITHUB_SHA 输出什么。
    //    为什么不核源码文本：那个文件的**注释里**也写着同一个标记 —— 核文本会被自己的注释
    //    喂绿（变异 C3 的第一版就是这么 exit 0 的）。行为断言则注释 / 排版 / 重构都骗不过。
    //    `robots.txt.ts` 只有 `import type`（编译期擦除）⇒ 运行时零依赖，可以直接 import。
    const { GET } = (await import(
      pathToFileURL(join(repoRoot, 'packages', 'website', 'src', 'pages', 'robots.txt.ts')).href
    )) as { GET: (ctx: { site: URL }) => Response };
    const render = async (sha: string | undefined) => {
      const saved = process.env.GITHUB_SHA;
      try {
        if (sha === undefined) delete process.env.GITHUB_SHA;
        else process.env.GITHUB_SHA = sha;
        return await GET({ site: new URL('https://agentia-web.pages.dev') }).text();
      } finally {
        if (saved === undefined) delete process.env.GITHUB_SHA;
        else process.env.GITHUB_SHA = saved;
      }
    };

    const sha = 'cafebabe0123456789abcdef0123456789abcdef';
    const withSha = await render(sha);
    assert.ok(
      withSha.includes(`${marker}${sha}`),
      `robots.txt.ts 没有把 $GITHUB_SHA 按 \`${marker}<sha>\` 输出 ——\n` +
        '  ⇒ ci.yml 那侧等的就是这个串；对不上只会白等 120s 再照旧打分，' +
        '而本步是 continue-on-error、退化不会红（正是它腐烂过一次的原因）。',
    );
    // 反向：没给 SHA（本地构建）时**不许**输出这一行 ——
    // 「这一行在不在」本身就是「这份产物是不是 CI 构建的」的判据，编个假缺省值就把它废了。
    const withoutSha = await render(undefined);
    assert.ok(
      !withoutSha.includes(marker),
      `没设 GITHUB_SHA 时 robots.txt.ts 仍然输出了 \`${marker}\` ——\n` +
        '  ⇒ 那等于给判据编了个假缺省值（它又会恒真）。本地构建就该没有这一行。',
    );
  });

  // ── 分片 ↔ 本地钩子 ↔ 文档：三处必须互指（2026-10-14）────────────────────────
  //
  // 加这条是因为「分片」**天然的失效形态是静默**：按名字选步的分片在步骤改名之后会
  // **选不到任何一步**，跑完、打印「全绿」—— 而它正是 pre-push 钩子调用的那条路。
  // 脚本自己已挡了一道（选到 0 步 ⇒ exit 2，见脚本里的注释），这里补的是**仓内三处的一致性**：
  // 脚本的分片定义 / `.githooks/pre-push` 调的确实是它 / `CONTRIBUTING.md` 教了怎么开。
  it('分片定义自洽，且与 .githooks/pre-push、CONTRIBUTING 三处互指', () => {
    const names = bashArray(script, 'step_names');
    assert.equal(
      names.length,
      steps.length,
      `step_names 有 ${names.length} 条、steps 有 ${steps.length} 条 —— 分片按名字选步，条数不等就会错位`,
    );
    assert.equal(
      new Set(names).size,
      names.length,
      `step_names 里有重名（${names.join(' / ')}）—— 重名会让分片只选到顺序上的第一个，另一个被静默跳过`,
    );

    // 分片定义写成 `<名字>) shard_want="<空格分隔的步骤名>" ;;`
    const shards = [...script.matchAll(/^\s*(\w+)\)\s*shard_want="([^"]*)"\s*;;/gm)].map((m) => ({
      name: m[1],
      want: m[2].trim().split(/\s+/).filter(Boolean),
    }));
    assert.ok(
      shards.length >= 1,
      '一个分片定义都没解析到 —— 解析锚点失效了，下面的断言会空转（真空变绿）',
    );
    assert.ok(
      shards.some((s) => s.name === 'rapid'),
      '脚本里没有 `rapid` 分片 —— 而 .githooks/pre-push 与 CONTRIBUTING.md 都指着它',
    );
    const badShard = shards.flatMap((s) =>
      s.want.filter((w) => !names.includes(w)).map((w) => `${s.name} → ${w}`),
    );
    assert.deepEqual(
      badShard,
      [],
      `这些分片里的步骤名不存在：${badShard.join(' · ')} —— 步骤改名后分片会**静默少跑**（脚本里那条自证只挡「0 步」这一种）`,
    );

    // ① 钩子必须真的存在且**可执行** —— git 对不可执行的钩子是**静默跳过**，比报错更难发现
    const hookPath = join(repoRoot, '.githooks', 'pre-push');
    const hook = readFileSync(hookPath, 'utf8');
    assert.ok(
      (statSync(hookPath).mode & 0o111) !== 0,
      '.githooks/pre-push 不可执行 —— git 会**静默跳过**它（`git push` 看起来正常，什么也没验）',
    );
    assert.ok(
      /verify-all\.sh\s+rapid/.test(hook),
      '.githooks/pre-push 里找不到 `verify-all.sh rapid` —— 钩子与分片脱钩了（改名/改参数都会走到这里）',
    );

    // ② 文档必须教怎么开 —— git 缺省不读仓库里的钩子，不写出来它只对本机有效且无人知道
    assert.ok(
      readRel('CONTRIBUTING.md').includes('core.hooksPath .githooks'),
      'CONTRIBUTING.md 里没有开钩子的那一条（`core.hooksPath .githooks`）——\n' +
        '  ⇒ git **不会**自动启用仓库里的钩子：不写出来，别人克隆下来永远不会跑它。',
    );
  });
});

// ── 同一句话的其它副本 ────────────────────────────────────────────────────────
//
// 「本链一共几步」「必需检查是哪些」这两句话在本仓被**抄写**到了 9 处（`CONTRIBUTING.md` ×2 ·
// `AGENTS.md` ×5 · PR 模板 ×2），而此前**只有 CI 的 job 名那一份**是被机器核过的。
// 抄写就会过期 —— 本轮刚在 `verify-all.sh` 自己身上踩过（注释说「3 个」而清单只列了 2 个）。
// 这里把每一份都钉住；**范围如实标注**：新写一份抄写不会被自动发现（最后一条用例是兜底扫描，
// 阈值只能挡住「同时点名 3 个以上 job」的那种，更含蓄的抄写仍要人来登记）。

/** 「本链一共几步」在仓库里的**每一种写法**。全是抄写 ⇒ 每一处都必须等于真值。 */
const STEP_COUNT_SHAPES: Array<{ re: RegExp; what: string }> = [
  { re: /(\d+)\s*\/\s*(\d+)\s*全绿/g, what: '「N/N 全绿」' },
  { re: /上面\s*(\d+)\s*步/g, what: '「不并入上面 N 步」' },
  { re: /verify-all\s*(\d+)\s*步/g, what: '「verify-all N 步」（= CI job 名里的数字）' },
  { re: /(\d+)\s*步验证链/g, what: '「N 步验证链」' },
  { re: /#\s*(\d+)\s*步[：:]/g, what: '代码块注释里的「# N 步：…」' },
  { re: /[，,]\s*(\d+)\s*步\s*——/g, what: '「，N 步 ——」' },
];

/**
 * 参与「步数」核对的文档，以及**每份至少要有几处**（防真空：解析锚点坏了不能空转绿）。
 * `atLeast` 是 1 而不是「精确条数」—— 允许有人把三处「上面 8 步」并成一处（那是好事），
 * 但不允许**整份文档不再说链有多长**。
 */
const STEP_COUNT_DOCS: Array<{ file: string; atLeast: number }> = [
  { file: 'CONTRIBUTING.md', atLeast: 2 },
  { file: 'AGENTS.md', atLeast: 3 },
  { file: '.github/PULL_REQUEST_TEMPLATE.md', atLeast: 2 },
];

/** 已登记的「必需检查清单」副本。新写一份抄写要加到这里（或被下面的 `EXEMPT` 挡掉）。 */
const REQUIRED_LIST_FILES = ['CONTRIBUTING.md', 'AGENTS.md', '.github/PULL_REQUEST_TEMPLATE.md'];

/** `ci_only` 里的 job id（= 本链不覆盖的必需检查）。 */
const ciOnlyIds = ciOnly.map((e) => e.split('|')[0]);

/** 分支保护里的必需检查全集 = 跑本链的那个 + `ci_only` 里的那些。 */
const requiredIds = new Set<string>([verifyJob?.id ?? '', ...ciOnlyIds]);

describe('「本链几步 / 必需检查是哪些」的每一处抄写都要与真值一致', () => {
  it('步数的每一处抄写都必须等于真值', () => {
    const bad: string[] = [];
    for (const { file, atLeast } of STEP_COUNT_DOCS) {
      const lines = readRel(file).split('\n');
      let seen = 0;
      for (const { re, what } of STEP_COUNT_SHAPES) {
        lines.forEach((line, i) => {
          for (const m of line.matchAll(new RegExp(re.source, 'g'))) {
            seen++;
            for (const g of m.slice(1)) {
              if (g !== undefined && Number(g) !== steps.length) {
                bad.push(
                  `${file}:${i + 1} 的${what}写着「${m[0].trim()}」，而真实步数是 ${steps.length}`,
                );
              }
            }
          }
        });
      }
      assert.ok(
        seen >= atLeast,
        `${file} 里只核到 ${seen} 处步数（预期 ≥${atLeast}）—— 要么文档不再说链有多长，` +
          '要么这些形状的锚点坏了。**别直接调低这个下限**：先确认是哪一种。',
      );
    }
    assert.deepEqual(
      bad,
      [],
      `这些抄写与真实步数（${steps.length}）不一致：\n  ${bad.join('\n  ')}\n` +
        '  ⇒ 本仓的规矩是「加检查一律折进已有步骤」（步数不变）；真要改步数，' +
        'CI job 名 / 分支保护 / 这几处抄写必须一起改。',
    );
  });

  it('CONTRIBUTING 的「# N 步：…」枚举必须与脚本的步骤一一对应', () => {
    const lines = readRel('CONTRIBUTING.md').split('\n');
    const at = lines.findIndex((l) => /#\s*\d+\s*步[：:]/.test(l));
    assert.notEqual(
      at,
      -1,
      'CONTRIBUTING.md 里找不到「# N 步：…」那条枚举 —— 它是给人看的步骤清单（第三份抄写）',
    );
    const block = [lines[at]];
    for (let i = at + 1; i < lines.length && /^\s*#\s*→/.test(lines[i]); i++) block.push(lines[i]);
    const named = block
      .map((l) =>
        l
          .replace(/^\s*#\s*/, '')
          .replace(/^.*?步[：:]\s*/, '')
          .trim(),
      )
      .join(' ')
      .split('→')
      .map((s) => s.trim())
      .filter(Boolean);
    assert.equal(
      named.length,
      steps.length,
      `CONTRIBUTING 枚举了 ${named.length} 项（${named.join(' → ')}），而脚本有 ${steps.length} 步`,
    );
    named.forEach((item, i) => {
      // ⚠️ 这里比的是**给人看的描述**，不是命令原文：第 1 步写作 `typecheck + lint`，而那条命令
      //    是 `npm run typecheck && npx biome ci .`（**没有 `lint` 这个词**）。所以判据放宽到
      //    「该步的任一词命中」—— 能抓的是**顺序错 / 漏项**，抓不到措辞漂移。射程如实标注。
      const tokens = item
        .split('+')
        .map((t) => t.trim())
        .filter(Boolean);
      assert.ok(
        tokens.some((t) => steps[i].includes(t)),
        `CONTRIBUTING 说第 ${i + 1} 步是「${item}」，而脚本那一步是「${steps[i]}」—— ` +
          '这一项的词一个都没命中（多半是顺序被换过或漏了一项）',
      );
    });
  });

  it('CONTRIBUTING 的「CI 必须全绿才能合并」列表 == 真实必需检查集合', () => {
    const line = readRel('CONTRIBUTING.md')
      .split('\n')
      .find((l) => l.includes('必须全绿才能合并'));
    assert.ok(line, 'CONTRIBUTING.md 里找不到「CI 必须全绿才能合并」那句（它是合并契约）');
    const paren = /（([^）]*)）/.exec(line);
    assert.ok(paren, `那句里读不到括号列表：${line}`);
    const named = new Set(paren[1].replace(/[`\s]/g, '').split('·').filter(Boolean).map(norm));
    assert.deepEqual(
      [...named].sort(),
      [...requiredIds].sort(),
      'CONTRIBUTING 列的必需检查与 ci.yml 的真实集合不一致（多了幽灵 / 少了新 job）',
    );
  });

  it('CONTRIBUTING 的「本地过了但 CI 挂了」那行必须点名每一个 CI 独有检查', () => {
    const row = readRel('CONTRIBUTING.md')
      .split('\n')
      .find((l) => l.includes('本地过了') && l.includes('CI 挂了'));
    assert.ok(row, 'CONTRIBUTING.md 里找不到「本地过了但 CI 挂了」那行（坑表的第一道分流）');
    const t = norm(row);
    const missing = [...ciOnlyIds].filter((id) => !idRe(id).test(t));
    assert.deepEqual(
      missing,
      [],
      `这行没点名这些 CI 独有检查：${missing.join(' · ')} —— ` +
        '新加一个 CI 独有检查时，这行是「本地全绿为什么还会挂」的第一处提示。\n' +
        '  ⚠️ 本断言只查「有没有漏」这一个方向：反向（这行点名了不存在的 job）**没有**机器判据 —— ' +
        '因为同一行里还有 `verify-all.sh` 这类文件名，抠反引号会误报。',
    );
  });

  it('AGENTS.md 的 CI 段落必须点名每一个 job，且圈码数与 job 数一致', () => {
    const lines = readRel('AGENTS.md').split('\n');
    const at = lines.findIndex((l) => l.includes('.github/workflows/ci.yml') && l.includes('job'));
    assert.notEqual(
      at,
      -1,
      'AGENTS.md 里找不到 CI 段落锚点（含 `.github/workflows/ci.yml` 且含 `job` 的那行）',
    );
    let end = lines.length;
    for (let i = at + 1; i < lines.length; i++) {
      if (/^ {2}- /.test(lines[i])) {
        end = i;
        break;
      }
    }
    const para = norm(lines.slice(at, end).join('\n'));
    const marks = [...para.matchAll(/[①②③④⑤⑥⑦⑧⑨]/g)].length;
    assert.ok(marks >= 2, `CI 段落里只数到 ${marks} 个圈码 —— 解析锚点坏了`);
    assert.equal(
      marks,
      jobs.length,
      `AGENTS.md 的 CI 段落列了 ${marks} 项，而 ci.yml 有 ${jobs.length} 个 job —— ` +
        'AGENTS.md 是 agent 读的那份说明，数字过期会直接误导自动读者',
    );
    const missing = jobs.map((j) => j.id).filter((id) => !idRe(id).test(para));
    assert.deepEqual(missing, [], `AGENTS.md 的 CI 段落没点名这些 job：${missing.join(' · ')}`);
  });

  it('新文档一旦同时点名 3 个以上 CI job，就必须登记（兜底扫描）', () => {
    const EXEMPT: Array<{ re: RegExp; why: string }> = [
      { re: /^CHANGELOG\.md$/, why: '发版历史，只增不改' },
      { re: /^docs\/spec\.md$/, why: '决策日志（§10），只增不改' },
      {
        re: /^docs\/guards\.md$/,
        why: '注册表本身：行文必须点名 job；它的完整性由自己的元守卫管',
      },
      { re: /^docs\/plans\//, why: '带日期的计划存档，只增不改' },
      {
        re: /^docs\/reviews\//,
        why:
          '快照目录（docs/reviews/<日期>/）：正文记的是**当日读数**、只增不改，' +
          '引用口径见 docs/reviews/2026-09-28/README.md §0 —— 与 docs/plans/ 同类',
      },
    ];
    const registered = new Set(REQUIRED_LIST_FILES);
    const suspects = markdownInTree().filter((f) => {
      if (registered.has(f) || EXEMPT.some((e) => e.re.test(f))) return false;
      const t = norm(readRel(f));
      return jobs.filter((j) => idRe(j.id).test(t)).length >= 3;
    });
    assert.deepEqual(
      suspects,
      [],
      `这些文档同时点名了 3 个以上 CI job，但没人核过它们的抄写：${suspects.join(' · ')}\n` +
        '  ⇒ 二选一：① 加进本文件的 `REQUIRED_LIST_FILES` 并补一条断言；\n' +
        '     ② 加进上面的 `EXEMPT` 并给出理由（例如「只增不改的历史记录」）。\n' +
        '  ⚠️ 阈值是 3：只点名一两个 job 的文档扫不出来；`.gitignore` 里的路径也不在射程内 ——\n' +
        '     这是本兜底扫描的**已知射程**。',
    );
  });
});
