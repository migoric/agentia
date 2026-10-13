import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { McpCore, McpServer, McpServerOptions } from './mcp-server.js';

/**
 * Agentia —— MCP 反向桥的 **StreamableHTTP 传输**（2026-09-28 自 `mcp-server.ts` 切出，
 * 与正向桥 `integrations/mcp-http.ts` 同款排布：桥居中、传输各居其文件）。
 *
 * 形状：POST 收 JSON-RPC，应答 `application/json`（简单应答不上 SSE）；`initialize`
 * 响应发 `mcp-session-id` 头（生成的 uuid），后续请求带了就接受、**不带也服务**
 * （无状态 server，宽容是有意的）；GET（server→client 流）→ 405；DELETE → 200；
 * 客户端断连会中止该次工具调用的 `signal`；**协议面之外的意外**回 200 + JSON-RPC
 * `-32603`（不冒泡成 unhandled rejection 把宿主带走，见 `onRequest` 的 catch）。
 *
 * **依赖方向（单向，运行期无环）**：本文件从 `mcp-server.js` 只取**类型**
 * （`McpCore` / `McpServer` / 传输相关的选项），协议与执行由 `core` 注入 ——
 * 与正向桥那条**真实的值环**（桥 re-export 连接器 + 连接器反向 import 共享 helper）
 * 刻意不同，见 `mcp-server-stdio.ts` 头注。
 *
 * 入参用 `Pick<McpServerOptions, …>` 而不是自定义一个选项类型：选项的文档**只有一份**
 * （在 `McpServerOptions` 上），子集在这里只表达「本条传输读哪几项」，
 * 免得两处描述同一批旋钮、然后其中一处过期。
 */

/** http 侧请求 body 上限（固定 1 MiB，与 HTTP 宿主缺省一致；不公开成旋钮） */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * 下面这一组（`sendJson` / `readBody` / `jsonRpcIdOf` / `startListening` / `closeOwnServer`）
 * 2026-10-11 从 `startHttpTransport` 里提到**模块级**：它们是纯件（只看传入的 `req` / `res` /
 * `server`，不碰那条连接的闭包状态），留在闭包里那一个函数有 **192 行 / 占文件 87%**
 * 〔**修前**读数，文件 220 行 —— 那是定阈值当天的全仓最高比例〕。见
 * `tests/architecture/method-size.test.ts` 头注的读数表。
 * ⚠️ **别把「修后多少」写在这里** —— 那是个会腐烂的比例（头部注释改动就会动分母），
 * 能现算：把那个上限临时改成 0 跑一次就是全表。搬迁是**逐字**的，判据与注释一并搬走。
 */

/** 回 JSON。⚠️ 客户端已走时静默返回：写了也没人收，而 `writeHead` 会抛 `ERR_STREAM_WRITE_AFTER_END`。 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return; // 客户端已走：写了也没人收
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * 读请求体；**超过上限 / 连接中断都返回 `null`**（调用方回 413，不区分是哪一种）。
 *
 * 四个事件都听着是为了**不挂死**：`data` 攒、`end` 收口、`error` 与 `close` 都是「不会再有
 * 数据了」—— 只盯 `end` 的话，客户端中途断开会让这个 Promise 永远不 settle（在飞连接泄漏）。
 */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (v: string | null): void => {
      if (done) return;
      done = true;
      resolvePromise(v);
    };
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        finish(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => finish(null));
    req.on('close', () => finish(null));
  });
}

/** 报文里的 JSON-RPC `id`（兜底那一支要用它回 `-32603`）；**不是数字 / 字符串 / null 就回 null** */
function jsonRpcIdOf(msg: unknown): number | string | null {
  const rawId = (msg as { id?: unknown }).id;
  return typeof rawId === 'number' || typeof rawId === 'string' || rawId === null ? rawId : null;
}

/** 起监听并算出对外 URL（端口 0 = 让内核挑一个；拿不到地址则返回 `undefined`） */
function startListening(
  server: Server,
  port: number,
  host: string,
  path: string,
): Promise<string | undefined> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, host, () => {
      const addr = server.address();
      resolvePromise(
        addr !== null && typeof addr === 'object'
          ? `http://${host}:${addr.port}${path}`
          : undefined,
      );
    });
  });
}

/**
 * 关掉自有 server。
 * ⚠️ 仍在飞的连接会吊住 `close` 的回调（Node ≥ 18.2 有 `closeAllConnections`；旧版没有则
 * 靠 `abortAll` 之后工具自行收尾 —— 读 signal 的工具会退出，连接随之结束）。
 */
function closeOwnServer(server: Server): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    server.close(() => resolvePromise());
    server.closeAllConnections?.();
  });
}

