// 浸泡 / 压力验证（soak）：本地假端点 + 故障注入 + N 并发长跑，验证「时间维度」的问题 ——
// 单测与 e2e 都是「跑一轮看结果」，回答不了「连跑一小时会不会缓慢漏内存 / 句柄」。
//
// 为什么零成本：模型侧是**本地假端点**（与 e2e-examples 同一手法：替掉模型，绝不替掉
// 被测的框架链路），零网络、零 token，CI 之外的任意机器都能跑。
//
// 注入的故障（按请求概率，种子固定 ⇒ 可复现）：
//   2%  HTTP 429 + retry-after      —— 可重试，应被适配器/引擎重试吸收
//   2%  SSE 流写到一半掐断 socket    —— 截断 ⇒ AnthropicApiError/OpenAICompatApiError(500) 可重试
//   3%  HTTP 400 invalid_request     —— 不可重试，run 应以 api 错误收尾
//   1%  200 流内 error 分片（4xx 类）—— 不可重试，run 应以 api 错误收尾
//   8%  正常路径但先发 tool_call     —— 让「调工具 → 回灌 → 收尾」的多回合链路也在压力下跑
//
// 结尾断言（缺一不可，挂了 exit 1）：
//   ① 失败与注入**逐笔对账**：每个不可重试故障（400/流内错误）恰好杀死一个 run ⇒
//     failed ≥ 注入数（少了 = 故障被静默吞），且超出部分 ≤ 请求的 0.1%
//     （多了 = 可重试故障没被重试吸收）；
//   ② 每个失败 run 的错误分类都要在**处置表**里表过态（`scripts/soak-error-posture.ts` 的
//      `SOAK_ERROR_POSTURE`，穷尽表：加一类不表态 ⇒ `typecheck:tests` 红）：`unknown` / `aborted` /
//      `timeout` 属 hard-red（出现即红 —— `unknown` 是「分类器失手」，后两类在这套跑法里不该发生），
//      其余**允许但分类计数并打印**。⚠️ 这里原先是一份手写的三名字白名单（`api` / `server` /
//      `rate_limit`），漏了框架自己的 `connection` ⇒ 2026-09-29 那轮 2 小时（719 万 run）撞到
//      **1 次**就报红，**红的是判据、不是被测的代码**（spec §10 2026-09-29 ref-soak-error-taxonomy）；
//      ⚠️ 守那张表的是 `npm run typecheck:tests`（不是 `typecheck` —— `scripts/` 不在根
//      tsconfig 的 include 里，写错命令＝没有护栏，见 soak-error-posture.ts 头注）；
//   ③ metricsSink 的 snapshot 与实测计数逐一对得上，render() 恒定发三个 dropped_keys 样本；
//   ④ 内存有界：热身后 heapUsed 末段均值相对前段均值的增长 < 48MB（采样间隔随时长
//     缩放，样本不足硬失败 —— 不「跳过」）；
//   ⑤ 干净退出：断言完若还有活着的句柄把进程吊住，看门狗超时后打印句柄并 exit 1。
//
// 不并入 verify-all（它是「跑多久」而不是「对不对」的验证，默认 60s 已偏慢）。
// 用法：npm run e2e:soak；调参：SOAK_DURATION_MS=7200000 SOAK_CONCURRENCY=32 npm run e2e:soak
import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createOpenAIClient, metricsSink, runAgent } from '../src/index.js';
import type { AgentTool } from '../src/index.js';
import { POSTURE_TYPES, soakErrorVerdict, tallyByType } from './soak-error-posture.js';

const DURATION_MS = Number(process.env.SOAK_DURATION_MS ?? 60_000);
const CONCURRENCY = Number(process.env.SOAK_CONCURRENCY ?? 16);
const SEED = Number(process.env.SOAK_SEED ?? 42);
assert.ok(DURATION_MS >= 5000, 'SOAK_DURATION_MS 太短得不出任何结论（≥ 5s）');
assert.ok(CONCURRENCY >= 1 && CONCURRENCY <= 256, 'SOAK_CONCURRENCY 应在 1..256');

