import { frameLimitText, MAX_FRAME_CHARS } from './line-framing.js';

/**
 * Agentia —— SSE 逐行分帧（**单源**）。
 *
 * Anthropic 与 OpenAI 兼容端点的事件流都是「一行一条 `data:`」（不需要处理跨行
 * payload），两个适配器此前各写了一份**逐字相同**的 `sseLines`。合并的意义不止整洁：
 * `finally` 里的 `reader.cancel()` 是「提前 break（abort / `[DONE]`）时底层流仍被回收」
 * 的唯一保证 —— 这份代码在两处各存一份，漏改一处就是一处泄漏（读锁不释放，连接挂着）。
 *
 * 只做分帧，不解释协议：空行照常 yield，是不是 `data:` 前缀、要不要认 `[DONE]`
 * 全由调用方判。
 *
 * core 是叶子层：只 import 同层的 `line-framing.js`（纯常量），不依赖任何上层。
 */
/**
 * 「单帧超限」的错误（归入**上游故障**：server 一档可重试，与适配器的流内错误同口径）。
 *
 * 单源：判据落在**一条切出来的帧**上（见下方，2026-11-09 深评 P3-2）。
 */
function frameTooLarge(): Error {
  const e = new Error(
    `SSE 单行超过分帧上限（${frameLimitText()}）—— 对端持续发送不带换行的数据，已中止`,
  );
  (e as { status?: number }).status = 500;
  return e;
}

export async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // 单条 `data:` 行无上限 = 坏 server 持续吐不带换行的字节就能把进程 OOM
      // （2026-11-07 深评）。与 MCP 两条桥共用同一个 8M 码元硬上限。
      //
      // ⚠️ 判据必须是**切出来的那一行**，不是整个 `buf`（2026-11-09 深评 P3-2）：此前先判
      // `buf.length` 再切分，一个 9MB 但每行都很短的 chunk 会被误判成「单行超限」（假阳性，
      // 且报的文案与事实相反）。先切后判同时也保住了原意 —— 一次 read 就把整条 9MB 行连
      // 换行一起送来的情形，下面那条 `line.length` 照样拦得住。
      let idx = buf.indexOf('\n');
      while (idx >= 0) {
        const line = buf.slice(0, idx);
        if (line.length > MAX_FRAME_CHARS) throw frameTooLarge();
        yield line.replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        idx = buf.indexOf('\n');
      }
      // 切完之后剩下的，才是「还没等到换行」的那一条（跨 read 累积的那一半）
      if (buf.length > MAX_FRAME_CHARS) throw frameTooLarge();
    }
    // 冲掉 TextDecoder 的尾字节（流若在码点中间结束，此前会静默丢掉最后半个字符）。
    buf += decoder.decode();
    // 末尾没有换行收尾的残行也要交出去（不是所有端点都补 \n）
    if (buf) yield buf.replace(/\r$/, '');
  } finally {
    // 提前 break（abort / [DONE]）时释放读锁，否则流不会被回收
    try {
      await reader.cancel();
    } catch {
      /* 已结束/已取消 */
    }
  }
}
