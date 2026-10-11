// 单测总入口：`npm test` 的唯一实现。
//
// 为什么是它而不是 package.json 里的 `&&` 串联：三段套件用 `&&` 连接时，
// 框架套件一挂，CLI 与 trace-view 套件**静默不跑** —— 而 packages/cli/test 里
// 恰好放着 harvest / diffTraces 的「移植副本逐字对拍」守卫，跳过它等于放掉防线；
// 且 verify-all.sh / CI 把 npm test 当单步，整条链上无人发现跳过。
//
// 本脚本依次 spawn 三个套件，**无论前面成败三个都跑完**，各自透传输出，
// 最后统一汇总并决定退出码。glob 参数原样传给 node --test（由 node 自己展开），
// 与原脚本行为一致；用 process.execPath 起手，不依赖 PATH 里的 node（Windows 同理）。

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 覆盖率棘轮走 c8（devDependency），**不是** node 内建的 --experimental-test-coverage：
// 后者在 `--import tsx`（loader hook）下整个失灵 —— 覆盖率报告不产出、阈值永不触发
// （实测：--test-coverage-lines=100 仍然 exit 0，门禁是死的）。c8 经
// NODE_V8_COVERAGE 收各子进程的原始 V8 覆盖率再按 source map 重映射，tsx 下可用。
// 阈值 = 棘轮防退化（阈值留 ~3pt 防抖余量 —— 2026-09-21 整体复核把分支/函数从 85/92 抬到
// 88/95：余量 6pt+ 时删掉一整个模块的测试都不触发），不是目标 —— 别追 100%，剩下的多是
// 防御性兜底，凑数测试 = 真空变绿。
// ⚠️ **水位写成日期**（不写「当前」）：它每次改 src 都会漂 —— 上一次记的「行 ~98.8 / 分支 ~91.7 /
// 函数 ~98.3」已经过期。
// 2026-10-11 ②（`#executeInner` 的结果记账外移 + 14 条直接单测）：
//   · **改前基线**（在 `HEAD` 上开独立 worktree 跑，里面只有改前那 353 条用例）
//     行 98.57 / 分支 92.82 / 函数 98.44
//   · **改后现测**（367 条用例）行 98.58 / 分支 92.85 / 函数 98.45
// 阈值按同一条纪律从水位推：**阈值 = 水位 − ~3pt 防抖余量**。
//   88 的余量 4.85pt 太宽（阈值离水位太远 = 放掉一整个模块的测试都不触发）⇒ 收到 **89**（余量 3.85pt）。
//   ⚠️ **为什么不收 90**：那只有 2.85pt，已经**低于** 3pt —— 会把正常抖动当退化报。
// **行 / 函数刻意不动**：行 95 的余量 3.58pt、函数 95 的余量 3.45pt，本来就在 ~3pt 上，再抬就贴水位。
// （新件 `transport/run-outcome.ts` 现测 100/100/100/100 —— 那 14 条单测确实把它的分支走遍了。）
// 只挂框架套件：CLI / trace-view 的产物不在 src/ 口径内。
const C8 = fileURLToPath(new URL('../node_modules/c8/bin/c8.js', import.meta.url));
const COVERAGE = {
  lines: 95,
  branches: 89,
  functions: 95,
};

const suites = [
  {
    name: '框架套件（tests/**/*.test.ts，含 c8 覆盖率棘轮）',
    args: [
      C8,
      '--check-coverage',
      '--lines',
      String(COVERAGE.lines),
      '--branches',
      String(COVERAGE.branches),
      '--functions',
      String(COVERAGE.functions),
      '--include',
      'src/**',
      '--reporter',
      'text',
      // c8 之后的参数是被测命令本身：node --import tsx --test …
      process.execPath,
      '--import',
      'tsx',
      '--test',
      'tests/**/*.test.ts',
    ],
  },
  {
    // ⚠️ **本套件测的是 `dist/`，不是 `src/`**（`test/dist-guard.mjs` 加 `../dist/*.js`）⇒
    // 「改了 `packages/cli/src` 就得先 `npm run build:cli`」这条**没有断言守**：
    // 产物陈旧时「新加的用例」会红（症状还算明显），但**源码里的错误不会被暴露**
    //（跑的是旧产物，绿得毫无意义）。`scripts/verify-all.sh` 的步序（步 5 build:cli →
    // 步 6 npm test）才是对的 —— **单独跑 `npm test` 不保证产物新鲜**。
    name: 'CLI 套件（packages/cli/test/*.test.mjs）',
    args: ['--test', 'packages/cli/test/*.test.mjs'],
  },
  {
    name: 'trace-view 套件（packages/trace-view/test/*.test.js）',
    args: ['--test', 'packages/trace-view/test/*.test.js'],
  },
];

// 依次跑完全部套件；任一失败不中断后续套件。
const results = [];
for (const suite of suites) {
  console.log(`\n========== ${suite.name} ==========`);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, suite.args, { stdio: 'inherit' });
    child.on('error', (err) => {
      console.error(`spawn 失败：${err.message}`);
      resolve(1);
    });
    child.on('close', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
  });
  results.push({ name: suite.name, code });
}

console.log('\n========== 套件汇总 ==========');
for (const { name, code } of results) {
  console.log(`${code === 0 ? 'OK ' : '✖ '} ${name}（exit ${code}）`);
}
const failed = results.filter(({ code }) => code !== 0);
if (failed.length > 0) {
  console.error(`\n✖ ${failed.length} 个套件失败：${failed.map(({ name }) => name).join('、')}`);
  process.exit(1);
}
console.log('\nOK  三个套件全部通过');
