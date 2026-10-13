import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
 */
export function jsonlTraceSink(options: { path: string }): TraceSink {
  mkdirSync(dirname(options.path), { recursive: true });
  return {
    export(trace: Trace): void {
      appendFileSync(options.path, `${JSON.stringify(trace)}\n`, 'utf8');
    },
  };
}
