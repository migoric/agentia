import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncRunner, createApp, executeRun, InMemorySessionStore } from '../../src/index.js';
import type { AgentTool, MessageParam, TaskRecord } from '../../src/index.js';
import { endTurnMsg, mockClient, toolUseMsg, waitFor } from '../helpers.js';

/**
 * run 级 `sessionId` 的出声闸（2026-10-12 ref-session-id-warn，评审 observability-deep-dive §2 行 7）：
 * `RunAppOptions` 继承了 `RunInvocationOptions.sessionId`，但 `AgentApp.run` 的转发清单里
 * 没有它 —— 程序内直传它此前是**静默丢弃**（run 根没有 `session.id`、会话历史接不上、
 * 零信号）。现在入口 `console.warn` 一次；内部链路（AsyncRunner）在
 * `buildRunCallOptions` 里已把 sessionId 消费掉、不再透传，踩不到这条闸。
 */

const user = (text: string): MessageParam => ({ role: 'user', content: text });

/** 捕获 console.warn（与 memory.test.ts / menu-drift.test.ts 同款） */
function captureWarn() {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
  return {
    warnings,
    restore: () => {
      console.warn = orig;
    },
  };
}

function rootAttributesOf(result: {
  trace: {
    spans: Array<{ spanId: string; attributes: Record<string, unknown> }>;
    rootSpanId: string;
  };
}): Record<string, unknown> {
  return result.trace.spans.find((s) => s.spanId === result.trace.rootSpanId)!.attributes;
}

describe('app.run 的 sessionId 出声闸（2026-10-12 ref-session-id-warn）', () => {
  it('直传 sessionId（无 session）⇒ 告警恰好一次；run 行为不变（成功、不建会话维度）', async () => {
    const { client } = mockClient([endTurnMsg('答')]);
    const app = createApp({ system: 'sys' });
    const cap = captureWarn();
    try {
      const { result } = await app.run([user('问')], { client, sessionId: 's1' });
      assert.equal(result.stopReason, 'end_turn');
      assert.equal(result.finalText, '答');
      assert.equal(
        'session.id' in rootAttributesOf(result),
        false,
        '裸 sessionId 不得建立会话维度（session.id → gen_ai.conversation.id）',
      );
    } finally {
      cap.restore();
    }
    assert.equal(cap.warnings.length, 1, '每条 run 恰好告警一次（不是每回合刷、也不是不出声）');
    assert.match(cap.warnings[0]!, /sessionId/);
    assert.match(cap.warnings[0]!, /session: \{ store, id \}/, '告警要指出正确的替代写法');
  });

  it('配了 session ⇒ 不告警；session.id 落 run 根', async () => {
    const { client } = mockClient([endTurnMsg('答')]);
    const app = createApp({ system: 'sys' });
    const cap = captureWarn();
    try {
      const { result } = await app.run([user('问')], {
        client,
        session: { store: new InMemorySessionStore(), id: 's1' },
      });
      assert.equal(rootAttributesOf(result)['session.id'], 's1');
    } finally {
      cap.restore();
    }
    assert.deepEqual(cap.warnings, [], '正常会话路径不该踩闸');
  });

  it('引擎级入口（executeRun）直传 sessionId 是**生效**的（它不是死字段）：落 session.id、无告警', async () => {
    // 钉住调查结论：sessionId 的死区只有 AgentApp.run 这一层 —— 引擎层 loop.ts 真读它。
    // 若哪天把这层也改没了，本用例会红，逼决策者同时改 spec.ts / usage-guide 的口径。
    const { client } = mockClient([endTurnMsg('答')]);
    const cap = captureWarn();
    try {
      const { result } = await executeRun({ messages: [user('问')], client, sessionId: 's1' });
      assert.equal(rootAttributesOf(result)['session.id'], 's1');
    } finally {
      cap.restore();
    }
    assert.deepEqual(cap.warnings, []);
  });

  it('内部链路不告警：带 sessionId 的任务挂起 → 批准 → 续跑成功，全程零告警', async () => {
    // 续跑段刻意不注入 session（buildRunCallOptions 的 isResume 纪律），而 spec.options 里的
    // sessionId 若原样透传进 app.run 就会误踩出声闸 —— 所以那一层把它**剥掉**。
    // 本用例走**真 AgentApp**（不是 fake app）：告警逻辑只有真 app 才在场。
    const OBJ = { type: 'object', properties: {} } as const;
    const { client } = mockClient([toolUseMsg('danger', {}, 'tu1'), endTurnMsg('最终回复')]);
    const tools: AgentTool[] = [
      {
        name: 'danger',
        description: '危险操作',
        inputSchema: OBJ,
        approval: 'required',
        run: () => 'done',
      },
    ];
    const app = createApp({ system: 'sys', tools });
    const runner = new AsyncRunner(app, { client, sessionStore: new InMemorySessionStore() });
    const cap = captureWarn();
    try {
      const t = runner.submit('新指令', { options: { sessionId: 's1' } });
      await waitFor(
        () => (runner.poll(t.taskId) as TaskRecord | undefined)?.status === 'suspended',
        '任务应挂起等审批',
      );
      await runner.approve(t.taskId, { tu1: { approved: true } });
      const done = await runner.awaitTask(t.taskId);
      assert.equal(done.status, 'succeeded');
      assert.equal(done.result?.finalText, '最终回复');
    } finally {
      cap.restore();
    }
    assert.deepEqual(cap.warnings, [], '首段（注入了 session）与续跑段（不注入）都不该踩闸');
  });
});
