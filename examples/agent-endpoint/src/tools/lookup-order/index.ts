import { Tool } from '@migor/agentia';
import { findOrder } from '../../orders.js';

/**
 * 把**已有业务函数**包成模型可调用的能力。
 *
 * 这是加 agent 时唯一需要新写的「业务胶水」（约 20 行）—— 里面没有检索、没有 embedding、
 * 没有向量库：**RAG 是你的 `@Tool` 自己的事**，框架只负责把调用接到模型。
 * 真实项目里把 `findOrder` 换成 `pg.query(...)` / `vectorStore.search(...)` 即可。
 */
export default class LookupOrder {
  @Tool({
    description:
      '按订单号查询订单的状态与金额（只读）。用户问「我的订单到哪了」「A-1001 多少钱」时用它。',
    schema: {
      type: 'object',
      properties: {
        orderId: { type: 'string', description: '订单号，形如 A-1001' },
      },
      required: ['orderId'],
      additionalProperties: false,
    },
    strict: true,
  })
  lookupOrder(input: { orderId: string }): string {
    const order = findOrder(input.orderId.trim().toUpperCase());
    if (order === undefined) return `没有找到订单 ${input.orderId}（请确认单号）`;
    return JSON.stringify(order);
  }
}
