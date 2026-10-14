#!/usr/bin/env node
/**
 * 分支保护对拍 —— 仓内推导的「应有必需检查」↔ GitHub 上的「实际配置」。
 *
 * ## 为什么存在
 *
 * `tests/scripts/verify-all-wiring.test.ts` 守的是「仓内各处抄写互为一致」，但它有一条
 * **写明不收尾的盲区**（见那个文件的「固有盲区」）：GitHub 分支保护的实际配置在仓外，
 * 任何仓内守卫都够不着。于是「GitHub 上某个检查其实没被设为必需」这种漂移会**全绿地错下去**：
 *   · 少一条 ⇒ 那个 job 红着也能合入 main（2026-10-15 实例：`e2e-mcp-server` 一度不在
 *     保护里，是改保护时人工对出来的）；
 *   · 多一条（或留着已改名 job 的旧名字）⇒ 所有 PR 永久等一个不出现的检查 → 卡死。
 * 本脚本把「人工对一眼」变成一条命令。
 *
 * ## 为什么进不了 CI（hence 它是手动工具）
 *
 * 读分支保护要 repository 的 **administration** 读权限，而 Actions 的 `GITHUB_TOKEN`
 * **拿不到这个权限**（不在可授予清单里）⇒ CI 里跑不了，只能维护者本机跑（需 `gh auth`）。
 * ⚠️ 所以它**不是门禁**：没人跑它就照样瞎。**动分支保护（增删必需检查）后必须跑一次。**
 *
 * ## 推导逻辑（与那个测试同源，输入都是单源）
 *
 *   应有必需检查 = verify job 的 name ∪ `ci_only` 里每个 job 的 name（matrix 展开后）
 *   · `ci_only` 读 `scripts/verify-all.sh`（仓内单源）；
 *   · job 的 id / name / matrix 读 `.github/workflows/ci.yml`（仓内单源）；
 *   · matrix 展开：`name` 里的 `${{ matrix.<key> }}` 按该 job 的 matrix 取值笛卡尔积替换
 *     （`import-floor` ⇒ 「导入下限（Node 18）」「导入下限（Node 20）」两条）。
 * 推导逻辑在这里是**第二份实现**（测试里有一份）—— 它的输入全是单源；这份实现烂掉时
 * 对拍会当场红（缺 / 多），不会静默（变异电池见 `.workbuddy/probes/2026-10-15-*.mjs`）。
 *
 * ## 射程（如实标注）
 *
 * 核 `required_status_checks` 的**有效集** = `contexts`（classic 状态检查）∪ `checks`
 * （GitHub App 检查，app_id 15368 = Actions）—— GitHub 把同一个检查**记在两处**且通常同步
 * 维护；有效集取并集，两处不一致时额外响亮提示（那种不一致本身就是「有人只改了一处」的信号）。
 * 不在射程：`strict` / `enforce_admins` / `required_pull_request_reviews` 等 —— 那些是策略选择，
 * 且退化时不造成上面那两种静默失效（一个是「合前要最新」、一个是「管理员可绕过」）。
 *
 * ## 用法
 *
 *   node scripts/check-branch-protection.mjs                    # 对拍 main（需 gh 认证）
 *   node scripts/check-branch-protection.mjs --branch main
 *   node scripts/check-branch-protection.mjs --root <dir> --actual-file <fixture.json>
 *       ↑ 两个都是**测试缝**（变异验证用）：`--root` 指定仓内两份文件的读取根；
 *         `--actual-file` 从 JSON 读「实际配置」（数组，或
 *         `{contexts: […], checks: […], strict: …}` —— 即 gh 返回的 required_status_checks），
 *         跳过 gh。线上跑**不要**传它们。
 *
 * ## 退出码
 *
 *   0 = 一致    1 = 漂移（缺 / 多）    2 = 工具或输入错（gh 没认证、解析锚点烂了、夹具为空…）
 *   2 与 1 分开：锚点烂了时「红」的原因不是分支保护，别让人去改 GitHub。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

/** 工具 / 输入错（不是「分支保护漂了」）—— 与漂移的 1 分开，排查方向不混淆。 */
function fail2(msg) {
  console.error(`✖ ${msg}`);
  process.exit(2);
}

