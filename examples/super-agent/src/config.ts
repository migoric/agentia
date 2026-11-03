/**
 * 示例的旋钮与剧本常量。
 *
 * 与 ../patrol/ 同一条纪律：**框架不读 env，宿主自己读** —— 这里读的 `AGENTIA_MODEL`
 * 是给「真模型跑法」（`npm start`）用的；`npm run demo` 完全不用模型端点。
 */
export const MODEL = process.env.AGENTIA_MODEL ?? 'claude-opus-5';

/**
 * 四个预算旋钮 —— **不设 = 没有保险丝**（usage-guide §4）。
 *
 * ⚠️ 多工单场景要特别注意：这些是**单个 run** 的上限，不是「一个目标」的上限。
 * Router 一条 + N 个 Worker 各自一份 ⇒ 真实花费是 N+1 条 run 之和。
 * 要「一个目标最多花多少钱」，得在宿主侧按 `labels.goal` 聚合（见 README「坑 3」）。
 */
export const BUDGETS = {
  maxTotalTokens: 120_000,
  maxCostUsd: 0.8,
  maxIterations: 10,
  /** 单工具超时（毫秒）：Worker 的工具都是内存操作，宽给 */
  toolTimeoutMs: 60_000,
} as const;

/**
 * demo / 真跑共用的沙箱种子 —— 一个**有真 bug** 的小工程。
 *
 * 缺陷：`total()` 累加 `price` 却忽略 `quantity` ⇒ 「2 件 × 50 元」算成 50。
 * 这是刻意选的：既能被 `search_text` 搜到、被 `read_file` 读到，修复又只需改一行，
 * 于是剧本里的「复现 → 修复」是**真判断**而不是走过场。
 */
export const SEED_FILES: Record<string, string> = {
  'src/pricing.ts': [
    'export interface Item {',
    '  price: number;',
    '  quantity: number;',
    '}',
    '',
    'export function total(items: Item[]): number {',
    '  let sum = 0;',
    '  for (const item of items) {',
    '    sum += item.price;',
    '  }',
    '  return sum;',
    '}',
    '',
  ].join('\n'),
  'test/pricing.test.ts': [
    "import { total } from '../src/pricing.js';",
    '',
    "test('两件 50 元应合计 100', () => {",
    '  expect(total([{ price: 50, quantity: 2 }])).toBe(100);',
    '});',
    '',
  ].join('\n'),
};

/** 用户报上来的那句话 —— demo 与 `npm start` 的默认输入 */
export const DEFAULT_GOAL = '客户投诉：下单 2 件、单价 50 元，订单总额却只算 50 元。请复现并修复。';
