import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createStdioMcpConnector,
  createStreamableHttpMcpConnector,
  mcpTools,
  MCP_CLOSE_GRACE_MS,
} from '../../src/integrations/mcp.js';
import type { McpConnector } from '../../src/integrations/mcp.js';
import { classifyError } from '../../src/engine/errors.js';

/**
 * 两个**内置连接器**的测试（2026-09-18 起连接器内置，见 spec §10 同日条）。
 *
 * 与 `mcp.test.ts` 的分工：那边验**桥**（`mcpTools` 的映射 / 归一化 / 超时裁判权，
 * 用假 client），这里验**连接器自己**。
 *
 * stdio 侧刻意**起真子进程**（`tests/fixtures/mcp/fake-server.mjs`）：连接器要保的三件事
 * —— spawn 的 `'error'` 事件、stdout 分帧、握手顺序 —— 只存在于真子进程世界里，
 * 用假 client 验等于没验。HTTP 侧注入 `fetchImpl`（与 `openai.test.ts` 同款）。
 */

const SERVER = fileURLToPath(new URL('../fixtures/mcp/fake-server.mjs', import.meta.url));

/** 本用例组开过的连接器：afterEach 统一收掉，免得留下孤儿进程 */
const open: McpConnector[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close().catch(() => undefined)));
});

function stdio(
  mode: string,
  opts: { logFile?: string; pidFile?: string; timeoutMs?: number } = {},
): McpConnector {
  const env: Record<string, string> = { FAKE_MCP_MODE: mode };
  if (opts.logFile) env.FAKE_MCP_LOG_FILE = opts.logFile;
  if (opts.pidFile) env.FAKE_MCP_PID_FILE = opts.pidFile;
  const c = createStdioMcpConnector([process.execPath, SERVER], {
    env,
    stderr: 'ignore',
    // 缺省给个上限：任一处卡住都应在**数十秒内**变成一条超时失败，而不是让整个套件
    // 挂够连接器默认的 60s。⚠️ 别把这个值调回 5s：`node --test` 按文件并行，本文件
    // 每例都要 spawn 一个子进程，重负载下**子进程启动**本身就可能吃掉数秒 ——
    // 5s 预算曾把握手判成 `MCP 工具 "initialize" 调用超时（超过 5000ms）`（并发跑时才现，
    // 单跑与 10 路 CPU 忙循环下都复现不出）。要断超时行为的那条用例**自带**
    // `timeoutMs: 60`，不依赖这里的缺省值。
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
  open.push(c);
  return c;
}

function logPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'agentia-mcp-')), 'calls.log');
}

function callsIn(log: string): string[] {
  return readFileSync(log, 'utf8').trim().split('\n');
}

