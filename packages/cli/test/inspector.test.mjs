import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distReadyOrLoud } from './dist-guard.mjs';

/* 对构建产物测试（inspector 的静态资源在 dist/inspector，src 下没有）。
 *
 * ── 退化面与变异清单（2026-10-17 从 `docs/guards.md` 的注册表行搬回真源：那一行曾 3374 码点、逼近 `doc-budget` 的 `MAX_ROW = 3600`）──
 *
 * 未鉴权的本机进程能驱动 agent（任意 prompt × 任意工作目录 = 让 agent 读你整个盘）；面板把「你手快点了两下」显示成「服务器炸了」，真实原因被 500 掩掉；⑤⑥ 的路由若只写在面板里而不在服务端（或反之），点下去**看着像成功了**却什么都没发生 —— 反向验证过：把 `/run/abort` 改成「忽略钩子、一律报 202/不升级」⇒ 红；`/session/clear` 同理 ⇒ 红；⑦ 往页面 import 名单里塞一个不存在的名字 ⇒ 红（`panel-logic 必须导出「runDoneNoticeTypo」`）。**2026-09-22 复核这一轮又长三条**：⑧ `POST /ingest-event` 的入站校验（形状不合法 ⇒ 400、没有 dev 钩子 ⇒ 503）与**原样广播**（接到的就是 `traceEvent` 钩子收到的那个对象）；⑨ `/api/fs` 的**三组**返回（`dirs` / `dotDirs` / `files` + `filesTruncated` 明示截断，点文件名要能拿到它所在的目录）；⑩ 三条**接线**判据（抽进 `panel-logic` 了、页面必须真的走它：`!replyBelongsTo(` / `browseTarget(` / `promptAfterFilePick(` / `kind === 'trace-event'` / `applyTraceEvent(` / `state.live = null`）—— 抽出来不接上等于没抽，而浏览器里没人替你发现。**2026-09-22 第三轮（Markdown / 滚动 / 折叠）**：⑦ 的反向全覆盖从「只查 `panel-logic.js`」扩到**所有自建模块**（`panel-logic.js` + `markdown.js`：逐文件 `curl` 200 + 逐名 `in mod`），并新增四条**页面级不变量** —— ① 全页对 `innerHTML` 的**赋值**只准一处且必须是 `renderSummary(`（模型正文一个字节都不许进 innerHTML —— 这条比「某个变量名没出现」强得多）；② `body` 必须 `overflow: hidden`（整页不滚）；③ `#trace` 必须是那个滚动区；④ 窄屏必须有单列回退；另 ⑤ 被服务的 `markdown.js` 里不许出现 `document.` / `innerHTML`（解析器是纯逻辑，渲染不许塞进它）。反向验证过：把滚动分层的 `body` 改回 `overflow: visible` ⇒ 红（`整页不该滚`）；把正文渲染改成 `body.innerHTML = text` ⇒ 红（`innerHTML 的赋值只该有`）。**2026-09-23 第四轮（面板卸载收口）**：⑪ 两条新判据 —— ① `POST /api/fs/pick/cancel` 真走钩子（`cancelPick` 被调、幂等 200、缺 token 403、**没有 dev 钩子必须 403 而不是 404**：403 = 路由在、被闸挡着；404 才是「路由没接上」，那正是本条要防的）；② **页面接线对拍** —— 页面必须挂 `pagehide` + 用 `sendBeacon`，且路径与服务端 `PICK_CANCEL_PATH` **逐字一致**（页面 import 不到那个常量，不钉就是「页面发了、服务端 404」的静默漏）。为什么必须有它：实测「刷新 / 卸载体」时服务端**收不到 close**（浏览器不关那条连接，`lsof` 上仍 ESTABLISHED）⇒ 只靠断开时选择框留在桌面上、之后每次点都 409。反向验证过三条：摘掉页面的 `pagehide` 接线 ⇒ 红；路径少一个字母 ⇒ 红（逐字对拍）；摘掉服务端那条路由 ⇒ 红；**2026-09-24（选择器返回值透传）**：⑫ 「选完文件夹 → 透传给 run 的就是所选目录」这条链的**两端接线** —— ① **页面接线**：`/api/fs/pick` 的返回值必须写进工作目录控件（`workdirEl.value = body.path`），且 `readControls` 从**控件**取值而不是镜像 `state`（两处各存一份就是「选完不生效」的温床）；② **服务端接线**：把选择器返回的 path 原样喂给 `/run` ⇒ 钩子收到的 `workdir` 就是它（且**不是**回落 `defaultWorkdir`）。为什么必须有它：2026-09-24 真用户反馈「选完之后透传给 agent 的不是所选文件夹」—— 逐环核实后链路是通的（`createApp` 把显式 `providers` 拼在 discover 结果**之后** ⇒ 模板的 `WORKDIR = opts.workdir` 赢；面板 `readControls` 读 DOM 单源），但**当时没有任何守卫钉着这条链**：`scripts/e2e-dev.ts` 第 15-ter 步只覆盖 `POST /run` **直带** workdir，选择器那一跳（返回值 → 控件 → 请求体）全靠人读码 —— 而「抽出来没接上」在浏览器里没人替你发现（与上面 ⑪②、`structure.test.mjs` 的 ⑦ 同一条纪律）。反向验证过**三条**：摘掉页面的 `workdirEl.value = body.path` ⇒ 恰好那条红；摘掉 `parseRunRequest` 的 workdir 转发 ⇒ 红（连带既有那条 `/run` 校验用例一起红 —— 同一行承重）；把 `readControls` 的 `workdirEl.value.trim()` 换成 `state.workdir` ⇒ 恰好那条红
 */
const DIST = fileURLToPath(new URL('../dist/inspector.js', import.meta.url));
let startInspector = null;
let HttpError = null;
/** 面板 `pagehide` beacon 打的那条路径（从产物取，页面自己写的是同一个字面量） */
let PICK_CANCEL_PATH = null;
if (existsSync(DIST)) {
  ({ startInspector, HttpError } = await import(
    new URL('../dist/inspector.js', import.meta.url).href
  ));
  ({ PICK_CANCEL_PATH } = await import(
    new URL('../dist/inspector-routes.js', import.meta.url).href
  ));
}
const SKIP = !startInspector ? '未构建 packages/cli/dist —— 先跑 npm run build:cli' : false;
/* dist 缺失不许静默：本地醒目警告后照旧 skip；CI（build 先于测试）里直接判失败 */
if (SKIP) distReadyOrLoud(DIST, 'CLI 构建产物');

const sample = (id) => ({
  traceId: id,
  status: 'ok',
  totalUsage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  spans: [
    {
      spanId: 'r',
      parentSpanId: null,
      kind: 'run',
      name: 'demo',
      startedAt: 0,
      endedAt: 100,
      status: 'ok',
    },
    {
      spanId: 't',
      parentSpanId: 'r',
      kind: 'llm.turn',
      name: 'm',
      startedAt: 5,
      endedAt: 50,
      status: 'ok',
      usage: { inputTokens: 10, outputTokens: 5 },
      events: [{ time: 6, name: 'tool.input', body: { tool: 'echo', input: { a: 1 } } }],
    },
  ],
});

