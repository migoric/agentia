import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * 「**已有的业务**」—— 这个文件在加 agent 之前就存在，加 agent 之后**一行都没改**。
 *
 * 这是本示例的叙事前提：真实项目里你要动的是「在 main.ts 里并排加一条路由」，
 * 而不是推倒重来。（`handleOrders` 与 `findOrder` 的名字都刻意保持业务原样。）
 */
export interface Order {
  id: string;
  status: 'paid' | 'shipped' | 'refunded';
  amountUsd: number;
  placedAt: string;
}

const ORDERS: readonly Order[] = [
  { id: 'A-1001', status: 'paid', amountUsd: 42.5, placedAt: '2026-10-14T09:12:00Z' },
  { id: 'A-1002', status: 'shipped', amountUsd: 118, placedAt: '2026-10-15T16:03:00Z' },
  { id: 'A-1003', status: 'refunded', amountUsd: 9.9, placedAt: '2026-10-16T11:40:00Z' },
];

/** 业务查询函数 —— agent 的 `@Tool` 包的就是它（不是另写一份） */
export function findOrder(id: string): Order | undefined {
  return ORDERS.find((o) => o.id === id);
}

/**
 * 已有的业务路由：`GET /api/orders/:id`。
 *
 * ⚠️ 这里**故意**用最朴素的写法（不引框架、不引路由库）—— 它代表「你的服务本来长这样」。
 */
export function handleOrders(req: IncomingMessage, res: ServerResponse): boolean {
  const url = (req.url ?? '').split('?')[0] ?? '';
  const m = /^\/api\/orders\/([^/]+)$/.exec(url);
  if (m === null) return false; // 不是我的路由 —— 交回上层
  if (req.method !== 'GET') {
    res.writeHead(405).end();
    return true;
  }
  const order = findOrder(decodeURIComponent(m[1] ?? ''));
  if (order === undefined) {
    res
      .writeHead(404, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: '订单不存在' }));
    return true;
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(order));
  return true;
}
