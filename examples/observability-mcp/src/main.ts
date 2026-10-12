/**
 * 入口：缺省起 **StreamableHTTP**（本地 127.0.0.1，缺省端口 7717），`--stdio` 换成 stdio。
 *
 * stdio 下 stdout **只走协议报文**（一行一个 JSON-RPC）；人类可读的话一律 stderr ——
 * 混进 stdout 会把协议流打崩（与 `tests/fixtures/mcp/reverse-server.ts` 同款纪律）。
 *
 * 顺带把本 server 自己**也**观测起来：`OBS_MCP_TRACE_FILE` 给了就把每次 `tools/call` 的
 * trace 追加落盘 —— 同一个 `TraceSink` 出口，没有为「观测观测台」新开任何口子。
 */
import { createMcpServer, jsonlTraceSink } from '@migor/agentia';
import type { McpServer, TraceSink } from '@migor/agentia';
import { buildApp } from './tools.js';

/** trace 根：本 server 只读**它底下**的文件（判据见 `traces.ts` 的 `resolveInsideRoot`） */
const root = process.env.AGENTIA_TRACE_ROOT ?? process.cwd();
const traceFile = process.env.OBS_MCP_TRACE_FILE;
const sinks: TraceSink[] = traceFile ? [jsonlTraceSink({ path: traceFile })] : [];

/** 优雅停机：中止在飞的 tools/call、摘掉 handler。信号里做的事越少越好，故只 close + exit。 */
function installStop(server: McpServer): void {
  const stop = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv.includes('--stdio')) {
  const server = createMcpServer(buildApp(), {
    transport: 'stdio',
    name: 'agentia-observability-mcp',
    sinks,
  });
  console.error(`[observability-mcp] stdio 就绪；trace 根 = ${root}`);
  installStop(server);
} else {
  // PORT 缺省 7717（写死一个好记的端口），0 = 系统分配 —— 后者给脚本用（先探端口再 bind 会 flake）
  const port = Number(process.env.PORT ?? 7717);
  const server = createMcpServer(buildApp(), {
    transport: 'http',
    host: '127.0.0.1',
    port,
    name: 'agentia-observability-mcp',
    sinks,
  });
  await server.ready;
  console.log(`[observability-mcp] listening on ${server.url}`);
  console.log(
    `[observability-mcp] trace 根 = ${root}（只读它底下的文件；AGENTIA_TRACE_ROOT 可改）`,
  );
  installStop(server);
}
