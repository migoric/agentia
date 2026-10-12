/**
 * G8 验收（`npm run verify`）—— **起真 server，用出厂的 MCP 客户端连回去，把两个工具都跑通**。
 *
 * 三层都是真的：真 HTTP server（`createMcpServer`，127.0.0.1 + 系统分配端口）、真协议客户端
 * （`createStreamableHttpMcpConnector` + `mcpTools` 走完 `initialize` / `tools/list` /
 * `tools/call`）、真 trace（由 `scriptedClient` 剧本跑出来）。零 API key、零网络 ——
 * 剧本对不上号就当场红，不必等线上。
 *
 * 为什么这条判据值得写：本示例的价值在**分发面**（agent 能自己接上来查）而不是功能面，
 * 所以「外部客户端能接上并拿到正确数字」就是它唯一的验收标准。
 *
 * ⚠️ 断言是**照着实测形状**写的，不是「能看到就行」：普通 `@Tool` 刻意不建 capability span
 * （只有 `@Skill` / `@SubAgent` 建）⇒ 换能力在 diff 里落在 llm.turn 的**事件体**上。
 * 形状是先跑探针（`.workbuddy/probes/g8-diff-shape.ts`）看出来的。
 */
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemorySessionStore,
  SystemPrompt,
  Tool,
  createApp,
  createMcpServer,
  createStreamableHttpMcpConnector,
  jsonlTraceSink,
  mcpTools,
  scriptedClient,
} from '@migor/agentia';
import type { ScriptedStep } from '@migor/agentia';
import { MAX_DIFF_SPANS, MAX_SESSION_ROWS, NO_SESSION } from './traces.js';
import { buildApp } from './tools.js';

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

const base = mkdtempSync(join(tmpdir(), 'agentia-obs-mcp-'));
const root = join(base, 'traces');
const outside = join(base, 'outside.jsonl');
mkdirSync(root, { recursive: true });
/** 只读边界（`traces.ts` 的 `resolveInsideRoot` 每次调用现读，故这里设一次就够） */
process.env.AGENTIA_TRACE_ROOT = root;

const sessionFile = join(root, 'session.jsonl');
const aFile = join(root, 'a.jsonl');
const bFile = join(root, 'b.jsonl');
const cFile = join(root, 'c.jsonl');
const longAFile = join(root, 'long-a.jsonl');
const longBFile = join(root, 'long-b.jsonl');
const tasksFile = join(root, 'tasks.jsonl');
const manySessionsFile = join(root, 'many-sessions.jsonl');

/* ───────────────── 被观测的「目标 app」：真跑若干条 run（剧本，零网络） ───────────────── */

const MODEL = 'deepseek-v4-flash';

/** 被查的应用：两个能力（跑不跑它们由剧本决定） */
class Target {
  @Tool({
    description: '列出某个目录下的文件',
    schema: {
      type: 'object',
      properties: { dir: { type: 'string' } },
      required: ['dir'],
      additionalProperties: false,
    },
  })
  list_files(input: { dir: string }): string {
    return `${input.dir}: a.txt，b.txt`;
  }

  @Tool({
    description: '读一个文件的内容',
    schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  })
  read_file(input: { path: string }): string {
    return `${input.path} 的内容：hello`;
  }
}

let seq = 0;
const usage = (input: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});
function toolTurn(input: number, output: number, name: string, args: unknown): ScriptedStep {
  const id = ++seq;
  return {
    id: `m${id}`,
    model: MODEL,
    stop_reason: 'tool_use' as const,
    usage: usage(input, output),
    content: [{ type: 'tool_use', id: `tu${id}`, name, input: args }],
  };
}
function endTurn(text: string): ScriptedStep {
  const id = ++seq;
  return {
    id: `m${id}`,
    model: MODEL,
    stop_reason: 'end_turn' as const,
    usage: usage(700, 40),
    content: [{ type: 'text', text }],
  };
}