/**
 * 带 `rootSpanId` 的样本 —— `agentia diff` / `/api/runs/compare` 的**必要条件**。
 *
 * ⚠️ 为什么必须单独一个构造器（而不是给 `sample()` 补上这个字段）：`diffTraces`
 * 找根靠 `spans.find((s) => s.spanId === a.rootSpanId)`，**找不到就整棵 walk 都不走**
 * ⇒ `equal` 恒 `true`、`spans` 恒空。于是「样本缺 rootSpanId」这个形态的表现是
 * **一份看起来正常的「无差异」结论** —— 最坏的假绿类型。测试里所有要比对的样本
 * 都必须走这个函数，让那个形态**没有入口**。
 *
 * `patch` 改 `totalUsage`（差异判据用）：默认 10/5，两条完全一样 ⇒ 恒无差异。
 */
const withRoot = (id, patch = {}) => {
  const t = sample(id);
  t.rootSpanId = 'r';
  t.totalUsage = { ...t.totalUsage, ...patch };
  return t;
};

/** 带会话根的 trace：run 根 span 的 `session.id` 是 D6 那个 join 的键 */
const sampleWithSession = (id, sessionId) => {
  const t = sample(id);
  t.spans[0].attributes = { 'session.id': sessionId };
  return t;
};

const post = (base, path, body) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** 用 node:http 发请求 —— fetch 把 Host / Origin 列为禁改头（会被静默丢掉），伪造不了 */
const raw = (port, { method = 'GET', path = '/', headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    req.end(body);
  });