// ── 命令行 ────────────────────────────────────────────────────────────────
const USAGE =
  '用法：node scripts/check-branch-protection.mjs [--branch <名>] [--root <目录>] [--actual-file <夹具.json>]\n' +
  '  --branch       对拍哪个分支（缺省 main）\n' +
  '  --root         仓内文件读取根（缺省 = 本脚本所在的仓库根；**测试缝**，线上别传）\n' +
  '  --actual-file  从 JSON 读「实际配置」跳过 gh（**测试缝**，线上别传）';

const args = process.argv.slice(2);
const flags = {
  root: join(dirname(fileURLToPath(import.meta.url)), '..'),
  branch: 'main',
  actualFile: null,
};

for (let i = 0; i < args.length; ) {
  const a = args[i];
  if (a === '-h' || a === '--help') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  let matched = null; // { name, value, next }
  for (const name of ['root', 'branch', 'actual-file']) {
    const flag = `--${name}`;
    if (a === flag) {
      if (i + 1 >= args.length) fail2(`${flag} 缺值\n${USAGE}`);
      matched = { name, value: args[i + 1], next: i + 2 };
      break;
    }
    if (a.startsWith(`${flag}=`)) {
      matched = { name, value: a.slice(flag.length + 1), next: i + 1 };
      break;
    }
  }
  if (!matched) fail2(`不认识的参数：${a}\n${USAGE}`);
  if (matched.name === 'root') flags.root = matched.value;
  else if (matched.name === 'branch') flags.branch = matched.value;
  else flags.actualFile = matched.value;
  i = matched.next;
}

