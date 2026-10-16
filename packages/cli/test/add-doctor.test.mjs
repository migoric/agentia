import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { distReadyOrLoud } from './dist-guard.mjs';

/* 对构建产物测试（未构建时本地醒目警告+跳过、CI 判失败 —— 不许静默 skip）。 */
const DIST = fileURLToPath(new URL('../dist/add.js', import.meta.url));
let resolvePackageName = null;
let doctor = null;
let generateCapability = null;
if (distReadyOrLoud(DIST, 'packages/cli/dist/add.js ')) {
  ({ resolvePackageName } = await import(new URL('../dist/add.js', import.meta.url).href));
  ({ doctor } = await import(new URL('../dist/doctor.js', import.meta.url).href));
  ({ generateCapability } = await import(new URL('../dist/generate.js', import.meta.url).href));
}
const SKIP = !resolvePackageName ? '未构建 packages/cli/dist —— 先跑 npm run build:cli' : false;

/* 版本号单源（与 CLI 同一个 dist 模块）—— 版本漂移闸要拿它构造「同一版」的标记 */
let readCliVersion = null;
if (!SKIP) {
  ({ readCliVersion } = await import(new URL('../dist/version.js', import.meta.url).href));
}

describe('add.resolvePackageName', { skip: SKIP }, () => {
  it('file: 协议本地路径 → 解析出 package.json 的 name（原实现把 file:./pkg 当包名）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-pkg-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-capabilities' }));
      assert.equal(resolvePackageName(`file:${dir}`), 'my-capabilities');
      assert.equal(resolvePackageName(dir), 'my-capabilities'); // 裸绝对路径同样可解析
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('npm 包名：去版本后缀、保留 scope', () => {
    assert.equal(resolvePackageName('@scope/foo@1.2.3'), '@scope/foo');
    assert.equal(resolvePackageName('plain@2.0.0'), 'plain');
    assert.equal(resolvePackageName('plain'), 'plain');
  });
});

describe('doctor 能力入口候选（与框架 discover 的源码级对拍）', () => {
  // doctor 不 import 框架代码（CLI 零运行时依赖），ENTRY_CANDIDATES 是双写 ——
  // 与 harvest / diff 的移植副本同款风险，这里钉源码级逐字对拍（不依赖构建产物，不进 SKIP 闸）。
  it('CLI doctor 与框架 discover 的 ENTRY_CANDIDATES 数组字面量逐字相等', () => {
    const cliSrc = readFileSync(new URL('../src/doctor.ts', import.meta.url), 'utf8');
    const fwSrc = readFileSync(
      new URL('../../../src/toolkit/discover.ts', import.meta.url),
      'utf8',
    );
    const pick = (s) => s.match(/ENTRY_CANDIDATES = \[[^\]]*\]/)?.[0];
    const a = pick(cliSrc);
    const b = pick(fwSrc);
    assert.ok(a, 'packages/cli/src/doctor.ts 里没找到 ENTRY_CANDIDATES 声明（防真空变绿）');
    assert.ok(b, 'src/toolkit/discover.ts 里没找到 ENTRY_CANDIDATES 声明（防真空变绿）');
    assert.equal(
      a,
      b,
      'doctor 的入口候选与框架 discover 漂移了 —— 改一侧必须同步另一侧（双写，无单源）',
    );
  });
});

