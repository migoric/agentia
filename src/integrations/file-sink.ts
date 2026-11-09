import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
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
 *
 * ⚠️ **`fsync` 不是缓存键的一部分**（2026-11-09 深评 P3-1）：键带 `fsync` 会回到「同一文件两个
 * 写者 ⇒ 一次 run 落两行」那个更贵的问题上。所以同路径永远共用一个 sink，而**第二次请求的
 * `fsync` 与既有 sink 不一致时出一次声** —— 此前是静默忽略，于是「我明明开了 fsync」这类
 * 持久性承诺会无声失效（`fsync` 只影响性能与耐久，不影响内容，所以不会有任何东西报错）。
 */
interface SinkEntry {
  readonly sink: TraceSink;
  readonly fsync: boolean;
  /** 不一致告警是否已出过（同路径只说一次，别按 run 刷屏） */
  warned: boolean;
}

const sinkByPath = new Map<string, SinkEntry>();

export function jsonlTraceSink(options: { path: string; fsync?: boolean }): TraceSink {
  const path = resolve(options.path);
  const fsync = options.fsync === true;
  const existing = sinkByPath.get(path);
  if (existing !== undefined) {
    if (existing.fsync !== fsync && !existing.warned) {
      existing.warned = true;
      console.warn(
        `[agentia] jsonlTraceSink：同路径已存在一个 fsync=${existing.fsync} 的 sink（${path}），` +
          `本次请求的 fsync=${fsync} 不会生效。` +
          '同路径进程内只保留一个 sink（否则一次 run 会落两行同 traceId 的记录）；' +
          '要换持久性口径，请在进程启动时统一整份配置。',
      );
    }
    return existing.sink;
  }
  mkdirSync(dirname(path), { recursive: true });
  const sink: TraceSink = {
    export(trace: Trace): void {
      const line = `${JSON.stringify(trace)}\n`;
      if (!fsync) {
        // 保持旧行为：appendFileSync 一次 open/write/close（进程内串行、按行原子）。
        const fd = openSync(path, 'a');
        try {
          writeSync(fd, line);
        } finally {
          closeSync(fd);
        }
        return;
      }
      // opt-in 持久性：fsync 之后才承诺「已落盘」。代价是每次 run 收尾多一次磁盘同步，
      // 高吞吐宿主应只在关键 trace 上开（2026-11-07 深评）。
      const fd = openSync(path, 'a');
      try {
        writeSync(fd, line);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
  };
  sinkByPath.set(path, { sink, fsync, warned: false });
  return sink;
}
