import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import {
  DEFAULT_CLIENT_INFO,
  DEFAULT_PROTOCOL_VERSION,
  MCP_DEFAULT_TIMEOUT_MS,
  assertToolResultNotError,
  isJsonRpcResponse,
  parseToolList,
  toolsCallParams,
  unwrap,
  withDeadline,
} from './mcp-protocol.js';
import type { Guard, McpCallOptions, McpConnector, McpToolInfo } from './mcp-protocol.js';
import { abortError } from '../core/timeout.js';
import { frameLimitText, MAX_FRAME_CHARS } from '../core/line-framing.js';

/**
 * MCP **stdio 连接器**（内置默认件之一）：spawn 子进程、换行分隔 JSON-RPC。
 * 桥在 `mcp.ts`、与桥共用的协议面在 `mcp-protocol.ts`；本文件只含 stdio 传输。
 * module 级 export，公共面仍由 `mcp.ts` re-export（`src/index.ts` 不变）。
 */

/** `close()` 里 SIGTERM → SIGKILL 的宽限期（毫秒） */
export const MCP_CLOSE_GRACE_MS = 2_000;

/** 子进程退出观察面（见 {@link trackChildExit}） */
interface ChildExitTracker {
  /** 真的退出时兑现 */
  done: Promise<void>;
  /** 即时读数（`close()` 用它避开「已经死了还要等宽限期」） */
  exited(): boolean;
}

/**
 * 建立一个子进程的「退出」观察面。
 *
 * ⚠️ **两个事件都要听**：`'exit'` 在 **spawn 失败**（ENOENT 那类）时可能不触发，`'close'`
 * 一定会 —— `close()` 靠它才不会白等（等一个永不到来的承诺 = 停机路径永久挂住）。
 *
 * 2026-10-11 从 `close()` 里抽出来。此前这件事靠一个 `resolveExit` / `exited` / `markExited`
 * 的闭包三元组维护，散落在 `ensureProc` 的三个监听器与 `close()` 里 —— 两处任意一处漏改
 * 都是「关不掉」或「白等」，而**两者都没有用例看得见**。
 */
function trackChildExit(p: ChildProcess): ChildExitTracker {
  let exited = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  const mark = (): void => {
    exited = true;
    resolveDone();
  };
  p.once('exit', mark);
  p.once('close', mark);
  // ⚠️ `'error'` 也要听 —— 外移前的 `markExited` 挂在三个监听器上（error / exit / close），
  // 只搬两个就是**改了行为**，而 `close()` 只会表现为「多等一个宽限期」或「永不返回」，
  // 用例看不见。实测 `spawn` ENOENT 时事件序 = `error:ENOENT` → `close:-2`（close 会到），
  // 但那是**观察到的**行为、不是文档承诺；保持逐字等价比赌它安全。
  p.once('error', mark);
  return { done, exited: () => exited };
}

/**
 * `close()` 的收尾：先 `SIGTERM`，宽限期到后 `SIGKILL`，然后**等真正的退出**。
 *
 * ⚠️ SIGKILL 之后**不** resolve：SIGKILL 不可被捕获，`'exit'` / `'close'` 必达 ——
 * 继续等真的退出。到点即返回是 2026-09-18 之前的行为：调用方以为进程没了，
 * 实际还留着一个孤儿。
 */
async function reapChild(p: ChildProcess, tracker: ChildExitTracker | null): Promise<void> {
  p.kill('SIGTERM');
  if (tracker?.exited() === true) return;
  const killTimer = setTimeout(() => {
    try {
      p.kill('SIGKILL');
    } catch {
      /* 已经死了 */
    }
  }, MCP_CLOSE_GRACE_MS);
  try {
    await (tracker?.done ?? Promise.resolve());
  } finally {
    clearTimeout(killTimer);
  }
}

export interface StdioMcpConnectorOptions {
  /** 追加 / 覆盖的环境变量（缺省继承 `process.env`） */
  env?: Record<string, string>;
  /** 子进程工作目录 */
  cwd?: string;
  /** 子进程 stderr 去向：`'inherit'`（缺省，server 日志直通终端）| `'ignore'` */
  stderr?: 'inherit' | 'ignore';
  /** 见 {@link DEFAULT_CLIENT_INFO} */
  clientInfo?: { name: string; version: string };
  /** 请求的协议版本，缺省 `'2024-11-05'` */
  protocolVersion?: string;
  /**
   * 装配期超时（毫秒）—— 只作用于**握手 + `tools/list`**，缺省
   * {@link MCP_DEFAULT_TIMEOUT_MS}；非正数 = 不限。语义见 {@link Guard}。
   *
   * 超时同样只是一类账（`code='timeout'`）：**不终止子进程**，与仓库其余「等待的终点」
   * 一致（超时 = 放弃等待）。
   */
  timeoutMs?: number;
}