describe('createStdioMcpConnector —— stdio 连接器', () => {
  it('握手顺序 initialize → notifications/initialized，两次调用只握手一次', async () => {
    const log = logPath();
    const c = stdio('normal', { logFile: log });

    assert.equal((await c.listTools()).length, 2);
    await c.listTools();

    assert.deepEqual(
      callsIn(log),
      ['initialize', 'notifications/initialized', 'tools/list', 'tools/list'],
      'initialize 必须在最前且只发一次；notifications/initialized 在 tools/list 之前',
    );
  });

  /*
   * 已经中止的信号：**不发请求**、**立即以 AbortError 收场**。
   *
   * 外部复核（2026-09-21）实测到的旧行为是「把 pending 条目删掉、然后照样 write」：
   * 副作用请求仍然送达 server，而返回的 Promise 因为条目已删**永远不 settle** ⇒ 调用方
   * 永久挂起（引擎虽已放弃等待，但这不是「没人等」就能算了的 —— 请求本身不该发）。
   * 两条断言缺一不可：日志里没有 tools/call（没发）+ reject 是 AbortError（会 settle）。
   * 再做一次正常调用，证明连接器没被这次拒绝搞坏（悬空条目会拖住后续调用）。
   */
  it('信号已中止：不发送、立即 AbortError 收场，且连接器仍可用', async () => {
    const log = logPath();
    const c = stdio('normal', { logFile: log });
    await c.listTools(); // 先握手，后续日志里只有 tools/call 与否的差别

    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      () => c.callTool('get-time', {}, { abandoned: ac.signal }),
      (e: unknown) => {
        assert.equal((e as Error).name, 'AbortError', `应为 AbortError，收到 ${String(e)}`);
        return true;
      },
    );
    assert.deepEqual(
      callsIn(log).filter((m) => m === 'tools/call'),
      [],
      '已中止的调用不得发出去（旧实现在删掉 pending 之后照样 write）',
    );

    const out = (await c.callTool('get-time', {})) as { content?: unknown };
    assert.ok(out.content, '连接器在拒绝一次已中止的调用后仍应可用');
  });

  it('并发调用共享同一次握手（不重复 initialize）', async () => {
    const log = logPath();
    const c = stdio('normal', { logFile: log });

    const [a, b] = await Promise.all([c.listTools(), c.listTools()]);
    assert.equal(a.length, 2);
    assert.equal(b.length, 2);
    assert.equal(
      callsIn(log).filter((m) => m === 'initialize').length,
      1,
      '两个并发 listTools 只应触发一次握手',
    );
  });

  it('一条报文跨多个 chunk 也能攒齐（stdout 分帧）', async () => {
    const c = stdio('split');
    const tools = await c.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ['get-time', 'read.file'],
      '响应被切成两段下发，必须按 \\n 攒包后再解析',
    );
  });

  it('stdout 里混进的非 JSON 日志行被忽略', async () => {
    const c = stdio('logline');
    assert.equal((await c.listTools()).length, 2, '日志行不该让整条响应解析失败');
  });

  it('命令不存在（ENOENT）时给可读错误，且**不把宿主进程带崩**', async () => {
    const c = createStdioMcpConnector(['/definitely/not/a/real/binary-agentia-xyz'], {
      stderr: 'ignore',
    });
    open.push(c);
    // 这一条是「spawn 的 'error' 是**异步事件**、必须有监听器」的承重断言：摘掉那个监听器
    // 再跑，ENOENT 会以**未捕获异常**的形态冒出来（这里由 node:test 兜住、记成失败；
    // 换成真实宿主进程没有人接得住 —— 那是直接崩，不是一条可 catch 的 rejection）。
    await assert.rejects(
      () => c.listTools(),
      (e: Error) => {
        assert.match(e.message, /ENOENT|not found|no such file/i);
        return true;
      },
    );
  });

  it('装配期卡住 → 超时（code=timeout，与引擎同一类账），不让宿主永久挂起', async () => {
    const c = stdio('noinit', { timeoutMs: 60 });
    await assert.rejects(
      () => c.listTools(),
      (e: { code?: unknown }) => {
        assert.equal(e.code, 'timeout', '带上 code 才会被 classifyError 归成 timeout 一类账');
        return true;
      },
    );
  });

  it('握手超时 ⇒ initialize 的 pending 簿记同步回收（guard 只是放弃等待，条目要靠信号删）', async () => {
    // 反向验证：摘掉 ensureReady 里的 handshake.abort() ⇒ server 是 noinit（活着但永不回
    // initialize），条目永远留在 pending 里，本用例红在 deletes 为空。
    // pending 是闭包私有，与上面「裁判放弃等待」用例同款观测法：patch Map.prototype 按
    // 「请求 id（number 键）」计数，入簿一次就必须出簿一次。
    const sets: number[] = [];
    const deletes: number[] = [];
    const origSet = Map.prototype.set;
    const origDelete = Map.prototype.delete;
    Map.prototype.set = function <K, V>(this: Map<K, V>, k: K, v: V): Map<K, V> {
      if (typeof k === 'number') sets.push(k);
      return origSet.call(this, k, v);
    } as typeof Map.prototype.set;
    Map.prototype.delete = function <K, V>(this: Map<K, V>, k: K): boolean {
      if (typeof k === 'number') deletes.push(k);
      return origDelete.call(this, k);
    } as typeof Map.prototype.delete;
    try {
      const c = stdio('noinit', { timeoutMs: 60 });
      await assert.rejects(() => c.listTools(), /timeout|超时/i);
      assert.equal(sets.length, 1, 'initialize 的请求条目应当入簿（number 键）');
      assert.ok(
        deletes.includes(sets[0] as number),
        `guard 超时后 id=${sets[0]} 的簿记必须被回收（deletes=${JSON.stringify(deletes)}）`,
      );
    } finally {
      Map.prototype.set = origSet;
      Map.prototype.delete = origDelete;
    }
  });

  it('server 进程意外退出 → 在途请求被拒绝（不挂死）', async () => {
    const c = stdio('die');
    await assert.rejects(() => c.listTools(), /已退出/);
  });

  it('协议层 isError 转成抛错 —— 否则模型与 trace 都会以为这调用成功了', async () => {
    const c = stdio('iserror');
    await assert.rejects(() => c.callTool('get-time', {}), /isError/);
  });

  it('server 回 JSON-RPC 错误帧（{error:{...}}）⇒ 在途 waiter 被 reject（不挂死、不假装成功）', async () => {
    // 反向验证：摘掉 waiter 的 `try { resolve(unwrap(...)) } catch { reject }` ⇒
    // unwrap 抛出的 jsonRpcError 变成未捕获异常 / waiter 永久挂起，本用例红。
    const c = stdio('rpcerror');
    await assert.rejects(() => c.callTool('get-time', {}), /MCP error -32000: server says no/);
  });

  it('响应正常时 callTool 原样交回 server 的结果', async () => {
    const c = stdio('normal');
    const r = (await c.callTool('get-time', { tz: 'UTC' })) as { content?: unknown };
    assert.deepEqual(r.content, [{ type: 'text', text: 'called get-time' }]);
  });

  it('裁判放弃等待（abandoned）⇒ pending 簿记立刻回收，server 永不回包也不泄漏', async () => {
    // 反向验证：摘掉 send() 里 `abandoned → pending.delete(id)` 的清理，本用例红在
    // 「请求 id 入了 set 却始终没进 delete」—— 对「活着但不回包」的 server（silentcall），
    // pending 里的 {resolve,reject} 会留到进程死 / close()，每条超时调用漏一条 = 无界泄漏。
    // pending 是闭包私有，这里 patch Map.prototype 按「请求 id（number 键）」计数来观测：
    // 入簿一次就必须出簿一次。
    const c = stdio('silentcall');
    await c.listTools(); // 先握手，把 initialize 的条目清出观察窗

    const sets: number[] = [];
    const deletes: number[] = [];
    const origSet = Map.prototype.set;
    const origDelete = Map.prototype.delete;
    Map.prototype.set = function <K, V>(this: Map<K, V>, k: K, v: V): Map<K, V> {
      if (typeof k === 'number') sets.push(k);
      return origSet.call(this, k, v);
    } as typeof Map.prototype.set;
    Map.prototype.delete = function <K, V>(this: Map<K, V>, k: K): boolean {
      if (typeof k === 'number') deletes.push(k);
      return origDelete.call(this, k);
    } as typeof Map.prototype.delete;
    try {
      const ac = new AbortController();
      const p = c.callTool('get-time', {}, { abandoned: ac.signal });
      // close() 会拒掉仍在簿的条目；若清理失效这条 rejection 得有人接，别变未捕获
      void p.catch(() => {});
      // callTool 内部先 await ensureReady，set 发生在那之后 —— 等请求真发出去
      for (let i = 0; i < 200 && sets.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(sets.length, 1, 'tools/call 的请求条目应当入簿（number 键）');
      ac.abort(); // abort 事件同步派发 ⇒ drop() 同步执行
      assert.ok(
        deletes.includes(sets[0] as number),
        `裁判一放弃，id=${sets[0]} 的簿记条目必须同步删掉（deletes=${JSON.stringify(deletes)}）`,
      );
    } finally {
      Map.prototype.set = origSet;
      Map.prototype.delete = origDelete;
    }
  });

  it('请求**发出之后**才中止 ⇒ Promise 以 AbortError settle（条目清掉的同时必须 reject）', async () => {
    // 反向验证：把 abort 监听回调退化成只做 `pending.delete(id)` ⇒ server 是
    // silentcall（活着但永不回包），条目一删就再也没人能 settle 这个 Promise ——
    // 本用例红在 race 的兜底分支（500ms 后仍是 'pending'）。
    // 「settle 了」是 bug 本体（HTTP 连接器把 signal 交给 fetch、中止即 AbortError
    // 收场，两条连接器在「在途中止」上必须同行为），所以必须 race 一个超时来证，
    // 不能只断言 reject 类型。
    const c = stdio('silentcall');
    await c.listTools(); // 先握手，把 initialize 的条目清出观察窗

    // 与上一条同款：patch Map.prototype 按 number 键观测 pending 簿记，
    // 确认请求真发出去了再中止（否则走的是「发送前已中止」那条路径，验不到在途中止）。
    const sets: number[] = [];
    const deletes: number[] = [];
    const origSet = Map.prototype.set;
    const origDelete = Map.prototype.delete;
    Map.prototype.set = function <K, V>(this: Map<K, V>, k: K, v: V): Map<K, V> {
      if (typeof k === 'number') sets.push(k);
      return origSet.call(this, k, v);
    } as typeof Map.prototype.set;
    Map.prototype.delete = function <K, V>(this: Map<K, V>, k: K): boolean {
      if (typeof k === 'number') deletes.push(k);
      return origDelete.call(this, k);
    } as typeof Map.prototype.delete;
    try {
      const ac = new AbortController();
      // 不吞 rejection —— 本用例断言的正是它以 AbortError 收场
      const outcome: Promise<Error | 'resolved'> = c
        .callTool('get-time', {}, { abandoned: ac.signal })
        .then(
          () => 'resolved' as const,
          (e: unknown) => e as Error,
        );
      // callTool 内部先 await ensureReady，set 发生在那之后 —— 等请求真发出去
      for (let i = 0; i < 200 && sets.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(sets.length, 1, 'tools/call 的请求条目应当入簿（number 键）');
      ac.abort();

      const raced = await Promise.race([
        outcome,
        new Promise<'pending'>((r) => setTimeout(() => r('pending'), 500)),
      ]);
      assert.notEqual(
        raced,
        'pending',
        '在途中止后 Promise 必须 settle —— 只删条目不 reject 就是永久挂起（bug 本体）',
      );
      assert.ok(raced instanceof Error, `应当以错误收场，收到 ${String(raced)}`);
      assert.equal(raced.name, 'AbortError', `应为 AbortError，收到 ${String(raced)}`);
      // 与「发送前已中止」同一错误形状 ⇒ errors.ts 按 name 归 aborted 一类账
      assert.equal(classifyError(raced).type, 'aborted');
      assert.ok(
        deletes.includes(sets[0] as number),
        `中止后 id=${sets[0]} 的簿记条目必须清掉（deletes=${JSON.stringify(deletes)}）`,
      );
    } finally {
      Map.prototype.set = origSet;
      Map.prototype.delete = origDelete;
    }
  });

  it('tools 不是数组 → 响亮抛错（不静默变成空菜单）', async () => {
    const c = stdio('badtools');
    await assert.rejects(() => c.listTools(), /不是数组/);
  });

  it('close() 幂等；关闭后调用给可读错误（不静默挂死）', async () => {
    const c = stdio('normal');
    await c.listTools();
    await c.close();
    await c.close(); // 幂等
    await assert.rejects(() => c.listTools(), /已 close/);
  });

  it('从未用过的连接器可以安全 close（惰性：构造不 spawn 进程）', async () => {
    const c = stdio('normal');
    await c.close();
    await c.close();
  });

  it('close() 返回时子进程**已被回收**（连忽略 SIGTERM 的 server 也照杀）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-mcp-'));
    const pidFile = join(dir, 'pid');
    const c = stdio('stubborn', { pidFile });
    await c.listTools(); // 先确认进程真起来了并完成握手
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isFinite(pid) && pid > 0, `没读到 pid：${pidFile}`);

    const started = Date.now();
    await c.close();
    const elapsed = Date.now() - started;

    assert.ok(
      elapsed >= MCP_CLOSE_GRACE_MS,
      `server 忽略了 SIGTERM ⇒ 必须走到 SIGKILL（实测 ${elapsed}ms，宽限期 ${MCP_CLOSE_GRACE_MS}ms）`,
    );
    // 这一条是承重的：在「到点就 resolve、不等 reap」的旧实现下，close() 会在 SIGKILL
    // 刚发出时就返回，此刻子进程还在（未回收）⇒ kill(pid, 0) 不报 ESRCH ⇒ 用例变红。
    assert.throws(
      () => process.kill(pid, 0),
      /ESRCH/,
      'close() 返回即代表子进程已终止 —— 不能留下孤儿进程',
    );
  });

  it('出厂连接器直接接 `mcpTools`（菜单名归一化整条走通）', async () => {
    const c = stdio('normal');
    const tools = await mcpTools(c, { server: 'fake' });
    assert.deepEqual(
      tools.map((t) => t.name),
      ['mcp_fake_get_time', 'mcp_fake_read_file'],
      '这条替代了「桥 + 脚本里一份私有连接器」的旧证明：现在测的就是出货的那份',
    );
  });

  it('cmd 为空在构造期即抛错（不等到 spawn 才炸）', () => {
    assert.throws(() => createStdioMcpConnector([]), /cmd 不能为空/);
  });
});