export function startHttpTransport(
  core: McpCore,
  opts: Pick<McpServerOptions, 'host' | 'port' | 'path' | 'server' | 'auth'>,
): McpServer {
  const host = opts.host ?? '127.0.0.1';
  const path = opts.path ?? '/mcp';
  const shared = opts.server !== undefined;
  const server: Server = opts.server ?? createServer();
  /** initialize 响应发的会话 id（生成的 uuid；无状态 server 只发不校验 —— 宽容是有意的） */
  const sessionId = randomUUID();

  const onRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== path) {
      // 挂进既有 server 时，别的路径交给宿主自己的路由（本 handler 不管）；
      // 自有 server 上就是 404
      if (shared) return;
      sendJson(res, 404, { error: `路径不存在: ${pathname}` });
      return;
    }
    const method = req.method ?? 'GET';

    // 鉴权缝：与 HTTP 宿主同纪律，**两点都同** ——
    // ① 在读 body 之前（body 一个字节都不收）；
    // ② 在**方法 / 路径判定之前**：未鉴权一律 401，不泄露 endpoint 存在性。
    //    宿主的分支顺序是「免鉴权组的 405 先于鉴权，其余先鉴权再判方法与路径」
    //    （`transport/http-route.ts`），此前这里把 DELETE/405 摆在鉴权前面，
    //    于是未鉴权能拿到 `405 allow: POST, DELETE` 与 `DELETE → 200`（2026-09-27 ⑦）。
    //    自己这条 path 的判定不在此列：它只是「这个请求是不是我的」，别的路径原样交回宿主。
    if (opts.auth) {
      try {
        await opts.auth(req);
      } catch (e) {
        console.error('[agentia:mcp-server] 鉴权钩子异常:', e);
        if (!req.complete) res.setHeader('connection', 'close'); // body 未消费 ⇒ 连接不可复用
        sendJson(res, 401, { error: '未通过鉴权' });
        return;
      }
    }

    if (method === 'DELETE') {
      // 尽力终止会话（MCP 约定）：无状态 server 没有可终止的会话，200 收口
      res.writeHead(200);
      res.end();
      return;
    }
    if (method !== 'POST') {
      // GET（server→client 流）不做（YAGNI，见 mcp-server.ts 文件头）→ 405
      res.setHeader('allow', 'POST, DELETE');
      sendJson(res, 405, { error: `方法 ${method} 不被允许，请用 POST` });
      return;
    }

    const raw = await readBody(req);
    if (raw === null) {
      if (!req.complete) res.setHeader('connection', 'close');
      sendJson(res, 413, { error: `请求 body 超过上限 ${MAX_BODY_BYTES} 字节或连接中断` });
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { error: '请求 body 不是合法 JSON' });
      return;
    }

    // 客户端断连 ⇒ 中止该次工具调用的 signal（协作式；与 HTTP 宿主同款 onClose 守卫）
    const ac = new AbortController();
    const signal = core.trackCall(ac);
    const onClose = (): void => {
      if (!res.writableEnded) ac.abort();
    };
    res.once('close', onClose);
    try {
      const resp = await core.dispatch(msg, signal);
      if (resp === null) {
        // 通知（含 notifications/initialized）：202 + 空体
        res.writeHead(202);
        res.end();
        return;
      }
      if (res.writableEnded || res.destroyed) return;
      const payload = JSON.stringify(resp);
      const headers: Record<string, string | number> = {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
      };
      // initialize 响应发 mcp-session-id（生成的 uuid）；后续请求带了就接受、不带也服务
      if ((msg as { method?: unknown }).method === 'initialize') {
        headers['mcp-session-id'] = sessionId;
      }
      res.writeHead(200, headers);
      res.end(payload);
    } catch (e) {
      // 兜底（2026-09-28 修）：这个 try 此前**只有 `finally`** —— 异常冒泡出 async handler
      // 就是 unhandled rejection，Node ≥15 默认**终止进程**（同文件的鉴权钩子与 JSON.parse
      // 两处都有 catch；stdio 那条传输也有 `.catch` 兜着，只有这里漏了 ⇒ 同一份协议面在两条
      // 传输上一条活着、一条把宿主带走）。
      //
      // 真能走到这里的只有「协议面之外的意外」，工具自身抛错由 `callTool` 兜成 `isError`
      // 不会冒泡：例如工具列表里某条 `inputSchema` 是带 getter 的对象（`validateJsonSchema`
      // 一读就抛）、或惰性 client 构造失败（默认 `createAnthropicClient()` 缺 API key）。
      // 这些是**请求级**的意外 ⇒ 该回一条 JSON-RPC 错误并继续服务，而不是退出进程。
      console.error('[agentia:mcp-server] 请求处理异常:', e);
      const id = jsonRpcIdOf(msg);
      if (res.headersSent) {
        res.end(); // 响应头已定（200 已发）：只能收口，状态码改不了了
      } else if (!res.writableEnded && !res.destroyed) {
        // 与 stdio 侧同形状（`rpcError` 是协议面的知识，由 core 注入 —— 传输层不自己拼错误码）
        sendJson(res, 200, core.rpcError(id, -32603, '内部错误（详见服务端日志）'));
      }
    } finally {
      res.off('close', onClose);
      core.untrackCall(ac);
    }
  };
  server.on('request', onRequest);

  let url: string | undefined;
  const ready = shared
    ? Promise.resolve()
    : startListening(server, opts.port ?? 0, host, path).then((u) => {
        url = u;
      });

  let closed = false;
  return {
    get url() {
      return url;
    },
    ready,
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      core.abortAll();
      if (shared) {
        // 挂进来的既有 server 由宿主自己管：只摘除本 handler
        server.off('request', onRequest);
        return Promise.resolve();
      }
      return closeOwnServer(server);
    },
  };
}