/** A：列目录 → 读文件 → 收尾 */
const SCRIPT_A: ScriptedStep[] = [
  toolTurn(1200, 40, 'list_files', { dir: '/tmp/demo' }),
  toolTurn(1800, 60, 'read_file', { path: '/tmp/demo/a.txt' }),
  endTurn('目录里有两个文件，内容已读到。'),
];
/** B：回合数与 A 相同，**第二个回合换成另一个能力** ⇒ 差异落在「同一位置换了能力」上 */
const SCRIPT_B: ScriptedStep[] = [
  toolTurn(1000, 30, 'list_files', { dir: '/tmp/demo' }),
  toolTurn(1400, 35, 'list_files', { dir: '/tmp/demo/sub' }),
  endTurn('目录里有两个文件，子目录也看了一眼。'),
];
/** C：**比 A 少一个回合** ⇒ 用来验「缺侧」那条路径（`missing === 'after'`） */
const SCRIPT_C: ScriptedStep[] = [
  toolTurn(1100, 35, 'list_files', { dir: '/tmp/demo' }),
  endTurn('只看了一层。'),
];

/** 长剧本：`n` 个回合、每回合 token 都不同 ⇒ 全部进差异，用来踩 `MAX_DIFF_SPANS` 的截断 */
function longScript(n: number, bias: number): ScriptedStep[] {
  const steps: ScriptedStep[] = [];
  for (let i = 0; i < n; i += 1) {
    steps.push(toolTurn(1000 + bias + i, 20 + i, 'list_files', { dir: `/tmp/demo/${i}` }));
  }
  steps.push(endTurn('看完了。'));
  return steps;
}

/**
 * 每次新建一个 app，sink 指向指定文件 —— JSONL sink 是**追加**写，所以同一个文件多跑几次
 * 就是「一个文件里多条 run」。真模型写法见 `npm start`；这里用剧本把整条链做成确定性的。
 */
function targetApp(traceFile: string) {
  return createApp({
    name: 'target-app',
    system: new SystemPrompt().add('role', '被观测的目标应用', true),
    providers: [{ provide: 'target', useClass: Target }],
    model: MODEL,
    // ⚠️ 必须显式抬高：引擎缺省 `maxIterations` 是 40（`src/engine/run-config.ts`），而第 6 组
    // 夹具要 45 个回合 —— 不抬的话 run 在第 40 回合被截断，恰好**等于** `MAX_DIFF_SPANS`，
    // 于是「截断」那条断言看起来过了、实际什么都没验（第一次跑就是这么被抓出来的）。
    maxIterations: 60,
    // 不在内置价格表的模型必须经这条缝定价，否则成本恒 undefined、maxCostUsd 静默失效
    priceOverrides: { [MODEL]: { in: 0.1, out: 0.2 } },
    sinks: [jsonlTraceSink({ path: traceFile })],
  });
}

/* ───────────────── 结果解包（MCP 结果对象 → 结构化 payload） ───────────────── */