describe('doctor 能力入口候选', { skip: SKIP }, () => {
  it('index.js 入口的能力不算「缺少入口文件」（与框架 ENTRY_CANDIDATES 一致）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-doctor-'));
    const cwd = process.cwd();
    try {
      mkdirSync(join(dir, 'src', 'tools', 'thumb'), { recursive: true });
      writeFileSync(join(dir, 'src', 'tools', 'thumb', 'index.js'), 'export default class {}');
      process.chdir(dir);
      // 未登记只是「警告」，入口齐全 → 无 error → 返回 0
      assert.equal(doctor(), 0);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('老布局（根 units/ + units.ts）→ 明确提示迁移，而不是去扫不存在的新布局', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-doctor-legacy-'));
    const cwd = process.cwd();
    const logs = [];
    const realLog = console.log;
    console.log = (...a) => {
      logs.push(a.join(' '));
    };
    try {
      mkdirSync(join(dir, 'units', 'echo'), { recursive: true });
      writeFileSync(join(dir, 'units', 'echo', 'index.ts'), 'export default class {}');
      writeFileSync(join(dir, 'units.ts'), 'export const providers = [];');
      process.chdir(dir);
      const code = doctor();
      process.exitCode = undefined;
      assert.equal(code, 0, '老布局只是警告，不是错误');
      const out = logs.join('\n');
      assert.ok(out.includes('老布局'), `应提示老布局，实际:\n${out}`);
      assert.ok(out.includes('src/registry.ts'), '提示里应给出迁移落点');
    } finally {
      console.log = realLog;
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('老布局下 agentia g 拒绝写入（不悄悄在旁边长出新目录）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-gen-legacy-'));
    const cwd = process.cwd();
    const realErr = console.error;
    console.error = () => {};
    try {
      mkdirSync(join(dir, 'units'), { recursive: true });
      writeFileSync(join(dir, 'units.ts'), 'export const providers = [];');
      process.chdir(dir);
      const code = generateCapability('tool', 'echo');
      process.exitCode = undefined;
      assert.equal(code, 1, '老布局下应拒绝生成');
      assert.ok(!existsSync(join(dir, 'src')), '不应新建 src/ —— 否则项目里会同时存在两套能力目录');
    } finally {
      console.error = realErr;
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('跨分类目录同名 → 判为错误（四个目录共用一套 DI token，装配期只会留一个）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-doctor-dup-'));
    const cwd = process.cwd();
    try {
      for (const d of ['tools', 'skills']) {
        mkdirSync(join(dir, 'src', d, 'weather'), { recursive: true });
        writeFileSync(join(dir, 'src', d, 'weather', 'index.ts'), 'export default class {}');
      }
      process.chdir(dir);
      const code = doctor();
      process.exitCode = undefined; // doctor 发现错误时会置 exitCode：别让它污染测试进程
      assert.equal(code, 1, '跨目录同名应判为错误');
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('doctor 注册表 import 识别（不再只认 default import）', { skip: SKIP }, () => {
  /** 在临时项目里写一份注册表，跑 doctor 并捕获输出 */
  function doctorOutput(registryContent) {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-doctor-imports-'));
    const cwd = process.cwd();
    const logs = [];
    const realLog = console.log;
    console.log = (...a) => {
      logs.push(a.join(' '));
    };
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'registry.ts'), registryContent);
      process.chdir(dir);
      doctor();
      process.exitCode = undefined;
      return logs.join('\n');
    } finally {
      console.log = realLog;
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('named import 也能定位来源：悬空条目被警告（此前被静默跳过）', () => {
    // 原正则只认 `import Foo from`，named / namespace 形态下 imports 查不到 →
    // 「无法定位 import，跳过」→ 悬空条目漏检
    const out = doctorOutput(`import { Hello } from './tools/hello/index.js';
import type { Provider } from '@migor/agentia';
export const providers: Provider[] = [
  { provide: 'hello', useClass: Hello },
];
`);
    assert.ok(out.includes('悬空条目'), `named import 应检出悬空条目，实际:\n${out}`);
  });

  it('namespace / default+named 混合 / 双引号同样识别', () => {
    for (const importLine of [
      "import * as Hello from './tools/hello/index.js';",
      "import Base, { Hello } from './tools/hello/index.js';",
      'import Hello from "./tools/hello/index.js";',
      "import {\n  Hello,\n} from './tools/hello/index.js';",
    ]) {
      const out = doctorOutput(`${importLine}
export const providers = [
  { provide: 'hello', useClass: Hello },
];
`);
      assert.ok(out.includes('悬空条目'), `应检出悬空条目（${importLine}），实际:\n${out}`);
    }
  });

  it('别名绑定按别名解析（useClass 写的是别名）', () => {
    const out = doctorOutput(`import { Orig as Hello } from './tools/hello/index.js';
export const providers = [
  { provide: 'hello', useClass: Hello },
];
`);
    assert.ok(out.includes('悬空条目'), `别名绑定应检出悬空条目，实际:\n${out}`);
  });
});

describe('doctor trace 出口闸（2026-10-16 ref-scaffold-observability-gap）', { skip: SKIP }, () => {
  /** 写一份 src/app.ts（可含 sinks 也可不含），跑 doctor 并捕获输出 */
  function appDoctorOutput(appTs) {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-doctor-sinks-'));
    const cwd = process.cwd();
    const logs = [];
    const realLog = console.log;
    console.log = (...a) => {
      logs.push(a.join(' '));
    };
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'app.ts'), appTs);
      process.chdir(dir);
      doctor();
      process.exitCode = undefined;
      return logs.join('\n');
    } finally {
      console.log = realLog;
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('app.ts 未配 sinks ⇒ 警告（trace 没有任何出口，异步任务的 trace 躺在库里没人导出）', () => {
    const out = appDoctorOutput(`import { createApp } from '@migor/agentia';
export async function createAgentApp() {
  return createApp({ name: 'x', system: 'sys' });
}
`);
    assert.ok(out.includes('未配 sinks'), `应警告 trace 无出口，实际:\n${out}`);
    assert.ok(out.includes('/tasks'), '警告要说清后果落在哪条路（异步任务）');
  });

  it('已配 sinks ⇒ 不算警告，且进 ok 清单（出声闸不得误报）', () => {
    const out = appDoctorOutput(`import { createApp, jsonlTraceSink } from '@migor/agentia';
export async function createAgentApp() {
  return createApp({ name: 'x', system: 'sys', sinks: [jsonlTraceSink({ path: 't.jsonl' })] });
}
`);
    assert.ok(!out.includes('未配 sinks'), `已配出口不该警告，实际:\n${out}`);
    assert.ok(out.includes('已配 trace 出口'), '应进 ok 清单');
  });

  it('整行注释掉的 sinks 仍然算「没接上」（判据只认代码里的）', () => {
    const out = appDoctorOutput(`import { createApp } from '@migor/agentia';
export async function createAgentApp() {
  return createApp({
    name: 'x',
    system: 'sys',
    // sinks: [jsonlTraceSink({ path: 't.jsonl' })],
  });
}
`);
    assert.ok(out.includes('未配 sinks'), `注释掉 = 出口没接上，应警告，实际:\n${out}`);
  });
});

describe('doctor AGENTS.md 版本漂移闸（2026-10-16 ref-scaffold-observability-gap）', {
  skip: SKIP,
}, () => {
  /** 写一份项目根 AGENTS.md，跑 doctor 并捕获输出 */
  function guideDoctorOutput(agentsMd) {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-doctor-guide-'));
    const cwd = process.cwd();
    const logs = [];
    const realLog = console.log;
    console.log = (...a) => {
      logs.push(a.join(' '));
    };
    try {
      writeFileSync(join(dir, 'AGENTS.md'), agentsMd);
      process.chdir(dir);
      doctor();
      process.exitCode = undefined;
      return logs.join('\n');
    } finally {
      console.log = realLog;
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('无版本标记 ⇒ 警告（旧版脚手架 / 手写 ⇒ 对不出是否同版）', () => {
    const out = guideDoctorOutput('# Agentia 使用说明\n\n正文\n');
    assert.ok(out.includes('没有版本标记'), `无标记应警告，实际:\n${out}`);
    assert.ok(out.includes('v' + readCliVersion()), '警告要给出当前 CLI 版本，否则无从判断');
  });

  it('标记与 CLI 不同 ⇒ 警告「说明可能已过期」（AI 正是照它写代码）', () => {
    const out = guideDoctorOutput('<!-- agentia-guide-version: 0.0.1 -->\n# 说明\n');
    assert.ok(out.includes('已过期'), `版本漂移应警告，实际:\n${out}`);
    assert.ok(out.includes('0.0.1'), '要说清是哪一版写的');
  });

  it('标记与 CLI 同版 ⇒ 进 ok 清单（出声闸不得误报）', () => {
    const out = guideDoctorOutput(`<!-- agentia-guide-version: ${readCliVersion()} -->\n# 说明\n`);
    assert.ok(!out.includes('已过期'), `同版不该警告，实际:\n${out}`);
    assert.ok(out.includes('版本标记与 CLI 一致'), '应进 ok 清单');
  });
});