// ─────────────────────────── StreamableHTTP ───────────────────────────

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  msg: { id?: number; method?: string; params?: Record<string, unknown> } | null;
}

/**
 * 假 endpoint：只认连接器真正会用的那点 HTTP 面（`ok` / `status` / `headers.get` / `text`），
 * 但用的是**真 `Response`** —— 免得「我的假设」和真实 fetch 的返回形状不一致时测不出来。
 */
function fakeServer(
  opts: {
    /** 固定会话 id（不换、不过期）—— 现有会话相关用例用它 */
    sessionId?: string;
    /** 每个**新**会话可承载的请求数；用完后再带该会话发请求一律 404（逼客户端重新 initialize） */
    sessionExpireAt?: number;
    /** `tools/call` 恒 404（验会话自愈**只重试一次**、不循环） */
    always404Call?: boolean;
    /** 视为「已死」的会话 id 集合：带这些会话的请求一律 404（验并发自愈的互斥） */
    deadSessions?: Set<string>;
    /** 死会话的 404 响应**攒够 N 个一起放**（把并发 404 钉成确定时序，否则微任务顺序看天） */
    deadBarrier?: number;
    negotiated?: string;
    sse?: boolean;
    isError?: boolean;
    status?: number;
    emptyBody?: boolean;
  } = {},
): { fetchImpl: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  /** 会话是**显式开启**的：没给任何会话相关选项就当作「不支持会话的 server」（不回该头） */
  const useSession =
    opts.sessionId !== undefined ||
    opts.sessionExpireAt !== undefined ||
    opts.always404Call === true ||
    opts.deadSessions !== undefined;
  /** 当前有效会话（`sessionId` 模式下恒为那个固定值；否则每次 initialize 铸一个新的） */
  let active: string | null = null;
  let minted = 0;
  let served = 0;
  const deadWaiting: Array<() => void> = [];

  const fetchImpl = (async (url: unknown, init: unknown) => {
    const i = init as { method: string; headers: Record<string, string>; body?: string };
    const msg = i.body === undefined ? null : JSON.parse(i.body);
    requests.push({ url: String(url), method: i.method, headers: i.headers, msg });

    if (i.method === 'DELETE') return new Response(null, { status: 204 });
    if (opts.status !== undefined && opts.status >= 400) {
      return new Response('upstream said no', {
        status: opts.status,
        headers: { 'content-type': 'text/plain' },
      });
    }
    const method = msg?.method;

    if (method === 'initialize' && useSession) {
      active = opts.sessionId ?? `sess-${++minted}`;
      served = 0;
    } else if (active !== null) {
      // 会话校验：带错会话 / 已过期 → 404（MCP 规范语义：这个会话我不认识）
      const carried = i.headers['mcp-session-id'];
      const expired = opts.sessionExpireAt !== undefined && served >= opts.sessionExpireAt;
      if (
        carried !== active ||
        expired ||
        opts.deadSessions?.has(carried ?? '') === true ||
        (opts.always404Call === true && method === 'tools/call')
      ) {
        if (opts.deadBarrier !== undefined && opts.deadSessions?.has(carried ?? '') === true) {
          await new Promise<void>((resolve) => {
            deadWaiting.push(resolve);
            if (deadWaiting.length >= (opts.deadBarrier ?? 0)) {
              for (const release of deadWaiting.splice(0)) release();
            }
          });
        }
        return new Response('session not found', {
          status: 404,
          headers: { 'content-type': 'text/plain' },
        });
      }
      served++;
    }

    const sessionHeader = (): Record<string, string> =>
      method === 'initialize' && active !== null ? { 'mcp-session-id': active } : {};

    if (method === 'notifications/initialized') {
      return new Response(null, { status: 202, headers: sessionHeader() });
    }
    if (opts.emptyBody) {
      return new Response('', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    let result: unknown;
    if (method === 'initialize') {
      result = {
        protocolVersion: opts.negotiated ?? '2024-11-05',
        serverInfo: { name: 'fake', version: '1' },
      };
    } else if (method === 'tools/list') {
      result = { tools: [{ name: 'get-time', inputSchema: { type: 'object' } }] };
    } else {
      result = opts.isError
        ? { isError: true, content: [{ type: 'text', text: 'boom' }] }
        : { content: [{ type: 'text', text: 'ok' }] };
    }
    const payload = JSON.stringify({ jsonrpc: '2.0', id: msg?.id, result });
    const headers = sessionHeader();
    if (opts.sse) {
      return new Response(`event: message\ndata: ${payload}\n\n`, {
        status: 200,
        headers: { ...headers, 'content-type': 'text/event-stream' },
      });
    }
    return new Response(payload, {
      status: 200,
      headers: { ...headers, 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, requests };
}

function http(opts: Parameters<typeof fakeServer>[0] = {}): {
  connector: McpConnector;
  requests: Recorded[];
} {
  const { fetchImpl, requests } = fakeServer(opts);
  const connector = createStreamableHttpMcpConnector('https://mcp.example/mcp', { fetchImpl });
  open.push(connector);
  return { connector, requests };
}

describe('createStreamableHttpMcpConnector —— StreamableHTTP 连接器', () => {
  it('application/json 响应：握手 + tools/list 全链', async () => {
    const { connector, requests } = http();
    assert.deepEqual(
      (await connector.listTools()).map((t) => t.name),
      ['get-time'],
    );
    assert.deepEqual(
      requests.map((r) => r.msg?.method ?? r.method),
      ['initialize', 'notifications/initialized', 'tools/list'],
    );
  });

  it('text/event-stream 响应也能接（SSE 帧解析）', async () => {
    const { connector } = http({ sse: true });
    assert.deepEqual(
      (await connector.listTools()).map((t) => t.name),
      ['get-time'],
      'StreamableHTTP 两种响应形态都必须支持，SSE 是规范允许的那一种',
    );
  });

  it('会话：initialize 带回的 id 在后续请求上回带；后续响应不带也不清空', async () => {
    const { connector, requests } = http({ sessionId: 'sess-1' });
    await connector.listTools();
    assert.equal(requests[0]?.headers['mcp-session-id'], undefined, 'initialize 时尚无会话');
    assert.equal(requests[1]?.headers['mcp-session-id'], 'sess-1');
    assert.equal(
      requests[2]?.headers['mcp-session-id'],
      'sess-1',
      'tools/list 的响应没带该头，但会话 id 必须留着',
    );
  });

  it('协议版本头：initialize 不带；后续带**协商到的**版本', async () => {
    const { connector, requests } = http({ negotiated: '2025-06-18' });
    await connector.listTools();
    assert.equal(requests[0]?.headers['mcp-protocol-version'], undefined);
    assert.equal(
      requests[1]?.headers['mcp-protocol-version'],
      '2025-06-18',
      '必须用 server 回的版本，不是我们请求的那个',
    );
    assert.equal(requests[2]?.headers['mcp-protocol-version'], '2025-06-18');
  });

  it('同时接受两种响应形态的 Accept 头（否则 server 无法按规范回 SSE）', async () => {
    const { connector, requests } = http();
    await connector.listTools();
    assert.match(requests[0]?.headers.accept ?? '', /application\/json/);
    assert.match(requests[0]?.headers.accept ?? '', /text\/event-stream/);
  });

  it('HTTP 429 → 抛错带数值 status ⇒ 被归成可重试的 rate_limit', async () => {
    const { connector } = http({ status: 429 });
    const err = await connector.listTools().then(
      () => assert.fail('应当抛错'),
      (e: unknown) => e,
    );
    assert.equal((err as { status?: unknown }).status, 429);
    const info = classifyError(err);
    assert.equal(info.type, 'rate_limit');
    assert.equal(info.retryable, true);
  });

  it('HTTP 404 且**尚无会话**时不当作会话过期（照常抛，不重试）', async () => {
    const { connector, requests } = http({ status: 404 });
    const err = await connector.listTools().then(
      () => assert.fail('应当抛错'),
      (e: unknown) => e,
    );
    const info = classifyError(err);
    assert.equal(info.type, 'api');
    assert.equal(info.retryable, false);
    assert.equal(
      requests.filter((q) => q.msg?.method === 'initialize').length,
      1,
      '没有会话可过期 ⇒ 不该触发重握手',
    );
  });

  it('会话过期（404）→ 自动重握手并把**这一次**重试一次（自愈成功）', async () => {
    const expired: number[] = [];
    const { fetchImpl, requests } = fakeServer({ sessionExpireAt: 2 });
    const connector = createStreamableHttpMcpConnector('https://mcp.example/mcp', {
      fetchImpl,
      onSessionExpired: () => expired.push(Date.now()),
    });
    open.push(connector);

    assert.equal((await connector.listTools()).length, 1, '握手恰好占满 2 次会话额度');
    const r = (await connector.callTool('get-time', {})) as { content?: unknown };
    assert.deepEqual(
      r.content,
      [{ type: 'text', text: 'ok' }],
      '过期的那次没被执行（404 = 会话未知），重试应当成功',
    );

    assert.equal(expired.length, 1, 'onSessionExpired 必须被调一次 —— 自愈不能是静默的');
    assert.equal(
      requests.filter((q) => q.msg?.method === 'initialize').length,
      2,
      '应当重新 initialize 建新会话',
    );
    assert.deepEqual(
      requests
        .filter((q) => q.msg?.method === 'tools/call')
        .map((q) => q.headers['mcp-session-id']),
      ['sess-1', 'sess-2'],
      '重试必须带**新**会话 id',
    );
  });

  it('会话自愈**只重试一次**：对面一直 404 就直接抛（不循环）', async () => {
    const { fetchImpl, requests } = fakeServer({ always404Call: true });
    const connector = createStreamableHttpMcpConnector('https://mcp.example/mcp', { fetchImpl });
    open.push(connector);

    assert.equal((await connector.listTools()).length, 1);
    const err = await connector.callTool('get-time', {}).then(
      () => assert.fail('应当抛错'),
      (e: unknown) => e,
    );
    assert.equal((err as { status?: unknown }).status, 404);
    assert.equal(
      requests.filter((q) => q.msg?.method === 'initialize').length,
      2,
      '只允许初始 1 次 + 自愈 1 次；再多就是重试循环',
    );
  });

  it('协议层 isError 转成抛错（与 stdio 同语义）', async () => {
    const { connector } = http({ isError: true });
    await assert.rejects(() => connector.callTool('get-time', {}), /isError/);
  });

  it('响应体为空 → 可读错误（不静默返回 undefined）', async () => {
    const { connector } = http({ emptyBody: true });
    await assert.rejects(() => connector.listTools(), /响应体为空/);
  });

  it('close() 尽力 DELETE 会话，且幂等（第二次不再发）', async () => {
    const { connector, requests } = http({ sessionId: 'sess-1' });
    await connector.listTools();
    await connector.close();
    await connector.close();
    assert.deepEqual(requests.filter((r) => r.method === 'DELETE').length, 1);
    const del = requests.find((r) => r.method === 'DELETE');
    assert.equal(del?.headers['mcp-session-id'], 'sess-1');
  });

  it('没有会话时 close() 不发 DELETE', async () => {
    const { connector, requests } = http();
    await connector.listTools();
    await connector.close();
    assert.equal(requests.filter((r) => r.method === 'DELETE').length, 0);
  });

  it('close() 的 DELETE 挂死 ⇒ 到点返回（best-effort ≠ 永久挂住）', async () => {
    // 反向验证（旧实现）：close() 直接 `await fetchImpl(...)`，外层 catch 只兜得住
    // **抛错**、兜不住**挂死** —— server 接受连接后不回（半开 / 卡在代理后面），
    // close() 就永久挂住。而调用方是**宿主停机路径**，挂住比失败更糟。
    // 本用例让 DELETE 永不 settle，断言 close() 仍会返回。
    const { fetchImpl } = fakeServer({ sessionId: 'sess-1' });
    let deletes = 0;
    const hanging: typeof fetch = (async (url: unknown, init: unknown) => {
      if ((init as { method?: string } | undefined)?.method === 'DELETE') {
        deletes += 1;
        return new Promise<Response>(() => {
          /* 永不 settle：模拟半开的 server */
        });
      }
      return fetchImpl(url as never, init as never);
    }) as unknown as typeof fetch;

    const connector = createStreamableHttpMcpConnector('https://mcp.example/mcp', {
      fetchImpl: hanging,
      timeoutMs: 50,
    });
    open.push(connector);
    await connector.listTools();

    const t0 = Date.now();
    await connector.close();
    const dt = Date.now() - t0;
    assert.equal(deletes, 1, '仍然尽力发过 DELETE');
    // 两侧都要断言：下界证明是 **guard 到点**收的口（timeoutMs=50 真的等满了），
    // 而不是 close() 因为别的理由提前返回；上界证明它没有永久挂住。
    assert.ok(dt >= 40, `应当由 guard 到点收口（timeoutMs=50），实际只等了 ${dt}ms`);
    assert.ok(dt < 5_000, `close() 必须到点返回，实际等了 ${dt}ms`);
    // 幂等标志在 try 之前就置上了 ⇒ 超时返回后再 close() 不会重发
    await connector.close();
    assert.equal(deletes, 1);
  });

  it('出厂连接器直接接 `mcpTools`', async () => {
    const { connector } = http();
    const tools = await mcpTools(connector, { server: 'remote' });
    assert.deepEqual(
      tools.map((t) => t.name),
      ['mcp_remote_get_time'],
    );
  });

  it('url 为空在构造期即抛错', () => {
    assert.throws(() => createStreamableHttpMcpConnector(''), /url 不能为空/);
  });
});

describe('StreamableHTTP：超时裁判权与响应配对（第八轮复审补缺）', () => {
  it('tools/call 不起第二个计时器：超过连接器 timeoutMs 的调用照常等完（裁判是引擎）', async () => {
    // 反向验证：旧实现里 rpc() 末尾无条件 guard(readResult(...))，本用例会红在
    // 30ms 超时被拒（而 spec §10 2026-09-17 ref-mcp-timeout-single-source 与文档都说 callTool 的裁判是引擎/桥）。
    const { fetchImpl } = fakeServer();
    const slow: typeof fetch = (async (url: unknown, init: unknown) => {
      const i = init as { body?: string };
      const method = i.body ? (JSON.parse(i.body) as { method?: string }).method : undefined;
      const res = await fetchImpl(url as never, init as never);
      if (method === 'tools/call') await new Promise((r) => setTimeout(r, 120));
      return res;
    }) as unknown as typeof fetch;
    const connector = createStreamableHttpMcpConnector('https://mcp.example/mcp', {
      fetchImpl: slow,
      timeoutMs: 30, // 握手/list 的裁判；若它管到 call，120ms 的调用必被掐
    });
    open.push(connector);
    const out = (await connector.callTool('get-time', {})) as {
      content: Array<{ text: string }>;
    };
    assert.equal(out.content[0]?.text, 'ok', '慢调用必须等完 —— 引擎没设超时时它就该等');
  });

  it('握手仍受连接器 timeoutMs 约束（装配期路径的裁判不变）', async () => {
    const hanging: typeof fetch = (() =>
      new Promise<Response>(() => {})) as unknown as typeof fetch;
    const connector = createStreamableHttpMcpConnector('https://mcp.example/mcp', {
      fetchImpl: hanging,
      timeoutMs: 30,
    });
    open.push(connector);
    await assert.rejects(() => connector.listTools(), /超时|timeout|deadline/i);
  });

  it('非 SSE 响应的 id 不配对的拒绝（与 SSE 分支同款），不把别的请求的结果当本次的', async () => {
    // 反向验证：旧实现只验「id 是 number」⇒ 本用例会红在「竟然返回了 ok」。
    const { fetchImpl } = fakeServer();
    const tampered: typeof fetch = (async (url: unknown, init: unknown) => {
      const res = await fetchImpl(url as never, init as never);
      const i = init as { body?: string };
      const method = i.body ? (JSON.parse(i.body) as { method?: string }).method : undefined;
      if (method !== 'tools/call') return res;
      // 串包：回一个**别的请求**的 id
      const body = JSON.parse(await res.text()) as { id: number };
      return new Response(JSON.stringify({ ...body, id: body.id + 1000 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const connector = createStreamableHttpMcpConnector('https://mcp.example/mcp', {
      fetchImpl: tampered,
    });
    open.push(connector);
    await assert.rejects(() => connector.callTool('get-time', {}), /id 为 \d+ 的 JSON-RPC 报文/);
  });

  it('并发请求同时吃到 404 ⇒ 共享同一次重握手（不双 initialize）', async () => {
    // 反向验证：旧实现里两个并发自愈各自 `ready = null`（第二个抹掉第一个的握手
    // Promise）⇒ initialize 会跑 3 次（初始 1 + 双自愈 2），本用例红在计数上；
    // 且假 server 只认最后一次铸的会话 ⇒ 带被覆盖会话的重试会再 404。
    const dead = new Set<string>();
    const expired: number[] = [];
    const { fetchImpl, requests } = fakeServer({ deadSessions: dead, deadBarrier: 2 });
    const connector = createStreamableHttpMcpConnector('https://mcp.example/mcp', {
      fetchImpl,
      onSessionExpired: () => expired.push(Date.now()),
    });
    open.push(connector);

    await connector.callTool('get-time', {}); // 握手 + 建立 sess-1
    dead.add('sess-1'); // 服务端把 sess-1 干掉（崩溃/重启/淘汰）
    const [a, b] = await Promise.all([
      connector.callTool('get-time', {}),
      connector.callTool('get-time', {}),
    ]);
    assert.equal((a as { content?: Array<{ text: string }> }).content?.[0]?.text, 'ok');
    assert.equal((b as { content?: Array<{ text: string }> }).content?.[0]?.text, 'ok');
    assert.equal(
      requests.filter((q) => q.msg?.method === 'initialize').length,
      2,
      '初始 1 次 + 并发自愈共享 1 次；出现 3 次就是双 initialize 竞态',
    );
    assert.equal(expired.length, 2, '每个 404 都是事实，逐次记；共享的只是重握手动作');
    assert.deepEqual(
      requests
        .filter((q) => q.msg?.method === 'tools/call')
        .map((q) => q.headers['mcp-session-id']),
      ['sess-1', 'sess-1', 'sess-1', 'sess-2', 'sess-2'],
      '建立 1 次 + 两次并发 404 + 两次带**同一个新会话**的重试',
    );
  });
});

describe('StreamableHTTP：abandoned 透传到传输层', () => {
  it('tools/call 带上裁判的 abandoned signal（自愈重试那次也带）；不带则没有 signal 键', async () => {
    // 反向验证：旧实现的 callTool 不接第三参、fetch 无 signal ⇒ 本用例红在
    // 「tools/call 的 init.signal 是 undefined」—— 引擎超时后在飞 fetch 泄漏。
    const { fetchImpl } = fakeServer({ sessionExpireAt: 2 });
    const seen: Array<{ hasKey: boolean; signal: unknown }> = [];
    const recording: typeof fetch = (async (url: unknown, init: unknown) => {
      const i = init as { body?: string; signal?: AbortSignal };
      const method = i.body ? (JSON.parse(i.body) as { method?: string }).method : undefined;
      if (method === 'tools/call') seen.push({ hasKey: 'signal' in i, signal: i.signal });
      return fetchImpl(url as never, init as never);
    }) as unknown as typeof fetch;
    const connector = createStreamableHttpMcpConnector('https://mcp.example/mcp', {
      fetchImpl: recording,
    });
    open.push(connector);

    // 不带 abandoned：fetch init 上不应出现 signal 键（exactOptionalPropertyTypes 口径）
    await connector.callTool('get-time', {});
    assert.deepEqual(
      seen.map((s) => s.hasKey),
      [false],
      '无 abandoned 时不得落 signal 键',
    );

    // 带 abandoned + 会话过期自愈：首次 404 与重试那次都必须收到同一个 signal
    const ac = new AbortController();
    const r = (await connector.callTool('get-time', {}, { abandoned: ac.signal })) as {
      content?: Array<{ text: string }>;
    };
    assert.equal(r.content?.[0]?.text, 'ok', '自愈重试应成功');
    assert.equal(seen.length, 3, '首次成功 1 次 + 过期 404 1 次 + 自愈重试 1 次');
    assert.deepEqual(
      seen.slice(1).map((s) => s.signal),
      [ac.signal, ac.signal],
      '首次与自愈重试都必须带上裁判的 abandoned signal',
    );
  });
});

describe('StreamableHTTP：响应形态防御（与 stdio 侧同款，HTTP 侧此前漏测）', () => {
  /** 把 tools/list 的 result 换成任意值（握手与其余请求照常走假 server） */
  const tamperListResult = (result: unknown): McpConnector => {
    const { fetchImpl } = fakeServer();
    const tampered: typeof fetch = (async (url: unknown, init: unknown) => {
      const i = init as { body?: string };
      const msg = i.body ? (JSON.parse(i.body) as { id?: number; method?: string }) : null;
      if (msg?.method !== 'tools/list') return fetchImpl(url as never, init as never);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const connector = createStreamableHttpMcpConnector('https://mcp.example/mcp', {
      fetchImpl: tampered,
    });
    open.push(connector);
    return connector;
  };

  it('tools/list 返回非对象 ⇒ 响亮抛错（不静默变成空菜单）', async () => {
    // 反向验证：摘掉 `typeof r !== 'object'` 的拦 ⇒ `(r as {tools}).tools` 读出 undefined
    // ⇒ 静默回落空菜单（「一个工具都没有」而不是「server 坏了」），本用例红在「不抛」。
    await assert.rejects(() => tamperListResult('nope').listTools(), /返回了非对象/);
  });

  it('tools/list 的 tools 不是数组 ⇒ 响亮抛错', async () => {
    await assert.rejects(() => tamperListResult({ tools: 'nope' }).listTools(), /不是数组/);
  });

  it('SSE 响应里没有与请求 id 配对的报文 ⇒ 响亮抛错（不把别的帧当结果）', async () => {
    // 反向验证：摘掉 SSE 分支的 id 配对 ⇒ 错 id 的帧被当成本次结果（静默错值），本用例红。
    const { fetchImpl } = fakeServer({ sse: true });
    const wrongId: typeof fetch = (async (url: unknown, init: unknown) => {
      const i = init as { body?: string };
      const msg = i.body ? (JSON.parse(i.body) as { id?: number; method?: string }) : null;
      if (msg?.method !== 'tools/call') return fetchImpl(url as never, init as never);
      // 串包：回一个**别的请求**的 id 的 SSE 帧
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id: (msg.id ?? 0) + 1000,
        result: { content: [{ type: 'text', text: 'ok' }] },
      });
      return new Response(`event: message\ndata: ${payload}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch;
    const connector = createStreamableHttpMcpConnector('https://mcp.example/mcp', {
      fetchImpl: wrongId,
    });
    open.push(connector);
    await assert.rejects(
      () => connector.callTool('get-time', {}),
      /SSE 响应里没有 id 为 \d+ 的报文/,
    );
  });

  it('响应体不是合法 JSON ⇒ 响亮抛错（不静默返回 undefined）', async () => {
    // 反向验证：摘掉 JSON.parse 的 catch ⇒ 裸 SyntaxError 冒出去（无可读上下文），
    // 本用例红在「报文不符」。
    const { fetchImpl } = fakeServer();
    const notJson: typeof fetch = (async (url: unknown, init: unknown) => {
      const i = init as { body?: string };
      const msg = i.body ? (JSON.parse(i.body) as { method?: string }) : null;
      if (msg?.method !== 'tools/call') return fetchImpl(url as never, init as never);
      return new Response('<html>bad gateway</html>', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const connector = createStreamableHttpMcpConnector('https://mcp.example/mcp', {
      fetchImpl: notJson,
    });
    open.push(connector);
    await assert.rejects(() => connector.callTool('get-time', {}), /不是合法 JSON/);
  });
});

describe('SEP-414 出站：`_meta.traceparent` 过传输边界', () => {
  const TP = '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01';

  it('stdio（真子进程回读）：带 traceparent ⇒ params 带 `_meta` 裸键；不带 ⇒ 无 `_meta` 键', async () => {
    // 反向验证：连接器漏掉 `toolsCallParams` 的第三参 ⇒ `_meta` 缺席，第一条断言红；
    // 恒落 `_meta` ⇒ 「不带 ⇒ 无键」那条红。
    const c = stdio('echoparams');
    const readParams = async (
      args: Record<string, unknown>,
      opts?: { traceparent?: string },
    ): Promise<Record<string, unknown>> => {
      const r = (await c.callTool('get-time', args, opts)) as {
        content: Array<{ text: string }>;
      };
      return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
    };

    const withTp = await readParams({ tz: 'UTC' }, { traceparent: TP });
    assert.deepEqual(
      withTp._meta,
      { traceparent: TP },
      'SEP-414：裸键 traceparent 进 params._meta',
    );
    assert.deepEqual(withTp.name, 'get-time');
    assert.deepEqual(
      withTp.arguments,
      { tz: 'UTC' },
      'arguments 一个字节不被碰（纪律②：trace 上下文不进工具签名）',
    );

    const without = await readParams({});
    assert.equal('_meta' in without, false, '没有上下文 ⇒ 不落 _meta 键（纪律③）');
  });

  it('StreamableHTTP：同上形状；握手与 tools/list 的 params 不受影响', async () => {
    const { connector, requests } = http();
    await connector.listTools();
    await connector.callTool('get-time', { tz: 'UTC' }, { traceparent: TP });
    await connector.callTool('get-time', {});

    const paramsOf = (method: string) =>
      requests.filter((r) => r.msg?.method === method).map((r) => r.msg?.params);
    const [withTp, without] = paramsOf('tools/call');
    assert.deepEqual(withTp, {
      name: 'get-time',
      arguments: { tz: 'UTC' },
      _meta: { traceparent: TP },
    });
    assert.equal(
      without !== undefined && '_meta' in without,
      false,
      '无 traceparent 不落 _meta 键',
    );
    // 只有 tools/call 会带：握手 / 菜单查询的 params 保持原样
    for (const p of [...paramsOf('initialize'), ...paramsOf('tools/list')]) {
      assert.equal(p !== undefined && '_meta' in p, false, `${JSON.stringify(p)} 不应有 _meta`);
    }
  });
});

describe('S6：分帧上限 —— 对端吐一条不带换行的巨型「报文」', () => {
  it('连接器自己封顶并拒绝在途请求（不是无界攒 buffer、也不是静默挂着）', async () => {
    const c = stdio('hugeline');
    // 上限是 8 MiB 码元、对端吐 9 MiB 且不换行 ⇒ 必须在读侧被拦下
    await assert.rejects(() => c.listTools(), /分帧上限/);
  });
});
