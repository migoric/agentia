import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Trace, TraceSink } from '../core/trace.js';

/**
 * Agentia —— JSONL 文件 sink：一行一条**裸 Trace** 追加落盘。
 *
 * 这是 CLI 四件套 `agentia report` / `agentia diff` / `agentia harvest` / `agentia export`
 * 的**输入格式**（每行一个 JSON，裸 Trace）—— 消费侧早就吃这个文件，产出侧此前要用户手写
 * `appendFileSync` 的 sink，这里把它收进框架。
 *
 * 语义：
 * - 父目录不存在时**构造期**递归创建（同 FileTaskStore：建一次，不落在每次 append 的热路径上）；
 * - 每次 `export` 追加一行（同步写，进程内串行）；**追加不覆盖**，文件已有时接着写；
 * - 写失败**抛给调用方**（`flushSinks` 会吞掉并落 console.warn —— 观测失败不击穿业务）；
 *   构造期 mkdir 失败同样抛（配置错误要响亮）。
 *
 * 前提：**单进程写者**（同 FileTaskStore）—— 多进程写同一文件会交错，
 * 跨进程协调（锁 / 队列）属部署层职责，不在本实现内。
 *
 * **同一路径进程内返回同一个 sink**（2026-10-16 ref-sink-exactly-once）：`jsonlTraceSink({ path: X })`
 * 调两次得到的是**同一个对象**，而不是两个各自 append 的写者。为什么必须幂等 ——
 * 两条 sink 对口同一个文件时，一次 run 会落**两行**同 traceId 的记录，而
 * `report` / `diff` / `harvest` 是把「一行 = 一次 run」当前提的 ⇒ 表现不是「报错」，
 * 而是「这次 run 被数了两次」（成本翻倍、错误率减半）。**比不落盘更难发现**：不落盘
 * 是「没有数据」，重复落盘是「数据看起来很正常，但错了」。
 * 现实里撞到它的形状：脚手架的 `createApp({ sinks })` 与 `agentia dev` 的
 * `registerDefaultTraceSink` 都往 `.agentia/traces.jsonl` 写（各自都合理）⇒ 幂等让
 * 「两处都接」退化成「恰好一次」，而不是「谁也不知道对方也写了」。
 * ⚠️ 幂等的粒度是**进程内按解析后的绝对路径**；跨进程仍受上面「单进程写者」前提约束。
 */
const sinkByPath = new Map<string, TraceSink>();

export function jsonlTraceSink(options: { path: string }): TraceSink {
  const path = resolve(options.path);
  const existing = sinkByPath.get(path);
  if (existing !== undefined) return existing;
  mkdirSync(dirname(path), { recursive: true });
  const sink: TraceSink = {
    export(trace: Trace): void {
      appendFileSync(path, `${JSON.stringify(trace)}\n`, 'utf8');
    },
  };
  sinkByPath.set(path, sink);
  return sink;
}