describe('inspector 服务', () => {
  it('ingest → 列表 → 单条；面板与静态资源可访问', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector();
    try {
      const base = `http://127.0.0.1:${srv.port}`;

      assert.deepEqual(await (await fetch(`${base}/api/runs`)).json(), [], '初始为空');

      assert.equal((await post(base, '/ingest', sample('t1'))).status, 200);

      const list = await (await fetch(`${base}/api/runs`)).json();
      assert.equal(list.length, 1);
      assert.equal(list[0].traceId, 't1');
      assert.equal(list[0].tokens, 15, 'input+output 汇总');
      assert.equal(list[0].ms, 100, 'run 根耗时');
      assert.equal(list[0].ok, true);

      const one = await (await fetch(`${base}/api/runs/t1`)).json();
      assert.equal(one.spans.length, 2, '返回完整 trace');

      assert.match(await (await fetch(`${base}/`)).text(), /Agentia Inspector/);
      assert.match(await (await fetch(`${base}/index.js`)).text(), /playTrace|createTraceView/);
      assert.match(await (await fetch(`${base}/trace-view.css`)).text(), /\.tr-row/);

      assert.equal((await post(base, '/ingest', {})).status, 400, '无 traceId → 400');
      assert.equal((await fetch(`${base}/api/runs/nope`)).status, 404, '未知 run → 404');
    } finally {
      await srv.close();
    }
  });

  it('Host 校验：非本机 Host 一律 403（防 DNS rebinding）', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector();
    try {
      // fetch 规范把 host 列为禁改头（会被静默丢掉），这里用 node:http 才能真的伪造 Host
      const withHost = (host, method = 'GET', path = '/api/runs', body) =>
        new Promise((resolve, reject) => {
          const req = request(
            { host: '127.0.0.1', port: srv.port, method, path, headers: { host } },
            (res) => {
              res.resume();
              res.on('end', () => resolve(res.statusCode));
            },
          );
          req.on('error', reject);
          req.end(body);
        });
      assert.equal(await withHost('evil.example.com'), 403, '外部 Host → 403');
      assert.equal(
        await withHost('10.0.0.9', 'POST', '/ingest', JSON.stringify(sample('h1'))),
        403,
        'ingest 同样被 Host 校验拦住',
      );
      assert.equal(await withHost('localhost'), 200, 'localhost Host 放行');
      assert.equal(await withHost('127.0.0.1:' + srv.port), 200, '带端口的本机 Host 放行');
    } finally {
      await srv.close();
    }
  });

  it('入站校验收紧：spans 非数组 / 缺 startedAt → 400，不进列表', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector();
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const bad1 = { traceId: 'b1', spans: 'nope' };
      assert.equal((await post(base, '/ingest', bad1)).status, 400, 'spans 非数组 → 400');
      const bad2 = {
        traceId: 'b2',
        spans: [{ spanId: 'r', parentSpanId: null, kind: 'run', name: 'x' }],
      };
      const res2 = await post(base, '/ingest', bad2);
      assert.equal(res2.status, 400, '缺 startedAt → 400（否则 ms 是 NaN 并被广播）');
      assert.match((await res2.json()).error, /startedAt/);
      const list = await (await fetch(`${base}/api/runs`)).json();
      assert.equal(list.length, 0, '非法 trace 不入库');
    } finally {
      await srv.close();
    }
  });

  it('面板页面不含 innerHTML 拼接 SSE 数据（s.name 是模型可控内容）', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector();
    try {
      const page = await (await fetch(`http://127.0.0.1:${srv.port}/`)).text();
      assert.ok(!page.includes('liveEl.innerHTML'), 'SSE 分支必须走 textContent，不得拼 innerHTML');
    } finally {
      await srv.close();
    }
  });

  /* 面板卸载时的**显式**收口：`pagehide` + `sendBeacon` 打 `/api/fs/pick/cancel`。
   *
   * 为什么必须有这条路：2026-09-23 实测（带插桩的产物副本 + 真浏览器）—— 刷新页面 / 卸载体
   * 之后那条连接**还开着**（`lsof` 上浏览器侧仍是 ESTABLISHED），服务端**收不到 close**，
   * 于是「在飞的选择框」没人收、之后每次点「系统选择…」都 409。beacon 是**一次新请求**，
   * 与服务端看不看得见断开无关 ⇒ 补上这个漏。
   *
   * 本条钉的是**接线**（页面真的挂上了 pagehide、路径与服务端常量逐字一致）：单测跑不了
   * 浏览器，而「抽出来没接上」在浏览器里没人替你发现（与 ⑦、⑩ 同一条纪律）。 */
  it('面板在 pagehide 时显式通知服务端收掉在飞的选择框（路径与常量逐字对拍）', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector();
    try {
      const page = await (await fetch(`http://127.0.0.1:${srv.port}/`)).text();
      assert.match(
        page,
        /addEventListener\(\s*'pagehide'/,
        '必须挂在 pagehide 上 —— 刷新 / 关标签页 / 跳走都会走它（onbeforeunload 未必）',
      );
      const hit = page.match(/sendBeacon\(\s*'([^']+)'\s*\)/);
      assert.ok(hit, '必须用 sendBeacon —— 卸载途中普通 fetch 会被浏览器掐掉');
      assert.equal(
        hit[1],
        PICK_CANCEL_PATH,
        '页面写的取消路径必须与 PICK_CANCEL_PATH 逐字一致，否则 beacon 静默 404（页面 import 不到那个常量）',
      );
    } finally {
      await srv.close();
    }
  });

  it('环形缓冲：超过上限淘汰最旧，最新的在前', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector();
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      for (let i = 0; i < 55; i++) await post(base, '/ingest', sample('r' + i));
      const list = await (await fetch(`${base}/api/runs`)).json();
      assert.equal(list.length, 50, '上限 50');
      assert.equal(list[0].traceId, 'r54', '最新的在前');
      assert.ok(!list.some((x) => x.traceId === 'r0'), '最旧的已淘汰');
    } finally {
      await srv.close();
    }
  });

  it('SSE /stream：新 run 到达即推一条摘要', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector();
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const res = await fetch(`${base}/stream`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      await post(base, '/ingest', sample('s1'));
      let buf = '';
      const deadline = Date.now() + 3000;
      while (!/s1/.test(buf) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
      assert.match(buf, /"traceId":"s1"/, 'SSE 收到新 run 摘要');
      await reader.cancel();
    } finally {
      await srv.close();
    }
  });

  it('CLI 侧记账：noteRun 后摘要带上目标目录与能力组合（读时合并，不假设到达顺序）', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector();
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      // 先记账、后 ingest —— 两条路都经进程内调用，**顺序不该被假设**（这里刻意反着来）
      srv.noteRun('n1', {
        prompt: 'review 一下',
        workdir: '/w/proj',
        toolSources: ['code-review'],
        multiTurn: false,
      });
      await post(base, '/ingest', sample('n1'));
      const list = await (await fetch(`${base}/api/runs`)).json();
      assert.equal(list[0].note.workdir, '/w/proj', 'run 列表要能显示这次动的哪棵树');
      assert.deepEqual(list[0].note.toolSources, ['code-review']);
      // 没有记账的 run（不是 dev 起的）note 为 null，不是 undefined —— 面板据此不渲染那一行
      await post(base, '/ingest', sample('n2'));
      const list2 = await (await fetch(`${base}/api/runs`)).json();
      assert.equal(list2[0].note, null, '非 dev 起的 run 没有记账');
    } finally {
      await srv.close();
    }
  });

  it('并排 A/B：/api/runs/compare 不被 /api/runs/ 前缀吃掉，且可比性判据随行', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector();
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      srv.noteRun('a1', {
        prompt: '第一版',
        workdir: '/w/proj',
        toolSources: ['code-review'],
        multiTurn: false,
      });
      srv.noteRun('b1', {
        prompt: '第二版',
        workdir: '/w/proj',
        toolSources: ['code-review'],
        multiTurn: false,
      });
      await post(base, '/ingest', withRoot('a1'));
      await post(base, '/ingest', withRoot('b1', { inputTokens: 99 }));

      // ① 路由顺序：这条若被 `/api/runs/` 前缀先吃掉，traceId 会变成
      //    "compare" ⇒ 恒404 且报错是「run 不存在」，完全指错方向。
      //    所以这里**只断言不是 404**（那是顺序错的症状），不只断言 200。
      const res = await fetch(`${base}/api/runs/compare?a=a1&b=b1`);
      assert.notEqual(res.status, 404, 'compare 不该落进 handleRunDetail（路由顺序反了）');
      assert.equal(res.status, 200);
      const body = await res.json();

      // ② diff 真的算出了东西：`withRoot('b1')` 把 inputTokens 改成 99 ⇒ 必须有差异。
      //    ⚠️ 这条同时钉住 `rootSpanId` 那个陷阱：`diffTraces` 靠
      //    `spans.find(s => s.spanId === rootSpanId)` 找根，**找不到就整棵 walk 都不走**
      //    ⇒`equal` 恒 true。没有 `rootSpanId` 的样本会让本断言假绿。
      assert.equal(body.diff.equal, false, 'token 不同 ⇒ 必须报差异');
      assert.ok(body.diff.summary.length > 0, 'run 级 summary 至少一条（totalUsage 差）');

      // ③ 可比性：同能力 + 同目录 ⇒ comparable 且**无提示**（空 message）。
      assert.equal(body.comparability.level, 'comparable');
      assert.equal(body.comparability.message, '', '可比时不显示任何提示（不制造噪声）');

      // ④ note 一起回：面板要显示「这两条当时用了什么能力 / 在哪个目录」。
      assert.equal(body.notes.a.workdir, '/w/proj');
      assert.deepEqual(body.notes.b.toolSources, ['code-review']);
    } finally {
      await srv.close();
    }
  });

  it('并排 A/B：不可比的组合显式降级（跨能力 / 跨目录 / note缺失 / 同一条）', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector();
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      // 跨能力选择（= 跨了进程重启）⇒ capabilities-differ
      srv.noteRun('c1', { prompt: 'p', workdir: '/w/p', toolSources: ['x'], multiTurn: false });
      srv.noteRun('c2', { prompt: 'p', workdir: '/w/p', toolSources: ['y'], multiTurn: false });
      // 同能力、跨目录 ⇒ workdir-differs
      srv.noteRun('c3', { prompt: 'p', workdir: '/w/p', toolSources: null, multiTurn: false });
      srv.noteRun('c4', { prompt: 'p', workdir: '/w/other', toolSources: null, multiTurn: false });
      // 没有 note 的一条（非 dev 起的 run）⇒ 不猜，按不可比处理
      for (const id of ['c1', 'c2', 'c3', 'c4', 'c5']) await post(base, '/ingest', withRoot(id));

      const get = async (a, b) => (await fetch(`${base}/api/runs/compare?a=${a}&b=${b}`)).json();

      const crossCaps = await get('c1', 'c2');
      assert.equal(crossCaps.comparability.level, 'capabilities-differ', '跨能力必须降级');
      assert.match(crossCaps.comparability.message, /能力选择不同/, '提示要说清差在哪');

      // c3/c4 的 `toolSources` 都是 `null`（全量）⇒ 这条同时钉住「全量不该被判成不同」，
      // 否则会先落进 capabilities-differ 而不是这里。
      // ⚠️ 面板侧 `normalizeToolSources` 那个 `undefined` 表示**到不了服务端**
      //（`noteRun` 存的是 `RunNote.toolSources: string[] | null`）⇒ 它的覆盖在
      // `panel-logic.test.mjs` 的 `comparability` 用例里，**不要**在这里写同义重复断言
      //（评审实证：原先那条 `bothFull` 与这条是同一对 run、同一断言，零信息量）。
      const crossDir = await get('c3', 'c4');
      assert.equal(crossDir.comparability.level, 'workdir-differs', '跨目录只是弱可比');
      assert.match(crossDir.comparability.message, /\/w\/other/, '提示里要带上两个目录');

      const noNote = await get('c1', 'c5');
      assert.equal(
        noNote.comparability.level,
        'capabilities-differ',
        'note 缺失不猜 —— 宁可说不可比，也不给一份没上下文的 diff',
      );
      assert.match(noNote.comparability.message, /元信息/);

      // 缺参 / 同一条 / 未知 run
      assert.equal((await fetch(`${base}/api/runs/compare?a=c1`)).status, 400, '缺 b ⇒ 400');
      const same = await fetch(`${base}/api/runs/compare?a=c1&b=c1`);
      assert.equal(same.status, 400, '同一条与自己比 ⇒ 400（否则恒「无差异」）');
      assert.equal((await fetch(`${base}/api/runs/compare?a=c1&b=nope`)).status, 404);
    } finally {
      await srv.close();
    }
  });

  it('会话键：run 根 span 的 session.id 上到摘要（D6 那个 join 的键）', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector();
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      await post(base, '/ingest', sampleWithSession('c1', 'dev'));
      await post(base, '/ingest', sample('c2'));
      const list = await (await fetch(`${base}/api/runs`)).json();
      assert.equal(list.find((r) => r.traceId === 'c1').sessionId, 'dev');
      assert.equal(list.find((r) => r.traceId === 'c2').sessionId, null, '没开会话的 run 为 null');
    } finally {
      await srv.close();
    }
  });
});

/**
 * 鉴权（D0）。两道：`Origin` 校验 + per-session token。
 *
 * ⚠️ 这一组必须**带 token** 起服务 —— 不带 token 的 `startInspector()` 是不校验的
 * （留给测试与程序内自用），而 `agentia dev` 一律带。
 */
