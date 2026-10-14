/**
 * 浸泡验证（`e2e-soak.ts`）里**每个错误类别的处置** —— 单一真源，且是一张**穷尽表**
 * （2026-09-29 ref-soak-error-taxonomy）。
 *
 * 为什么单独成件：这套判据必须能被**答案驱动地**单测（`tests/scripts/soak-error-posture.test.ts`），
 * 而 soak 本体是顶层 `await main()` 的脚本 —— 测试里 import 它就会真跑一轮（默认 60s，
 * 调参后 2 小时）。所以把「表态」这块纯件搬出来，本体只消费。
 *
 * **这里记着的是它的来历**：判据原先是本体内手写的一行
 * `['api','server','rate_limit'].includes(type)` —— 漏了 `connection`（框架自己的合法类，
 * 见 `src/engine/errors.ts` 的 `ERROR_TYPES`）。漏一类的表现是**静默**的：默认 60s 的跑法
 * 永远撞不到；2026-09-29 那轮 2 小时（719 万 run / 811 万请求）撞到 **1 次**，整轮报红 ——
 * **红的是判据，不是被测的代码**。同一份手写清单还出现在外部审计报告里（它照抄了本文件）。
 *
 * 于是判据被拆成两件**不同**的事（原先糊在一行里）：
 *   ① `unknown` 才是「分类器失手」—— 这是那条断言原本想抓的东西；
 *   ② 其余合法类按各自处置表态：**允许**（计数、打印、仍受本体 ① 那条逐笔对账的 slack 约束）
 *      或**硬红**。
 */
import { ERROR_TYPES, type ErrorType } from '../src/engine/errors.js';

/** 一类错误的处置 */
export type ErrorPosture =
  /** 允许它作为失败收尾：数量受 `e2e-soak` ① 那条逐笔对账的 slack 约束（不是「不管」） */
  | 'expected'
  /** 出现即红：在这套假端点 + 不取消任何 run 的跑法里，它不该发生 */
  | 'hard-red';

export interface ErrorClassRule {
  posture: ErrorPosture;
  /** 为什么这么判（**必填**：加一类不解释 ⇒ `why` 长度断言红，见测试） */
  why: string;
}

/**
 * 七类的处置表。`Record<ErrorType, …>` 是**穷尽的** —— 给 `ERROR_TYPES` 加一类而不表态，
 * `npm run typecheck:tests` 报 `TS2741`（与 `KIND_SPEC` / `SUCCESS_STOP_REASON` 同款护栏）。
 *
 * ⚠️ **命令别写错**：本文件在 `scripts/`，而**根 `tsconfig.json` 的 include 里只有 `src`** ——
 * 所以守这张表的是 `typecheck:tests`（`tsconfig.tests.json` 才 include `scripts`）。
 * 第一次跑变异时这点就当场翻车：删掉 `unknown` 那一项，`npm run typecheck` **照样绿**
 * （假绿），换成 `typecheck:tests` 才报 `TS2741`。写错命令 = 没有护栏。
 */
export const SOAK_ERROR_POSTURE: Record<ErrorType, ErrorClassRule> = {
  aborted: {
    posture: 'hard-red',
    why: 'soak 不取消任何 run（不传 signal、没有 cancel 入口）⇒ 出现它只能是别处把 run 掐了，必须看',
  },
  rate_limit: {
    posture: 'expected',
    why: '注入的 2% 429：要连穿适配器 2 次 × 引擎 3 次重试才会杀死一个 run（ppm 级，受 ① slack 约束）',
  },
  server: {
    posture: 'expected',
    why: '注入的截断（2%）与流内错误在适配器侧就是 5xx 类：可重试，靠重试吸收',
  },
  api: {
    posture: 'expected',
    why: '注入的 3% 400 与 1% 流内错误**不可重试** —— 每个恰好杀死一个 run，是 ① 那条对账的基准',
  },
  timeout: {
    posture: 'hard-red',
    why: '本地假端点毫秒级应答、适配器也没有默认请求超时（只有宿主显式传 timeout 才有）⇒ 真出现 timeout 说明连 undici 自己的兜底都被拖爆了，是有信息量的事件：先看日志，再决定是否降级',
  },
  connection: {
    posture: 'expected',
    why: '本地网络层的真实故障（截断注入会把 socket 掐掉，undici 抛带 cause 的 TypeError）—— 2026-09-29 那轮 719 万 run 里出现过 1 次；数量仍受 ① 的 slack 约束，超了就红',
  },
  unknown: {
    posture: 'hard-red',
    why: '「分类器失手」本身才是这条断言要抓的东西（原先那行白名单把它与「我没列到」混成了一件事）',
  },
};

/**
 * 一个**运行期读到的**错误类别该怎么处置。入参刻意收 `string`（不是 `ErrorType`）：
 * 被检验的值来自 `SpanError.type`，它在类型上就是 `string` —— 表里没有的一律 `hard-red`
 * （宁可响，不可静默放过）。`THROWN:` 前缀（run 以抛错收尾）也走这条默认。
 */
export function soakErrorVerdict(type: string): ErrorPosture {
  return Object.hasOwn(SOAK_ERROR_POSTURE, type)
    ? SOAK_ERROR_POSTURE[type as ErrorType].posture
    : 'hard-red';
}

/** 分类计数（打印用：让「允许」的那几类**看得见**，而不是不看） */
export function tallyByType(types: Iterable<string>): Array<[type: string, count: number]> {
  const tally = new Map<string, number>();
  for (const t of types) tally.set(t, (tally.get(t) ?? 0) + 1);
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

/** 判据认得的全部类别（打印用；与 `ERROR_TYPES` 同一个源） */
export const POSTURE_TYPES: readonly ErrorType[] = ERROR_TYPES;
