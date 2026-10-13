import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Tool,
  SubAgent,
  Skill,
  Prompt,
  collectTools,
  collectSubAgents,
  collectSkills,
  collectPrompts,
} from '../../src/index.js';
import { capabilityName } from '../../src/toolkit/collect.js';

const OBJ = { type: 'object', properties: {} } as const;

describe('collect*（装饰器能力收集）', () => {
  it('@Tool：收集方法、绑定 this、schema/strict 透传', async () => {
    class T {
      prefix = 'p';
      @Tool({ description: 'd', schema: OBJ, strict: true })
      my_tool(): string {
        return `${this.prefix}:ok`;
      }
    }
    const tools = collectTools(new T());
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'my_tool');
    assert.equal(tools[0].strict, true);
    assert.equal(await tools[0].run({}), 'p:ok');
  });

  it('@Tool：approval 声明透传到 AgentTool（HITL）；未声明则无该字段', async () => {
    class T {
      @Tool({ description: 'd', schema: OBJ, approval: 'required' })
      dangerous(): string {
        return 'x';
      }

      @Tool({ description: 'd', schema: OBJ })
      safe(): string {
        return 'y';
      }
    }
    const tools = collectTools(new T());
    assert.equal(tools.find((t) => t.name === 'dangerous')?.approval, 'required');
    assert.equal(tools.find((t) => t.name === 'safe')?.approval, undefined);
  });

  it('继承：父类装饰方法进入子类实例菜单', () => {
    class P {
      @Tool({ description: 'd', schema: OBJ })
      base_tool(): string {
        return 'base';
      }
    }
    class C extends P {}
    assert.deepEqual(
      collectTools(new C()).map((t) => t.name),
      ['base_tool'],
    );
  });

  it('override 语义：子类未装饰的 override 继承父类 spec 且调到子类实现', async () => {
    class P {
      @Tool({ description: 'd', schema: OBJ })
      my_tool(): string {
        return 'parent';
      }
    }
    class C extends P {
      override my_tool(): string {
        return 'child';
      }
    }
    const tools = collectTools(new C());
    assert.equal(tools.length, 1);
    assert.equal(await tools[0].run({}), 'child');
  });

  it('override 语义：@Skill / @Prompt 也调到子类实现（不绕过未装饰的 override）', async () => {
    class P {
      @Skill({ description: 'd' })
      async run_skill(): Promise<string> {
        return 'parent-skill';
      }

      @Prompt({ description: 'd' })
      asset(): string {
        return 'parent-asset';
      }
    }
    class C extends P {
      override async run_skill(): Promise<string> {
        return 'child-skill';
      }
      override asset(): string {
        return 'child-asset';
      }
    }
    const inst = new C();

    const skills = collectSkills(inst);
    assert.equal(skills.length, 1, '父类 spec 继承，只出一个能力');
    assert.equal(
      await skills[0].invoke(
        {},
        { llm: async () => ({ text: '', stopReason: 'end_turn' as const }) },
      ),
      'child-skill',
      '必须调用实例上的实现',
    );

    const prompts = collectPrompts(inst);
    assert.equal(prompts.length, 1);
    assert.equal(await prompts[0].run({}), 'child-asset');
  });

  it('@SubAgent / @Skill / @Prompt 各自收集出能力', async () => {
    class M {
      @SubAgent({ description: 'd', schema: OBJ, system: 's' })
      reviewer(_input: unknown): void {}

      @Skill({ description: 'd' })
      async writer(
        _input: unknown,
        ctx: { llm(o: { prompt: string }): Promise<{ text: string }> },
      ) {
        const r = await ctx.llm({ prompt: 'x' });
        return r.text;
      }

      @Prompt({ description: 'd' })
      asset(): string {
        return 'volatile';
      }

      @Prompt({ description: 'd2', name: 'brand' })
      static brand(): string {
        return 'const';
      }
    }
    const inst = new M();
    const subs = collectSubAgents(inst);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].name, 'reviewer');

    const skills = collectSkills(inst);
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, 'writer');
    const out = await skills[0].invoke(
      {},
      { llm: async () => ({ text: 'llm-done', stopReason: 'end_turn' as const }) },
    );
    assert.equal(out, 'llm-done');

    const prompts = collectPrompts(inst);
    assert.deepEqual(prompts.map((p) => p.name).sort(), ['asset', 'brand']);
    assert.equal(await prompts.find((p) => p.name === 'brand')!.run({}), 'const');
  });

  it('装饰器拒绝非方法目标', () => {
    assert.throws(
      () => Tool({ description: 'd', schema: OBJ })(() => {}, { kind: 'field', name: 'x' }),
      /只能修饰类方法/,
    );
  });

  it('四类装饰器都拒绝私有方法（#method 会被收集器静默漏掉）', () => {
    // 直接以标准 context 形态调用（私有方法的 kind 同样是 'method'，只是 private: true）
    const ctx = { kind: 'method', name: '#secret', private: true };
    assert.throws(() => Tool({ description: 'd', schema: OBJ })(() => {}, ctx), /不支持私有方法/);
    assert.throws(() => Skill({ description: 'd' })(() => {}, ctx), /不支持私有方法/);
    assert.throws(
      () => SubAgent({ description: 'd', schema: OBJ, system: 's' })(() => {}, ctx),
      /不支持私有方法/,
    );
    assert.throws(() => Prompt({ description: 'd' })(() => {}, ctx), /不支持私有方法/);

    // 非私有的实例方法照常登记
    assert.doesNotThrow(() =>
      Tool({ description: 'd', schema: OBJ })(() => {}, {
        kind: 'method',
        name: 'x',
        private: false,
      }),
    );
  });

  it('@Tool / @SubAgent / @Skill 装饰期拒绝静态方法（收集只扫实例原型链）；@Prompt 是唯一例外', () => {
    // 直接以标准 context 形态调用（静态方法的 kind 同样是 'method'，只是 static: true）
    const ctx = { kind: 'method', name: 'x', static: true };
    assert.throws(() => Tool({ description: 'd', schema: OBJ })(() => {}, ctx), /不支持静态方法/);
    assert.throws(() => Skill({ description: 'd' })(() => {}, ctx), /不支持静态方法/);
    assert.throws(
      () => SubAgent({ description: 'd', schema: OBJ, system: 's' })(() => {}, ctx),
      /不支持静态方法/,
    );
    // @Prompt 的静态收集是显式支持形态（prompt.ts 扫构造函数链）
    assert.doesNotThrow(() => Prompt({ description: 'd' })(() => {}, ctx));
  });

  it('真实装饰器路径：静态 @Tool 在类定义期即抛（不等到装配）', () => {
    assert.throws(() => {
      // biome-ignore lint/complexity/noStaticOnlyClass: 测试夹具 —— 被测的正是这个形态
      class BadStatic {
        @Tool({ description: 'd', schema: OBJ })
        static hidden_tool(): string {
          return 'x';
        }
      }
      return BadStatic;
    }, /@Tool 不支持静态方法/);
  });

  it('多层级继承：中间层未装饰 override 继承祖父 spec 且调到中间层实现', async () => {
    class G {
      @Tool({ description: 'd', schema: OBJ })
      x(): string {
        return 'grand';
      }
    }
    class M extends G {
      override x(): string {
        return 'middle';
      }
    }
    class C extends M {}
    const tools = collectTools(new C());
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'x');
    assert.equal(await tools[0].run({}), 'middle');
  });

  it('多层级继承：中间层装饰 override 用自己的 spec，祖父不重复命中', () => {
    class G {
      @Tool({ description: 'g', schema: OBJ })
      x(): string {
        return 'grand';
      }
    }
    class M extends G {
      @Tool({ description: 'm', schema: OBJ, name: 'mid_tool' })
      override x(): string {
        return 'middle';
      }
    }
    class C extends M {}
    const tools = collectTools(new C());
    assert.equal(tools.length, 1, '同名装饰方法只命中最近一层');
    assert.equal(tools[0].name, 'mid_tool');
    assert.equal(tools[0].description, 'm');
  });

  it('非函数原型成员与同名 getter 不干扰收集', async () => {
    // 同名 getter（accessor 描述符无 value）：跳过且不标 seen，父类 spec 继续生效
    class P {
      @Tool({ description: 'd', schema: OBJ })
      thing(): string {
        return 'tool';
      }
    }
    class C extends P {
      // @ts-expect-error 故意用 getter 遮蔽父类方法，验证扫描不崩且父类 spec 仍命中
      get thing(): string {
        return 'getter';
      }
    }
    const tools = collectTools(new C());
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'thing');

    // 普通 getter / 非函数成员本身不会被收集成能力
    class G {
      @Tool({ description: 'd', schema: OBJ })
      ok(): string {
        return 'ok';
      }
      get notTool(): number {
        return 1;
      }
    }
    assert.deepEqual(
      collectTools(new G()).map((t) => t.name),
      ['ok'],
    );
  });

  it('capabilityName：symbol 方法名且无显式 name → 抛错文案带符号信息', () => {
    const sym = Symbol('hidden');
    assert.throws(
      () => capabilityName({}, sym, '@Tool'),
      /@Tool 需要显式 name（方法名为私有符号 Symbol\(hidden\)）/,
    );
    assert.equal(capabilityName({ name: 'n' }, sym, '@Tool'), 'n', '显式 name 优先');
    assert.equal(capabilityName({}, 'method', '@Tool'), 'method', '字符串 key 缺省取方法名');
  });

  it('symbol 命名的装饰方法：无显式 name 抛错，有显式 name 正常收集', () => {
    const sym = Symbol('hidden');
    class NoName {
      @Tool({ description: 'd', schema: OBJ })
      [sym](): string {
        return 'x';
      }
    }
    assert.throws(() => collectTools(new NoName()), /@Tool 需要显式 name/);

    class Named {
      @Tool({ description: 'd', schema: OBJ, name: 'hidden_tool' })
      [sym](): string {
        return 'x';
      }
    }
    const tools = collectTools(new Named());
    assert.deepEqual(
      tools.map((t) => t.name),
      ['hidden_tool'],
    );
  });

  it('null/undefined/原始值实例 → 空收集（useValue 合法 provider 不该炸装配）', () => {
    for (const v of [null, undefined, 42, 's', true]) {
      assert.deepEqual(collectTools(v as never), []);
      assert.deepEqual(collectSubAgents(v as never), []);
      assert.deepEqual(collectSkills(v as never), []);
      assert.deepEqual(collectPrompts(v as never), []);
    }
  });

  it('能力名合法性校验（与 MCP 桥同口径 ^[A-Za-z0-9_-]{1,64}$）', () => {
    // 非法显式名：引号（会让 Anthropic API 400）
    class BadQuote {
      @Tool({ description: 'd', schema: OBJ, name: 'a"b' })
      x(): string {
        return 'x';
      }
    }
    assert.throws(() => collectTools(new BadQuote()), /@Tool 能力名 .* 非法/);

    // 空名 / 超长名 / 含点与空格
    for (const bad of ['', 'a'.repeat(65), 'a.b', 'a b']) {
      class Bad {
        @Tool({ description: 'd', schema: OBJ, name: bad })
        x(): string {
          return 'x';
        }
      }
      assert.throws(() => collectTools(new Bad()), /@Tool 能力名 .* 非法/, `name=${bad}`);
    }

    // 非 ASCII 方法名（合法 JS 标识符、非法 API 工具名）缺省取名时同样拦截
    class ChineseName {
      @Tool({ description: 'd', schema: OBJ })
      工具(): string {
        return 'x';
      }
    }
    assert.throws(() => collectTools(new ChineseName()), /@Tool 能力名 .* 非法/);

    // 合法字符集：字母/数字/下划线/连字符，64 字符整
    class Ok {
      @Tool({ description: 'd', schema: OBJ, name: `a_B-9${'x'.repeat(58)}` })
      x(): string {
        return 'x';
      }
    }
    assert.equal(collectTools(new Ok()).length, 1);
  });

  it('静态 @Prompt 沿构造函数原型链收集（父类静态资产在子类实例上可用）', async () => {
    // biome-ignore lint/complexity/noStaticOnlyClass: 测试夹具 —— 纯静态能力类正是被测形态
    class P {
      @Prompt({ description: 'd' })
      static brand_voice(): string {
        return 'parent-static';
      }
    }
    class C extends P {}
    const prompts = collectPrompts(new C());
    assert.deepEqual(
      prompts.map((p) => p.name),
      ['brand_voice'],
    );
    assert.equal(await prompts[0].run({}), 'parent-static');
  });

  it('静态 @Prompt：子类未装饰 override 继承父类 spec、调子类实现（与实例侧同语义）', async () => {
    // biome-ignore lint/complexity/noStaticOnlyClass: 测试夹具 —— 纯静态能力类正是被测形态
    class P {
      @Prompt({ description: 'd' })
      static tone(): string {
        return 'parent';
      }
    }
    class C extends P {
      static override tone(): string {
        return 'child';
      }
    }
    const prompts = collectPrompts(new C());
    assert.equal(prompts.length, 1, '同名静态只命中一次');
    assert.equal(await prompts[0].run({}), 'child', '实现取最外层类上的（不绕过子类 override）');
  });

  it('symbol 键的静态 @Prompt：显式 name 正常收集（Reflect.ownKeys 覆盖 symbol）', async () => {
    const sym = Symbol('s');
    // biome-ignore lint/complexity/noStaticOnlyClass: 测试夹具 —— 纯静态能力类正是被测形态
    class M {
      @Prompt({ description: 'd', name: 'static_sym' })
      static [sym](): string {
        return 'sym-ok';
      }
    }
    const prompts = collectPrompts(new M());
    assert.deepEqual(
      prompts.map((p) => p.name),
      ['static_sym'],
    );
    assert.equal(await prompts[0].run({}), 'sym-ok');
  });

  it('静态 @Prompt 的非法 name 同样被校验（静态路径也走 capabilityName）', () => {
    // biome-ignore lint/complexity/noStaticOnlyClass: 测试夹具 —— 纯静态能力类正是被测形态
    class BadStatic {
      @Prompt({ description: 'd', name: 'bad name' })
      static brand(): string {
        return 'x';
      }
    }
    assert.throws(() => collectPrompts(new BadStatic()), /@Prompt 能力名 .* 非法/);
  });
});
