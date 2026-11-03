/**
 * 真服务跑法（`npm start`）—— 需要模型端点（`ANTHROPIC_API_KEY` 或 OpenAI 兼容端点）。
 *
 * 跟 `npm run demo` 的区别只有一件事：**模型换成真的**。编排代码一行没变
 * （同一个 `dispatchGoal`），所以 demo 里跑通的语义就是这里的语义。
 *
 * 路由契约（**刻意不用内置 `/tasks`**）：
 *   POST /goal             { goal, goalId? } → 拆单并派发，立刻 202
 *   GET  /goal/:goalId     汇总这个目标下所有工单的状态与报告
 *   POST /approve/:taskId  { approved, decidedBy?, reason? } → 给挂起的工单放行/拒绝
 *   GET  /healthz /metrics · POST /run（同步问 Router 一句）—— 框架内置 handler 提供的
 *
 * 为什么不用内置 `POST /tasks/:id/approve`：那个端点绑定在 handler 构造时传的**一个**
 * runner 上，而本示例有 repro / fix 两个 runner（菜单不同，见 agents.ts）。审批必须交给
 * **任务归属的那个 runner**，否则会用错的 app 恢复执行。这是多 runner 场景的真实细节，
 * 不是框架缺陷 —— 单 runner 时不存在的选择，对框架来说无从默认。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AsyncRunner,
  HttpException,
  Scheduler,
  SqliteTaskStore,
  createHttpHandler,
  createOpenAIClient,
  gracefulShutdown,
  loadEnvFile,
  serve,
} from '@migor/agentia';
import type { TaskRecord } from '@migor/agentia';
import { createRouterApp, createWorkerApp } from './agents.js';
import { DEFAULT_GOAL, SEED_FILES } from './config.js';
import { dispatchGoal } from './orchestrator.js';
import { Sandbox } from './sandbox.js';

/**
 * 读 `.env`（框架不带这个行为，是宿主的一行决策：读哪个文件、什么时候读）。
 * ⚠️ 必须在**下面第一个 `process.env` 读取之前**调用 —— 放晚了就只对后面生效，
 * 表现为「明明填了 .env 却不生效」；「真实环境变量优先于文件」是它的缺省语义。
 */
loadEnvFile();

const PORT = Number(process.env.PORT ?? 3000);
const TOKEN = process.env.SUPERAGENT_TOKEN ?? ''; // 不设 = 不鉴权（仅本地开发）
const DB_RAW = process.env.SUPERAGENT_DB ?? 'super-agent.db';
/**
 * `:memory:` 哨兵必须**原样**交给驱动 —— 先 `resolve()` 会把它变成一个名叫
 * `:memory:` 的**磁盘文件**（一个绝对路径），「要内存库」静默失效。
 * 其余值也原样传（相对路径按 cwd 解析，这是宿主的约定，框架不管）。
 */
const DB_PATH = DB_RAW;
const EVENT_POLL_MS = Number(process.env.SUPERAGENT_EVENT_POLL_MS ?? 0); // 0 = 关闭「主动巡检」
const CONCURRENCY = { repro: 4, fix: 2 } as const;

/**
 * 模型端点。
 *
 * 不设 `OPENAI_BASE_URL` 就走框架的**缺省**（`createAnthropicClient()`，从 env 读 `ANTHROPIC_API_KEY`）——
 * 那一步是 `engine/loop.ts` 里的 `options.client ?? createAnthropicClient()`，宿主什么都不用做。
 * 要接 OpenAI 兼容端点（DeepSeek / vLLM / Ollama）才需要在这里显式造一个。
 *
 * ⚠️ 这个 client 实例**不能**随任务落库（`options.client` 是进程内对象）——
 * 本示例在派发时直接传对象，进程内有效；跨进程续跑（`resumePending`）时它会丢，
 * 所以真部署请改用 `AGENTIA_MODEL` + 应用级配置，别把 client 塞进任务。
 */