/** `content[0].text` 是 JSON 文本（非 string 的返回值由 server `stringifySafe` 化） */
function payloadOf(res: unknown): Record<string, unknown> {
  const o = res as { content?: Array<{ type?: string; text?: string }> };
  const text = o?.content?.find((c) => c.type === 'text')?.text;
  if (text === undefined) throw new Error(`MCP 结果里没有 text content：${JSON.stringify(res)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

try {
  console.log('\n== 1. 造真 trace：scriptedClient 剧本跑 6 次（零 API key、零网络） ==');
  {
    const session = new InMemorySessionStore();
    // 同一个 app 跑两次（同一会话）⇒ 该文件两条 run，且都带 run 根 `session.id`
    const app = targetApp(sessionFile);
    for (const step of [SCRIPT_A, SCRIPT_B]) {
      await app.run([{ role: 'user', content: '看看这个目录' }], {
        client: scriptedClient(step),
        session: { store: session, id: 'demo-session' },
      });
    }
    const oneOff: Array<[string, ScriptedStep[]]> = [
      [aFile, SCRIPT_A],
      [bFile, SCRIPT_B],
      [cFile, SCRIPT_C],
      [longAFile, longScript(45, 0)],
      [longBFile, longScript(45, 500)],
    ];
    for (const [file, step] of oneOff) {
      await targetApp(file).run([{ role: 'user', content: '看看这个目录' }], {
        client: scriptedClient(step),
      });
    }
    // 根之外再放一个**真实存在的、而且内容合法**的 trace 文件 —— 边界要拦的是「读得到但
    // 不该读」，不是「读不出来」。⚠️ 这一条是变异测出来的：起初这里放的是个非 trace 的
    // JSON，于是把边界判断删掉后工具**仍然**报错（只是理由从「越界」变成「认不出 trace」），
    // isError 那条断言照样绿 —— 样本没有复现病灶的形状。换成合法 trace 后，删掉边界
    // 就会真的返回一份报告，两条断言同时红。
    copyFileSync(aFile, outside);
    // §8 的夹具：TaskRecord 形态的 wrapper（顶层 `taskId`）—— FileTaskStore / SqliteTaskStore
    // 导出的就是这种形状。task-3 那条包的是**带 `session.id` 的 trace**（sessionFile 里真跑出来的），
    // 用来验「会话优先于任务键」；裸行用来验「无会话桶」。
    const bareLine = readFileSync(aFile, 'utf8').split('\n')[0] ?? '';
    const sessionLine = readFileSync(sessionFile, 'utf8').split('\n')[0] ?? '';
    const bareTrace = JSON.parse(bareLine) as unknown;
    const sessionTrace = JSON.parse(sessionLine) as unknown;
    writeFileSync(
      tasksFile,
      `${[
        JSON.stringify({ taskId: 'task-1', status: 'succeeded', result: { trace: bareTrace } }),
        JSON.stringify({ taskId: 'task-2', status: 'succeeded', result: { trace: bareTrace } }),
        bareLine,
        JSON.stringify({ taskId: 'task-3', status: 'succeeded', result: { trace: sessionTrace } }),
      ].join('\n')}\n`,
    );
    // §10 的夹具：45 个不同 `session.id` 的**手写**最小 trace —— 验的是报告聚合与截断，
    // 不是引擎，所以不必经剧本真跑。`endedAt = i + 1` ⇒ 总耗时随编号递增，
    // 截断后谁留谁走是确定的（sess-44 最贵，sess-0 最便宜）。
    writeFileSync(
      manySessionsFile,
      `${Array.from({ length: 45 }, (_, i) =>
        JSON.stringify({
          traceId: `t${i}`,
          rootSpanId: 's0',
          status: 'ok',
          spans: [
            {
              spanId: 's0',
              parentSpanId: null,
              kind: 'run',
              name: 'agent.run',
              startedAt: 0,
              endedAt: i + 1,
              status: 'ok',
              attributes: { 'session.id': `sess-${i}` },
              events: [],
            },
          ],
        }),
      ).join('\n')}\n`,
    );
    console.log(`  · trace 根 = ${root}`);
  }

  console.log('\n== 2. 起真 server（StreamableHTTP）⇐ 出厂连接器 + mcpTools ==');
  const server = createMcpServer(buildApp(), {
    transport: 'http',
    host: '127.0.0.1',
    port: 0, // 系统分配：先探端口再 bind 会 flake，交给服务自己分配
    name: 'agentia-observability-mcp',
  });
  await server.ready;
  console.log(`  · ${server.url}`);

  const conn = createStreamableHttpMcpConnector(server.url ?? '');
  const clientTools = await mcpTools(conn);
  const reportTool = clientTools.find((t) => t.name.endsWith('report_trace'));
  const diffTool = clientTools.find((t) => t.name.endsWith('diff_traces'));
  check(
    'mcpTools 握手拿到两个只读工具',
    clientTools.length === 2,
    clientTools.map((t) => t.name).join(', '),
  );
  if (!reportTool || !diffTool) throw new Error('tools/list 里缺 report_trace 或 diff_traces');

  console.log('\n== 3. 跑通一次 report（相对路径 ⇒ 落在 trace 根里） ==');
  {
    const r = payloadOf(await reportTool.run({ file: 'session.jsonl' }));
    const sessions = (r.sessions ?? []) as Array<Record<string, unknown>>;
    const report = (r.report ?? {}) as {
      capabilities?: Array<{ capability: string }>;
      totalUsage?: { costEstimate?: number };
    };
    check('runs = 2（同一文件里两条 run）', r.runs === 2, `runs=${String(r.runs)}`);
    check('succeeded = 2', r.succeeded === 2, `succeeded=${String(r.succeeded)}`);
    check(
      '会话表归到 demo-session（2 run / 2 成功）',
      sessions.length === 1 && sessions[0]?.session === 'demo-session' && sessions[0]?.runs === 2,
      JSON.stringify(sessions[0] ?? null),
    );
    // 能力标签带 kind 前缀（`tool:<名>` / `skill:<名>` / `subagent:<名>`），不是裸工具名
    check(
      '能力表含两个真跑过的能力',
      Array.isArray(report.capabilities) &&
        report.capabilities.some((c) => c.capability === 'tool:list_files') &&
        report.capabilities.some((c) => c.capability === 'tool:read_file'),
      (report.capabilities ?? []).map((c) => c.capability).join(', '),
    );
    check(
      '成本算得出（priceOverrides 定价生效，不是 undefined）',
      typeof report.totalUsage?.costEstimate === 'number' && report.totalUsage.costEstimate > 0,
      `cost=${String(report.totalUsage?.costEstimate)}`,
    );
  }

  console.log('\n== 4. diff：同一位置换了能力 ==');
  {
    const d = payloadOf(await diffTool.run({ before: 'a.jsonl', after: 'b.jsonl' }));
    const spans = (d.spans ?? []) as Array<{
      path: string;
      missing: string | null;
      fields: Array<{ field: string; a: unknown; b: unknown }>;
    }>;
    const summary = (d.summary ?? []) as Array<{ field: string }>;
    check('equal = false', d.equal === false, `equal=${String(d.equal)}`);
    check('run 级差异非空（usage 至少一处变）', summary.length > 0, `${summary.length} 条`);
    // ⚠️ 普通 `@Tool` **刻意不建 capability span** ⇒ 「第二回合换了能力」在 diff 里的落点是
    // llm.turn 的**事件体差异**，而不是什么 `capability:read_file` 路径。
    check(
      '看得到「第二回合换了能力」（事件体 a=read_file / b=list_files）',
      spans.some(
        (s) =>
          s.path.endsWith('llm.turn#1') &&
          s.fields.some(
            (f) =>
              f.field === 'events[0].body' &&
              JSON.stringify(f.a ?? '').includes('read_file') &&
              JSON.stringify(f.b ?? '').includes('list_files'),
          ),
      ),
      spans.map((s) => `${s.path}(${s.fields.length} 字段)`).join(' | '),
    );
  }

  console.log('\n== 5. diff：一侧少一个回合（缺侧那条路径） ==');
  {
    const d = payloadOf(await diffTool.run({ before: 'a.jsonl', after: 'c.jsonl' }));
    const spans = (d.spans ?? []) as Array<{
      path: string;
      missing: string | null;
      fields: unknown[];
    }>;
    const after = spans.filter((s) => s.missing === 'after');
    check(
      '缺侧标成 missing = after（不是 null、也不是另一侧）',
      after.length > 0 && !spans.some((s) => s.missing === 'before'),
      spans.map((s) => `${s.path}${s.missing ? `(缺 ${s.missing})` : ''}`).join(' | '),
    );
    check(
      '缺侧那些不下钻（fields 为空 —— 一条缺失记录即代表整支）',
      after.every((s) => s.fields.length === 0),
    );
  }

  console.log(`\n== 6. diff：45 个回合 ⇒ 截断到 ${MAX_DIFF_SPANS} 条并如实报出 ==`);
  {
    const d = payloadOf(await diffTool.run({ before: 'long-a.jsonl', after: 'long-b.jsonl' }));
    const spans = (d.spans ?? []) as Array<{ path: string }>;
    const spanDiffs = Number(d.spanDiffs);
    check(
      '差异总数大于上限（这份夹具真的踩到了截断）',
      spanDiffs > MAX_DIFF_SPANS,
      `${spanDiffs} 条`,
    );
    check('返回条数正好卡在上限', spans.length === MAX_DIFF_SPANS, `${spans.length} 条`);
    check(
      '截掉的条数如实报出（不是 0、不是编的）',
      d.truncated === spanDiffs - spans.length,
      `truncated=${String(d.truncated)}`,
    );
  }

  console.log('\n== 7. 边界：trace 根之外的文件必须被拒 ==');
  {
    // 客户端（桥）把 isError 应答**转成抛错**（协议层是成功应答 + isError，见 mcp-protocol 的
    // assertToolResultNotError）—— 这样模型才看得见失败，而不是拿到一段像正常结果的东西。
    let msg = '';
    try {
      // 用**相对**越界路径（`../`）来试：它同时验了「相对路径按根解析」与「解析后仍在根内」两步
      await reportTool.run({ file: '../outside.jsonl' });
    } catch (e) {
      msg = (e as Error).message;
    }
    check('越界路径被拒（isError 转成抛错）', msg.includes('isError'), msg.slice(0, 160));
    check('拒绝理由点名了「根之外」', msg.includes('根之外'), msg.slice(0, 200));
    // 报出来的根是 **realpath 之后**的那个（macOS 上 /var 是 /private/var 的符号链接）——
    // 这正是「比字符串前缀」拦不住「同名兄弟目录」绕过的原因。⚠️ 只比对前缀 32 字：
    // 桥侧错误文案经 brief(max=200) 截断，长路径会把后半段吃掉。
    check(
      '拒绝时给出的是解析后的根（符号链接已消解）',
      msg.includes(realpathSync(root).slice(0, 32)),
    );
  }

  console.log('\n== 8. report：分组键三级回退（session.id → wrapper taskId → (无会话)） ==');
  {
    const r = payloadOf(await reportTool.run({ file: 'tasks.jsonl' }));
    const sessions = (r.sessions ?? []) as Array<{ session?: unknown }>;
    const keys = sessions.map((s) => String(s.session));
    check('四条 run 全数收进报告', r.runs === 4, `runs=${String(r.runs)}`);
    check(
      'wrapper 顶层的 taskId 作回退键（task-1 / task-2 各自成组）',
      keys.includes('task-1') && keys.includes('task-2'),
      keys.join(', '),
    );
    check(
      'session.id 优先于 taskId（包着 demo-session 的那条归会话组，不落 task-3）',
      keys.includes('demo-session') && !keys.includes('task-3'),
      keys.join(', '),
    );
    check('裸 Trace 落 (无会话) 桶', keys.includes(NO_SESSION), keys.join(', '));
  }

  console.log('\n== 9. 边界特判：AGENTIA_TRACE_ROOT=/ 时根下文件不被误拒 ==');
  // `root + sep` 在 root=/ 时是 "//" ⇒ 不修的话根下**所有**路径都被误拒（方向过紧）。
  // resolveInsideRoot 每次调用现读环境变量，这里临时换根再换回。
  process.env.AGENTIA_TRACE_ROOT = '/';
  try {
    const r = payloadOf(await reportTool.run({ file: outside }));
    check('根为 / 时根下的真实 trace 文件正常出报告', r.runs === 1, `runs=${String(r.runs)}`);
  } finally {
    process.env.AGENTIA_TRACE_ROOT = root;
  }

  console.log(`\n== 10. report：45 个不同会话 ⇒ 截断到 ${MAX_SESSION_ROWS} 组并如实报出 ==`);
  {
    const r = payloadOf(await reportTool.run({ file: 'many-sessions.jsonl' }));
    const sessions = (r.sessions ?? []) as Array<{ session?: unknown }>;
    check(
      '截断前的真实组数如实报出（45）',
      r.sessionGroups === 45,
      `sessionGroups=${String(r.sessionGroups)}`,
    );
    check('返回组数正好卡在上限', sessions.length === MAX_SESSION_ROWS, `${sessions.length} 组`);
    check(
      '截掉的组数如实报出（不是 0、不是编的）',
      r.sessionsTruncated === 45 - MAX_SESSION_ROWS,
      `sessionsTruncated=${String(r.sessionsTruncated)}`,
    );
    check(
      '截断按总耗时降序保留（最贵的 sess-44 还在、最便宜的 sess-0 被截掉）',
      sessions[0]?.session === 'sess-44' && !sessions.some((s) => s.session === 'sess-0'),
      `首行=${String(sessions[0]?.session)}`,
    );
  }

  await conn.close();
  await server.close();
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'G8 验收通过' : `G8 验收失败：${failures} 项`}`);
process.exit(failures === 0 ? 0 : 1);