describe('inspector 鉴权（Origin + token）', { skip: SKIP }, () => {
  const TOKEN = 'tok-abcdef0123456789';

  it('Origin 校验：跨源一律 403（这正是 CSRF 那半条），本机 origin 与缺省放行', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector({ token: TOKEN });
    try {
      const q = `?t=${TOKEN}`;
      assert.equal(
        (
          await raw(srv.port, {
            path: `/api/runs${q}`,
            headers: { origin: 'https://evil.example' },
          })
        ).status,
        403,
        '跨源 Origin → 403（浏览器跨源 fetch 必带 Origin，这半条挡住了任意网页打本地端口）',
      );
      assert.equal(
        (await raw(srv.port, { path: `/api/runs${q}`, headers: { origin: 'null' } })).status,
        403,
        'Origin: null（sandboxed iframe / file://）是浏览器明说的不可信上下文，必须拒',
      );
      assert.equal(
        (
          await raw(srv.port, {
            path: `/api/runs${q}`,
            headers: { origin: 'http://localhost:5173' },
          })
        ).status,
        200,
        '本机 origin 放行',
      );
      assert.equal(
        (await raw(srv.port, { path: `/api/runs${q}` })).status,
        200,
        '缺省 Origin 放行（同源导航与非浏览器客户端）',
      );
    } finally {
      await srv.close();
    }
  });

  it('token 覆盖**所有**接口：缺 token 一律 403，三种携带方式都认', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector({ token: TOKEN });
    try {
      // 读接口也要挡 —— 本机任意网页同样不该读得到 trace 内容，而校验成本为零
      for (const path of ['/api/runs', '/api/dev', '/', '/index.js']) {
        const r = await raw(srv.port, { path });
        assert.equal(r.status, 403, `${path} 缺 token 应 403`);
        assert.match(r.text, /token/, `${path} 的 403 要说清是缺 token（可诊断，不是干瞪眼）`);
      }
      assert.equal(
        (
          await raw(srv.port, {
            method: 'POST',
            path: '/ingest',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
        403,
        '写接口同样挡',
      );
      // 三种携带方式：URL query（面板首帧）/ 自定义头（脚本、preload）/ cookie（面板后续请求）
      assert.equal((await raw(srv.port, { path: `/api/runs?t=${TOKEN}` })).status, 200, 'query');
      assert.equal(
        (await raw(srv.port, { path: '/api/runs', headers: { 'x-agentia-token': TOKEN } })).status,
        200,
        '自定义头',
      );
      assert.equal(
        (
          await raw(srv.port, {
            path: '/api/runs',
            headers: { cookie: `agentia_dev_token=${TOKEN}` },
          })
        ).status,
        200,
        'cookie',
      );
      assert.equal(
        (await raw(srv.port, { path: '/api/runs?t=wrong-token-value' })).status,
        403,
        '错 token → 403',
      );
    } finally {
      await srv.close();
    }
  });

  it('面板首帧带 ?t= 时种 cookie（token 不进 URL 历史、不进截图）', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector({ token: TOKEN });
    try {
      const page = await raw(srv.port, { path: `/?t=${TOKEN}` });
      assert.equal(page.status, 200);
      const cookie = page.headers['set-cookie']?.[0] ?? '';
      assert.match(cookie, /agentia_dev_token=/);
      assert.match(cookie, /HttpOnly/, 'HttpOnly：面板 JS 读不到它');
      assert.match(cookie, /SameSite=Strict/, 'SameSite=Strict：跨站请求不带');
      // 不带 ?t= 的页面请求（靠 cookie）也放行；不带 cookie 则 403
      assert.equal(
        (await raw(srv.port, { path: '/', headers: { cookie: `agentia_dev_token=${TOKEN}` } }))
          .status,
        200,
      );
      assert.equal((await raw(srv.port, { path: '/' })).status, 403);
      // 不带 token 起服务时不种 cookie（没有可种的）
      const open = await startInspector();
      try {
        const p = await raw(open.port, { path: '/' });
        assert.equal(p.status, 200);
        assert.equal(p.headers['set-cookie'], undefined);
      } finally {
        await open.close();
      }
    } finally {
      await srv.close();
    }
  });

  it('面板逻辑模块可静态取到，且页面 import 的每个名字都真的导出', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector();
    try {
      // 页面必须真的引用它们 —— 否则「抽出来」只是抽了、没接上
      const page = await (await fetch(`http://127.0.0.1:${srv.port}/`)).text();

      // 反向全覆盖：面板 import 的**每个自建模块**（都在 dist 根、都由本仓编译）里，
      // 页面写进 import 列表的每个名字都必须是该模块的真导出。
      // 为什么要钉：浏览器里「import 一个不存在的导出」是**整块模块求值失败** ——
      // 面板直接白屏，而 node 侧的单测照样全绿（它们各自 import 自己要用的名字）。
      for (const file of ['panel-logic.js', 'markdown.js']) {
        const res = await fetch(`http://127.0.0.1:${srv.port}/${file}`);
        assert.equal(res.status, 200, `面板要能静态取到 ${file}`);
        const src = await res.text();
        if (file === 'markdown.js') {
          // Markdown 解析器是**纯逻辑**：它按构造不产生 HTML，也不该碰 DOM。
          // 这条一红就说明有人把渲染塞进了解析器（安全前提的落点，见 src/markdown.ts 头注）。
          assert.doesNotMatch(
            src,
            /innerHTML|outerHTML|document\./,
            'markdown.js 不许出现 DOM / innerHTML —— 它只负责把正文解析成 token 树',
          );
        }
        const mod = await import(new URL(`../dist/${file}`, import.meta.url).href);
        const names = (
          new RegExp(`import \\{([^}]*)\\} from '\\./${file.replace('.', '\\.')}'`).exec(
            page,
          )?.[1] ?? ''
        )
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        assert.ok(names.length > 0, `没解析出页面 import ${file} 的名单（页面结构变了？）`);
        for (const n of names) {
          assert.ok(n in mod, `${file} 必须导出「${n}」—— 页面 import 了它（缺失 = 浏览器白屏）`);
        }
      }

      /* `./index.js`（trace-view）同一口径：页面 import 的四个符号
       * （createTraceView / playTrace / summarizeTrace / renderSummary）必须都是它的真导出。
       * 它在 dist/inspector/ 下（构建期从 packages/trace-view 拷入，零依赖 ESM），
       * 与上面同一做法：直接 import 构建产物、逐个符号点名。 */
      {
        const res = await fetch(`http://127.0.0.1:${srv.port}/index.js`);
        assert.equal(res.status, 200, '面板要能静态取到 index.js（trace-view）');
        const mod = await import(new URL('../dist/inspector/index.js', import.meta.url).href);
        const names = (/import \{([^}]*)\} from '\.\/index\.js'/.exec(page)?.[1] ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        assert.ok(names.length > 0, '没解析出页面 import index.js 的名单（页面结构变了？）');
        for (const n of names) {
          assert.ok(
            n in mod,
            `index.js（trace-view）必须导出「${n}」—— 页面 import 了它（缺失 = 浏览器白屏）`,
          );
        }
      }

      /* 中止语义的**接线**判据（2026-09-22 复核补）：判「这一轮失败了吗」必须走
       * `runIsFailure`，不能裸读 `r.ok`。引擎的 `abortedResult()` 刻意给已取消的 run 带
       * 结构化 error（取消不是失败，但原因要可查）⇒ 中止时 `ok === false`：裸读 ok 的两个
       * 表面会一起说谎 —— run 列表给红点、对话视图给红边「（这一轮失败了…）」，
       * 而同一个 run 的通知条写着「已中止」。上面那条 import 名单检查只保证「名字存在」，
       * 不保证「判断走的是它」，所以这条得单独钉。 */
      assert.match(page, /runIsFailure\(/, '面板必须用 runIsFailure 判「失败」，不能裸读 r.ok');
      assert.doesNotMatch(
        page,
        /'run' \+ \(r\.ok/,
        '面板不该再用 `r.ok` 直接决定红点（中止的 ok 也是 false ⇒ 会标成失败）',
      );

      /* 本轮（2026-09-22 复核 ②③①）三条同类接线判据 —— 都是「抽到 panel-logic 了，
       * 但页面必须真的走它」：抽出来不接上等于没抽（浏览器里没人替你发现）。
       * 单测覆盖 panel-logic 的规则本身，这里只钉接线。 */
      assert.match(
        page,
        /if \(!replyBelongsTo\(/,
        '自动 open() 清回复必须先过 replyBelongsTo —— 无条件清会把 run-done 刚写上去的回复擦掉（实测 17 ms）',
      );
      assert.match(
        page,
        /browseTarget\(/,
        '`浏览…` 必须走 browseTarget（否则又变回「开着时点它只是关掉」）',
      );
      assert.match(
        page,
        /promptAfterFilePick\(/,
        '选文件必须走 promptAfterFilePick（不许悄悄改用户已经写好的 prompt）',
      );
      assert.match(page, /kind === 'trace-event'/, '面板必须处理在飞的增量帧（① 实时右栏）');
      assert.match(
        page,
        /applyTraceEvent\(/,
        '在飞增量帧必须折回（applyTraceEvent），不能各写一套',
      );
      assert.match(
        page,
        /state\.live = null/,
        '收尾那份整棵 trace 到达后必须让在飞的那份作废（否则迟到的帧会把树重画成残缺的一棵）',
      );

      /* 2026-09-22 第二轮（Markdown 渲染 / 滚动分层 / 消息折叠）三条同类接线判据。 */
      assert.match(page, /renderMessage\(/, '模型正文（最终回复 / 助手轮）必须走 renderMessage');
      assert.match(
        page,
        /collapseDecision\(/,
        '折叠判定必须走 collapseDecision（纯逻辑、带单测）—— 不许在渲染层量高度',
      );
      assert.match(page, /md-toggle/, '长正文必须有明确的展开控件（在正文下方，不在行尾悬 caret）');
      assert.match(page, /md-clamped/, '折叠态必须真的把正文卡住');
      // 模型正文**一个字节都不许进 innerHTML**：页面里对 innerHTML 的赋值只该有 renderSummary 那一处
      // （summary.js 自己 escape 了）。这条是安全前提的守卫，比「某个变量名没出现」强。
      const innerHtmlAssigns = page.split('\n').filter((l) => /\.innerHTML\s*=/.test(l));
      assert.equal(
        innerHtmlAssigns.length,
        1,
        `页面里对 innerHTML 的赋值只该有 renderSummary 那一处 —— 实际 ${innerHtmlAssigns.length} 处：${innerHtmlAssigns.join(' | ')}`,
      );
      assert.match(
        innerHtmlAssigns[0],
        /renderSummary\(/,
        '唯一那处 innerHTML 必须是 renderSummary',
      );
      // 滚动分层：**整页不滚**（body 卡住），滚的是树（#trace 自己 overflow: auto）。
      // 内容一长就整页滚的话，「看树」与「读回复」会互相把对方推走。
      const css = page.replace(/\s+/g, ' ');
      assert.match(css, /body \{ overflow: hidden;/, '整页不该滚：body 必须 overflow: hidden');
      assert.match(
        css,
        /#trace \{[^}]*overflow: auto/,
        '#trace 必须是那个滚动区（overflow: auto）',
      );
      assert.match(page, /@media \(max-width: 860px\)/, '窄屏必须有单列回退（否则两栏都不可用）');
    } finally {
      await srv.close();
    }
  });
});

/**
 * dev 环的 HTTP 面（`POST /run` / `GET /api/dev` / `/api/fs` / `/api/session`）。
 * 用假钩子测 —— 本文件不该知道子进程、tsx、runner 的存在。
 */
describe('inspector 的 dev 环接口', { skip: SKIP }, () => {
  const mkDev = (over = {}) => {
    const calls = [];
    /** `POST /ingest-event` 转给钩子的那些增量事件（① 实时右栏） */
    const traceEvents = [];
    const dev = {
      state: () => ({
        available: true,
        projectRoot: '/w/proj',
        home: '/w',
        capabilities: ['a', 'b'],
        multiTurn: ['b'],
        warning: null,
        defaultWorkdir: '/w/proj',
        budget: { maxCostUsd: 1, maxTotalTokens: 200000 },
        running: false,
        lastError: null,
        sessionId: 'dev',
      }),
      run: async (req) => {
        calls.push(req);
        return { accepted: true, restarted: false };
      },
      session: async () => ({ messages: [{ role: 'user', content: 'hi' }] }),
      abort: async () => ({ accepted: true, escalated: false }),
      clearSession: async () => ({ sessionId: 'dev-2' }),
      traceEvent: (e) => traceEvents.push(e),
      ...over,
    };
    return { dev, calls, traceEvents };
  };

  it('没有 dev 钩子时：面板不显示输入条、/run 明确 503、目录浏览关闭', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const srv = await startInspector();
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const state = await (await fetch(`${base}/api/dev`)).json();
      assert.equal(
        state.available,
        false,
        '只读面板：available=false，面板据此隐藏输入条（不做空壳）',
      );
      assert.equal((await post(base, '/run', { prompt: 'x' })).status, 503, '没有 runner ⇒ 503');
      assert.equal(
        (
          await post(base, '/ingest-event', {
            seq: 1,
            type: 'span.event',
            spanId: 's',
            event: { name: 'x' },
          })
        ).status,
        503,
        '增量帧同样要 runner 在场才收（没有面板就没人消费它）',
      );
      assert.equal((await fetch(`${base}/api/fs?path=/tmp`)).status, 403, '只读面板不暴露文件树');
      assert.equal((await (await fetch(`${base}/api/session`)).json()).session, null);
    } finally {
      await srv.close();
    }
  });

  it('POST /run：校验 body，通过后交给钩子（202 + restarted）', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const { dev, calls } = mkDev();
    const srv = await startInspector({ dev });
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      assert.equal((await post(base, '/run', { prompt: '' })).status, 400, '空 prompt → 400');
      assert.equal((await post(base, '/run', { prompt: '  ' })).status, 400, '全空白 prompt → 400');
      assert.equal((await post(base, '/run', { prompt: 'x', toolSources: 'nope' })).status, 400);
      assert.equal((await post(base, '/run', { prompt: 'x', multiTurn: 'yes' })).status, 400);
      assert.equal((await post(base, '/run', { prompt: 'x', workdir: 7 })).status, 400);
      assert.equal((await post(base, '/run', {})).status, 400);
      const ok = await post(base, '/run', {
        prompt: ' review 一下 ',
        workdir: '/w/proj',
        toolSources: ['a'],
        multiTurn: true,
      });
      assert.equal(ok.status, 202, '受理（异步：run 结果经 SSE 回来）');
      assert.deepEqual(await ok.json(), { accepted: true, restarted: false });
      assert.deepEqual(calls, [
        { prompt: ' review 一下 ', workdir: '/w/proj', toolSources: ['a'], multiTurn: true },
      ]);
    } finally {
      await srv.close();
    }
  });

  it('钩子抛错时按其状态码回（409 在飞 / 400 目录不存在 / 500 兜底），不是一律 500', async (t) => {
    if (SKIP) return t.skip(SKIP);
    /* 三个出口各测一遍 —— 这里最容易出的错是「4xx 被吞成 500」：
     * 面板看到 500 会当成「服务器炸了」，而实际只是「你手快点了两下」或「路径写错了」。 */
    const cases = [
      [new HttpError(409, '上一次 run 还在跑'), 409, /还在跑/],
      [new HttpError(400, '工作目录不存在或不是文件夹：/nope'), 400, /工作目录不存在/],
      // 兜底：不带状态码的普通错误必须是 500 —— 不能把内部错误伪装成「你输错了」
      [new Error('炸了'), 500, /炸了/],
    ];
    for (const [err, status, re] of cases) {
      const { dev } = mkDev({
        run: async () => {
          throw err;
        },
      });
      const srv = await startInspector({ dev });
      try {
        const res = await post(`http://127.0.0.1:${srv.port}`, '/run', { prompt: 'x' });
        assert.equal(res.status, status, `${err.message} → ${status}`);
        assert.match((await res.json()).error, re);
      } finally {
        await srv.close();
      }
    }
  });

  it('/api/fs：目录 / 隐藏目录 / 文件分三类列，且不存在与「不是目录」都响亮报错', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const { dev } = mkDev();
    const srv = await startInspector({ dev });
    const dir = mkdtempSync(join(tmpdir(), 'agentia-fs-'));
    try {
      mkdirSync(join(dir, 'sub'), { recursive: true });
      mkdirSync(join(dir, '.hidden'), { recursive: true });
      writeFileSync(join(dir, 'file.txt'), 'x');
      const base = `http://127.0.0.1:${srv.port}`;
      const ok = await (await fetch(`${base}/api/fs?path=${encodeURIComponent(dir)}`)).json();
      assert.deepEqual(ok.dirs, ['sub'], '普通目录');
      assert.deepEqual(
        ok.dotDirs,
        ['.hidden'],
        '隐藏目录**单列**而不是过滤掉 —— 旧实现整批跳过，于是 ~/x/.y 这类目录根本点不进去',
      );
      assert.deepEqual(ok.files, ['file.txt'], '文件也要列（面板据此提供「选这个文件」）');
      assert.equal(ok.filesTruncated, false);
      assert.equal(ok.path, dir);
      assert.equal(ok.parent, dirname(dir));
      assert.equal(
        (await fetch(`${base}/api/fs?path=${encodeURIComponent(dir + '/file.txt')}`)).status,
        400,
        '「不是文件夹」要响亮报错（工作目录只能是目录）',
      );
      assert.equal(
        (await fetch(`${base}/api/fs?path=${encodeURIComponent(dir + '/nope')}`)).status,
        400,
        '不存在的目录要响亮报错 —— 静默回退会让 agent 对着错的目录乱写（D5）',
      );
      assert.equal((await fetch(`${base}/api/fs`)).status, 400, '缺 path → 400');
    } finally {
      await srv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('POST /ingest-event：校验形状、转给钩子并广播（① 实时右栏）', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const { dev, traceEvents } = mkDev();
    const srv = await startInspector({ dev });
    // `dev.ts` 的钩子干的是「记一笔 + `emitDev({kind:'trace-event'})` 广播」；这里补上后半
    // （单测用的是假钩子，它自己不会广播）。**真实的那条**（runner → HTTP → 父进程 → SSE）
    // 由 e2e-dev 第 7-bis 步守 —— 这里只保证「/ingest-event 把帧交给了钩子」。
    dev.traceEvent = (e) => {
      traceEvents.push(e);
      srv.emitDev({ kind: 'trace-event', event: e });
    };
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const begin = {
        seq: 1,
        type: 'span.begin',
        span: {
          spanId: 'r',
          traceId: 'tr-1',
          parentSpanId: null,
          kind: 'run',
          name: 'demo',
          startedAt: 0,
          status: 'ok',
          attributes: {},
          events: [],
        },
      };
      // 先连上 SSE，才能断言「广播出去了」而不只是「钩子被调了」
      const ac = new AbortController();
      const stream = await fetch(`${base}/stream`, { signal: ac.signal });
      const reader = stream.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const frames = [];
      const pump = (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buf += dec.decode(value, { stream: true });
          let cut = buf.indexOf('\n\n');
          while (cut >= 0) {
            frames.push(buf.slice(0, cut));
            buf = buf.slice(cut + 2);
            cut = buf.indexOf('\n\n');
          }
        }
      })();
      const waitFrame = async (needle, ms = 3000) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if (frames.some((f) => f.includes(needle))) return true;
          await new Promise((r) => setTimeout(r, 25));
        }
        return false;
      };

      assert.equal((await post(base, '/ingest-event', begin)).status, 202, '合法帧 → 202');
      assert.equal(traceEvents.length, 1, '帧应转给 dev 钩子（父进程只转发、不解释）');
      assert.ok(
        await waitFrame('"kind":"trace-event"'),
        `增量帧必须走 SSE 的 dev 命名事件广播给面板。收到的帧：${JSON.stringify(frames)}`,
      );

      // 坏帧一律 400：面板拿这些字段**直接建树**，缺字段的表现是「树上少一个节点」
      // 而不是任何报错 —— 那种症状只能在浏览器里查，所以入口就要拦住
      assert.equal((await post(base, '/ingest-event', { seq: 1 })).status, 400, '不认识的事件类型');
      assert.equal(
        (
          await post(base, '/ingest-event', {
            type: 'span.end',
            spanId: 'x',
            endedAt: 1,
            status: 'ok',
          })
        ).status,
        400,
        '缺 seq',
      );
      assert.equal(
        (
          await post(base, '/ingest-event', {
            seq: 2,
            type: 'span.end',
            spanId: 'x',
            endedAt: 0 / 0,
            status: 'ok',
          })
        ).status,
        400,
        'endedAt 是 NaN',
      );
      assert.equal(
        (await post(base, '/ingest-event', { seq: 3, type: 'span.begin', span: { spanId: 's' } }))
          .status,
        400,
        'span.begin 缺 traceId / name / startedAt',
      );
      assert.equal(
        (await post(base, '/ingest-event', { seq: 4, type: 'span.event', spanId: 's' })).status,
        400,
      );
      const res = await raw(srv.port, {
        method: 'POST',
        path: '/ingest-event',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      });
      assert.equal(res.status, 400, 'body 不是 JSON → 400');
      assert.equal(traceEvents.length, 1, '坏帧一个都不该转给钩子');
      ac.abort();
      await pump.catch(() => {});
    } finally {
      await srv.close();
    }
  });

  it('/api/session 透传钩子结果；钩子抛错按其状态码回', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const { dev } = mkDev();
    const srv = await startInspector({ dev });
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const body = await (await fetch(`${base}/api/session`)).json();
      assert.equal(body.session.messages.length, 1);
    } finally {
      await srv.close();
    }
    const { dev: bad } = mkDev({
      session: async () => {
        const e = new Error('会话文件不是合法 JSON');
        e.statusCode = 500;
        throw e;
      },
    });
    const srv2 = await startInspector({ dev: bad });
    try {
      const res = await fetch(`http://127.0.0.1:${srv2.port}/api/session`);
      assert.equal(res.status, 500);
      assert.match((await res.json()).error, /不是合法 JSON/);
    } finally {
      await srv2.close();
    }
  });

  it('SSE 的 dev 命名事件与 run 摘要（默认事件）互不干扰', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const { dev } = mkDev();
    const srv = await startInspector({ dev });
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const res = await fetch(`${base}/stream`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      srv.emitDev({ kind: 'runner-restart', reason: '文件变更：src/app.ts' });
      await post(base, '/ingest', sample('s9'));
      let buf = '';
      const deadline = Date.now() + 3000;
      while (
        !(buf.includes('event: dev') && buf.includes('"traceId":"s9"')) &&
        Date.now() < deadline
      ) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
      assert.match(buf, /event: dev\ndata: \{"kind":"runner-restart"/, 'dev 事件带事件名');
      assert.match(buf, /"traceId":"s9"/, 'run 摘要仍走默认事件（老面板的 onmessage 照常工作）');
      await reader.cancel();
    } finally {
      await srv.close();
    }
  });

  /* §6 待定 5 的 kill 按钮（中止在飞 run）。三条要守：
   * ① 没有 dev 环 ⇒ 503（与 /run 同一口径，不假装成功）
   * ② 没有在飞 run ⇒ 钩子的 409 原样回（面板据此提示「当前没有在飞的 run」）
   * ③ 方法不对 ⇒ 404，**绝不落到钩子上**（GET 也能中止 run 就太吓人了） */
  it('POST /run/abort：503 / 409 / 202；且方法不对不落钩子', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const noDev = await startInspector();
    try {
      const res = await post(`http://127.0.0.1:${noDev.port}`, '/run/abort', {});
      assert.equal(res.status, 503, '只读面板没有 runner ⇒ 503');
    } finally {
      await noDev.close();
    }

    const { dev } = mkDev({
      abort: async () => {
        const e = new Error('当前没有在飞的 run');
        e.statusCode = 409;
        throw e;
      },
    });
    const srv = await startInspector({ dev });
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const busy = await post(base, '/run/abort', {});
      assert.equal(busy.status, 409, '没在飞 run ⇒ 钩子的 409 原样回');
      assert.match((await busy.json()).error, /没有在飞的 run/);
      assert.equal(
        (await fetch(`${base}/run/abort`)).status,
        404,
        'GET 不落钩子（方法不对就是没这个路由）',
      );
    } finally {
      await srv.close();
    }

    // 优雅中止（escalated=false）与升级重启（escalated=true）都是 202 —— 区别在响应体，
    // 面板据此说「trace 保得住」还是「trace 丢了」
    for (const escalated of [false, true]) {
      const { dev: d } = mkDev({ abort: async () => ({ accepted: true, escalated }) });
      const s = await startInspector({ dev: d });
      try {
        const res = await post(`http://127.0.0.1:${s.port}`, '/run/abort', {});
        assert.equal(res.status, 202, '中止是「已受理」：run 真正收尾要走 SSE 的 run-done');
        assert.deepEqual(await res.json(), { accepted: true, escalated });
      } finally {
        await s.close();
      }
    }
  });

  /* §6 待定 3 的「清空对话」。清空 = **换 sessionId**，不动 session.json
   * （那是 store 的账，面板对它只读）—— 所以这里只断言「返回新 id」，不假设旧对话被删。 */
  it('POST /session/clear：503 / 409 / 200 + 新 sessionId', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const noDev = await startInspector();
    try {
      const res = await post(`http://127.0.0.1:${noDev.port}`, '/session/clear', {});
      assert.equal(res.status, 503);
    } finally {
      await noDev.close();
    }

    const { dev } = mkDev({
      clearSession: async () => {
        const e = new Error('有 run 在飞时不能清空对话（它会写回当前会话）');
        e.statusCode = 409;
        throw e;
      },
    });
    const srv = await startInspector({ dev });
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const res = await post(base, '/session/clear', {});
      assert.equal(res.status, 409, '在飞时不许清空 —— 否则 run 会写回一份模型没见过的会话');
      assert.match((await res.json()).error, /不能清空对话/);
    } finally {
      await srv.close();
    }

    const { dev: ok } = mkDev({ clearSession: async () => ({ sessionId: 'dev-7' }) });
    const s2 = await startInspector({ dev: ok });
    try {
      const res = await post(`http://127.0.0.1:${s2.port}`, '/session/clear', {});
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { sessionId: 'dev-7' });
    } finally {
      await s2.close();
    }
  });

  /* 原生目录选择器（POST /api/fs/pick）：面板侧只认这份契约 ——
   * 200 {path} 选了 / 200 {path:null} 取消 / 409 已有一个在等 / 500 其它失败，
   * 鉴权与其它接口同一条缝（cookie/query/header 任一）。服务端由 dev 钩子
   * `pickFolder` 提供（另一批改动并行接入中）：还没接上（404）时形状断言跳过，
   * 接上之后自动开始守；缺 token ⇒ 403 那条与路由是否接上无关，始终断言。 */
  it('POST /api/fs/pick：走 dev 钩子；缺 token 403；路径 / 取消 / 冲突 / 失败四种形状', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const TOKEN = 'tok-picker';
    const mk = (pickFolder) => {
      const { dev } = mkDev({ pickFolder });
      return startInspector({ dev, token: TOKEN });
    };
    const call = (srv, authed) =>
      post(`http://127.0.0.1:${srv.port}`, `/api/fs/pick${authed ? `?t=${TOKEN}` : ''}`, {});

    const srv = await mk(async () => '/picked/dir');
    try {
      assert.equal((await call(srv)).status, 403, '缺 token → 403（与其它接口同一条缝）');
      const probe = await call(srv, true);
      if (probe.status === 404) {
        return t.skip('服务端 /api/fs/pick 还没接上（并行开发）—— 接上后本用例自动生效');
      }
      assert.equal(probe.status, 200);
      assert.deepEqual(await probe.json(), { path: '/picked/dir' }, '选了目录 ⇒ 200 { path }');
    } finally {
      await srv.close();
    }

    const srvNull = await mk(async () => null);
    try {
      const res = await call(srvNull, true);
      assert.equal(res.status, 200, '取消也是 200（不是错误）');
      assert.deepEqual(await res.json(), { path: null }, '取消 ⇒ { path: null }');
    } finally {
      await srvNull.close();
    }

    const srvBusy = await mk(async () => {
      throw new HttpError(409, '已有一个系统选择框在等');
    });
    try {
      const res = await call(srvBusy, true);
      assert.equal(res.status, 409, '钩子的 409 原样回（面板据此提示重重点击）');
      assert.match((await res.json()).error, /在等/);
    } finally {
      await srvBusy.close();
    }

    const srvBad = await mk(async () => {
      throw new Error('系统对话框炸了');
    });
    try {
      const res = await call(srvBad, true);
      assert.equal(res.status, 500, '不带状态码的错误兜底 500（不伪装成 4xx）');
      assert.match((await res.json()).error, /炸了/);
    } finally {
      await srvBad.close();
    }
  });

  /* 客户端断开出口：等待系统选择框期间刷新 / 关标签页 ⇒ 路由必须通知钩子收掉
   * 在飞的选择框。缺了这条：桌面上的对话框没人看、钩子里的「在飞」标志永远不落，
   * 之后每次点「系统选择…」都 409 —— 症状像「功能坏了」，与「面板锁死」同族。 */
  it('POST /api/fs/pick：客户端断开 ⇒ cancelPick 被调，且后续请求不再 409', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const TOKEN = 'tok-picker-drop';
    let cancelled = 0;
    let calls = 0;
    let resolveFirst;
    const { dev } = mkDev({
      // 第一次调用挂住（用户还没选）；取消后才 settle。之后直接给结果（证明不再 409）
      pickFolder: () => {
        calls++;
        return calls === 1
          ? new Promise((r) => {
              resolveFirst = r;
            })
          : Promise.resolve('/next/dir');
      },
      cancelPick: () => {
        cancelled++;
        resolveFirst?.(null);
      },
    });
    const srv = await startInspector({ dev, token: TOKEN });
    try {
      // 裸 socket 发了就毁 —— 「刷新 / 关标签页」是底层连接没了；fetch 的 abort()
      // 走的是受控关闭，不是同一个事件面。
      await new Promise((resolve) => {
        const req = request({
          host: '127.0.0.1',
          port: srv.port,
          path: `/api/fs/pick?t=${TOKEN}`,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        });
        req.on('error', () => resolve()); // 对端 RST 也算「断了」
        req.end('{}', () => {
          req.destroy();
          resolve();
        });
      });
      const deadline = Date.now() + 3_000;
      while (cancelled === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(cancelled, 1, '客户端断开必须通知 cancelPick —— 否则选择框挂在桌面上没人收');
      const again = await post(`http://127.0.0.1:${srv.port}`, `/api/fs/pick?t=${TOKEN}`, {});
      assert.equal(again.status, 200, '取消之后再来一次不该 409（在飞标志要落下来）');
      assert.deepEqual(await again.json(), { path: '/next/dir' });
    } finally {
      await srv.close();
    }
  });

  /* 面板卸载的**显式**收口（`pagehide` beacon）。与上一条**互补**，不是重复：
   *   上一条守「连接真的断了」（浏览器进程没了 / 非浏览器客户端断开）；
   *   这一条守「连接没断、但页面走了」—— 刷新就是这个形态，而它此前**漏得掉**。 */
  it('POST /api/fs/pick/cancel：面板卸载的显式通知 ⇒ 钩子被调、幂等、无钩子时 403（不是 404）', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const TOKEN = 'tok-picker-cancel';
    let cancelled = 0;
    const { dev } = mkDev({
      cancelPick: () => {
        cancelled++;
      },
    });
    const srv = await startInspector({ dev, token: TOKEN });
    try {
      const call = (authed) =>
        post(
          `http://127.0.0.1:${srv.port}`,
          `${PICK_CANCEL_PATH}${authed ? `?t=${TOKEN}` : ''}`,
          {},
        );

      assert.equal((await call(false)).status, 403, '缺 token → 403（与其它接口同一条缝）');

      const res = await call(true);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { cancelled: true });
      assert.equal(cancelled, 1, 'beacon 必须真把钩子叫起来 —— 否则「刷新时收掉」是句空话');

      // 面板**无条件**发它（不在飞时服务端是空操作）⇒ 第二次也必须 200 且再叫一次钩子，
      // 不许变成 409/500（那会让「刷新」这条路时灵时不灵）
      assert.equal((await call(true)).status, 200, '幂等：不在飞也该是 200');
      assert.equal(cancelled, 2, '无条件发送是设计（服务端幂等），第二次同样要叫钩子');
    } finally {
      await srv.close();
    }

    // 没有 dev 钩子（静态起的 inspector）⇒ 必须 **403 而不是 404**：
    // 403 = 「路由在、被闸挡着」；404 才是「路由没接上」—— 后者正是本条要防的。
    const srv2 = await startInspector();
    try {
      const res = await post(`http://127.0.0.1:${srv2.port}`, PICK_CANCEL_PATH, {});
      assert.equal(res.status, 403, '没有 dev 钩子必须是 403（路由存在、闸生效）');
    } finally {
      await srv2.close();
    }
  });

  /* 「选完文件夹 → 透传给 run 的就是所选目录」这条链的两端**接线**。
   *
   * 为什么要有这条：2026-09-24 真用户反馈「选完之后透传给 agent 的不是所选文件夹」。
   * 逐环核实后链路是通的（`docs/guards.md` §2 那条 2026-09-24 的记录），但**当时没有任何
   * 守卫钉着这条链**：e2e 第 15-ter 步只覆盖 `POST /run` **直带** workdir，选择器那一跳
   * （返回值 → 控件 → 请求体）全靠人读码 —— 而「抽出来没接上」在浏览器里没人替你发现
   * （与上面 pagehide 那条、structure.test.mjs 的 ⑦ 同一条纪律）。
   *
   * 本条钉两个端点，都不需要浏览器 / 原生对话框：
   *   ① 页面接线：`/api/fs/pick` 的返回值必须写进工作目录控件，且 readControls 读的是**控件**
   *      （不是另一份镜像 state —— 两处各存一份就是「选完不生效」的温床）；
   *   ② 服务端接线：把 ① 拿到的 path **原样**喂给 /run ⇒ 钩子收到的 workdir 就是它。
   * 两端合起来 = 「选择器返回什么，run 就用什么」。再往下的「工具真正看到的根」由
   * `scripts/e2e-dev.ts` 第 15-ter 步守着（真跑，判据落在模型请求体里的 tool_result）。 */
  it('选完文件夹 → 透传给 run 的就是所选目录（选择器返回值 / 控件 / /run 三处接线）', async (t) => {
    if (SKIP) return t.skip(SKIP);
    const TOKEN = 'tok-picker-wire';
    const PICKED = '/picked/from/native';
    const { dev, calls } = mkDev({ pickFolder: async () => PICKED });
    const srv = await startInspector({ dev, token: TOKEN });
    try {
      const base = `http://127.0.0.1:${srv.port}`;

      // ① 页面接线（读下发到浏览器的页面文本，与 pagehide 那条同一手法）
      const page = await (await fetch(`${base}/?t=${TOKEN}`)).text();
      assert.match(
        page,
        /workdirEl\.value\s*=\s*body\.path/,
        'pick 成功分支必须把 /api/fs/pick 返回的 path 写进工作目录控件 —— 少了这行，' +
          '选择器选完什么都不会进 /run，而服务端单测与 e2e 全都照样绿',
      );
      assert.match(
        page,
        /workdir:\s*workdirEl\.value\.trim\(\)/,
        'readControls 必须从控件取值（不是另一份镜像 state）—— 两处各存一份就是「选完不生效」的温床',
      );

      // ② 服务端接线：选择器返回的 path 原样喂给 /run ⇒ 钩子收到的 workdir 就是它
      const picked = await post(base, `/api/fs/pick?t=${TOKEN}`, {});
      assert.equal(picked.status, 200, `选择器应 200，实际 ${picked.status}`);
      const { path } = await picked.json();
      assert.equal(path, PICKED, '选择器返回的就是它给的那个目录');

      const run = await post(base, `/run?t=${TOKEN}`, {
        prompt: 'x',
        workdir: path,
        toolSources: ['a'],
      });
      assert.equal(run.status, 202, `带 workdir 的 /run 应 202，实际 ${run.status}`);
      assert.equal(
        calls.at(-1)?.workdir,
        PICKED,
        '把选择器返回值原样喂给 /run ⇒ 钩子必须收到同一个目录（且**不是**回落到 defaultWorkdir：' +
          `这里 defaultWorkdir 是 /w/proj，收到它就说明 workdir 被丢了）。实际 ${JSON.stringify(calls.at(-1))}`,
      );
    } finally {
      await srv.close();
    }
  });
});
