// 部署示例端到端：`examples/deploy` **真构建、真起服务**，把 README 承诺的四件事真打一遍：
//   /healthz · 同步 /run（主 agent → echo → 收尾）· /metrics · 优雅停机（drain → exit 0）
// 外加 deploy 示例独有的两条：**崩溃续跑** —— SIGKILL 模拟崩溃，同库重启后
// `resumePending()` 必须把「running 死在半路的任务」续跑到 succeeded；
// **PORT 校验** —— `PORT=abc` 必须非零退出并报校验文案（`Number('')`/`Number('abc')`
// 会被 listen 静默当随机端口），`PORT=0` 合法（本脚本自己靠它拿随机端口）。
//
// 为什么独立成脚本而不并进 e2e-examples.ts：那份是 complete 示例的（README 三触发全流程），
// 这份是 deploy 示例的（最小可交付 + 耐久/续跑），两者断言面不同；且 deploy 走**框架默认的
// Anthropic client**（complete 走 OpenAI 兼容缝），假端点协议不同 —— 顺带把
// 「ANTHROPIC_BASE_URL 环境变量接管默认 client」这条部署路径也真跑了一遍。
//
// 不联网：模型侧是本脚本内置的假 Anthropic Messages 端点（真 SSE 事件流），只走 127.0.0.1。
//
// 运行：npm run e2e:deploy（先 build 框架，再 tsx 跑本脚本）；也挂在 npm run e2e 链上。
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
};

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const exampleDir = join(repoRoot, 'examples', 'deploy');

/** 假 Anthropic 端点观测到的记录（断言「能力真执行」靠它，不靠读响应文本） */
interface FakeProviderObserved {
  /** 第一次请求里模型看到的工具菜单（证明 echo 真装配上了） */
  menu: string[];
  /** 回传给模型的 tool_result 文本（证明 echo 真跑过） */
  toolResults: string[];
  /** 调用次数 */
  calls: number;
}

/**
 * 起一个假的 Anthropic Messages 端点（SSE 事件流，与真端点同形：event + data 成对）。
 *
 * 剧本（够模拟一次「主 agent 选能力 → 拿到结果 → 收尾」的完整往返）：
 * - 请求里还没有 tool_result ⇒ 回 `echo` 的 tool_use，**input_json 拆成两片**下发
 *   （真端点就是这么流的，顺带把框架侧的分片累积逻辑放进真实链路）；
 * - 有了 tool_result ⇒ 回最终文本 end_turn。
 *
 * 闸门：hold=true 期间所有请求**挂起不响应**（模拟「模型调用死在半路」），release()
 * 后放行 —— 崩溃续跑测试靠它把任务精确停在 running 态。
 */
