import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, SystemPrompt, Tool, SubAgent, Skill } from '../../src/index.js';
import type { SkillContext } from '../../src/index.js';
import type { CapabilityMiddleware } from '../../src/toolkit/middleware.js';
import { mockClient, toolUseMsg, endTurnMsg } from '../helpers.js';

const OBJ = { type: 'object', properties: {} } as const;
const sys = () => new SystemPrompt().add('role', 'r', true);

/** 取 mock 收到的第 n 次请求的菜单名列表（seen[0]=主 agent，seen[1]=子 agent / skill 子运行） */
const toolNamesAt = (seen: unknown[], n: number): string[] =>
  ((seen[n] as { tools: Array<{ name: string }> }).tools ?? []).map((t) => t.name).sort();

describe('tools 能力级路径引用（<token>/<能力名>）', () => {
  it('子 agent 只拿到被点名的那一个工具（api 菜单断言）', async () => {
    class Tools {
      @Tool({ description: 'd', schema: OBJ })
      tool_a(): string {
        return 'a';
      }
      @Tool({ description: 'd', schema: OBJ })
      tool_b(): string {
        return 'b';
      }
    }
    class Agents {
      @SubAgent({ description: 'd', schema: OBJ, system: 's', tools: ['tools/tool_a'] })
      runner_agent(_input: unknown): void {}
    }
    const app = createApp({
      providers: [
        { provide: 'tools', useClass: Tools },
        { provide: 'agents', useClass: Agents },
      ],
      system: sys(),
    });

    const { seen, client } = mockClient([
      toolUseMsg('runner_agent', {}),
      endTurnMsg('子报告'),
      endTurnMsg('主收尾'),
    ]);
    const out = await app.run([{ role: 'user', content: 'go' }], { client });

    assert.equal(out.result.stopReason, 'end_turn');
    assert.deepEqual(toolNamesAt(seen, 1), ['tool_a'], '子 agent 菜单应只含被点名的能力');
  });

  it('skill 的 ctx.llm() 同样只拿到被点名的那一个工具', async () => {
    class Tools {
      @Tool({ description: 'd', schema: OBJ })
      tool_a(): string {
        return 'a';
      }
      @Tool({ description: 'd', schema: OBJ })
      tool_b(): string {
        return 'b';
      }
    }
    class Skills {
      @Skill({ description: 'd', tools: ['tools/tool_b'] })
      async worker(_input: unknown, ctx: SkillContext): Promise<string> {
        await ctx.llm({ prompt: 'go' });
        return 'done';
      }
    }
    const app = createApp({
      providers: [
        { provide: 'tools', useClass: Tools },
        { provide: 'skills', useClass: Skills },
      ],
      system: sys(),
    });

    const { seen, client } = mockClient([
      toolUseMsg('worker', {}),
      endTurnMsg('skill 子运行'),
      endTurnMsg('主收尾'),
    ]);
    const out = await app.run([{ role: 'user', content: 'go' }], { client });

    assert.equal(out.result.stopReason, 'end_turn');
    assert.deepEqual(toolNamesAt(seen, 1), ['tool_b'], 'skill 子运行菜单应只含被点名的能力');
  });

  it('能力级引用仍过中间件 —— 防绕过回归', async () => {
    class Tools {
      @Tool({ description: 'd', schema: OBJ })
      inner_tool(): string {
        return 'inner';
      }
      @Tool({ description: 'd', schema: OBJ })
      other_tool(): string {
        return 'other';
      }
    }
    class Agents {
      @SubAgent({ description: 'd', schema: OBJ, system: 's', tools: ['tools/inner_tool'] })
      runner_agent(_input: unknown): void {}
    }
    const calls: string[] = [];
    const mw: CapabilityMiddleware = (call, next) => {
      calls.push(call.capability.name);
      return next();
    };
    const app = createApp({
      providers: [
        { provide: 'tools', useClass: Tools },
        { provide: 'agents', useClass: Agents },
      ],
      middleware: [mw],
      system: sys(),
    });

    const { seen, client } = mockClient([
      toolUseMsg('runner_agent', {}),
      toolUseMsg('inner_tool', {}),
      endTurnMsg('子报告'),
      endTurnMsg('主收尾'),
    ]);
    const out = await app.run([{ role: 'user', content: 'go' }], { client });

    assert.equal(out.result.stopReason, 'end_turn');
    assert.ok(calls.includes('runner_agent'), '子 agent 调用走中间件');
    // 能力级引用也必须解析到「中间件包装后」的菜单，否则内部工具调用绕过
    // 鉴权/限流/审计（与整片引用同一处既有教训）
    assert.ok(calls.includes('inner_tool'), '能力级引用的内部工具也必须走中间件');
    assert.deepEqual(toolNamesAt(seen, 1), ['inner_tool']);
  });

  it('引用不存在的能力名 → 装配期抛错，消息含 token、能力名与可用名单', () => {
    class Tools {
      @Tool({ description: 'd', schema: OBJ })
      tool_a(): string {
        return 'a';
      }
      @Tool({ description: 'd', schema: OBJ })
      tool_b(): string {
        return 'b';
      }
    }
    class Agents {
      @SubAgent({ description: 'd', schema: OBJ, system: 's', tools: ['tools/nope'] })
      runner_agent(_input: unknown): void {}
    }
    assert.throws(
      () =>
        createApp({
          providers: [
            { provide: 'tools', useClass: Tools },
            { provide: 'agents', useClass: Agents },
          ],
          system: sys(),
        }),
      /tools 引用 "tools" 中不存在的能力: "nope"（可用: tool_a, tool_b）/,
    );
  });

  it('能力级路径可点名该 provider 的 @Skill / @SubAgent 能力（不止 @Tool）', async () => {
    class Skills {
      @Skill({ description: 'd' })
      helper_skill(): string {
        return 'skill-ok';
      }
    }
    class Agents {
      @SubAgent({ description: 'd', schema: OBJ, system: 's', tools: ['skills/helper_skill'] })
      runner_agent(_input: unknown): void {}
    }
    const app = createApp({
      providers: [
        { provide: 'skills', useClass: Skills },
        { provide: 'agents', useClass: Agents },
      ],
      system: sys(),
    });

    const { seen, client } = mockClient([
      toolUseMsg('runner_agent', {}),
      toolUseMsg('helper_skill', {}),
      endTurnMsg('子报告'),
      endTurnMsg('主收尾'),
    ]);
    const out = await app.run([{ role: 'user', content: 'go' }], { client });

    assert.equal(out.result.stopReason, 'end_turn');
    assert.deepEqual(toolNamesAt(seen, 1), ['helper_skill']);
  });

  it('混写：整片 token + 能力级路径同时引用', async () => {
    class Tools {
      @Tool({ description: 'd', schema: OBJ })
      tool_a(): string {
        return 'a';
      }
    }
    class Extra {
      @Tool({ description: 'd', schema: OBJ })
      extra_tool(): string {
        return 'extra';
      }
      @Tool({ description: 'd', schema: OBJ })
      extra_hidden(): string {
        return 'hidden';
      }
    }
    class Agents {
      @SubAgent({
        description: 'd',
        schema: OBJ,
        system: 's',
        tools: ['tools', 'extra/extra_tool'],
      })
      runner_agent(_input: unknown): void {}
    }
    const app = createApp({
      providers: [
        { provide: 'tools', useClass: Tools },
        { provide: 'extra', useClass: Extra },
        { provide: 'agents', useClass: Agents },
      ],
      system: sys(),
    });

    const { seen, client } = mockClient([
      toolUseMsg('runner_agent', {}),
      endTurnMsg('子报告'),
      endTurnMsg('主收尾'),
    ]);
    const out = await app.run([{ role: 'user', content: 'go' }], { client });

    assert.equal(out.result.stopReason, 'end_turn');
    assert.deepEqual(toolNamesAt(seen, 1), ['extra_tool', 'tool_a']);
  });

  it('token 部分未注册（含带 / 的路径形态）→ 沿用「未注册 provider」文案', () => {
    class Agents {
      @SubAgent({ description: 'd', schema: OBJ, system: 's', tools: ['ghost/tool_a'] })
      runner_agent(_input: unknown): void {}
    }
    assert.throws(
      () => createApp({ providers: [{ provide: 'agents', useClass: Agents }], system: sys() }),
      /tools 引用未注册 provider: "ghost"/,
    );
  });

  it('子菜单重名查重：两个 provider 的同名能力被同一 subagent 整片引用 → 装配期抛错', () => {
    // 此前这条路径装配全绿、第一次模型调用才由 API 400 暴露（tool names must be unique）——
    // 主菜单查重只管 sources 合并后的主菜单，子菜单是运行期展开的
    class SearchA {
      @Tool({ description: 'd', schema: OBJ })
      search(): string {
        return 'a';
      }
    }
    class SearchB {
      @Tool({ description: 'd', schema: OBJ })
      search(): string {
        return 'b';
      }
    }
    class Agents {
      @SubAgent({ description: 'd', schema: OBJ, system: 's', tools: ['a', 'b'] })
      researcher(_input: unknown): void {}
    }
    assert.throws(
      () =>
        createApp({
          providers: [
            { provide: 'a', useClass: SearchA },
            { provide: 'b', useClass: SearchB },
            { provide: 'agents', useClass: Agents },
          ],
          system: sys(),
        }),
      /子菜单能力重名：@SubAgent "researcher" 的 tools 引用展开后 "search"（来自 "a" \+ "b"）/,
    );
  });

  it('子菜单重名查重：能力级路径与整片引用叠出同名也算（报错指到引用片）', () => {
    class Tools {
      @Tool({ description: 'd', schema: OBJ })
      tool_a(): string {
        return 'a';
      }
    }
    class Extra {
      @Tool({ description: 'd', schema: OBJ })
      tool_a(): string {
        return 'dup';
      }
    }
    class Skills {
      @Skill({ description: 'd', tools: ['tools', 'extra/tool_a'] })
      worker(): string {
        return 'x';
      }
    }
    assert.throws(
      () =>
        createApp({
          providers: [
            { provide: 'tools', useClass: Tools },
            { provide: 'extra', useClass: Extra },
            { provide: 'skills', useClass: Skills },
          ],
          system: sys(),
        }),
      /子菜单能力重名：@Skill "worker" 的 tools 引用展开后 "tool_a"（来自 "tools" \+ "extra\/tool_a"）/,
    );
  });

  it('子菜单查重的反向对照：同名能力引用收窄到不撞即放行（且运行时菜单正确）', async () => {
    class SearchA {
      @Tool({ description: 'd', schema: OBJ })
      search(): string {
        return 'a';
      }
    }
    class SearchB {
      @Tool({ description: 'd', schema: OBJ, name: 'search_v2' })
      search(): string {
        return 'b';
      }
    }
    class Agents {
      @SubAgent({ description: 'd', schema: OBJ, system: 's', tools: ['a', 'b/search_v2'] })
      researcher(_input: unknown): void {}
    }
    const app = createApp({
      providers: [
        { provide: 'a', useClass: SearchA },
        { provide: 'b', useClass: SearchB },
        { provide: 'agents', useClass: Agents },
      ],
      system: sys(),
    });

    const { seen, client } = mockClient([
      toolUseMsg('researcher', {}),
      endTurnMsg('子报告'),
      endTurnMsg('主收尾'),
    ]);
    const out = await app.run([{ role: 'user', content: 'go' }], { client });

    assert.equal(out.result.stopReason, 'end_turn');
    assert.deepEqual(toolNamesAt(seen, 1), ['search', 'search_v2']);
  });
});

