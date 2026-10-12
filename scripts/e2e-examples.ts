// 示例端到端验证：`examples/complete` 按它 README 里写的方式**真起服务、真跑三种触发**；
// `examples/code-review` 真构建并跑它的**离线确定性 demo**（scriptedClient 剧本，零网络）。
//
// 为什么要有这一条：`examples/complete` 被 usage-guide / 项目 README 指着说「完整可跑写法见
// examples/complete/」，但它此前只被 `typecheck:tests` 覆盖 —— 全仓**没有任何门禁真跑过**它
// （`examples/` 下 0 个测试）。这条把「文档承诺可跑」变成「门禁证明可跑」。
//
// 不联网：complete 的模型侧用本脚本内置的假 OpenAI 兼容端点（真 SSE，逐分片）；
// code-review 的 demo 模式根本不需要模型端点（scriptedClient）。只走 127.0.0.1。
//
// 运行：npm run e2e（先 build 框架与 CLI，再 tsx 跑本脚本）
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
};

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const exampleDir = join(repoRoot, 'examples', 'complete');
const obsPkgDir = join(repoRoot, 'examples', 'observability');
const codeReviewDir = join(repoRoot, 'examples', 'code-review');
const evalGateDir = join(repoRoot, 'examples', 'eval-gate');
const obsMcpDir = join(repoRoot, 'examples', 'observability-mcp');

/** 假 OpenAI 兼容端点的记录（断言「能力真的被执行」靠它，而不是靠自己读响应文本） */
interface FakeProviderObserved {
  /** 第一次请求里模型看到的工具菜单（证明四类能力真装配上了） */
  menu: string[];
  /** 回传给模型的能力执行结果（证明 echo 真跑过） */
  toolResults: string[];
  /** 调用次数（≥2 说明走完了「调能力 → 再问一次」完整回路） */
  calls: number;
}

