import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { asset, discoverProviders, createApp, SystemPrompt, Tool } from '../../src/index.js';
import type { ClassProvider } from '../../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));

describe('discoverProviders（目录发现）', () => {
  it('类 / Provider / Provider[] 三种 default export 形态', async () => {
    const providers = await discoverProviders(`${fixtures}/capabilities`);
    const byToken = new Map(providers.map((p) => [p.provide, p]));
    // 类 → token = 文件夹名 + useClass
    assert.ok('useClass' in byToken.get('alpha')!);
    // Provider 对象 → 原样（自定义 token）
    assert.ok('useValue' in byToken.get('beta-custom')!);
    // Provider[] → 展开
    assert.ok(byToken.has('g1') && byToken.has('g2'));
    assert.equal(providers.length, 4);
  });

  it('目录不存在 → 明确报错', async () => {
    await assert.rejects(discoverProviders(`${fixtures}/nope`), /能力目录不存在/);
  });

  describe('能力类自带依赖声明（static deps，2026-10-16 ref-di-dup-loud）', () => {
    it('static deps 会被带上，且**真的注入**（不必把能力挪到显式 providers 再注册一遍）', async () => {
      const root = mkdtempSync(join(tmpdir(), 'agentia-static-deps-'));
      try {
        mkdirSync(join(root, 'needs-root'), { recursive: true });
        writeFileSync(
          join(root, 'needs-root', 'index.ts'),
          'export default class NeedsRoot {\n' +
            "  static readonly deps = ['WORKDIR'];\n" +
            '  constructor(public readonly root: string) {}\n' +
            '}\n',
        );
        const providers = await discoverProviders(root);
        // Provider 是三态联合 ⇒ 先按 ClassProvider 收窄再取 deps（直接取联合上的字段编译不过）
        const first = providers[0] as ClassProvider;
        assert.deepEqual(first.deps, ['WORKDIR'], 'discover 产出的 provider 要带 deps');

        // 端到端：注入真的发生（只钉 deps 字段的话，「记录了但没人用」照样绿）
        const app = await createApp({
          discover: root,
          providers: [{ provide: 'WORKDIR', useValue: '/injected/root' }],
          system: 'sys',
        });
        assert.equal(
          (app.container.resolve('needs-root') as { root: string }).root,
          '/injected/root',
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('static deps 形状写错 ⇒ 响亮报错（不当成「没有依赖」去无参构造）', async () => {
      const root = mkdtempSync(join(tmpdir(), 'agentia-bad-deps-'));
      try {
        mkdirSync(join(root, 'bad'), { recursive: true });
        writeFileSync(
          join(root, 'bad', 'index.ts'),
          "export default class Bad {\n  static readonly deps = 'WORKDIR';\n}\n",
        );
        await assert.rejects(discoverProviders(root), /static deps 必须是字符串数组/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('没有 static deps 的普通能力类 ⇒ 行为逐字不变（不加 deps 键）', async () => {
      const root = mkdtempSync(join(tmpdir(), 'agentia-no-deps-'));
      try {
        mkdirSync(join(root, 'plain'), { recursive: true });
        writeFileSync(join(root, 'plain', 'index.ts'), 'export default class Plain {}\n');
        const providers = await discoverProviders(root);
        const first = providers[0] as ClassProvider;
        // 逐字不变：只有 provide + useClass 两个键（多一个 deps 键也算形状变了）
        assert.deepEqual(Object.keys(first).sort(), ['provide', 'useClass']);
        assert.equal(first.provide, 'plain');
        assert.equal(typeof first.useClass, 'function');
        assert.equal('deps' in providers[0]!, false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it('数组形态：目录间顺序 = 入参数组顺序（不跨目录重排）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentia-multi-'));
    try {
      const a = join(root, 'a');
      const b = join(root, 'b');
      // a 里放 zulu、b 里放 alpha —— 目录内按名排序，目录间按入参顺序
      mkdirSync(join(a, 'zulu'), { recursive: true });
      writeFileSync(join(a, 'zulu', 'index.ts'), 'export default class Z {}\n');
      mkdirSync(join(b, 'alpha'), { recursive: true });
      writeFileSync(join(b, 'alpha', 'index.ts'), 'export default class A {}\n');

      assert.deepEqual(
        (await discoverProviders([a, b])).map((p) => p.provide),
        ['zulu', 'alpha'],
      );
      assert.deepEqual(
        (await discoverProviders([b, a])).map((p) => p.provide),
        ['alpha', 'zulu'],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('数组里任一目录不存在 → 报错（显式给出的搜索路径不该静默落空）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentia-multi-'));
    try {
      mkdirSync(join(root, 'real'), { recursive: true });
      await assert.rejects(discoverProviders([root, join(root, 'ghost')]), /能力目录不存在/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('跨目录重名 token → 留告警（装配期后者覆盖，菜单只会剩一个）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentia-dup-'));
    const warns: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => {
      warns.push(a.join(' '));
    };
    try {
      for (const d of ['tools', 'skills']) {
        mkdirSync(join(root, d, 'weather'), { recursive: true });
        writeFileSync(join(root, d, 'weather', 'index.ts'), 'export default class W {}\n');
      }
      const providers = await discoverProviders([join(root, 'tools'), join(root, 'skills')]);
      assert.equal(
        providers.length,
        2,
        '两个目录各产出一个 provider（覆盖发生在装配期，不是发现期）',
      );
      assert.ok(
        warns.some((w) => /重名能力 weather/.test(w)),
        `应留重名告警，实际: ${JSON.stringify(warns)}`,
      );
    } finally {
      console.warn = realWarn;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('非法 default export → 报出形态要求', async () => {
    await assert.rejects(
      discoverProviders(`${fixtures}/capabilities-broken`),
      /default export 形态非法/,
    );
  });

  it('入口加载失败 → 报出能力名与入口路径，并保留 cause', async () => {
    const dir = `${fixtures}/capabilities-loadfail`;
    const entry = join(fixtures, 'capabilities-loadfail', 'badcapability', 'index.ts');
    await assert.rejects(discoverProviders(dir), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /能力 badcapability 入口加载失败/);
      assert.ok(e.message.includes(entry), `错误信息应包含入口路径，实际: ${e.message}`);
      assert.ok(e.cause instanceof Error, '应把原始异常保留在 cause 上');
      return true;
    });
  });

  it('.ts 与编译产物并存：首选失败时回落下一候选并留告警', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentia-fallback-'));
    const warns: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => {
      warns.push(a.join(' '));
    };
    try {
      mkdirSync(join(root, 'dual'), { recursive: true });
      // .ts 入口在求值期抛错（模拟纯 node 选中了 .ts）；.mjs 是并存的可加载产物
      //（不用 index.js 当对照：tsx 会把 .js 说明符解析回 .ts，测不出回落）
      writeFileSync(join(root, 'dual', 'index.ts'), 'throw new Error("ts 入口加载不了");\n');
      writeFileSync(join(root, 'dual', 'index.mjs'), 'export default class Dual {}\n');

      const providers = await discoverProviders(root);
      assert.deepEqual(
        providers.map((p) => p.provide),
        ['dual'],
        '首选 .ts 失败后应回落 index.mjs 装配成功（tsx dev 下 .ts 仍是首选，顺序未变）',
      );
      assert.ok(
        warns.some((w) => /回落/.test(w) && w.includes('dual')),
        `回落必须留告警（命中的可能是陈旧编译产物），实际: ${JSON.stringify(warns)}`,
      );
    } finally {
      console.warn = realWarn;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('全部候选都加载失败 → 报错列出每个候选与各自原因', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentia-allfail-'));
    try {
      mkdirSync(join(root, 'broken'), { recursive: true });
      writeFileSync(join(root, 'broken', 'index.ts'), 'throw new Error("ts-boom");\n');
      writeFileSync(join(root, 'broken', 'index.mjs'), 'throw new Error("mjs-boom");\n');

      await assert.rejects(discoverProviders(root), (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /能力 broken 入口加载失败/);
        assert.ok(e.message.includes('index.ts'), `应列出 .ts 候选: ${e.message}`);
        assert.ok(e.message.includes('ts-boom'), `应带 .ts 的失败原因: ${e.message}`);
        assert.ok(e.message.includes('index.mjs'), `应列出 .mjs 候选: ${e.message}`);
        assert.ok(e.message.includes('mjs-boom'), `应带 .mjs 的失败原因: ${e.message}`);
        assert.ok(e.cause instanceof Error, '应把原始异常保留在 cause 上');
        return true;
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('软链目录（pnpm/monorepo）同样识别为能力目录', async () => {
    const real = mkdtempSync(join(tmpdir(), 'agentia-capability-'));
    const root = mkdtempSync(join(tmpdir(), 'agentia-capabilities-'));
    try {
      const capabilityDir = join(real, 'linked');
      mkdirSync(capabilityDir, { recursive: true });
      writeFileSync(join(capabilityDir, 'index.ts'), 'export default class Linked {}\n');
      symlinkSync(capabilityDir, join(root, 'linked'), 'dir');

      const providers = await discoverProviders(root);
      assert.deepEqual(
        providers.map((p) => p.provide),
        ['linked'],
        '软链目录不该被静默漏掉',
      );
    } finally {
      rmSync(real, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('无入口的目录：跳过但留告警（菜单少能力时可排查）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentia-capabilities-'));
    const warns: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => {
      warns.push(a.join(' '));
    };
    try {
      mkdirSync(join(root, 'assets'), { recursive: true });
      writeFileSync(join(root, 'assets', 'note.md'), 'x');
      mkdirSync(join(root, 'real'), { recursive: true });
      writeFileSync(join(root, 'real', 'index.ts'), 'export default class R {}\n');

      const providers = await discoverProviders(root);
      assert.deepEqual(
        providers.map((p) => p.provide),
        ['real'],
      );
      assert.equal(warns.length, 1);
      assert.match(warns[0], /\[agentia:discover\].*assets/);
    } finally {
      console.warn = realWarn;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('发现的能力可直接装配出菜单', async () => {
    const app = await createApp({
      discover: `${fixtures}/capabilities`,
      system: new SystemPrompt().add('role', 'r', true),
    });
    assert.deepEqual(
      app.tools.map((t) => t.name),
      ['alpha_tool'],
    );
    assert.equal(await app.tools[0].run({}), 'alpha');
  });

  it('discover + 显式 providers：同 token 时显式覆盖发现结果', async () => {
    class Explicit {
      @Tool({ description: 'd', schema: { type: 'object', properties: {} } })
      explicit_tool(): string {
        return 'explicit';
      }
    }
    const app = await createApp({
      discover: `${fixtures}/capabilities`,
      providers: [{ provide: 'alpha', useClass: Explicit }], // 显式声明应压过 capabilities/alpha/
      system: new SystemPrompt().add('role', 'r', true),
    });
    assert.deepEqual(
      app.tools.map((t) => t.name),
      ['explicit_tool'],
      'capabilities/ 下同名文件夹不得悄悄顶掉调用方手写的 provider',
    );
    assert.ok(app.container.resolve('alpha') instanceof Explicit);
  });
});

describe('asset（文本资产加载）', () => {
  it('相对调用模块读取文本', () => {
    const text = asset(import.meta.url, '../fixtures/asset.md');
    assert.ok(text.includes('fixture asset content'));
  });

  it('../ 越出调用方目录是有意放行（共享资产；rel 是开发者字面量）', () => {
    // 上面的用例本身就是 ../fixtures/... —— 越出 tests/toolkit/ 读共享夹具
    const text = asset(import.meta.url, '../fixtures/asset.md');
    assert.ok(text.length > 0);
  });

  it('带 scheme 的 rel 显式拒绝（new URL 会整个忽略 base，静默读到别处）', () => {
    assert.throws(() => asset(import.meta.url, 'file:///etc/passwd'), /必须是相对路径/);
    assert.throws(() => asset(import.meta.url, 'https://example.com/x.md'), /必须是相对路径/);
  });

  it('绝对路径的 rel 显式拒绝（与带 scheme 同一类：base 被整个忽略）', () => {
    // 反向验证（旧实现）：`new URL('/etc/passwd', 'file:///…/x.js')` 解析成
    // `file:///etc/passwd` —— base 的路径部分被整个丢掉，守卫只拦了 scheme，
    // 于是这一路直接走到 readFileSync（在 macOS 上**真能读到**，静默读了别处）。
    assert.throws(() => asset(import.meta.url, '/etc/passwd'), /必须是相对路径/);
    assert.throws(() => asset(import.meta.url, '//etc/passwd'), /必须是相对路径/);
    // Windows 反斜杠：`file:` 是 special scheme，`\` 会被规范化成 `/`，同样丢掉 base
    assert.throws(() => asset(import.meta.url, '\\etc\\passwd'), /必须是相对路径/);
    // 反向对照：`../` **不在此列**（它是相对 base 解析的，base 没被忽略）—— 仍放行
    assert.ok(asset(import.meta.url, '../fixtures/asset.md').includes('fixture asset content'));
  });
});

describe('discoverProviders（路径不是目录）', () => {
  it('路径是普通文件 → 明确报「不是文件夹」而非原始 ENOTDIR', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-notdir-'));
    const file = join(dir, 'plain.txt');
    writeFileSync(file, 'x');
    try {
      await assert.rejects(discoverProviders(file), /能力目录不是文件夹/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
