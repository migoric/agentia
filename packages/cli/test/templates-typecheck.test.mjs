import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distReadyOrLoud } from './dist-guard.mjs';

/**
 * 模板 ↔ 框架的**编译级**对拍（2026-10-16 ref-scaffold-observability-gap）。
 *
 * 补的是哪一类漏：`templates.test.mjs` 断言的是模板**文本**的约定（且讲究地先剥注释），
 * 但没人证明「用模板建出来的工程**编译得过**」。于是框架改了 API 形状、而模板还是旧写法时，
 * 文本断言全绿、CI 全绿，**第一个发现的人是 npm install 完的用户**。
 * 本用例把那一步搬进门禁：真建一个工程 → 真跑 tsc。
 *
 * ⚠️ 两条前置（与 `dist-guard.mjs` 那条同族）：
 *   ① CLI 测的是 `dist/` ⇒ 改了 `packages/cli/src|templates` 必须先 `npm run build:cli`；
 *   ② 脚手架 `import '@migor/agentia'` ⇒ 框架也必须先 `npm run build`（`dist/index.d.ts`）。
 *      CI 里 build 先于 test，本地单独跑本文件请先跑那两条。
 */

const DIST = fileURLToPath(new URL('../dist/create.js', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

let createProject = null;
if (distReadyOrLoud(DIST, 'packages/cli/dist/create.js')) {
  ({ createProject } = await import(new URL('../dist/create.js', import.meta.url).href));
}
const SKIP = !createProject ? '未构建 packages/cli/dist —— 先跑 npm run build:cli' : false;

describe('模板工程的编译级对拍（建工程 → tsc --noEmit）', { skip: SKIP }, () => {
  it('脚手架建出来的工程对框架类型 typecheck 全绿', () => {
    const fwTypes = join(REPO_ROOT, 'dist', 'index.d.ts');
    assert.ok(
      existsSync(fwTypes),
      `找不到 ${fwTypes} —— 先 npm run build（本用例把 @migor/agentia 指向框架仓库，靠它的 dist 类型）`,
    );
    const tsc = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    assert.ok(existsSync(tsc), `找不到 ${tsc}`);

    const parent = mkdtempSync(join(tmpdir(), 'agentia-tpl-tsc-'));
    const realLog = console.log;
    const realErr = console.error;
    console.log = () => {}; // createProject 会打一大段「后续步骤」，别污染 TAP 输出
    console.error = () => {};
    try {
      assert.equal(createProject('demo', parent), 0, 'createProject 应成功');
      const proj = join(parent, 'demo');

      // 依赖解析：**不 npm install**（不依赖网络、不拖慢门禁）—— 把框架仓库与 @types
      // 直接链进工程。Node/tsc 的解析规则照常生效，等价于装好了那两个包。
      const nm = join(proj, 'node_modules');
      mkdirSync(join(nm, '@migor'), { recursive: true });
      symlinkSync(REPO_ROOT, join(nm, '@migor', 'agentia'), 'dir');
      symlinkSync(join(REPO_ROOT, 'node_modules', '@types'), join(nm, '@types'), 'dir');

      let out = '';
      try {
        out = execFileSync(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.json'], {
          cwd: proj,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        assert.fail(
          `模板工程类型检查失败（模板与框架 API 对不上）：\n` +
            `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`,
        );
      }
      assert.ok(!/error TS/.test(out), `tsc 输出里出现了 error TS（模板没编译过）：\n${out}`);
    } finally {
      console.log = realLog;
      console.error = realErr;
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