/** 确定性 RNG（mulberry32）：种子固定 ⇒ **故障序列**可复现（第 N 个请求注不注入、
 *  注入什么是定的）；按墙钟停表 ⇒ run 总数/吞吐不可复现（别拿它们当回归基线） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// —— 假端点（OpenAI 兼容 SSE + 故障注入）——

interface FaultStats {
  requests: number;
  f429: number;
  truncated: number;
  f400: number;
  errorShard: number;
  toolPath: number;
  plain: number;
}

function sseChunks(res: ServerResponse, chunks: unknown[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

async function startFaultyProvider(rng: () => number): Promise<{
  baseURL: string;
  stats: FaultStats;
  close: () => Promise<void>;
}> {
  const stats: FaultStats = {
    requests: 0,
    f429: 0,
    truncated: 0,
    f400: 0,
    errorShard: 0,
    toolPath: 0,
    plain: 0,
  };
  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      stats.requests++;
      const parsed = JSON.parse(body) as { messages?: Array<{ role?: string }> };
      const r = rng();

      if (r < 0.02) {
        // 可重试限流（retry-after: 0 ⇒ 退避不拖时间，soak 才能跑出量）
        stats.f429++;
        res.writeHead(429, { 'retry-after': '0' });
        res.end(JSON.stringify({ error: { type: 'rate_limit_exceeded', message: 'slow down' } }));
        return;
      }
      if (r < 0.04) {
        // 截断：吐出一个正常分片后直接把 socket 掐掉（无 [DONE]、无 finish_reason）
        stats.truncated++;
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.write(
          `data: ${JSON.stringify({ id: 'chatcmpl-x', model: 'soak-model', choices: [{ delta: { content: '半句' } }] })}\n\n`,
        );
        res.socket?.destroy();
        return;
      }
      if (r < 0.07) {
        // 不可重试 4xx：改配置才有救的病因，引擎一次都不该重试
        stats.f400++;
        res.writeHead(400);
        res.end(
          JSON.stringify({
            error: {
              type: 'invalid_request_error',
              code: 'context_length_exceeded',
              message: 'too long',
            },
          }),
        );
        return;
      }
      if (r < 0.08) {
        // 200 流内 error 分片（兼容端点常见形态）—— 同样按 4xx 判
        stats.errorShard++;
        sseChunks(res, [
          {
            error: {
              type: 'invalid_request_error',
              code: 'model_not_found',
              message: 'no such model',
            },
          },
        ]);
        return;
      }

      const hasToolResult = (parsed.messages ?? []).some((m) => m.role === 'tool');
      if (!hasToolResult && r < 0.16) {
        // 8%：先发 tool_call（arguments 分两片，与真端点同形），让多回合链路也承压
        stats.toolPath++;
        sseChunks(res, [
          {
            id: 'chatcmpl-t',
            model: 'soak-model',
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_echo_1',
                      type: 'function',
                      function: { name: 'echo', arguments: '' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: '{"text":' } }] } },
            ],
          },
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: '"ping"}' } }] } },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
        ]);
        return;
      }

      stats.plain++;
      sseChunks(res, [
        { id: 'chatcmpl-ok', model: 'soak-model', choices: [{ delta: { content: '收尾' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 8, completion_tokens: 2 } },
      ]);
    });
  });

  const baseURL = await new Promise<string>((ready) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      assert.ok(typeof addr === 'object' && addr !== null, '假端点没有拿到端口');
      ready(`http://127.0.0.1:${addr.port}`);
    });
  });
  return {
    baseURL,
    stats,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

// —— soak 主体 ——

const echoTool: AgentTool = {
  name: 'echo',
  description: '回显输入文本。',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  } as unknown as AgentTool['inputSchema'],
  run: async (input) => `echo: ${String((input as { text: string }).text)}`,
};

async function main(): Promise<void> {
  const rng = mulberry32(SEED);
  const provider = await startFaultyProvider(rng);
  const client = createOpenAIClient({ baseURL: provider.baseURL, apiKey: 'soak', maxRetries: 1 });
  const sink = metricsSink();

  // 看门狗：断言结束后进程若被活着的句柄吊住，打出来再死 —— 「没退出」本身是一条失败
  const watchdog = setTimeout(() => {
    console.error('\n✖ soak 结束后进程未退出（句柄泄漏）。活跃句柄：');
    const handles = (
      process as unknown as { _getActiveHandles?: () => unknown[] }
    )._getActiveHandles?.();
    console.error(`  ${handles?.length ?? '?'} 个`);
    process.exit(1);
  }, DURATION_MS + 30_000);

  // 采样间隔随时长缩放：任何时长都攒够内存断言所需的样本量（≥10 个）——
  // 「采样不足就跳过断言」= 静默跳过 = 假装验过（第八轮复审抓到的自家病灶）。
  const SAMPLE_INTERVAL_MS = Math.max(500, Math.floor(DURATION_MS / 30));
  const memSamples: Array<{ t: number; heap: number; rss: number }> = [];
  const sampler = setInterval(() => {
    const m = process.memoryUsage();
    memSamples.push({ t: Date.now(), heap: m.heapUsed, rss: m.rss });
  }, SAMPLE_INTERVAL_MS);

  let total = 0;
  let failed = 0;
  let thrown = 0; // runAgent 正常失败是 result.error 在场，throw 出来 = 契约破了
  // 判据的两半（原先糊在一行 `['api','server','rate_limit'].includes(type)` 里，
  // 见 scripts/soak-error-posture.ts 的头注）：
  //   · failedTypes —— 每个失败 run 的类别，用来**分类计数并打印**（允许 ≠ 不看）；
  //   · hardRedTypes —— 处置表判 hard-red 的那些（含 THROWN:），非空即红。
  const failedTypes: string[] = [];
  const hardRedTypes: string[] = [];
  const endAt = Date.now() + DURATION_MS;

  const worker = async (id: number): Promise<void> => {
    let n = 0;
    while (Date.now() < endAt) {
      n++;
      try {
        const result = await runAgent({
          model: 'soak-model',
          maxTokens: 256,
          client,
          messages: [{ role: 'user', content: `worker ${id} 第 ${n} 轮` }],
          tools: [echoTool],
        });
        total++;
        sink.export(result.trace);
        if (result.error) {
          failed++;
          failedTypes.push(result.error.type);
          if (soakErrorVerdict(result.error.type) === 'hard-red') {
            hardRedTypes.push(result.error.type);
          }
        }
      } catch (e) {
        thrown++;
        total++;
        hardRedTypes.push(`THROWN:${(e as Error).message.slice(0, 80)}`);
      }
    }
  };

  console.log(
    `soak 开跑：${CONCURRENCY} 并发 × ${DURATION_MS / 1000}s，种子 ${SEED}（故障：2% 429 / 2% 截断 / 3% 400 / 1% 流内错误 / 8% 工具路径）`,
  );
  const started = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
  clearInterval(sampler);

  const elapsed = (Date.now() - started) / 1000;
  const snap = sink.snapshot();
  const rendered = sink.render();
  sink.stop();
  await provider.close();

  // —— 汇总 ——
  const rate = total === 0 ? 0 : failed / total;
  const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)}MB`;
  console.log('\n—— soak 结果 ——');
  console.log(
    `run：total=${total} failed=${failed}（${(rate * 100).toFixed(2)}%）thrown=${thrown}，吞吐 ${(total / elapsed).toFixed(1)} run/s`,
  );
  console.log(
    `端点：requests=${provider.stats.requests} 429=${provider.stats.f429} 截断=${provider.stats.truncated} 400=${provider.stats.f400} 流内错误=${provider.stats.errorShard} 工具路径=${provider.stats.toolPath} 正常=${provider.stats.plain}`,
  );
  // 「允许」的那几类必须**看得见**：分类计数打出来（不是不看）。这一行就是当初缺的东西 ——
  // 手写白名单把「我没列到」与「分类器失手」混成了一件，于是 719 万 run 里那 1 次
  // `connection` 只表现为「有个东西不在我的名单里」。
  console.log(
    `错误分类：${
      failedTypes.length === 0
        ? '（无失败）'
        : tallyByType(failedTypes)
            .map(([t, n]) => `${t}=${n}`)
            .join(' ')
    }`,
  );
  console.log(
    `判据：scripts/soak-error-posture.ts 的处置表（expected 允许、hard-red 即红）；认得 ${POSTURE_TYPES.join('/')}`,
  );
  if (memSamples.length >= 4) {
    console.log(
      `内存：heap ${mb(memSamples[0]!.heap)} → ${mb(memSamples[memSamples.length - 1]!.heap)}，rss 峰值 ${mb(Math.max(...memSamples.map((s) => s.rss)))}（${memSamples.length} 个采样）`,
    );
  }

  // —— 断言 ——
  assert.ok(total >= 100, `样本太少（${total} 个 run），统计结论无意义 —— 加长 SOAK_DURATION_MS`);

  // ① 失败与注入**逐笔对账**（不是宽区间糊弄）：
  //    400 / 流内错误是不可重试故障 —— 每个这样的响应**恰好杀死一个 run**（一个 run
  //    不可能吃到两个：第一发就终局）。所以 failed 必须 ≥ 两者之和（少了 = 故障被
  //    静默吞了，比全挂更可怕）；而可重试故障（429/截断）要连穿 适配器 2 次 × 引擎 3 次
  //    重试才会杀死 run（ppm 级），故 failed 超出部分不得超过请求的 0.1%。
  const nonRetryable = provider.stats.f400 + provider.stats.errorShard;
  assert.ok(
    provider.stats.f429 + provider.stats.truncated > 0,
    '可重试故障一次都没注入 —— 注入机制坏了，后面的断言都在空转',
  );
  assert.ok(nonRetryable > 0, '不可重试故障一次都没注入 —— 同上');
  assert.ok(
    failed >= nonRetryable,
    `失败数 ${failed} < 不可重试注入数 ${nonRetryable} —— 有故障被静默吞了（比全挂更可怕）`,
  );
  const retryableSlack = Math.max(2, Math.ceil(provider.stats.requests * 0.001));
  assert.ok(
    failed <= nonRetryable + retryableSlack,
    `失败数 ${failed} 超出不可重试注入数 ${nonRetryable} 太多（容差 ${retryableSlack}）—— ` +
      '重试没在吸收可重试故障（429/截断），或出现了计划外的失败类别',
  );

  // ② 错误分类：**处置表**里判 hard-red 的一个都不许出现（run 以 throw 收尾也走这条）。
  //    判 hard-red 的是：`unknown`（分类器失手 —— 这条断言原本要抓的东西）、`aborted`
  //    （这套跑法没人取消）、`timeout`（本地假端点毫秒级应答，不该超时），以及
  //    **表里没有的类别**（`soakErrorVerdict` 对未登记的一律判红：宁可响，不可静默放过）。
  assert.equal(
    thrown,
    0,
    `有 ${thrown} 个 run 以 throw 收尾（契约是 result.error 在场）：${hardRedTypes[0] ?? ''}`,
  );
  assert.deepEqual(
    [...new Set(hardRedTypes)],
    [],
    `出现处置表判 hard-red 的错误分类：${[...new Set(hardRedTypes)].join(', ')}` +
      '（表与理由在 scripts/soak-error-posture.ts；要放行某类，先在那里表态并写清为什么）',
  );

  // ③ metricsSink 与实测逐一对账
  assert.equal(snap.runs, total, 'snapshot().runs 与实测 run 数不符');
  assert.equal(snap.failed, failed, 'snapshot().failed 与实测失败数不符');
  for (const k of ['capability', 'model', 'score']) {
    assert.match(
      rendered,
      new RegExp(`agentia_dropped_keys\\{kind="${k}"\\} \\d+`),
      `render() 缺 dropped_keys{kind=${k}}`,
    );
  }

  // ④ 内存有界：丢掉前 20% 采样（预热），末 3 个均值相对前 3 个均值的增长 < 48MB。
  //    采样间隔已随时长缩放（SAMPLE_INTERVAL_MS），样本量不够是脚本 bug —— 硬失败，
  //    不「跳过」（静默跳过 = 假装验过）。
  assert.ok(
    memSamples.length >= 10,
    `内存采样不足（${memSamples.length} 个）—— 采样间隔缩放失效，这是脚本 bug，不是跳过`,
  );
  const warm = memSamples.slice(Math.ceil(memSamples.length * 0.2));
  const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const headAvg = avg(warm.slice(0, 3).map((s) => s.heap));
  const tailAvg = avg(warm.slice(-3).map((s) => s.heap));
  assert.ok(
    tailAvg - headAvg < 48 * 1024 * 1024,
    `heapUsed 热身后仍增长 ${mb(tailAvg - headAvg)}（${mb(headAvg)} → ${mb(tailAvg)}）—— 疑似泄漏`,
  );

  clearTimeout(watchdog);
  console.log(
    `\nOK —— soak 全过：${total} run / ${provider.stats.requests} 请求，` +
      `失败与不可重试注入逐笔对账（${failed} vs ${nonRetryable}），` +
      `错误分类无 unknown，metrics 对账一致，heap ${mb(headAvg)} → ${mb(tailAvg)}（热身后），干净退出。`,
  );
}

await main();