const customClient =
  process.env.OPENAI_BASE_URL !== undefined
    ? createOpenAIClient({
        baseURL: process.env.OPENAI_BASE_URL,
        ...(process.env.OPENAI_API_KEY !== undefined ? { apiKey: process.env.OPENAI_API_KEY } : {}),
      })
    : undefined;

/** 沙箱：真跑时也从种子文件开始（换成真工作区请同时补路径边界与写幂等，见 sandbox.ts 头注） */
const sandbox = new Sandbox(SEED_FILES);

const routerApp = createRouterApp();
const reproApp = createWorkerApp('repro', sandbox);
const fixApp = createWorkerApp('fix', sandbox);

// 两个 runner **共用一个 store**（同一本账）：框架按 ownerId 区分任务归属，同进程多 runner 共库是受支持形状
const store = new SqliteTaskStore(DB_PATH);
const runners = {
  repro: new AsyncRunner(reproApp, { store, concurrency: CONCURRENCY.repro }),
  fix: new AsyncRunner(fixApp, { store, concurrency: CONCURRENCY.fix }),
};

const handler = createHttpHandler(routerApp, {
  authenticate: (req) => {
    if (TOKEN !== '' && req.headers.authorization !== `Bearer ${TOKEN}`) {
      throw new HttpException(401, { error: '无效凭据' });
    }
  },
});

// ─────────────────────────── 小工具 ───────────────────────────

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new HttpException(413, { error: 'body 过大' });
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new HttpException(400, { error: 'body 不是合法 JSON' });
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(text);
}

/** 这个目标下的全部工单记录（两个 runner 的账本合并后按 `labels.goal` 过滤） */
async function ticketsOf(goalId: string): Promise<TaskRecord[]> {
  const all = [...(await runners.repro.list()), ...(await runners.fix.list())];
  return all.filter((rec) => rec.spec.options?.labels?.goal === goalId);
}

function summarize(rec: TaskRecord): Record<string, unknown> {
  return {
    taskId: rec.taskId,
    ticket: rec.spec.options?.labels?.ticket,
    kind: rec.spec.options?.labels?.kind,
    status: rec.status,
    summary: rec.result?.finalText ?? '',
    // 挂起时把人要批的 tool_use 列出来（客户端据此调 /approve）
    pendingApprovals: rec.pendingApprovals ?? [],
    error: rec.error?.message,
  };
}

// ─────────────────────────── 路由 ───────────────────────────

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  try {
    // —— 新增的主人契约：一个目标 = 若干工单 ——
    if (path === '/goal' && req.method === 'POST') {
      const body = await readJson(req);
      const goal = typeof body.goal === 'string' ? body.goal : DEFAULT_GOAL;
      // goalId 由调用方给（通常是上游那条消息的 id）；不给就按时间戳造一个。
      // ⚠️ 它是幂等键的一部分：同一条消息重投时必须传**同一个** goalId，否则会重复开工。
      const goalId = typeof body.goalId === 'string' ? body.goalId : `goal-${Date.now()}`;
      const out = await dispatchGoal({
        goal,
        goalId,
        router: routerApp,
        runners,
        ...(customClient ? { routerClient: customClient, clientFor: () => customClient } : {}),
      });
      send(res, 202, {
        goalId,
        routerRunId: out.routerRunId,
        tickets: out.dispatched.map((d) => ({
          id: d.ticket.id,
          kind: d.ticket.kind,
          taskId: d.taskId,
        })),
      });
      return;
    }

    if (path.startsWith('/goal/') && req.method === 'GET') {
      const goalId = decodeURIComponent(path.slice('/goal/'.length));
      const records = await ticketsOf(goalId);
      if (records.length === 0) {
        send(res, 404, { error: `没有这个目标下的工单：${goalId}` });
        return;
      }
      send(res, 200, { goalId, tickets: records.map(summarize) });
      return;
    }

    // —— 审批：必须找回**任务归属的那个 runner**（见文件头注）——
    if (path.startsWith('/approve/') && req.method === 'POST') {
      const taskId = decodeURIComponent(path.slice('/approve/'.length));
      const rec = await store.get(taskId);
      if (!rec) {
        send(res, 404, { error: `任务不存在：${taskId}` });
        return;
      }
      const kind = rec.spec.options?.labels?.kind;
      if (kind !== 'repro' && kind !== 'fix') {
        send(res, 400, { error: `任务 ${taskId} 不是本服务的工单（没有 kind label）` });
        return;
      }
      const body = await readJson(req);
      const pending = rec.pendingApprovals ?? [];
      if (pending.length === 0) {
        send(res, 409, { error: `任务 ${taskId} 当前没有待决项（状态：${rec.status}）` });
        return;
      }
      const approved = body.approved === true;
      const reason = typeof body.reason === 'string' ? body.reason : undefined;
      const decidedBy = typeof body.decidedBy === 'string' ? body.decidedBy : 'http';
      // 待决清单要**给齐**：多一个键会被整批拒（400），少一个则继续挂起
      const updated = await runners[kind].approve(
        taskId,
        Object.fromEntries(pending.map((id) => [id, { approved, ...(reason ? { reason } : {}) }])),
        { decidedBy },
      );
      send(res, 200, summarize(updated));
      return;
    }

    // —— 其余交给框架内置 handler：/run（同步问 Router 一句）、/healthz、/metrics ——
    await handler(req, res);
  } catch (e) {
    if (e instanceof HttpException) {
      send(res, e.status, e.body);
      return;
    }
    console.error('[super-agent] 未处理异常', e);
    send(res, 500, { error: '内部错误' });
  }
}

