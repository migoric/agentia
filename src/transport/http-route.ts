/**
 * Agentia —— HTTP 宿主的**路由判定**（transport/http.ts 的拆分第二步）。
 *
 * `(pathname, method, 有没有 metrics 出口) → 该走哪条分支`。纯函数：不碰 req/res、
 * 不读 body、不写响应、不抛异常 —— 编排（读 body / 调 runner / 写响应 / 状态码选择）
 * 留在 http.ts，本文只回答「这是哪条路」。
 *
 * ⚠️ 顺序是这个文件的全部内容，三条都是踩过的坑，改任何一条都是**行为变更**：
 *
 *   ① **免鉴权组先于鉴权**：`/healthz` 与「配了出口的 `/metrics`」不鉴权（探针带不了
 *      凭据、抓取端在集群内网），**它们自己的 405 也在鉴权之前** —— 配了 authenticate 时
 *      `POST /healthz` 回的是 405，不是 401。
 *      而没配 metrics 出口时 `/metrics` **不是**免鉴权路径（会先过鉴权，最后 404）。
 *   ② **其余一律先鉴权、再判方法与路径**：所以鉴权失败时 `DELETE /run` 回 401 而不是 405，
 *      `POST /不存在的路径` 也先过鉴权 —— 「你路径写错了」不该泄露给未鉴权的调用方。
 *   ③ **`/tasks/<id>/approve`、`/tasks/<id>/cancel`、`/tasks/<id>/events` 与
 *      `/tasks/<id>/stream` 都先于 `/tasks/<id>`，且「方法不对」压过「id 坏了」**：
 *      `GET /tasks/x/approve` 回 **405（Allow: POST）**而不是 404、也不走轮询
 *      （cancel 同款：`GET /tasks/x/cancel` = 405）；
 *      `POST /tasks/x/stream` 回 **405（Allow: GET）**；
 *      `DELETE /tasks/%zz/approve` 回 **405 而不是 400** —— 方法不对就轮不到判 id。
 *      可观测的是这个结果，不是源码里的书写次序：解码经 `decodeSegment`（**不抛错**，
 *      失败只回 undefined），所以「先判方法」的落点是**解码结果只在方法通过之后才被消费**。
 *      反例：把「解码失败」写成早返回（`if (id === undefined) return badTaskId`）就变成
 *      400/404 —— 那是行为变更，`http-route.test.ts` 里各有一条断言守着。
 *
 * 调用方约定：`pathname` 已剥掉 query（`(req.url ?? '/').split('?')[0]`），
 * `method` 已兜过缺省（`req.method ?? 'GET'`）。
 */

/** 路由判定结果。`methodNotAllowed.preAuth` 说明这条 405 该在鉴权之前回。 */
export type HttpRoute =
  | { kind: 'healthz' }
  | { kind: 'metrics' }
  | { kind: 'run' }
  | { kind: 'submit' }
  | { kind: 'approve'; taskId: string }
  | { kind: 'cancel'; taskId: string }
  | { kind: 'taskEvent'; taskId: string }
  | { kind: 'taskStream'; taskId: string }
  | { kind: 'poll'; taskId: string }
  /** taskId 的 URL 编码残缺 → 400（调用方输入问题，不是 500） */
  | { kind: 'badTaskId' }
  | { kind: 'notFound' }
  | { kind: 'methodNotAllowed'; allowed: string; preAuth: boolean };

function refuse(allowed: string, preAuth: boolean): HttpRoute {
  return { kind: 'methodNotAllowed', allowed, preAuth };
}

/** 残缺的 `%` 转义会抛 URIError —— 是调用方的输入问题（400），不是服务端 500 */
function decodeSegment(seg: string): string | undefined {
  try {
    return decodeURIComponent(seg);
  } catch {
    return undefined;
  }
}

/** 这条路由是否属于「免鉴权组」（含它们的 405）—— 调用方据此决定先回还是先鉴权 */
export function isPreAuthRoute(route: HttpRoute): boolean {
  return (
    route.kind === 'healthz' ||
    route.kind === 'metrics' ||
    (route.kind === 'methodNotAllowed' && route.preAuth)
  );
}

export function routeRequest(pathname: string, method: string, hasMetrics: boolean): HttpRoute {
  // ① 免鉴权组（顺序陷阱见头注）
  if (pathname === '/healthz') return method === 'GET' ? { kind: 'healthz' } : refuse('GET', true);
  if (pathname === '/metrics' && hasMetrics)
    return method === 'GET' ? { kind: 'metrics' } : refuse('GET', true);

  // ② 以下都由调用方**先鉴权**（含方法不符与路径不存在）
  if (pathname === '/run') return method === 'POST' ? { kind: 'run' } : refuse('POST', false);
  if (pathname === '/tasks') return method === 'POST' ? { kind: 'submit' } : refuse('POST', false);

  if (pathname.startsWith('/tasks/')) {
    const rest = pathname.slice('/tasks/'.length);
    // ③ approve 先于通用 id 分支；方法检查先于解码
    if (rest.endsWith('/approve')) {
      if (method !== 'POST') return refuse('POST', false);
      const id = decodeSegment(rest.slice(0, -'/approve'.length));
      return id === undefined ? { kind: 'badTaskId' } : { kind: 'approve', taskId: id };
    }
    // 取消（2026-09-28 ref-cancel-api）：与 approve 同款排法 —— 先判方法、再解码
    if (rest.endsWith('/cancel')) {
      if (method !== 'POST') return refuse('POST', false);
      const id = decodeSegment(rest.slice(0, -'/cancel'.length));
      return id === undefined ? { kind: 'badTaskId' } : { kind: 'cancel', taskId: id };
    }
    // 事件投入口（2026-09-28 ref-run-event-input）：同款排法 —— 先判方法、再解码
    if (rest.endsWith('/events')) {
      if (method !== 'POST') return refuse('POST', false);
      const id = decodeSegment(rest.slice(0, -'/events'.length));
      return id === undefined ? { kind: 'badTaskId' } : { kind: 'taskEvent', taskId: id };
    }
    if (rest.endsWith('/stream')) {
      if (method !== 'GET') return refuse('GET', false);
      const id = decodeSegment(rest.slice(0, -'/stream'.length));
      return id === undefined ? { kind: 'badTaskId' } : { kind: 'taskStream', taskId: id };
    }
    if (method !== 'GET') return refuse('GET', false);
    const id = decodeSegment(rest);
    return id === undefined ? { kind: 'badTaskId' } : { kind: 'poll', taskId: id };
  }

  return { kind: 'notFound' };
}