// ── 仓内两份单源 ─────────────────────────────────────────────────────────
function main() {
  let scriptSrc;
  let workflowSrc;
  try {
    scriptSrc = readFileSync(join(flags.root, 'scripts', 'verify-all.sh'), 'utf8');
    workflowSrc = readFileSync(join(flags.root, '.github', 'workflows', 'ci.yml'), 'utf8');
  } catch (err) {
    fail2(
      `读不到仓内文件（--root=${flags.root}）：${err.message}\n` +
        '  ⇒ 这个根得同时含 scripts/verify-all.sh 与 .github/workflows/ci.yml',
    );
  }

  /**
   * 从 `NAME=(` 到独立的 `)` 行之间，抽出所有**整行就是一个双引号/单引号字符串**的条目。
   * 与 `tests/scripts/verify-all-wiring.test.ts` 的解析器同款：认不出的写法**响亮失败**，
   * 不静默跳过（跳过的条目 = 清单里悄悄少一条，而那正是本脚本要防的漂移）。
   */
  function bashArray(src, name) {
    const lines = src.split('\n');
    const at = lines.findIndex((l) => l.includes(`${name}=(`));
    assert.notEqual(at, -1, `verify-all.sh 里找不到 \`${name}=(\` —— 解析锚点没了，先修它再跑`);
    const out = [];
    let closed = false;
    for (const l of lines.slice(at + 1)) {
      if (/^\s*\)\s*$/.test(l)) {
        closed = true;
        break;
      }
      const t = l.trim();
      if (t === '' || t.startsWith('#')) continue;
      const m = /^(?:"([^"]+)"|'([^']+)')\s*,?$/.exec(t);
      assert.ok(
        m,
        `\`${name}=(\` 里这行看不懂，而它**不能被静默跳过**：「${t}」\n` +
          '  ⇒ 数组条目只认整行的 `"…"` / `\'…\'`（尾逗号可选）。放宽解析前先想清楚：' +
          '跳过的条目 = 清单里悄悄少一条。',
      );
      out.push(m[1] ?? m[2]);
    }
    assert.ok(closed, `\`${name}=(\` 之后找不到独立的 \`)\` 行 —— 数组收尾锚点没了`);
    return out;
  }

  /** `ci.yml` 的 job：`jobs:` 之下**恰好两空格缩进**的 `id:` 行（注释不在字符类里）。 */
  function workflowJobs(src) {
    const lines = src.split('\n');
    const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
    assert.notEqual(jobsAt, -1, 'ci.yml 里找不到顶层的 `jobs:` —— 解析锚点没了');
    const raw = [];
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

  /** 去掉 YAML 标量首尾的成对引号；没有引号就原样返回。 */
  function unquote(s) {
    const t = s.trim();
    if (
      t.length >= 2 &&
      ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')))
    ) {
      return t.slice(1, -1);
    }
    return t;
  }

  /** `['18', '20']` 或 `[18, 20]` → ['18', '20']；裸标量 → [标量]。 */
  function parseFlowOrScalar(rest) {
    const t = rest.trim();
    if (t.startsWith('[')) {
      const end = t.lastIndexOf(']');
      if (end < 1) fail2(`matrix 的流式列表看不懂：「${t}」`);
      return t
        .slice(1, end)
        .split(',')
        .map((s) => unquote(s))
        .filter((s) => s !== '');
    }
    return [unquote(t)];
  }

  /**
   * 解析 job body 里的 `matrix:` 块 → Map<key, values[]>；没有 matrix 返回 null。
   * ⚠️ 见到 `include:` / `exclude:` **响亮失败**：那种矩阵的展开结果不是笛卡尔积，
   *    推不出检查名 —— 宁可红，不猜。
   */
  function parseMatrix(body) {
    const lines = body.split('\n');
    const at = lines.findIndex((l) => /^\s+matrix:\s*$/.test(l));
    if (at === -1) return null;
    const indent = /^\s*/.exec(lines[at])[0].length;
    const out = new Map();
    let currentKey = null;
    for (const l of lines.slice(at + 1)) {
      if (l.trim() === '') continue;
      if (/^\s*/.exec(l)[0].length <= indent) break;
      const t = l.trim();
      if (/^(include|exclude)\s*:/.test(t)) {
        fail2(
          `ci.yml 的 matrix 里出现了 \`${t.split(':')[0]}\` —— 那种矩阵的展开不是笛卡尔积，` +
            '本脚本推不出检查名。先在这里补它的展开规则，再跑。',
        );
      }
      const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(t);
      if (kv) {
        const [, key, rest] = kv;
        currentKey = rest === '' ? key : null;
        out.set(key, rest === '' ? [] : parseFlowOrScalar(rest));
        continue;
      }
      const item = /^-\s*(.+)$/.exec(t);
      if (item && currentKey !== null) {
        out.get(currentKey).push(unquote(item[1]));
        continue;
      }
      fail2(`matrix 块里这行看不懂：「${t}」—— 推不出检查名，响亮失败（不跳过）。`);
    }
    for (const [key, values] of out) {
      if (values.length === 0) fail2(`matrix 的键 \`${key}\` 解析出 0 个取值 —— 推不出检查名`);
    }
    return out;
  }

  /**
   * 展开 job 的 `name` 里的 `${{ matrix.<key> }}`（笛卡尔积）。
   * 没有 matrix 引用 ⇒ 返回 [name] 一个（GitHub 对显式 name 的 job 就报这一个检查名，
   * matrix 变体共享它）。
   */
  function expandName(job) {
    if (!job.name) {
      fail2(
        `ci.yml 的 job \`${job.id}\` 没有 \`name:\` —— 本脚本按显式 name 推导检查名，` +
          '没有 name 的 job 的检查名由 GitHub 生成，推不出。',
      );
    }
    const refs = [
      ...new Set(
        [...job.name.matchAll(/\$\{\{\s*matrix\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map(
          (m) => m[1],
        ),
      ),
    ];
    if (refs.length === 0) return [job.name];
    const matrix = parseMatrix(job.body);
    if (!matrix) {
      fail2(
        `job \`${job.id}\` 的 name 引用了 matrix（${refs.join(' · ')}），但 body 里没有 matrix 块`,
      );
    }
    const lists = refs.map((k) => {
      const v = matrix.get(k);
      if (!v || v.length === 0) {
        fail2(
          `job \`${job.id}\` 的 name 引用 \`matrix.${k}\`，但 matrix 块里没这个键（或有键无值）`,
        );
      }
      return v;
    });
    let combos = [[]];
    for (const list of lists) {
      const next = [];
      for (const c of combos) for (const v of list) next.push([...c, v]);
      combos = next;
    }
    return combos.map((values) => {
      let name = job.name;
      refs.forEach((k, idx) => {
        name = name.replaceAll(
          new RegExp(`\\$\\{\\{\\s*matrix\\.${k}\\s*\\}\\}`, 'g'),
          values[idx],
        );
      });
      return name;
    });
  }

  // ── 推导「应有必需检查」─────────────────────────────────────────────────
  const ciOnly = bashArray(scriptSrc, 'ci_only');
  const jobs = workflowJobs(workflowSrc);
  const verifyJob = jobs.find((j) => j.body.includes('scripts/verify-all.sh'));

  // 防真空：解析锚点烂了必须红，不能空转绿（与测试同款下限）。
  assert.ok(jobs.length >= 4, `从 ci.yml 只解析出 ${jobs.length} 个 job —— 解析锚点大概率失效了`);
  assert.ok(ciOnly.length >= 1, '`ci_only` 解析出 0 条 —— 要么清单被删空，要么解析失效');
  assert.ok(
    verifyJob,
    'ci.yml 里没有任何 job 跑 `scripts/verify-all.sh` —— 推导不出「本链 = 哪个检查」',
  );

  /** name → 来源（人话），顺序即推导顺序（verify 在前，ci_only 按清单顺序）。 */
  const expected = new Map();
  for (const n of expandName(verifyJob)) expected.set(n, 'verify job（跑 verify-all.sh 的那个）');
  for (const entry of ciOnly) {
    assert.match(
      entry,
      /^[A-Za-z0-9_-]+\|.+/,
      `ci_only 的这条不是 \`<job id>|<说明>\` 形状：「${entry}」—— 前两半截是给机器核对用的`,
    );
    const id = entry.split('|')[0];
    const job = jobs.find((j) => j.id === id);
    assert.ok(
      job,
      `ci_only 里的 \`${id}\` 在 ci.yml 里不存在 —— 幽灵条目（job 被改名或删掉了？）：「${entry}」\n` +
        '  ⇒ 这该由 tests/scripts/verify-all-wiring.test.ts 先抓到；它没红说明那个守卫也失效了。',
    );
    for (const n of expandName(job)) expected.set(n, `ci_only：${id}`);
  }
  assert.ok(
    expected.size >= 2,
    `只推导出 ${expected.size} 条应有检查 —— 不正常（verify + ci_only 至少两条），拒绝继续`,
  );

  // ── 拿「实际配置」────────────────────────────────────────────────────────
  /** 从 gh 读（线上路径）。失败 ⇒ exit 2：这是工具/权限问题，不是分支保护漂了。 */
  function fetchFromGh(root, branch) {
    let out;
    try {
      out = execFileSync(
        'gh',
        [
          'api',
          `repos/{owner}/{repo}/branches/${branch}/protection`,
          '--jq',
          '.required_status_checks',
        ],
        { cwd: root, encoding: 'utf8' },
      );
    } catch (err) {
      const detail = err.stderr ? String(err.stderr).trim() : err.message;
      fail2(
        `gh api 读分支保护失败：\n     ${detail}\n` +
          '  ⇒ 依次确认：gh 装了（gh --version）／认证了（gh auth status）／当前仓库的 ' +
          `${branch} 开着分支保护。这四项任一不满足都**不是**「必需检查配错了」。`,
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(out);
    } catch {
      fail2(`gh 返回的不是 JSON（前 200 字符）：${out.slice(0, 200)}`);
    }
    if (parsed === null) {
      fail2(
        `分支 ${branch} 的 protection.required_status_checks 是 null —— 它没要求任何检查。\n` +
          '  ⇒ 那不是「漂移」，是保护根本没配（或配在别的分支上）。先确认 --branch 指对了。',
      );
    }
    return parsed;
  }

  /** 从夹具 JSON 读（测试缝）。形状：数组，或 `{contexts: […], checks: […], strict: …}`。 */
  function readFixture(path) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      fail2(`--actual-file 读不懂：${err.message}`);
    }
    const obj = Array.isArray(parsed) ? { contexts: parsed } : parsed;
    if (!obj || !Array.isArray(obj.contexts)) {
      fail2('--actual-file 的形状得是 string[] 或 {contexts: string[]}');
    }
    return obj;
  }

  const actualObj = flags.actualFile
    ? readFixture(flags.actualFile)
    : fetchFromGh(flags.root, flags.branch);

  // 有效集 = contexts ∪ checks（GitHub 把同一个检查记两处）。两处不一致 ⇒ 响亮提示：
  // 通常该一致，不一致意味着有人只改了一处（这正是「对拍」要看的信号之一）。
  const classic = actualObj.contexts ?? [];
  const appChecks = Array.isArray(actualObj.checks)
    ? actualObj.checks.map((c) => c?.context).filter(Boolean)
    : [];
  const twoSidesAgree =
    classic.length === appChecks.length && classic.every((c) => appChecks.includes(c));
  if (!twoSidesAgree) {
    console.log('⚠️ contexts 与 checks 两份记录不一致 —— 有效集按并集算，但建议去仓库设置页核对：');
    console.log(`     contexts: ${JSON.stringify(classic)}`);
    console.log(`     checks:   ${JSON.stringify(appChecks)}`);
  }
  const actual = new Set([...classic, ...appChecks]);
  assert.ok(
    actual.size > 0,
    '「实际必需检查」是空的 —— 空集对空集会假绿，拒绝继续。' +
      '（若分支保护真的没配任何检查，那是配置事故，不是本脚本的「一致」。）',
  );

  // ── 对拍 ─────────────────────────────────────────────────────────────────
  const missing = [...expected.keys()].filter((n) => !actual.has(n));
  const extra = [...actual].filter((n) => !expected.has(n));

  if (missing.length === 0 && extra.length === 0) {
    console.log(`✓ 分支保护与仓内推导一致（${expected.size} 条必需检查，分支 ${flags.branch}）`);
    for (const [name, origin] of expected) console.log(`   · ${name}   ← ${origin}`);
    process.exit(0);
  }

  console.log('✖ 分支保护与仓内推导不一致');
  if (missing.length > 0) {
    console.log('\n  GitHub 里【缺少】这些必需检查 ⇒ 对应 job 红着也能合入 main：');
    for (const n of missing) console.log(`   · ${n}   ← ${expected.get(n)}`);
    console.log('\n  ⇒ 补上（窄端点，只加、不动其它字段；2026-10-15 实测可用）：');
    console.log(
      `     gh api --method POST repos/{owner}/{repo}/branches/${flags.branch}` +
        "/protection/required_status_checks/contexts --input - <<'EOF'",
    );
    console.log(`     ${JSON.stringify({ contexts: missing })}`);
    console.log('     EOF');
    console.log('  ⚠️ 若这个检查是**有意**不再要求的：改仓内那半 —— 从 ci_only 删掉它，');
    console.log('     并在 tests/scripts/verify-all-wiring.test.ts 的 EXEMPT 里带理由登记。');
  }
  if (extra.length > 0) {
    console.log('\n  GitHub 里【多出】这些检查 ⇒ PR 会永久等一个不出现的检查 → 卡死：');
    for (const n of extra) console.log(`   · ${n}`);
    console.log('\n  ⇒ 若多出的是**有意**设为必需的：改仓内那半 —— 加进 scripts/verify-all.sh');
    console.log(
      '     的 ci_only（并同步 tests/scripts/verify-all-wiring.test.ts 盯的那几处抄写）。',
    );
    console.log('     若不是有意的：删掉它。窄端点只能加不能删，删要整份替换');
    console.log('     （**整份替换语义**：跑前先 gh api 读现状存底，跑后逐字段对拍）：');
    console.log(
      `     gh api --method PATCH repos/{owner}/{repo}/branches/${flags.branch}` +
        "/protection/required_status_checks --input - <<'EOF'",
    );
    console.log(
      `     ${JSON.stringify({ strict: actualObj.strict !== false, contexts: [...expected.keys()] })}`,
    );
    console.log('     EOF');
    console.log('     ⚠️ 这条 PATCH 命令本仓**未实测**（2026-10-15 只实测过窄端点 POST）—— 照上面');
    console.log('        「先存底、后对拍」的纪律跑，别盲信。');
  }
  process.exit(1);
}

try {
  main();
} catch (err) {
  // 上面那些 assert 抛的是 AssertionError —— node 会原样甩栈并以 **exit 1** 退出，
  // 与「漂移」的 1 撞码（排查方向被指向 GitHub，而真因是仓内文件/夹具坏了）。
  // ⇒ 工具与输入错统一走 fail2 的 exit 2：消息给人话、不给栈。
  if (err && err.code === 'ERR_ASSERTION') {
    fail2(`仓内推导失败（这不是分支保护的问题）：\n  ${err.message}`);
  }
  throw err;
}