/**
 * **stdio 连接器**：spawn 一个 MCP server 子进程，走换行分隔的 JSON-RPC 2.0
 * （`initialize` → `notifications/initialized` → `tools/list` / `tools/call`）。
 *
 * 进程与握手都是**惰性**的 —— 构造不产生副作用，第一次 `listTools` / `callTool` 才 spawn；
 * 握手只做一次（并发调用共享同一次握手）。
 *
 * 三处非显然的坑，这里都兜住了（此前 `scripts/e2e-mcp.ts` 内联的那 94 行踩过）：
 * 1. spawn **失败**（命令不存在 → `ENOENT`）是异步的 `'error'` 事件，不是抛出 ——
 *    没有监听器就是未捕获异常、直接把宿主进程带崩，所以必须接住并拒绝在途请求；
 * 2. 分帧：一条报文可能跨多个 chunk，必须自己攒 buffer 按 `\n` 切；
 * 3. **协议层 `isError: true` 必须转成抛错** —— 否则模型收到一条「成功」的结果，
 *    trace 也把它记成成功的调用（`McpClientLike` 的约定，见其注释）。
 */
export function createStdioMcpConnector(
  cmd: readonly string[],
  opts: StdioMcpConnectorOptions = {},
): McpConnector {
  const bin = cmd[0];
  if (typeof bin !== 'string' || bin === '') {
    throw new Error('createStdioMcpConnector：cmd 不能为空（需要可执行文件 + 参数）');
  }
  const rest = cmd.slice(1);
  const timeoutMs = opts.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
  const clientInfo = opts.clientInfo ?? DEFAULT_CLIENT_INFO;
  const protocolVersion = opts.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;

  let proc: ChildProcess | null = null;
  let fatal: Error | null = null;
  let closed = false;
  let buf = '';
  let nextId = 1;
  let ready: Promise<void> | null = null;
  /** spawn 时建立（`close()` 靠它等真的退出）；从未 spawn 过则为 null */
  let exitTracker: ChildExitTracker | null = null;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  /** 进程已死 / 已 close 时一次性拒绝全部在途请求 —— 不留永久挂起的 promise */
  const fail = (err: Error): void => {
    fatal = err;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  const guard: Guard = (p, label) => withDeadline(p, timeoutMs, label);

  const ensureProc = (): ChildProcess => {
    if (closed) throw new Error('MCP 连接器已 close —— 请重新创建一个');
    if (fatal) throw fatal;
    if (proc) return proc;

    const spawnOpts: SpawnOptions = {
      stdio: ['pipe', 'pipe', opts.stderr ?? 'inherit'],
      // exactOptionalPropertyTypes：可选字段不能赋 undefined，只能条件展开
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    };
    const p = spawn(bin, rest, spawnOpts);
    proc = p;
    exitTracker = trackChildExit(p);

    p.on('error', (err: unknown) => {
      // 见函数头第 1 条：这个监听器不是可选的
      fail(err instanceof Error ? err : new Error(String(err)));
    });
    p.on('exit', (code, signal) => {
      if (!closed) {
        fail(
          new Error(`MCP server 进程已退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`),
        );
      }
    });
    // 进程已死时写 stdin 会异步报 EPIPE；真实原因由上面的 'error' / 'exit' 给出
    p.stdin?.on('error', () => {
      /* 吞掉：EPIPE 是「进程没了」的次生现象，不是根因 */
    });

    p.stdout?.setEncoding('utf8');
    p.stdout?.on('data', (chunk: string) => {
      // 分帧上限（2026-09-28 外部深评 S6）：对端一直吐不带换行的字节 ⇒ 缓冲无界增长
      // ⇒ 先 OOM 再谈协议。这不是罕见输入：stdout 混日志的 server 本来就常见，
      // 而**一个不换行的日志行**正是这形态。
      // 超限的处置：一次性拒绝全部在途请求（`fail` 置 fatal）并**终止子进程** ——
      // 帧边界已经丢了，再读下去既救不回那条「一行」，也答不出任何在途请求。
      if (buf.length + chunk.length > MAX_FRAME_CHARS) {
        buf = '';
        p.stdout?.destroy();
        p.kill();
        fail(
          new Error(
            `MCP server 的 stdout 单条报文超过分帧上限（${frameLimitText()}）—— ` +
              '对端没有按换行分隔报文（或吐了一条巨型「日志行」）；已丢弃缓冲并终止连接',
          ),
        );
        return;
      }
      buf += chunk;
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl < 0) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() === '') continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // MCP 规定 stdout 只走协议，但 server 混日志进来是常事
        }
        if (!isJsonRpcResponse(msg)) continue; // 通知（无 id）不配对
        const waiter = pending.get(msg.id);
        if (!waiter) continue;
        pending.delete(msg.id);
        try {
          waiter.resolve(unwrap(msg, 'response'));
        } catch (e) {
          waiter.reject(e instanceof Error ? e : new Error(String(e)));
        }
      }
    });

    return p;
  };

  const write = (payload: unknown): void => {
    const p = ensureProc();
    p.stdin?.write(`${JSON.stringify(payload)}\n`);
  };

  const send = (method: string, params: unknown, abandoned?: AbortSignal): Promise<unknown> => {
    if (closed) return Promise.reject(new Error('MCP 连接器已 close —— 请重新创建一个'));
    if (fatal) return Promise.reject(fatal);
    const id = nextId++;
    return new Promise<unknown>((resolve, reject) => {
      // ⚠️ **已经中止的调用根本不该发出去**（2026-09-21 外部复核）：此前的写法是
      // 「把 pending 条目删掉、然后照样 write」—— 两个后果：
      //   ① 副作用请求仍然送达 server（取消在传输层是无效的）；
      //   ② 返回的 Promise 永远不 settle（条目已删，没人能 resolve/reject）⇒ 调用方永久挂起。
      // 判在 write **之前**，且以 `AbortError` 收场（取消不是超时，见 core/timeout.ts）。
      if (abandoned?.aborted === true) {
        reject(abortError('调用已被取消（信号在发送前就处于中止态）'));
        return;
      }
      try {
        ensureProc();
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      pending.set(id, { resolve, reject });
      // 裁判放弃等待 ≠ 条目自动回收：超时的调用（引擎 toolTimeoutMs 或桥兜底）只是
      // 不再 await，pending 里的 {resolve,reject} 会留到「server 终于回包 / 进程死 /
      // close」—— 对「活着但不回包」的 server 就是无界泄漏。裁判表过态就删条目：
      // 之后回包到了也没人等（:441 的 pending.get 落空即忽略，语义安全）。
      // ⚠️ 删条目的同时必须 **reject**：只删不拒的话这个 Promise 永远没人 settle
      // （响应帧按 id 配对，条目已删 ⇒ 回包被忽略），直接 await 连接器 API 的宿主会
      // 永久挂起 —— HTTP 连接器把 signal 交给 fetch、中止即以 AbortError 收场，
      // 同一份契约的两条实现在「在途中止」上必须同行为。响应已到时这里的 reject
      // 是 no-op（Promise 已定型），不破坏正常路径。
      if (abandoned !== undefined) {
        abandoned.addEventListener(
          'abort',
          () => {
            pending.delete(id);
            reject(abortError('调用已被取消（请求在途中止）'));
          },
          { once: true },
        );
      }
      write({ jsonrpc: '2.0', id, method, params });
    });
  };

  /** 握手只做一次；失败是**粘性**的（连接器已不可用 → 重建，而不是半初始化态） */
  const ensureReady = (): Promise<void> => {
    if (ready) return ready;
    ready = (async () => {
      // 握手自带 abandoned 信号：guard 超时只是「放弃等待」，send 里的 pending 条目
      // 要靠这个信号回收（否则「活着但不回包」的 server 每超时一次就泄漏一条）。
      const handshake = new AbortController();
      try {
        const init = await guard(
          send('initialize', { protocolVersion, capabilities: {}, clientInfo }, handshake.signal),
          'initialize',
        );
        // 协商结果以 server 回的那个为准（协议允许 server 降级或选自己的版本）
        void init;
        write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      } catch (e) {
        // 触发 send 里的 abandoned 清理（删 pending 条目 + reject 那张没人等的
        // promise —— 已 settle 时两者都是 no-op，正常路径踩不到这里）
        handshake.abort();
        throw e;
      }
    })();
    return ready;
  };

  const request = async (
    method: string,
    params: unknown,
    abandoned?: AbortSignal,
  ): Promise<unknown> => {
    await ensureReady();
    return send(method, params, abandoned);
  };

  const listTools = async (): Promise<McpToolInfo[]> => {
    // 与握手同款：guard 超时只是放弃等待，pending 条目靠 abandoned 信号回收
    const abandoned = new AbortController();
    try {
      const r = await guard(request('tools/list', {}, abandoned.signal), 'tools/list');
      return parseToolList(r);
    } catch (e) {
      abandoned.abort();
      throw e;
    }
  };

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    callOpts?: McpCallOptions,
  ): Promise<unknown> => {
    // `toolsCallParams` 把 SEP-414 的 traceparent 放进 params._meta（裸键）；没有则不留 _meta 键
    const r = await request(
      'tools/call',
      toolsCallParams(name, args, callOpts?.traceparent),
      callOpts?.abandoned,
    );
    // 承重：协议层 isError 只有连接器看得见（见函数头第 3 条；判定与文案在 mcp-protocol.ts）
    assertToolResultNotError(r, name);
    return r;
  };

  return {
    listTools,
    callTool,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      fail(new Error('MCP 连接器已 close —— 请重新创建一个'));
      const p = proc;
      proc = null;
      if (!p) return;
      await reapChild(p, exitTracker);
    },
  };
}