const { server, port } = await serve((req, res) => void route(req, res), { port: PORT });

console.log(`[boot] :${port}`);
console.log(`  鉴权        ${TOKEN ? 'Bearer token' : '关（仅本地）'}`);
console.log(`  存储        ${DB_PATH}（两 runner 共库）`);
console.log(`  并发        repro=${CONCURRENCY.repro} fix=${CONCURRENCY.fix}`);
console.log('  POST /goal        拆单并派发（202）');
console.log('  GET  /goal/:id    汇总状态与报告');
console.log('  POST /approve/:taskId  审批挂起的工单');

// ─────────────────────────── 「主动」那半：事件源 ───────────────────────────
//
// Super-agent 的「主动」= 没人叫它也在盯。框架里对应的是 **事件源 + 过滤 + 派发**，
// 三件都是你的策略（框架只给 Scheduler 与 submit，不替你定义「什么值得处理」）。
//
// ⚠️ 成本纪律：**两级过滤**。第一级用规则（在这里是「只有 LABEL 匹配才进」）挡掉绝大多数事件，
// 第二级才交给模型判断 —— 直接对每条消息跑一次 Router，一个月能烧掉一台车。
if (EVENT_POLL_MS > 0) {
  const scheduler = new Scheduler(runners.repro);
  scheduler.every(
    EVENT_POLL_MS,
    {
      prompt:
        '例行巡检：读 src/pricing.ts，若发现「计算总额时未乘数量」这类缺陷，报出文件与行号；没有就说明未见异常。',
    },
    // 巡检出问题才需要人看，这里只演示「定时派发一条只读工单」这一跳
    { idempotencyKeyPrefix: 'patrol' } as never,
  );
  console.log(
    `  主动巡检    每 ${EVENT_POLL_MS}ms 派发一条只读工单（SUPERAGENT_EVENT_POLL_MS 设 0 关闭）`,
  );
}

// ─────────────────────────── 优雅停机 ───────────────────────────

gracefulShutdown({
  server,
  drain: async () => {
    const results = await Promise.all([
      handler.drain({ timeoutMs: 15_000 }),
      runners.repro.drain({ timeoutMs: 15_000 }),
      runners.fix.drain({ timeoutMs: 15_000 }),
    ]);
    return results.every(Boolean);
  },
  signals: ['SIGTERM', 'SIGINT'],
  timeoutMs: 20_000,
  onShutdown: (clean) => {
    console.log(
      clean ? '[bye] 已排空' : '[bye] 超时收口（挂起/未落地任务下次启动被 resumePending 接手）',
    );
    process.exit(clean ? 0 : 1);
  },
});
