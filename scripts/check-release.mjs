#!/usr/bin/env node
/**
 * 发版一致性自检 —— 把**整个发布面**在**发布前**钉死。
 *
 * 发布面定义在 `scripts/release-surface.mjs`（替换面 + 3 项结构面的唯一真源）。这里只做
 * 「跑一遍 + 加一条网络闸门 + 决定退出码」。
 *
 * 为什么挂在 `prepublishOnly` 而不是 `verify-all`：未发布窗口内 `AGENTIA_VERSION` 是
 * **有意落后**于 package.json 的（包版本先行，发布时同步 —— 见官网 API 页对该常量的说明）。
 * 所以这项检查只在**真发**时生效：忘了 bump 就发不出去，而不会在平时把全链弄红。
 *
 * 覆盖的漏点（每一项都是真实发生过的）：
 *   - 使用者能读到的版本常量 / 脚手架装到的框架版本 / 官网用的渲染器版本 → 版本漂移
 *   - `examples/` 的 `^旧版` pin（含 Dockerfile **注释**里那份，按扩展名过滤必扫不到）
 *   - `.github/ISSUE_TEMPLATE/*.yml` 的版本占位 / README 版本行 / roadmap 状态行
 *   - `package-lock.json` 的 version 字段（手改 manifest 却整轮漏掉 lock）
 *   - 本版 CHANGELOG 条目与链接引用（发了版却没有变更记录）
 *   - **bump 闸门**：要发的版本必须高于 npm 已发布版本（查官方 registry；E404 = 首发，放行）
 *
 * 用法：
 *   node scripts/check-release.mjs                    # 全跑（含网络闸门，即根包 prepublishOnly 的行为）
 *   node scripts/check-release.mjs --package @migor/cli
 *                                                     # 工作区包发布时指定要查 registry 的包名
 *   node scripts/check-release.mjs --offline          # 跳过网络闸门（无网 / 测试）
 *   node scripts/check-release.mjs --allow-pending    # CHANGELOG 正文未填降级为警告
 *                                                     #   （release.mjs bump 刚跑完就是这状态）
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SURFACES, STRUCTURAL, checkSurfaces, compareSemver } from './release-surface.mjs';

// 从脚本位置推仓库根 —— 不要硬编码绝对路径（CI / 他人机器上必挂）。
// 也正因为这样，测试可以把本脚本连同 release-surface.mjs 一起拷进夹具目录，
// 它就自然把夹具当仓库根（见 tests/scripts/release-scripts.test.ts）。
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

/** 网络闸门：要发的版本必须**高于** npm 已发布版本。返回问题字符串或 null。 */
function publishedGate(v, packageName) {
  let published = null;
  try {
    published = execFileSync(
      'npm',
      ['view', packageName, 'version', '--registry=https://registry.npmjs.org'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch (e) {
    const stderr = String(e?.stderr ?? e);
    if (!stderr.includes('E404')) {
      return `查询 ${packageName} 已发布版本失败（发布需要网络）：${stderr.slice(0, 200)}`;
    } // E404 = 从未发布过（首发），放行
  }
  if (published && compareSemver(v, published) <= 0) {
    return `要发的 ${packageName}@${v} 不高于 npm 已发布的 ${published} —— 先 bump 再发（破坏性变更走 minor）`;
  }
  return null;
}

const argv = process.argv.slice(2);
const flags = new Set(argv);
const packageFlag = argv.indexOf('--package');
const packageName = packageFlag >= 0 ? (argv[packageFlag + 1] ?? '') : '@migor/agentia';
if (packageFlag >= 0 && packageName === '') {
  console.error('--package 需要一个包名（如 @migor/agentia-pg）');
  process.exit(1);
}
const { problems, warnings } = checkSurfaces(root, version, {
  allowPending: flags.has('--allow-pending'),
});

// 网络闸门：要发的版本必须**高于** npm 已发布版本 —— 只验一致不验高低时，
// 破坏性变更可能压在旧版本号上发出去（0.6.0 窗口真踩过）。挂 prepublishOnly（发布必有网络）。
if (!flags.has('--offline')) {
  const g = publishedGate(version, packageName);
  if (g) problems.push(g);
}

for (const w of warnings) console.warn(`  ⚠ ${w}`);
if (problems.length) {
  console.error(`发版自检未通过（根包版本 ${version}）：`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(
    '\n提示：未发布窗口内 AGENTIA_VERSION 落后是正常的 —— 这一项只在**发布时**要求一致。',
  );
  process.exit(1);
}
const net = flags.has('--offline') ? '（未查 registry：--offline）' : '，且高于 npm 已发布版本';
console.log(
  `发版自检通过：${version}（${SURFACES.length} 项发布面 + ${STRUCTURAL.length} 项结构面一致${net}）`,
);