describe('能力引用成环：装配期即拒绝（2026-09-28）', () => {
  // 为什么必须挡：能力是**运行期**展开的（subagentToTool 的 resolveTools 是延迟 thunk，
  // 装配期已把整个菜单建满）⇒ 成环 = 模型点一次就无限递归，而 maxIterations 只限每层宽度、
  // 深度没有闸 ⇒ 树按 宽度^深度 炸开。且这一切要到运行期才显形 —— 装配期拒绝是唯一便宜的时点。
  it('自引用（整片引用自己所在的 provider）→ createApp 抛错，文案给出环的路径', () => {
    class Agents {
      @SubAgent({ description: 'd', schema: OBJ, system: 's', tools: ['agents'] })
      runner_agent(_input: unknown): void {}
    }
    assert.throws(
      () => createApp({ providers: [{ provide: 'agents', useClass: Agents }], system: sys() }),
      /能力引用成环：@SubAgent "runner_agent" \(agents\) → @SubAgent "runner_agent" \(agents\)/,
    );
  });

  it('互引（两个能力各引对方）→ 抛错并列出完整环；拆掉一条边即放行（反向对照）', () => {
    const build = (bRefs: string[]) => {
      class Agents {
        @SubAgent({ description: 'd', schema: OBJ, system: 's', tools: ['agents/agent_b'] })
        agent_a(_input: unknown): void {}
        @SubAgent({ description: 'd', schema: OBJ, system: 's', tools: bRefs })
        agent_b(_input: unknown): void {}
      }
      return createApp({
        providers: [
          { provide: 'agents', useClass: Agents },
          { provide: 'tools', useClass: class {} },
        ],
        system: sys(),
      });
    };
    assert.throws(
      () => build(['agents/agent_a']),
      /能力引用成环：@SubAgent "agent_a" \(agents\) → @SubAgent "agent_b" \(agents\) → @SubAgent "agent_a" \(agents\)/,
    );
    // 反向对照：把环拆开（agent_b 不再引用 agent_a）⇒ 正常装配
    assert.doesNotThrow(() => build([]));
  });

  it('经整片 token 引用形成的隐式环也能抓到（不点名，直接引自己的 provider）', () => {
    class Agents {
      @SubAgent({ description: 'd', schema: OBJ, system: 's', tools: ['agents/agent_b'] })
      agent_a(_input: unknown): void {}
      @SubAgent({ description: 'd', schema: OBJ, system: 's', tools: ['agents'] })
      agent_b(_input: unknown): void {}
    }
    assert.throws(
      () => createApp({ providers: [{ provide: 'agents', useClass: Agents }], system: sys() }),
      /能力引用成环：@SubAgent "agent_a" \(agents\) → @SubAgent "agent_b" \(agents\) → @SubAgent "agent_a" \(agents\)/,
    );
  });
});
