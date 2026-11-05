import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpHandler, executeRun } from '../../src/index.js';
import type { AgentTool, AppCallable, HttpHandler } from '../../src/index.js';
import { mockClient, toolUseMsg, endTurnMsg } from '../helpers.js';

/**
 * HITL 审批端点：`POST /tasks/:id/approve`。
 * 真路径：HTTP → AsyncRunner → executeRun（真引擎）→ 挂起/恢复。
 * 模型侧是 mockClient（脚本化往返），不联网。
 */

const OBJ = { type: 'object', properties: {} } as const;

/** 真路径 app：executeRun + 脚本化 client；spy 记工具执行次数 */
function hitlApp(script: Array<Record<string, unknown>>, spy: { calls: number }) {
  const { client } = mockClient(script);
  const tools: AgentTool[] = [
    {
      name: 'danger',
      description: '危险操作',
      inputSchema: OBJ,
      approval: 'required',
      run: () => {
        spy.calls++;
        return 'done';
      },
    },
  ];
  const app: AppCallable = {
    name: 'hitl',
    run: (messages, opts) => executeRun({ messages, client, tools, ...opts }),
  };
  return app;
}

async function start(
  app: AppCallable,
  opts: Parameters<typeof createHttpHandler>[1] = {},
): Promise<{ server: Server; base: string; handler: HttpHandler }> {
  const handler = createHttpHandler(app, opts);
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}`, handler };
}

function close(server: Server): Promise<void> {
  return new Promise((r) => server.close(() => r()));
}

// biome-ignore lint/suspicious/noExplicitAny: 端点回的是运行时数据（契约见 http.ts 的 RunHttpResponse / TaskRecord），逐字段断言时不必逐个窄化 unknown
async function readJson(res: Response): Promise<any> {
  return res.json();
}

function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** 提交一个会挂起的任务并等到 suspended（轮询走真 GET /tasks/:id） */
async function submitAndSuspend(
  base: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const res = await post(base, '/tasks', { input: '删库' }, headers);
  assert.equal(res.status, 202);
  const rec = await readJson(res);
  for (;;) {
    const poll = await fetch(`${base}/tasks/${rec.taskId}`, { headers });
    const cur = await readJson(poll);
    if (cur.status === 'suspended') return cur.taskId;
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('POST /tasks/:id/approve（HITL）', () => {
  it('200：批准挂起的任务 → 返回任务记录 → 任务恢复跑到终态', async () => {
    const spy = { calls: 0 };
    const app = hitlApp([toolUseMsg('danger', {}, 'tu1'), endTurnMsg('完成')], spy);
    const { server, base } = await start(app);
    try {
      const taskId = await submitAndSuspend(base);
      const res = await post(base, `/tasks/${taskId}/approve`, {
        decisions: { tu1: { approved: true } },
        decidedBy: 'alice',
      });
      assert.equal(res.status, 200);
      const rec = await readJson(res);
      assert.equal(rec.taskId, taskId);
      assert.equal(rec.approvals.tu1.approved, true);
      assert.equal(rec.approvals.tu1.decidedBy, 'alice');

      // 轮询到终态（与 readJson 同源：运行时数据）
      // biome-ignore lint/suspicious/noExplicitAny: 同文件的 readJson 豁免，来源一致
      let final: any;
      for (;;) {
        const poll = await fetch(`${base}/tasks/${taskId}`);
        final = await readJson(poll);
        if (final.status === 'succeeded' || final.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.equal(final.status, 'succeeded');
      assert.equal(final.result.finalText, '完成');
      assert.equal(spy.calls, 1, '批准后工具恰好执行一次');
    } finally {
      await close(server);
    }
  });

  it('400：body 非法（缺 decisions / approved 不是布尔 / decidedBy 不是字符串）', async () => {
    const spy = { calls: 0 };
    const app = hitlApp([toolUseMsg('danger', {}, 'tu1')], spy);
    const { server, base } = await start(app);
    try {
      const taskId = await submitAndSuspend(base);
      for (const bad of [
        {},
        { decisions: 'x' },
        { decisions: { tu1: { approved: 'yes' } } },
        { decisions: { tu1: { approved: true } }, decidedBy: 42 },
        { decisions: { tu1: { approved: true, reason: 1 } } },
      ]) {
        const res = await post(base, `/tasks/${taskId}/approve`, bad);
        assert.equal(res.status, 400, `body ${JSON.stringify(bad)} 应回 400`);
      }
      assert.equal(spy.calls, 0, '非法 body 不该推进任何执行');
    } finally {
      await close(server);
    }
  });

  it('404：任务不存在', async () => {
    const spy = { calls: 0 };
    const app = hitlApp([], spy);
    const { server, base } = await start(app);
    try {
      const res = await post(base, '/tasks/task_nope/approve', {
        decisions: { tu1: { approved: true } },
      });
      assert.equal(res.status, 404);
    } finally {
      await close(server);
    }
  });

  it('409：任务不在 suspended 状态', async () => {
    const spy = { calls: 0 };
    const app = hitlApp([endTurnMsg('ok')], spy);
    const { server, base, handler } = await start(app);
    try {
      const res = await post(base, '/tasks', { input: '普通任务' });
      const rec = await readJson(res);
      await handler.runner.awaitTask(rec.taskId); // succeeded
      const conflict = await post(base, `/tasks/${rec.taskId}/approve`, {
        decisions: { tu1: { approved: true } },
      });
      assert.equal(conflict.status, 409);
      const body = await readJson(conflict);
      assert.match(body.error, /succeeded/);
    } finally {
      await close(server);
    }
  });

  it('401：未通过鉴权（approve 与任务路径同受 authenticate 闸）', async () => {
    const spy = { calls: 0 };
    const app = hitlApp([toolUseMsg('danger', {}, 'tu1')], spy);
    const { server, base } = await start(app, {
      authenticate: (req) => {
        if (req.headers.authorization !== 'Bearer ok') throw new Error('bad token');
      },
    });
    try {
      const taskId = await submitAndSuspend(base, { authorization: 'Bearer ok' });
      const res = await post(
        base,
        `/tasks/${taskId}/approve`,
        { decisions: { tu1: { approved: true } } },
        // 无凭据
      );
      assert.equal(res.status, 401);
      assert.equal(spy.calls, 0);
    } finally {
      await close(server);
    }
  });

  it('拒绝：approved:false → 恢复后模型收到 is_error 的「审批被拒绝」，任务照常收尾', async () => {
    const spy = { calls: 0 };
    let denialSeen = '';
    const script: Array<Record<string, unknown>> = [
      toolUseMsg('danger', {}, 'tu1'),
      {
        onParams: (p: unknown) => {
          const msgs = (p as { messages: Array<{ content: unknown }> }).messages;
          denialSeen = (msgs[msgs.length - 1].content as Array<{ content: string }>)[0].content;
        },
        message: endTurnMsg('换路完成'),
      } as unknown as Record<string, unknown>,
    ];
    const app = hitlApp(script, spy);
    const { server, base } = await start(app);
    try {
      const taskId = await submitAndSuspend(base);
      const res = await post(base, `/tasks/${taskId}/approve`, {
        decisions: { tu1: { approved: false, reason: '超出权限' } },
      });
      assert.equal(res.status, 200);
      // biome-ignore lint/suspicious/noExplicitAny: 同文件的 readJson 豁免，来源一致
      let final: any;
      for (;;) {
        const poll = await fetch(`${base}/tasks/${taskId}`);
        final = await readJson(poll);
        if (final.status === 'succeeded' || final.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.equal(final.status, 'succeeded');
      assert.equal(final.result.finalText, '换路完成');
      assert.equal(spy.calls, 0, '被拒绝的工具不执行');
      assert.equal(denialSeen, '审批被拒绝：超出权限', '拒绝理由经 tool_result 回给模型');
    } finally {
      await close(server);
    }
  });
});

describe('可信审批人', () => {
  it('resolveApprovalActor 从 principal 生成 decidedBy，并覆盖请求体自报身份', async () => {
    const spy = { calls: 0 };
    const app = hitlApp([toolUseMsg('danger', {}, 'tu1'), endTurnMsg('完成')], spy);
    const { server, base } = await start(app, {
      authenticate: (req) => ({ userId: String(req.headers['x-user'] ?? '') }),
      resolveApprovalActor: (_req, principal) => (principal as { userId: string }).userId,
    });
    try {
      const taskId = await submitAndSuspend(base, { 'x-user': 'alice' });
      const res = await post(
        base,
        `/tasks/${taskId}/approve`,
        { decisions: { tu1: { approved: true } }, decidedBy: 'mallory' },
        { 'x-user': 'alice' },
      );
      assert.equal(res.status, 200);
      const rec = await readJson(res);
      assert.equal(rec.approvals.tu1.decidedBy, 'alice');
      assert.notEqual(rec.approvals.tu1.decidedBy, 'mallory');
    } finally {
      await close(server);
    }
  });
});
