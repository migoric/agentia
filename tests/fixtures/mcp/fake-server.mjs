#!/usr/bin/env node
/**
 * 离线夹具 MCP server（stdio，换行分隔的 JSON-RPC 2.0）—— 只给
 * `tests/integrations/mcpConnector.test.ts` 用。
 *
 * 为什么是一个能真跑的进程而不是 mock：连接器要验的三件事（spawn 的 `'error'` 事件、
 * stdout 分帧、握手顺序）**都只存在于真子进程世界里** —— 用假 client 验等于什么都没验。
 *
 * 行为由 env 决定（一个文件覆盖全部分支，免得为每个场景再开一个进程脚本）：
 *
 *   FAKE_MCP_MODE      normal | split | logline | noinit | die | iserror | badtools | stubborn | silentcall | rpcerror | hugeline | echoparams
 *     normal    正常握手 + tools/list + tools/call
 *     split     tools/list 响应**分两个 chunk** 下发（间隔 15ms）⇒ 验攒包
 *     logline   tools/list 之前先往 stdout 写一行非 JSON 日志 ⇒ 验忽略它
 *     noinit    initialize 不回应 ⇒ 验装配期超时（否则宿主永久挂起）
 *     die       握手后立刻退出且不回应 tools/list ⇒ 验在途请求被拒绝（不挂死）
 *     iserror   tools/call 回 `{ isError: true }` ⇒ 验转成抛错（否则 trace 会把它记成成功）
 *     badtools  tools/list 的 `tools` 不是数组 ⇒ 验响亮失败而不是空菜单
 *     stubborn  **忽略 SIGTERM**（协议面同 normal）⇒ 验 close() 走 SIGKILL 后**仍等真退出**
 *     silentcall tools/call **永不回应**（握手与 tools/list 正常）⇒ 验裁判放弃等待后
 *               pending 簿记被回收，「活着但不回包」的 server 不会造成无界泄漏
 *     rpcerror  tools/call 回 `{ error: {...} }` 形态的 JSON-RPC 错误 ⇒ 验 waiter 走 reject
 *               （区别于 iserror：那是 result 里的协议层失败标记，这是 JSON-RPC 层的错误帧）
 *     echoparams tools/call 把收到的 **params 原文**回显进结果文本 ⇒ 验 SEP-414 的
 *               `_meta.traceparent` 真的过了子进程边界（读出参以外的 params 键）
 *     hugeline  往 stdout 写一条**不带换行**的巨型报文（9 MiB > 8 MiB 分帧上限，S6）——
 *               验连接器自己封顶并拒绝在途请求。不做这一条的话，对端吐一个不换行的日志行
 *               就是 `buf` 无界增长（先 OOM 再谈协议）。
 *   FAKE_MCP_LOG_FILE 若设，收到的每个 method 追加一行（测试据此断言握手顺序 / 只握手一次）
 *   FAKE_MCP_PID_FILE 若设，启动时写入自己的 pid（测试据此断言 close() 返回时进程真没了）
 */
import { appendFileSync, writeFileSync } from 'node:fs';

const MODE = process.env.FAKE_MCP_MODE ?? 'normal';
const LOG_FILE = process.env.FAKE_MCP_LOG_FILE;
const PID_FILE = process.env.FAKE_MCP_PID_FILE;

if (PID_FILE) writeFileSync(PID_FILE, String(process.pid));
// 挂上监听器即覆盖 Node 的默认 SIGTERM 行为 ⇒ 进程不会因此退出（close() 必须升级到 SIGKILL）
if (MODE === 'stubborn') process.on('SIGTERM', () => {});
if (MODE === 'hugeline') {
  // 一条「报文」9 MiB 且**全程没有换行**：分帧缓冲若没有上限就是无界增长。
  // 之后什么都不做（不回应任何请求）—— 连接器必须在读侧自己封顶。
  process.stdout.write('x'.repeat(9 * 1024 * 1024));
  setInterval(() => {}, 1000); // 吊住进程，别自己退出（否则测的是「对端走了」而不是「超限」）
}

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });

const SERVER_INFO = { name: 'fake-mcp', version: '1.0.0' };

function toolsList() {
  return {
    tools: [
      {
        name: 'get-time',
        description: '取当前时间',
        inputSchema: { type: 'object', properties: { tz: { type: 'string' } } },
      },
      // 带 `.` —— 顺带让上游的归一化路径也走到（`read.file` → `read_file`）
      { name: 'read.file', inputSchema: { type: 'object' } },
    ],
  };
}

function handle(msg) {
  if (LOG_FILE) appendFileSync(LOG_FILE, `${msg.method}\n`);

  if (msg.method === 'initialize') {
    if (MODE === 'noinit') return;
    reply(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: {},
      serverInfo: SERVER_INFO,
    });
    if (MODE === 'die') setTimeout(() => process.exit(7), 10);
    return;
  }

  if (msg.method === 'notifications/initialized') return;

  if (msg.method === 'tools/list') {
    if (MODE === 'die') return; // 手都不伸：让进程退出把这条在途请求拒掉
    if (MODE === 'logline') process.stdout.write('not json, just a log line\n');
    if (MODE === 'badtools') {
      reply(msg.id, { tools: 'nope, not an array' });
      return;
    }
    if (MODE === 'split') {
      const text = `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: toolsList() })}\n`;
      process.stdout.write(text.slice(0, 20));
      setTimeout(() => process.stdout.write(text.slice(20)), 15);
      return;
    }
    reply(msg.id, toolsList());
    return;
  }

  if (msg.method === 'tools/call') {
    if (MODE === 'silentcall') return; // 活着但永不回包：验连接器侧 pending 簿记的回收
    if (MODE === 'iserror') {
      reply(msg.id, { isError: true, content: [{ type: 'text', text: 'boom from server' }] });
      return;
    }
    if (MODE === 'rpcerror') {
      // JSON-RPC 层的错误帧（不是 result 里的 isError）⇒ 连接器 waiter 必须 reject
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'server says no' } });
      return;
    }
    if (MODE === 'echoparams') {
      // 回显 params 原文：测试据此断言 `_meta.traceparent` 等键真的过了进程边界
      reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(msg.params ?? null) }] });
      return;
    }
    reply(msg.id, { content: [{ type: 'text', text: `called ${msg.params.name}` }] });
    return;
  }

  send({
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: `method not found: ${msg.method}` },
  });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  for (;;) {
    const nl = buf.indexOf('\n');
    if (nl < 0) break;
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim() === '') continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});
