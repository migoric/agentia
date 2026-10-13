import type { McpCore, McpServer } from './mcp-server.js';
import { frameLimitText, MAX_FRAME_CHARS } from '../core/line-framing.js';

/**
 * Agentia —— MCP 反向桥的 **stdio 传输**（2026-09-28 自 `mcp-server.ts` 切出，
 * 与正向桥 `integrations/mcp-stdio.ts` 同款排布：桥居中、传输各居其文件）。
 *
 * 形状：stdin/stdout **换行分隔 JSON-RPC**（每行一个完整报文）；日志只去 stderr
 * —— stdout 是协议面，往里写一个字节都会污染报文流。
 *
 * **依赖方向（单向，运行期无环）**：本文件从 `mcp-server.js` 只取**类型**
 * （`McpCore` / `McpServer`，编译期擦除），协议与执行**由 `core` 注入**。
 * ⚠️ 与正向桥的差别（那边的 `mcp.ts ↔ mcp-stdio.ts` 是一条**真实的值环**：桥 re-export
 * 连接器、连接器反向 import 桥的共享 helper，靠 ESM 的函数提升与调用时机侥幸无恙）——
 * 这里刻意做成注入式：无环是**构造性**的，不靠运气。
 */
/**
 * 派发一行（2026-10-11 自 `onData` 里提到模块级：它是纯件 —— 只依赖这一行、`core` 与
 * 「还开着吗」这一个读数，留在闭包里 `startStdioTransport` 有 **88 行 / 占文件 85%**
 * 〔**修前**读数，文件 104 行〕。⚠️ **别把「修后多少」写在这里** —— 那是个会腐烂的比例，
 * 能现算：把 `tests/architecture/method-size.test.ts` 的上限临时改成 0 跑一次就是全表）。
 *
 * 两个刻意的处置（搬迁时一字未改）：
 * ① **坏 JSON 由协议侧定义形状**回 `-32700` —— 传输层不该知道 JSON-RPC 的错误码
 *    （见 `McpCore.rpcError`）；
 * ② 分派自身抛错**吞掉**：`callTool` 内部已兜住工具错，真漏出来的也不许把 server 带崩。
 */
function dispatchLine(line: string, core: McpCore, isClosed: () => boolean): void {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stdout.write(`${JSON.stringify(core.rpcError(null, -32700, '行不是合法 JSON'))}\n`);
    return;
  }
  const ac = new AbortController();
  const signal = core.trackCall(ac);
  void core
    .dispatch(msg, signal)
    .then((resp) => {
      if (resp !== null && !isClosed()) {
        process.stdout.write(`${JSON.stringify(resp)}\n`);
      }
    })
    .catch(() => {
      /* 分派自身不该抛（callTool 内部已兜住）；真抛了也不许把 server 带崩 */
    })
    .finally(() => core.untrackCall(ac));
}

export function startStdioTransport(core: McpCore): McpServer {
  // stdout 的 error **必须吞**：宿主先关读端、stdin 仍开着时，下一次应答写入就是异步
  // `write EPIPE` —— 未捕获会把 server 打成栈回溯 + exit 1（2026-09-27 ⑦），而它只是
  // 「对端没了」的次生现象，不是根因。正向连接器对子进程 stdin 是同一处置
  // （`integrations/mcp-stdio.ts` 的 `p.stdin?.on('error', () => {})`），方向对称。
  // 吞掉 ≠ 静默：真该知道的人（宿主）已经从自己的管道拿到 EOF 了。
  // 监听器挂在**进程级** stdout 上 ⇒ close 时必须摘掉，否则多次 createMcpServer 会累积
  // （stdin 的 data 监听是 per-close 摘的，stdout 这条漏了 —— 深度评审 2026-10-13 低等项）。
  const onStdoutError = (): void => {
    /* EPIPE：对端已走 */
  };
  process.stdout.on('error', onStdoutError);
  let buf = '';
  let closed = false;
  /**
   * 正在丢弃一条**超限行**（2026-09-28 外部深评 S6）。
   *
   * 宿主（或任何写 stdin 的一方）吐了一条超过分帧上限、且至今没有换行的「报文」——
   * 不做处理就是 `buf` 无界增长 ⇒ 先 OOM。这里**不静默吞**：回一条协议错（说清是超限），
   * 然后丢弃字节直到下一个换行 —— 那是唯一能重新对齐帧边界的地方（丢掉半截行之后，
   * 剩下的字节是完整的下一帧，照常派发）。
   */
  let oversized = false;
  const onData = (chunk: string): void => {
    // 先归位：上一块把我们带进了「丢弃超限行」的状态，处理完再谈攒缓冲
    let rest = chunk;
    for (;;) {
      if (oversized) {
        const nl = rest.indexOf('\n');
        if (nl < 0) return; // 还在那条超长行里，继续丢
        oversized = false;
        rest = rest.slice(nl + 1);
        continue; // 换行之后的这段可能又超限，回环再判
      }
      if (buf.length + rest.length > MAX_FRAME_CHARS) {
        // 丢弃已攒的（含超限尾块）并重新同步 —— 报文边界已丢，这些字节拼不回一条合法报文
        buf = '';
        oversized = true;
        // 协议侧定义形状：传输层只说「这条超限了」（与下面坏 JSON 那条同一处置口径）
        process.stdout.write(
          `${JSON.stringify(core.rpcError(null, -32700, `报文超过分帧上限（${frameLimitText()}），已丢弃`))}\n`,
        );
        continue;
      }
      buf += rest;
      break;
    }
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim() === '') continue;
      dispatchLine(line, core, () => closed);
    }
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onData);
  return {
    url: undefined,
    ready: Promise.resolve(),
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      core.abortAll();
      process.stdin.off('data', onData);
      process.stdout.off('error', onStdoutError); // 进程级监听：不摘会随多次 create 累积
      process.stdin.pause(); // 摘掉读端，宿主进程的事件循环不再被我们吊住
      return Promise.resolve();
    },
  };
}