async function startFakeProvider(): Promise<{
  baseURL: string;
  observed: FakeProviderObserved;
  release: () => void;
  close: () => Promise<void>;
}> {
  const observed: FakeProviderObserved = { menu: [], toolResults: [], calls: 0 };
  let hold = true;
  const held: ServerResponse[] = [];

  const writeEvent = (res: ServerResponse, event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const messageStart = {
    type: 'message_start',
    message: {
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      model: 'fake-model',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  };
  const finish = (stopReason: string, outputTokens: number) =>
    [
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        {
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: outputTokens },
        },
      ],
      ['message_stop', { type: 'message_stop' }],
    ] as const;

  const respond = (res: ServerResponse, hasToolResult: boolean): void => {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    writeEvent(res, 'message_start', messageStart);
    if (!hasToolResult) {
      // 第一回合：要求调 echo，arguments 分片（{"text": + "ping"}）
      writeEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_fake_1', name: 'echo', input: {} },
      });
      writeEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"text":' },
      });
      writeEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"ping"}' },
      });
      for (const [event, data] of finish('tool_use', 4)) writeEvent(res, event, data);
    } else {
      // 第二回合：收尾文本
      writeEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      writeEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'deploy-ok' },
      });
      for (const [event, data] of finish('end_turn', 3)) writeEvent(res, event, data);
    }
    res.end();
  };

  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      observed.calls++;
      const parsed = JSON.parse(body) as {
        tools?: Array<{ name?: string }>;
        messages?: Array<{ content?: unknown }>;
      };
      if (observed.calls === 1) {
        for (const t of parsed.tools ?? []) if (t.name) observed.menu.push(t.name);
      }
      // Anthropic 协议：tool_result 是 user 消息 content 里的一个 block
      const toolResultBlocks = (parsed.messages ?? []).flatMap((m) =>
        Array.isArray(m.content)
          ? (m.content as Array<{ type?: string; content?: unknown }>).filter(
              (b) => b?.type === 'tool_result',
            )
          : [],
      );
      for (const b of toolResultBlocks) observed.toolResults.push(JSON.stringify(b.content));
      if (hold) {
        held.push(res); // 闸门关着：挂起（进程被杀时此 socket 随之销毁）
        return;
      }
      respond(res, toolResultBlocks.length > 0);
    });
  });

  const baseURL = await new Promise<string>((ready) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      assert(typeof addr === 'object' && addr !== null, '假端点没有拿到端口');
      ready(`http://127.0.0.1:${(addr as { port: number }).port}`);
    });
  });

  return {
    baseURL,
    observed,
    release: () => {
      hold = false;
      // 被挂起的请求若来自已被 SIGKILL 的进程，socket 已销毁 —— 跳过
      for (const res of held.splice(0)) if (!res.destroyed) respond(res, false);
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/**
 * 让示例的 `import '@migor/agentia'` 解析到**仓库根**（当前 dist）—— 与 e2e-examples.ts
 * 同一手法（symlink）：CI 上示例目录没有 node_modules；本地 npm install 的 file: 是快照
 * 拷贝（装的是安装那天的框架，改了 dist 不生效），对「验证当前代码」是失真。
 */
function ensureLinks(): void {
  const link = join(exampleDir, 'node_modules', '@migor', 'agentia');
  let current: string | null = null;
  try {
    current = realpathSync(link);
  } catch {
    current = null; // 不存在
  }
  if (current === realpathSync(repoRoot)) return; // 已指向正确目标
  rmSync(link, { recursive: true, force: true });
  mkdirSync(join(link, '..'), { recursive: true });
  symlinkSync(repoRoot, link, 'dir');
}

/** 按示例**自己的构建脚本**构建（deploy 只有 tsc，无 .md 资产要拷） */
function buildExample(): void {
  assert(
    existsSync(join(repoRoot, 'dist', 'index.js')),
    '框架 dist 不存在 —— 先跑 npm run build（e2e / e2e:deploy 链已含）',
  );
  execFileSync(join(repoRoot, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], {
    cwd: exampleDir,
    stdio: 'inherit',
  });
}

/**
 * 起示例进程（`node dist/main.js`，即示例的 `npm run serve`），等它的就绪日志（不 sleep 猜时间）。
 *
 * PORT=0 + 解析日志里的**实际**端口（与 scripts/e2e-grpc.ts、scripts/e2e-examples.ts 同一做法）：
 * 「`listen(0)` 探到端口 → 关掉 → 子进程再绑」两步之间会被抢（本地实测真撞上过
 * `EADDRINUSE: ::53174`，且症状被报成「示例进程启动即退出」，读起来像示例坏了）——
 * 由服务自己分配端口，没有那个窗口，也就不再需要「撞端口换端口重试」。
 */
async function startExample(opts: { dbPath: string; fakeBaseURL: string; tag: string }): Promise<{
  child: ChildProcess;
  port: number;
  base: string;
  stdout: () => string;
  waitExit: () => Promise<number | null>;
}> {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: exampleDir,
    env: {
      ...process.env,
      PORT: '0',
      AGENTIA_DB: opts.dbPath,
      // 部署路径的关键缝：**默认 Anthropic client** 由 ANTHROPIC_BASE_URL 接管（不改代码换端点）
      ANTHROPIC_BASE_URL: opts.fakeBaseURL,
      ANTHROPIC_API_KEY: 'fake-key',
      AGENTIA_MODEL: 'fake-model',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  child.stdout?.on('data', (c: Buffer) => {
    out += c.toString();
  });
  child.stderr?.on('data', (c: Buffer) => {
    err += c.toString();
  });

  const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
  const deadline = Date.now() + 30_000; // 就绪预算给足：验的是「能不能起来」，不是「多快起来」
  let port: number | undefined;
  while (port === undefined) {
    const m = /\[boot\] listening on :(\d+)/.exec(out);
    if (m) {
      port = Number(m[1]);
    } else if (child.exitCode !== null) {
      throw new Error(
        `[${opts.tag}] 示例进程启动即退出（code=${child.exitCode}）\n--- stdout ---\n${out}\n--- stderr ---\n${err}`,
      );
    } else if (Date.now() > deadline) {
      throw new Error(
        `[${opts.tag}] 等示例就绪超时（30s）\n--- stdout ---\n${out}\n--- stderr ---\n${err}`,
      );
    } else {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  return {
    child,
    port,
    base: `http://127.0.0.1:${port}`,
    stdout: () => out,
    waitExit: () => exited,
  };
}

/** 轮询任务记录到终态（预算给足：验的是「最终会成功」，不是「多快成功」） */
async function pollTask(base: string, taskId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const rec = (await (await fetch(`${base}/tasks/${taskId}`)).json()) as Record<string, unknown>;
    if (rec.status !== 'queued' && rec.status !== 'running') return rec;
    if (Date.now() > deadline) throw new Error(`任务 ${taskId} 20s 未终态：${JSON.stringify(rec)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** 等条件成立（带自陈超时） */
async function waitFor(cond: () => boolean, what: string, budgetMs = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 >= budgetMs) throw new Error(`waitFor 超时（${budgetMs}ms）：${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const fake = await startFakeProvider();
const tmp = mkdtempSync(join(tmpdir(), 'agentia-e2e-deploy-'));
const dbPath = join(tmp, 'agentia.db');
let server: Awaited<ReturnType<typeof startExample>> | undefined;
try {
  ensureLinks();
  buildExample();

  // —— PORT 校验：`PORT=abc` 必须**响亮失败**（非零退出 + 校验文案）——
  // 没这道闸时 `Number('abc')` = NaN、`Number('')` = 0 都会被 listen 当「随机端口」静默吞掉
  // （没人知道的端口 = 看起来就是起不来）。`PORT=0` 是**合法**的（e2e 自己靠它拿随机端口），别误伤。
  {
    const bad = spawn(process.execPath, ['dist/main.js'], {
      cwd: exampleDir,
      env: { ...process.env, PORT: 'abc', AGENTIA_DB: join(tmp, 'bad-port.db') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let badErr = '';
    bad.stderr?.on('data', (c: Buffer) => {
      badErr += c.toString();
    });
    const badCode = await new Promise<number | null>((done) =>
      bad.on('exit', (code) => done(code)),
    );
    assert(badCode !== 0 && badCode !== null, `PORT=abc 应非零退出，实际 ${String(badCode)}`);
    assert(
      badErr.includes('PORT 必须是 0–65535 的整数'),
      `PORT=abc 应报 PORT 校验错，实际 stderr：${badErr.slice(0, 300)}`,
    );
  }

  // —— 阶段 A：起服务 → 提交异步任务 → 模型调用挂在闸门里 → SIGKILL 模拟崩溃 ——
  server = await startExample({ dbPath, fakeBaseURL: fake.baseURL, tag: 'A' });
  const baseA = server.base;

  const health = (await (await fetch(`${baseA}/healthz`)).json()) as Record<string, unknown>;
  assert(health.ok === true, `healthz.ok=${health.ok}`);
  assert(health.draining === false, '刚起来不该是 draining');

  const submit = await fetch(`${baseA}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: '回显 ping' }),
  });
  assert(submit.status === 202, `POST /tasks 应 202，实际 ${submit.status}`);
  const queued = (await submit.json()) as { taskId?: string };
  assert(typeof queued.taskId === 'string' && queued.taskId.length > 0, '202 应带 taskId');

  // 等任务进入 running（假端点真收到请求 = 模型调用在飞），再 SIGKILL —— 确定性停在半路
  await waitFor(() => fake.observed.calls >= 1, '假端点收到阶段 A 的模型调用');
  server.child.kill('SIGKILL');
  const killedCode = await server.waitExit();
  assert(killedCode !== 0, 'SIGKILL 后进程不应干净退出（退出码应为 null/非 0）');
  server = undefined;

  // —— 阶段 B：同库重启 → resumePending 必须把死在半路的任务续跑到 succeeded ——
  server = await startExample({ dbPath, fakeBaseURL: fake.baseURL, tag: 'B' });
  const baseB = server.base;
  assert(
    server.stdout().includes('[boot] 续跑 1 个未完成任务'),
    `重启应续跑 1 个未完成任务，实际 stdout：${server.stdout()}`,
  );

  fake.release(); // 开闸：续跑的模型调用放行
  const done = await pollTask(baseB, queued.taskId as string);
  assert(done.status === 'succeeded', `续跑任务终态=${done.status}`);
  assert(
    fake.observed.toolResults.some((t) => t.includes('echo: ping')),
    `echo 应真执行并回传 tool_result，实际收到 ${JSON.stringify(fake.observed.toolResults)}`,
  );
  assert(
    fake.observed.menu.includes('echo'),
    `工具菜单应含 echo，实际 ${JSON.stringify(fake.observed.menu)}`,
  );

  // —— 同步 /run：主 agent → echo → 收尾文本 ——
  const runRes = await fetch(`${baseB}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '回显 ping' }),
  });
  assert(runRes.status === 200, `POST /run 应 200，实际 ${runRes.status}`);
  const runBody = (await runRes.json()) as { status?: string; finalText?: string };
  assert(runBody.status === 'succeeded', `status=${runBody.status}`);
  assert(
    (runBody.finalText ?? '').includes('deploy-ok'),
    `finalText 应是假端点的收尾文本，实际 ${JSON.stringify(runBody.finalText)}`,
  );

  // —— /metrics（Prometheus 文本；handler 自带的 metrics 选项，不鉴权）——
  // 注：不断言 capability_calls_total —— echo 是普通 @Tool，按 trace 模型**不建 capability
  // span**（capability span 只给 @Skill/@SubAgent 这类嵌套能力，见 core/trace.ts），
  // 工具是否真执行已由上面的 tool_result 断言钉住。
  const metrics = await (await fetch(`${baseB}/metrics`)).text();
  assert(
    /agentia_runs_total [1-9]/.test(metrics),
    `/metrics 应有非零 agentia_runs_total，实际片段 ${metrics.slice(0, 300)}`,
  );

  // —— 优雅停机：SIGTERM → drain 排空 → exit 0 ——
  server.child.kill('SIGTERM');
  const code = await Promise.race([
    server.waitExit(),
    new Promise<null>((r) => setTimeout(() => r(null), 20_000)), // drain 超时是 15s，预算盖过它
  ]);
  assert(code === 0, `SIGTERM 后应 exit 0，实际 ${String(code)}`);
  assert(
    server.stdout().includes('[bye] 已排空退出'),
    `应走排空分支，实际尾部 ${server.stdout().slice(-300)}`,
  );
  server = undefined;

  console.log('E2E-DEPLOY PASS');
  console.log(
    JSON.stringify(
      {
        menu: fake.observed.menu,
        providerCalls: fake.observed.calls,
        toolResultsReachedModel: fake.observed.toolResults.length,
        resumedTaskStatus: done.status,
        syncRunStatus: runBody.status,
        metricsHasRuns: true,
        shutdownExitCode: code,
      },
      null,
      2,
    ),
  );
} finally {
  // 兜底：失败路径上进程不得残留
  if (server) {
    server.child.kill('SIGKILL');
    await server.waitExit();
  }
  await fake.close();
  rmSync(tmp, { recursive: true, force: true });
}