/** SSE 分片构造：`data: {...}` 逐条下发，末尾 `[DONE]`（与真端点同形） */
function sse(res: ServerResponse, chunks: unknown[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * 起一个假的 OpenAI 兼容端点。
 *
 * 剧本（够模拟一次「主 agent 选能力 → 拿到结果 → 收尾」的完整往返）：
 * - 请求里还没有 tool 消息 ⇒ 回一个 `echo` 的 tool_call，**且把 arguments 拆成多片**下发
 *   （真端点就是这么发的，顺带把框架侧的分片累积逻辑放进真实链路里跑一遍）；
 * - 有了 tool 消息 ⇒ 回最终文本。
 */
async function startFakeProvider(): Promise<{
  baseURL: string;
  observed: FakeProviderObserved;
  close: () => Promise<void>;
}> {
  const observed: FakeProviderObserved = { menu: [], toolResults: [], calls: 0 };
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
        tools?: Array<{ function?: { name?: string } }>;
        messages?: Array<{ role?: string; content?: unknown }>;
      };
      if (observed.calls === 1) {
        for (const t of parsed.tools ?? []) {
          if (t.function?.name) observed.menu.push(t.function.name);
        }
      }
      const toolMsgs = (parsed.messages ?? []).filter((m) => m.role === 'tool');
      for (const m of toolMsgs) observed.toolResults.push(String(m.content));

      if (toolMsgs.length === 0) {
        sse(res, [
          {
            id: 'chatcmpl-fake-1',
            model: 'fake-model',
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_echo_1',
                      type: 'function',
                      function: { name: 'echo', arguments: '' },
                    },
                  ],
                },
              },
            ],
          },
          // arguments 分片：`{"text":` + `"ping"}` —— 真端点的形态
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: '{"text":' } }] } },
            ],
          },
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: '"ping"}' } }] } },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
        ]);
        return;
      }

      sse(res, [
        {
          id: 'chatcmpl-fake-2',
          model: 'fake-model',
          choices: [{ delta: { content: '已回显：' } }],
        },
        { choices: [{ delta: { content: 'ping' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
      ]);
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
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/**
 * 让示例的 `import '@migor/agentia'` 可解析 —— 与 `scripts/e2e-cli.ts` 同一手法（symlink 回仓库根）。
 *
 * 两个理由必须自己建：
 * 1. CI 上示例目录里的 `node_modules` 不存在（已 gitignore），不建示例直接起不来；
 * 2. 本地 `npm install` 装出来的 `file:../..` 是**快照拷贝**（实测 npm 会拷贝而非软链），
 *    于是示例跑的是安装那天的框架，改了 dist 也不生效 —— 对「验证当前代码」的脚本来说这是失真。
 *    指向仓库根即可拿到**当前** dist。
 */
function ensureLinks(): void {
  const links: Array<[string, string]> = [
    // 示例应用：要能解析框架本体与本地小包
    [join(exampleDir, 'node_modules', '@migor', 'agentia'), repoRoot],
    [join(exampleDir, 'node_modules', '@migor', 'agentia-observability'), obsPkgDir],
    [join(codeReviewDir, 'node_modules', '@migor', 'agentia'), repoRoot],
    [join(evalGateDir, 'node_modules', '@migor', 'agentia'), repoRoot],
    [join(obsMcpDir, 'node_modules', '@migor', 'agentia'), repoRoot],
    // 本地小包**自己也要能构建** —— CI 上没有它的 node_modules，不建的话 `tsc -p` 会
    // 报「Cannot find module '@migor/agentia'」+「Cannot find name 'process'」
    // （@types/node 沿目录树上溯到仓库根即可解析，只有 @migor 需要这一步）
    [join(obsPkgDir, 'node_modules', '@migor', 'agentia'), repoRoot],
  ];
  for (const [link, target] of links) {
    let current: string | null = null;
    try {
      current = realpathSync(link);
    } catch {
      current = null; // 不存在
    }
    if (current === realpathSync(target)) continue; // 已指向正确目标
    rmSync(link, { recursive: true, force: true }); // 清掉快照拷贝 / 错链
    mkdirSync(join(link, '..'), { recursive: true });
    symlinkSync(target, link, 'dir');
  }
}

/** 本地小包 `@migor/agentia-observability` 的 main 指向 dist —— 没构建就先构建（离线、几秒） */
function ensureObsPkgBuilt(): void {
  if (existsSync(join(obsPkgDir, 'dist', 'index.js'))) return;
  execFileSync(join(repoRoot, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], {
    cwd: obsPkgDir,
    stdio: 'inherit',
  });
}

/**
 * 按示例**自己的构建脚本**构建（`tsc -p tsconfig.json && node scripts/copy-assets.mjs`）。
 *
 * 顺手把「示例能不能构建」也纳入门禁 —— 此前它同样没人跑过。
 * 用 dist 而不是 tsx 跑 src 还有两个好处：node 就是应用进程本身（SIGTERM 直达信号处理器，
 * 不经过 tsx CLI 的包装进程），且验的是**部署形态**的产物。
 */
function buildExample(): void {
  execFileSync(join(repoRoot, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], {
    cwd: exampleDir,
    stdio: 'inherit',
  });
  execFileSync(process.execPath, ['scripts/copy-assets.mjs'], {
    cwd: exampleDir,
    stdio: 'inherit',
  });
}

/**
 * 起示例进程（`node dist/main.js`，即示例 README 的 `npm run serve`），等它的就绪日志（不 sleep 猜时间）。
 *
 * PORT=0 + 解析日志里的**实际**端口（与 scripts/e2e-grpc.ts 同一做法）：先探空闲端口再交给
 * 子进程 bind，两步之间会被抢（EADDRINUSE flake 就是这么来的）—— 由服务自己分配，没有那个窗口。
 */
async function startExample(
  fakeBaseURL: string,
): Promise<{ port: number; stdout: () => string; stop: () => Promise<number | null> }> {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: exampleDir,
    env: {
      ...process.env,
      PORT: '0',
      AGENTIA_DB: ':memory:',
      // 走 OpenAI 兼容端点 ⇒ 用上示例里那段「注入 model client」的缝（而不是框架默认 Anthropic client）
      OPENAI_BASE_URL: fakeBaseURL,
      OPENAI_API_KEY: 'fake-key',
      AGENTIA_MODEL: 'fake-model',
      API_KEY: 'e2e-secret', // 打开鉴权缝，验 README 里那条 401
      AGENTIA_CHECK_INTERVAL_MS: '0',
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
  const deadline = Date.now() + 30_000; // 就绪预算给足：这里验的是「能不能起来」，不是「多快起来」
  let port: number | undefined;
  while (port === undefined) {
    const m = /\[boot\] listening on :(\d+)/.exec(out);
    if (m) {
      port = Number(m[1]);
    } else if (child.exitCode !== null) {
      throw new Error(
        `示例进程启动即退出（code=${child.exitCode}）\n--- stdout ---\n${out}\n--- stderr ---\n${err}`,
      );
    } else if (Date.now() > deadline) {
      throw new Error(`等示例就绪超时（30s）\n--- stdout ---\n${out}\n--- stderr ---\n${err}`);
    } else {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  return {
    port,
    stdout: () => out,
    stop: async () => {
      child.kill('SIGTERM'); // README 承诺的优雅停机路径
      const code = await Promise.race([
        exited,
        new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
      ]);
      if (code === null) child.kill('SIGKILL');
      return code;
    },
  };
}

/** 轮询任务记录到终态（就绪预算是给足的：验的是「最终会成功」，不是「多快成功」） */
async function pollTask(
  base: string,
  taskId: string,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const rec = (await (await fetch(`${base}/tasks/${taskId}`, { headers })).json()) as Record<
      string,
      unknown
    >;
    if (rec.status !== 'queued' && rec.status !== 'running') return rec;
    if (Date.now() > deadline) throw new Error(`任务 ${taskId} 20s 未终态：${JSON.stringify(rec)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** code-review demo 产出的 trace 里本脚本要断言的最小形状（只声明用到的字段） */
interface CodeReviewSpan {
  spanId: string;
  kind: string;
  name: string;
  events: Array<{ name: string; body: unknown }>;
}

/**
 * `examples/code-review` 的离线 demo 验证（README「npm run demo」一节的可执行版本）：
 * 真构建（tsc + copy-assets）→ 跑 dist/demo.js（exit≠0 时 execFileSync 直接抛）→
 * 断言 stdout 摘要与 out/ 产物（trace.jsonl 的 capability span / llm.turn 数 / score 事件 /
 * token 口径，report.json 的结构化结论）。
 *
 * demo 是**确定性**的（scriptedClient 8 步剧本）：token 数与成本数字钉死断言，
 * 任何框架侧记账口径的变化都会在这里响亮失败 —— 这正是「产品验证」要的效果。
 */
function verifyCodeReview(): Record<string, unknown> {
  execFileSync(join(repoRoot, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], {
    cwd: codeReviewDir,
    stdio: 'inherit',
  });
  execFileSync(process.execPath, ['scripts/copy-assets.mjs'], {
    cwd: codeReviewDir,
    stdio: 'inherit',
  });

  // 剥掉模型侧 env：本机 export 过 AGENTIA_MODEL / ANTHROPIC_* 时，demo 的数字会随之变 ——
  // 确定性验证必须在自己控制的环境里跑
  const env = { ...process.env };
  delete env.AGENTIA_MODEL;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_BASE_URL;
  const out = execFileSync(process.execPath, ['dist/demo.js'], {
    cwd: codeReviewDir,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });

  assert(out.includes('stopReason=end_turn'), `demo 应正常收尾，实际 stdout:\n${out}`);
  assert(out.includes('整体定级 high'), `结论应定级 high，实际 stdout:\n${out}`);
  assert(
    out.includes('估算成本：$0.002796'),
    `demo 的成本行是确定性数字（25600 入 / 1180 出 × deepseek-v4-flash 定价），实际 stdout:\n${out}`,
  );

  const tracePath = join(codeReviewDir, 'out', 'trace.jsonl');
  assert(existsSync(tracePath), 'demo 应产出 out/trace.jsonl');
  const lines = readFileSync(tracePath, 'utf8').trim().split('\n');
  assert(lines.length === 1, `一次 run 一行 trace，实际 ${lines.length} 行`);
  const trace = JSON.parse(lines[0]) as {
    rootSpanId: string;
    spans: CodeReviewSpan[];
    totalUsage: { inputTokens: number; outputTokens: number; costEstimate?: number };
  };

  const capabilities = trace.spans
    .filter((s) => s.kind === 'capability')
    .map((s) => s.name)
    .sort();
  assert(
    JSON.stringify(capabilities) === JSON.stringify(['security_scan', 'summarize']),
    `应有 subagent/skill 两个 capability span，实际 ${JSON.stringify(capabilities)}`,
  );
  const turns = trace.spans.filter((s) => s.kind === 'llm.turn').length;
  assert(turns === 8, `llm.turn 应 8 个（主 5 + 子 agent 2 + skill 1），实际 ${turns}`);

  const root = trace.spans.find((s) => s.spanId === trace.rootSpanId);
  const score = root?.events.find((e) => e.name === 'score')?.body as
    | { name?: string; value?: number }
    | undefined;
  assert(
    score?.name === 'fixture_coverage' && score?.value === 1,
    `根 span 应有 fixture_coverage=1 的 score 事件（种子问题全命中），实际 ${JSON.stringify(score)}`,
  );
  assert(
    trace.totalUsage.inputTokens === 25_600 && trace.totalUsage.outputTokens === 1_180,
    `totalUsage 口径变了：${JSON.stringify(trace.totalUsage)}`,
  );
  assert(
    trace.totalUsage.costEstimate === 0.002796,
    `priceOverrides 定价应算出 $0.002796，实际 ${JSON.stringify(trace.totalUsage.costEstimate)}`,
  );

  const report = JSON.parse(readFileSync(join(codeReviewDir, 'out', 'report.json'), 'utf8')) as {
    riskLevel?: string;
    findings?: unknown[];
  };
  assert(
    report.riskLevel === 'high' && report.findings?.length === 5,
    `report.json 应是 5 条发现 + high 定级，实际 ${JSON.stringify(report).slice(0, 200)}`,
  );

  return {
    demoExit: 0,
    spans: trace.spans.length,
    llmTurns: turns,
    capabilities,
    score: `${score!.name}=${score!.value}`, // 上面已断言存在
    costUsd: trace.totalUsage.costEstimate,
  };
}

/**
 * `examples/eval-gate` 的验证（`docs/eval-gate.md` 与它的 README 的可执行版本）。
 *
 * 三件事：真构建 → 对**仓库里那份基线**跑（应通过）→ 再喂三份**被改坏的**基线，
 * 断言闸门按语义分别给出 `1 / 1 / 2`。
 *
 * 为什么值得进 e2e：这套判据的失败方式是**静默泄成 `EvalReport.ok` 的转发**
 * （「用例都过就通过」）—— 那样它就不再防「删掉失败用例」与「撒谎的基线」，而两条都不报错。
 * 单测覆盖了纯函数那一层（`tests/docs/eval-gate.test.ts`），这里覆盖**产物那一层**：
 * `npm run build` 出来的 `dist/main.js` + 真的读文件 + 真的以退出码收场。
 */
function verifyEvalGate(): Record<string, unknown> {
  // 构建与运行都走**示例自己 package.json 里承诺的 script**（'npm' 的可执行名在 e2e-cli 里
  // 已有同款先例）—— 直接调 .bin/tsc 或 node dist/main.js 等于测试脚本另算一份等价输入，
  // 「承诺过的 script 坏了」就没人发现（本仓纪律：测产物用产物自己的命令）。
  const npmRun = (script: string, extraArgs: string[] = []): { code: number; out: string } => {
    const r = spawnSync('npm', ['run', script, ...extraArgs], {
      cwd: evalGateDir,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const built = npmRun('build');
  assert(
    built.code === 0,
    `示例自己的 npm run build 应成功，实际 ${String(built.code)}：\n${built.out}`,
  );

  /** 跑一次闸门（`--baseline` 指到临时文件上，仓库里那份基线全程只读） */
  const run = (baseline?: string): { code: number; out: string } =>
    // 干净跑走示例承诺的 `check` script；带基线的变体走它透传的同一条 main
    npmRun('check', baseline === undefined ? [] : ['--', '--baseline', baseline]);

  const clean = run();
  assert(
    clean.code === 0,
    `对仓库基线应通过（exit 0），实际 ${String(clean.code)}：\n${clean.out}`,
  );
  assert(
    clean.out.includes('⇒ 通过：没有回归、没有删用例'),
    `应打印通过的结论，实际：\n${clean.out}`,
  );
  assert(
    clean.out.includes('通过 3 / 失败 1'),
    `示例刻意留着一条已知失败（基线记 false）—— 它不该拦住发布，实际：\n${clean.out}`,
  );

  const dir = mkdtempSync(join(tmpdir(), 'agentia-eval-gate-'));
  try {
    // `npm run update`（= --update）是示例承诺的第三条 script —— 此前从未被真跑过。
    // 基线指到临时文件：仓库里那份保持只读。
    const updateBaseline = join(dir, 'updated.json');
    const updated = npmRun('update', ['--', '--baseline', updateBaseline]);
    assert(
      updated.code === 0,
      `示例自己的 npm run update 应成功，实际 ${String(updated.code)}：\n${updated.out}`,
    );
    const written = JSON.parse(readFileSync(updateBaseline, 'utf8')) as {
      cases?: Record<string, boolean>;
    };
    assert(
      Object.keys(written.cases ?? {}).length === 4,
      `update 应把本次结论写成 4 条用例的新基线，实际：${JSON.stringify(Object.keys(written.cases ?? {}))}`,
    );

    const base = JSON.parse(readFileSync(join(evalGateDir, 'baseline.json'), 'utf8')) as {
      cases: Record<string, boolean>;
    };
    const knownFailure = Object.keys(base.cases).find((k) => k.startsWith('demo-known-failure::'));
    assert(knownFailure !== undefined, '基线里应有那条已知失败的用例键');

    // ① 撒谎：把「已知失败」记成「曾经通过」⇒ 基线说过通过、这次失败 ⇒ 回归
    const lie = join(dir, 'lie.json');
    writeFileSync(
      lie,
      JSON.stringify({ ...base, cases: { ...base.cases, [knownFailure!]: true } }),
    );
    const lied = run(lie);
    assert(
      lied.code === 1,
      `撒谎的基线应判成回归（exit 1），实际 ${String(lied.code)}：\n${lied.out}`,
    );
    assert(
      lied.out.includes('✗ 回归 1 条') && lied.out.includes(knownFailure!),
      `应点名那条回归，实际：\n${lied.out}`,
    );

    // ② 删用例：基线里多一条「这次不存在」的键 ⇒ 不通过（删掉失败用例不是通过的方式）
    const ghost = join(dir, 'ghost.json');
    writeFileSync(
      ghost,
      JSON.stringify({ ...base, cases: { ...base.cases, 'demo-ghost::被删掉的用例': true } }),
    );
    const ghosted = run(ghost);
    assert(
      ghosted.code === 1,
      `基线里有、这次没跑应判不通过（exit 1），实际 ${String(ghosted.code)}：\n${ghosted.out}`,
    );
    assert(
      ghosted.out.includes('删用例不是通过的方式'),
      `应说清为什么不过，实际：\n${ghosted.out}`,
    );

    // ③ 坏基线 ⇒ exit 2：**「基线文件坏了」不该被读成「我的 agent 退化了」**
    const empty = join(dir, 'empty.json');
    writeFileSync(empty, JSON.stringify({ name: 'broken', generatedAt: '', cases: {} }));
    const broken = run(empty);
    assert(
      broken.code === 2,
      `空基线应 exit 2（环境错误），实际 ${String(broken.code)}：\n${broken.out}`,
    );

    return {
      cleanExit: clean.code,
      lieExit: lied.code,
      ghostExit: ghosted.code,
      emptyBaselineExit: broken.code,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * `examples/observability-mcp` 的验证（G8）—— 「分发面」的验收：**起真 server，用出厂的
 * MCP 客户端连回去**跑通 `report` / `diff` / 越界拒绝。
 *
 * 为什么值得进 e2e：这个示例的全部价值就是「外部 MCP 客户端接得上」，而那条链路
 * （握手 → `tools/list` → `tools/call` → 边界拒绝）**单测覆盖不到** —— 它是两个进程 + HTTP
 * 才活起来的东西。走示例自己的 `npm run build` / `npm run verify`（不另算一份等价输入，
 * 同 eval-gate 的纪律：测产物用产物自己的命令）。
 *
 * 也顺带进了门禁：示例的 `src/` 在 `tsconfig.tests.json` 的 include 里，`typecheck:tests`
 * 会按**仓库根**那套严格开关（含 `exactOptionalPropertyTypes`）编它。
 */
function verifyObservabilityMcp(): Record<string, unknown> {
  const npmRun = (script: string): { code: number; out: string } => {
    const r = spawnSync('npm', ['run', script], {
      cwd: obsMcpDir,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const built = npmRun('build');
  assert(
    built.code === 0,
    `示例自己的 npm run build 应成功，实际 ${String(built.code)}：\n${built.out}`,
  );

  const verified = npmRun('verify');
  assert(
    verified.code === 0,
    `npm run verify 应 exit 0，实际 ${String(verified.code)}：\n${verified.out}`,
  );
  assert(
    verified.out.includes('G8 验收通过'),
    `verify 应打印通过结论，实际尾部：\n${verified.out.slice(-400)}`,
  );
  // ⚠️ 除退出码外还要数**失败标记**：verify 内部是一条条 check，退出码只反映最后统计，
  //    而「统计写错 / 提前 process.exit」这类坏法会让 exit 0 与失败断言并存（本仓纪律：
  //    结论行与失败标记都要看，别只看一个）。
  const failed = (verified.out.match(/✗/g) ?? []).length;
  assert(failed === 0, `不应有失败断言，实际 ${failed} 条：\n${verified.out}`);
  assert(
    verified.out.includes('mcpTools 握手拿到两个只读工具'),
    '应真的走了 MCP 协议握手（tools/list），而不是绕过协议直接调工具',
  );
  const passed = (verified.out.match(/✓/g) ?? []).length;
  return {
    buildExit: built.code,
    verifyExit: verified.code,
    checks: passed,
    boundaryRefused: verified.out.includes('越界路径被拒'),
  };
}

const fake = await startFakeProvider();
let example: Awaited<ReturnType<typeof startExample>> | undefined;
try {
  ensureLinks();
  ensureObsPkgBuilt();
  buildExample();

  example = await startExample(fake.baseURL);
  const base = `http://127.0.0.1:${example.port}`;
  const auth = { 'x-api-key': 'e2e-secret', 'content-type': 'application/json' };

  // —— 1) /healthz（不鉴权）——
  const health = (await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>;
  assert(health.ok === true, `healthz.ok=${health.ok}`);
  assert(health.draining === false, '刚起来不该是 draining');

  // —— 2) 鉴权缝：开了 API_KEY 时无凭据必须 401（README 明写）——
  const unauthorized = await fetch(`${base}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'hi' }),
  });
  assert(unauthorized.status === 401, `无凭据应 401，实际 ${unauthorized.status}`);

  // —— 3) 同步 /run：主 agent → 选能力（echo）→ 出结果 ——
  // 顺带带上 W3C `traceparent`（入站链路，C）：真实验证「头 → run 根 links」这条跨进程关联路径，
  // 而不只是单测里过一遍（e2e 的价值就在于走真 HTTP 栈、真装配）。
  const UP_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
  const UP_SPAN = '00f067aa0ba902b7';
  const runRes = await fetch(`${base}/run`, {
    method: 'POST',
    headers: { ...auth, traceparent: `00-${UP_TRACE}-${UP_SPAN}-01` },
    body: JSON.stringify({ prompt: '回显 ping' }),
  });
  assert(runRes.status === 200, `POST /run 应 200，实际 ${runRes.status}`);
  // /run 的响应是**扁平**形状（toHttpBody）：runId/status/stopReason/finalText/typed/trace/error
  const runBody = (await runRes.json()) as {
    status?: string;
    stopReason?: string;
    finalText?: string;
    trace?: { spans: Array<{ kind: string; links?: Array<{ traceId: string; spanId?: string }> }> };
  };
  assert(runBody.status === 'succeeded', `status=${runBody.status}`);
  assert(runBody.stopReason === 'end_turn', `stopReason=${runBody.stopReason}`);
  const rootLinks = runBody.trace?.spans.find((s) => s.kind === 'run')?.links;
  assert(
    rootLinks?.length === 1 && rootLinks[0].traceId === UP_TRACE && rootLinks[0].spanId === UP_SPAN,
    `traceparent 头应记成 run 根的一条 link，实际 ${JSON.stringify(rootLinks)}`,
  );
  assert(
    (runBody.finalText ?? '').includes('已回显'),
    `finalText 应是假端点给的收尾文本，实际 ${JSON.stringify(runBody.finalText)}`,
  );
  assert(
    fake.observed.toolResults.some((t) => t.includes('echo: ping')),
    `能力应真执行并回传 tool_result，实际收到 ${JSON.stringify(fake.observed.toolResults)}`,
  );
  const expectedMenu = ['echo', 'house_style', 'outline_writer', 'researcher'];
  const menu = [...fake.observed.menu].sort();
  assert(
    JSON.stringify(menu) === JSON.stringify(expectedMenu),
    `四类能力应全部进菜单，实际 ${JSON.stringify(menu)}`,
  );

  // —— 4) SSE 流式下发 ——
  const sseRes = await fetch(`${base}/run`, {
    method: 'POST',
    headers: { ...auth, accept: 'text/event-stream' },
    body: JSON.stringify({ prompt: '回显 ping' }),
  });
  assert(sseRes.status === 200, `SSE 应 200，实际 ${sseRes.status}`);
  assert(
    (sseRes.headers.get('content-type') ?? '').includes('event-stream'),
    `SSE content-type=${sseRes.headers.get('content-type')}`,
  );
  const sseText = await sseRes.text();
  assert(sseText.includes('已回显'), `SSE 应下发了增量文本，实际 ${sseText.slice(0, 200)}`);

  // —— 5) 异步 /tasks + 幂等键去重 + 轮询到终态 ——
  const submit = await fetch(`${base}/tasks`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ input: '回显 ping', idempotencyKey: 'e2e-demo-1' }),
  });
  assert(submit.status === 202, `POST /tasks 应 202，实际 ${submit.status}`);
  const queued = (await submit.json()) as { taskId?: string };
  assert(typeof queued.taskId === 'string' && queued.taskId.length > 0, '202 应带 taskId');
  const done = await pollTask(base, queued.taskId as string, auth);
  assert(done.status === 'succeeded', `异步任务终态=${done.status}`);

  const again = (await (
    await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ input: '回显 ping', idempotencyKey: 'e2e-demo-1' }),
    })
  ).json()) as { taskId?: string };
  assert(again.taskId === queued.taskId, `同幂等键应去重返回既有记录，实际 ${again.taskId}`);

  // —— 6) /metrics（Prometheus 文本）——
  const metrics = await (await fetch(`${base}/metrics`)).text();
  assert(metrics.includes('agentia_runs_total'), '/metrics 应含 agentia_runs_total');
  assert(
    /agentia_capability_calls_total\{capability="[^"]+"\} [1-9]/.test(metrics),
    `能力级指标应有非零样本（证明 E2 在真链路里生效），实际片段 ${metrics.slice(0, 300)}`,
  );

  // —— 7) 优雅停机：SIGTERM → 排空后 exit 0 ——
  const code = await example.stop();
  assert(code === 0, `SIGTERM 后应 exit 0，实际 ${String(code)}`);
  assert(
    example.stdout().includes('[bye] 已排空退出'),
    `应走排空分支，实际尾部 ${example.stdout().slice(-300)}`,
  );

  // —— 8) code-review 示例：离线 demo 真跑 + 产物断言（见 verifyCodeReview）——
  const codeReview = verifyCodeReview();
  // —— 9) eval-gate 示例：闸门真跑 + 三份被改坏的基线（见 verifyEvalGate）——
  const evalGate = verifyEvalGate();

  // —— 10) observability-mcp 示例：起真 server + 出厂 MCP 客户端连回去（见 verifyObservabilityMcp）——
  const obsMcp = verifyObservabilityMcp();

  console.log('E2E-EXAMPLES PASS');
  console.log(
    JSON.stringify(
      {
        menu,
        providerCalls: fake.observed.calls,
        toolResultsReachedModel: fake.observed.toolResults.length,
        syncRunStatus: runBody.status,
        sseBytes: sseText.length,
        taskStatus: done.status,
        idempotentDedupe: again.taskId === queued.taskId,
        metricsHasCapabilitySamples: true,
        shutdownExitCode: code,
        codeReview,
        evalGate,
        obsMcp,
      },
      null,
      2,
    ),
  );
} finally {
  if (example) await example.stop();
  await fake.close();
}
