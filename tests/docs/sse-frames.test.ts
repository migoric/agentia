import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * SSE **帧名**的守卫：usage-guide 里用反引号写出的帧名（`task.end` / `stream.closed` …）
 * 必须真从 `src/transport/` 下的 `sse.event('…')` 发出来。
 *
 * 为什么需要它：帧名是**字符串面**，不进类型系统 —— 文档与实现各说各话没有任何机械守卫
 * （2026-09-22 复核记录 §6 第 5 条：「`tests/docs` 对 `task.end` / `stream.closed` /
 * `trace.event` 零命中，帧名漂移无机械守卫」）。
 *
 * 扫描面是**整个 `src/transport/` 目录**，不是某一个文件：帧从哪**个**文件发出来是
 * 实现的排布，不是契约（契约是「这些帧真的存在」）。这条守卫原先写死
 * `src/transport/http.ts`，2026-09-28 拆分第三步把 HTTP 端点体搬到 `http-endpoints.ts`
 * 时它当场**误红**（帧一条没少，只是换了文件）—— 守卫盯着实现排布就会在每次重构时
 * 报假警，而假警的最后结局是被人顺手放宽。按目录扫则搬家免疫。
 * 过宽会不会误报：不会。断言方向是「文档提到的 ⊆ 实现 emit 的」，多扫到的记号
 * 只会把实现侧集合撑大（更宽松的通过），不会凭空造出「文档说谎」。
 *
 * 口径与已知边界：
 * - 只扫**带点前缀**（task./stream./trace./text./run.）的反引号词 ⇒ 无点的 `error` 帧
 *   不在射程内（太泛，误报多）；它由 HTTP 侧的实现测试守。
 * - `trace.truncated` 是 **run 根的 trace 事件名**（`traceLimits.maxEvents` 超限时的簿记：
 *   起点标记 + 收尾摘要两笔，见 tracer.ts），**不是** SSE 帧名 —— 它会作为 **`trace.event`
 *   帧体**里的 `event.name` 流经 SSE，但帧名本身不是它 ⇒ 显式排除。（2026-09-28 订正：
 *   此前写成「run 根的 attribute」，两处都不准 —— 它是事件不是属性。）
 * - 单向（文档 ⇒ 实现）：文档不许写实现里没有的帧。反向（新帧必须写文档）由人评审守 ——
 *   自动做会误伤「内部帧不该进使用者文档」的正当取舍。
 */
describe('SSE 帧名：文档 ⇐ 实现（单向，文档不许说谎）', () => {
  const transportDir = join(repoRoot, 'src', 'transport');
  const emitted = new Set(
    readdirSync(transportDir)
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) =>
        [...readFileSync(join(transportDir, f), 'utf8').matchAll(/sse\.event\('([^']+)'/g)].map(
          (m) => m[1] as string,
        ),
      ),
  );
  const guide = readFileSync(join(repoRoot, 'docs', 'usage-guide.md'), 'utf8');

  /**
   * 不是 SSE 帧的名字（见文件头）：
   * - `trace.truncated` 是 run 根的 **trace 事件名**（`traceLimits.maxEvents` 超限时的簿记：
   *   起点标记 + 收尾摘要两笔；它以 `trace.event` 帧体的形式流经 SSE，但本身不是帧名）；
   * - `task.event` 是**续跑段 run 根的 trace 事件名**（2026-09-28 ref-run-event-input 事件投入口的留痕），
   *   与 SSE 的 `task.end` 帧同名族但不是帧 —— 它由 engine/loop.ts 的 recorder.event 发出。
   */
  const NOT_A_FRAME = new Set(['trace.truncated', 'task.event']);

  it('usage-guide 里每个带点前缀的反引号帧名都必须真被 emit', () => {
    const mentioned = new Set(
      [...guide.matchAll(/`((?:task|stream|trace|text|run)\.[a-z]+(?:\.[a-z]+)?)`/g)]
        .map((m) => m[1] as string)
        .filter((name) => !NOT_A_FRAME.has(name)),
    );
    // 防真空变绿：文档里确实提到了帧名、实现侧也确实在 emit（正则口径变了要在这里炸出来）
    assert.ok(mentioned.size >= 6, `文档侧帧名少于预期（${mentioned.size}）—— 抽取口径变了？`);
    assert.ok(emitted.size >= 7, `实现侧帧名少于预期（${emitted.size}）—— 抽取口径变了？`);
    const lying = [...mentioned].filter((name) => !emitted.has(name));
    assert.deepEqual(
      lying,
      [],
      `usage-guide 提到了实现里不存在的 SSE 帧：${lying.join('、')} ` +
        `（实现实际 emit：${[...emitted].sort().join('、')}）—— 要么文档写错了，要么帧改名了没同步`,
    );
  });
});
