import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distReadyOrLoud } from './dist-guard.mjs';

/* 对构建产物测试（未构建时跳过而非报错）。 */
const DIST = fileURLToPath(new URL('../dist/panel-logic.js', import.meta.url));
let L = null;
if (existsSync(DIST)) L = await import(new URL('../dist/panel-logic.js', import.meta.url).href);
const SKIP = !L ? '未构建 packages/cli/dist —— 先跑 npm run build:cli' : false;
/* dist 缺失不许静默：本地醒目警告后照旧 skip；CI（build 先于测试）里直接判失败 */
if (SKIP) distReadyOrLoud(DIST, 'CLI 构建产物');

/**
 * 反复写、直到回调真的来。
 *
 * 为什么不是「写一次、等满 15 秒」：真 fs 的监视器**建立是异步的**（`fs.watch` 返回 ≠
 * 底下的 FSEvents 流已经开始投递），`watchTree()` 一返回就写的那**一次**可能整个漏掉 ——
 * 那时等多久都没用。2026-09-22 实测：同一份套件，**stdout 被管道捕获**时（`verify-all.sh`
 * 与 CI 都这么跑）这一条等满 15s 稳定红，stdout 写文件时稳定绿 ⇒ 这是**夹具的竞态**，
 * 不是产品缺陷（生产里 dev 环**先建立监视、再对外服务**）。
 *
 * ⚠️ 断言没放宽：那个路径**必须**触发一次回调 —— 只是不再要求「第一次写就被看到」。
 */
async function writeUntilSeen(seen, write, deadlineMs = 15_000) {
  const deadline = Date.now() + deadlineMs;
  do {
    write();
    if (seen.length > 0) return;
    await new Promise((r) => setTimeout(r, 300));
  } while (Date.now() < deadline);
}

describe('面板纯逻辑（无 DOM，可在 Node 里直接测）', { skip: SKIP }, () => {
  it('能力多选 → toolSources：全选传 undefined，其余按字典序（可复现）', () => {
    const all = ['b', 'a', 'c'];
    // 全选 ⇒ undefined：与「不传即全量」同义，且省掉一次白跑的孤儿能力告警
    assert.equal(L.normalizeToolSources(['a', 'b', 'c'], all), undefined, '全选应传 undefined');
    assert.equal(L.normalizeToolSources(['c', 'a', 'b'], all), undefined, '顺序无关，仍是全选');
    // 收窄 ⇒ 固定顺序（字典序），**不是点击顺序** —— 否则同一组能力两次跑出不同菜单序
    assert.deepEqual(L.normalizeToolSources(['c', 'a'], all), ['a', 'c'], '收窄应按字典序');
    assert.deepEqual(
      L.normalizeToolSources(['c', 'a'], all),
      L.normalizeToolSources(['a', 'c'], all),
    );
    // 空集也当全量：toolSources: [] 会收窄到**空菜单**（每个 provider 都成孤儿），是纯陷阱值
    assert.equal(L.normalizeToolSources([], all), undefined, '空选应兜成全量，绝不传空数组');
    // 不认识的名字静默丢弃（能力被删了 / 面板缓存旧了），但结果里就没有它了
    assert.deepEqual(L.normalizeToolSources(['a', 'gone'], all), ['a'], '未知 token 应丢弃');
    assert.equal(L.normalizeToolSources(['gone'], all), undefined, '全是未知 token ⇒ 退化成全量');
  });

  it('「已选/总数」计数：全量时显示 N/N（一眼看出这次是全量还是收窄）', () => {
    assert.equal(L.capabilityBadge(['a', 'b'], ['a', 'b']), '2/2');
    assert.equal(L.capabilityBadge(['a'], ['a', 'b', 'c']), '1/3');
  });

  it('徽标不许说谎：渲染前过滤失效 token（filterSelected）', () => {
    // runner 重启后菜单变了、state.selected 里残留旧 token ⇒ 不过滤徽标就是「4/3」
    const all = ['a', 'b', 'c'];
    assert.deepEqual(L.filterSelected(['a', 'gone', 'b'], all), ['a', 'b'], '失效 token 应被丢掉');
    assert.equal(
      L.capabilityBadge(L.filterSelected(['a', 'b', 'gone', 'gone2'], all), all),
      '2/3',
      '过滤后的计数才配得上分母（不混进菜单上已不存在的名字）',
    );
    assert.deepEqual(
      L.filterSelected(['gone'], all),
      [],
      '全是失效 token ⇒ 空（面板据此回落全选）',
    );
    assert.deepEqual(L.filterSelected([], all), []);
    assert.deepEqual(L.filterSelected(['a', 'a'], all), ['a'], '顺手去重');
  });

  it('「已选来源」显示口径：null = 全量（formatToolSources，两处共用一份）', () => {
    assert.equal(L.formatToolSources(null), '全量');
    assert.equal(L.formatToolSources(['a', 'b']), 'a,b');
    assert.equal(L.formatToolSources([]), '', '空数组不是全量（全量由 null 表示）');
  });

  it('多轮默认值 = 所选能力声明的 OR，并给出**来源**（混选时默认值有歧义）', () => {
    const declared = ['trip-planner'];
    // 只选任务型 ⇒ 单轮
    assert.deepEqual(L.multiTurnDefault(['code-review'], declared), { value: false, sources: [] });
    // 只选对话型 ⇒ 多轮，来源就是它
    assert.deepEqual(L.multiTurnDefault(['trip-planner'], declared), {
      value: true,
      sources: ['trip-planner'],
    });
    // 混选 ⇒ **OR**（只要有一个声明多轮就默认多轮），且来源标出来 —— 不让你面对「为什么这次带了上下文」的谜
    assert.deepEqual(L.multiTurnDefault(['code-review', 'trip-planner'], declared), {
      value: true,
      sources: ['trip-planner'],
    });
    // 没选到任何声明多轮的 ⇒ 单轮（任务型是安全默认，不会串味）
    assert.deepEqual(L.multiTurnDefault([], declared), { value: false, sources: [] });
  });

  it('多轮开关文案必须说清「几轮」与「为什么」', () => {
    assert.equal(L.multiTurnLabel(true, ['trip-planner'], true), '多轮·trip-planner');
    assert.equal(L.multiTurnLabel(true, [], true), '多轮');
    assert.equal(L.multiTurnLabel(true, [], false), '多轮（手动开）');
    assert.equal(L.multiTurnLabel(false, [], true), '单轮');
    // 覆盖默认时要说明被覆盖的是谁 —— 否则「我明明声明了多轮，怎么这次是单轮」无从查起
    assert.match(L.multiTurnLabel(false, ['trip-planner'], false), /覆盖默认.*trip-planner/);
  });

  it('prompt 回显（乙）：连续重复不入栈、空白丢弃、超上限截断', () => {
    let h = [];
    h = L.pushPromptHistory(h, '帮我 review 一下代码');
    assert.deepEqual(h, ['帮我 review 一下代码']);
    // 与 shell 的 HISTCONTROL=ignoredups 同口径：只与栈顶比
    h = L.pushPromptHistory(h, '帮我 review 一下代码');
    assert.deepEqual(h, ['帮我 review 一下代码'], '连续重复不该占两格');
    h = L.pushPromptHistory(h, '   ');
    assert.deepEqual(h, ['帮我 review 一下代码'], '空白串直接丢弃');
    h = L.pushPromptHistory(h, '换个文件夹再看');
    assert.deepEqual(h, ['帮我 review 一下代码', '换个文件夹再看']);
    // 上限截断（保留最近的）
    // 注意：不能写成 `.reduce(L.pushPromptHistory, [])` —— reduce 会把**下标**当第三个实参
    // 传进去，正好落在 limit 上，于是「上限」变成了 0..59 的滑动值。包一层箭头函数。
    const long = Array.from({ length: 60 }, (_, i) => `p${i}`).reduce(
      (acc, p) => L.pushPromptHistory(acc, p),
      [],
    );
    assert.equal(long.length, L.PROMPT_HISTORY_LIMIT);
    assert.equal(long[long.length - 1], 'p59', '截断必须保留最近的');
  });

  it('↑/↓ 游标：不绕回（按过头不该把人送回一个没想到的位置）', () => {
    const h = ['a', 'b', 'c'];
    // cursor: -1 = 草稿，0 = 最新，n-1 = 最旧
    assert.equal(L.historyStep(h, L.HISTORY_DRAFT, 'older'), 0, '↑ 从草稿到最新一条');
    assert.equal(L.historyStep(h, 0, 'older'), 1);
    assert.equal(L.historyStep(h, 1, 'older'), 2);
    assert.equal(L.historyStep(h, 2, 'older'), 2, '到最旧就夹住，不绕回');
    assert.equal(L.historyStep(h, 2, 'newer'), 1);
    assert.equal(L.historyStep(h, 0, 'newer'), L.HISTORY_DRAFT, '↓ 回到草稿');
    assert.equal(L.historyStep(h, L.HISTORY_DRAFT, 'newer'), L.HISTORY_DRAFT, '草稿位再 ↓ 不动');
    assert.equal(L.historyStep([], L.HISTORY_DRAFT, 'older'), L.HISTORY_DRAFT, '没有历史时不动');
    // 文本取值：草稿位返回草稿本身（按 ↓ 回到你还没发出去的那句）
    assert.equal(L.historyText(h, 0, 'draft'), 'c');
    assert.equal(L.historyText(h, 2, 'draft'), 'a');
    assert.equal(L.historyText(h, L.HISTORY_DRAFT, 'draft'), 'draft');
  });

  it('对话流 = 会话文件的消息 ∪ 失败 run（D6 的 join，键是 session.id）', () => {
    /** run 的**生产形状**：prompt 在 `note` 里（`/api/runs` 的每一项就是 RunSummary）。
     *  这条 fixture 本身曾经是 bug 的一半 —— 早先它写顶层 `prompt`，而生产从来没有那个键，
     *  于是 join 恒对不上、失败轮一轮都显示不出来，单测却一直是绿的。 */
    const run = (traceId, ok, sessionId, prompt) => ({
      traceId,
      ok,
      sessionId,
      note: prompt === null ? null : { prompt, workdir: '/w', toolSources: null, multiTurn: false },
    });
    const messages = [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '第二问' },
      { role: 'assistant', content: [{ type: 'text', text: '第二答' }] },
    ];
    const runs = [
      // 成功的 run：已经在会话文件里了，不该被重复追加
      run('t1', true, 'dev', '第一问'),
      // 失败的 run：`runtime/run.ts` 只在成功轮次回写 session ⇒ 它在会话文件里**根本不存在**，
      // 靠 run 列表 join 出来。少了这一步就是「显示一份**少了**一轮的对话」。
      run('t2', false, 'dev', '第三问（失败了）'),
      // 别的 session：不掺进来
      run('t3', false, 'other', '别人的失败'),
      // 没开会话的 run（sessionId 为 null）：也不掺进来
      run('t4', false, null, '没开会话的失败'),
      // 记账丢了（note 为 null，trace 落盘后重启面板就会这样）：**不猜**，跳过
      run('t5', false, 'dev', null),
    ];
    const turns = L.mergeConversation(messages, runs, 'dev');
    assert.equal(turns.length, 3, `轮数=${turns.length}`);
    assert.equal(turns[0].user, '第一问');
    assert.equal(turns[0].assistant, '第一答');
    assert.equal(turns[0].failed, false);
    assert.equal(turns[1].assistant, '第二答', 'content block 数组也要能取文本');
    assert.equal(turns[2].user, '第三问（失败了）');
    assert.equal(turns[2].assistant, null);
    assert.equal(turns[2].failed, true, '失败轮必须标失败，不假装那轮没发生');
    assert.equal(turns[2].traceId, 't2', '失败轮要能指回它的 run');
  });

  it('中止轮：**也 join 进来**，但不算失败（aborted 的 ok 同样是 false）', () => {
    /* 2026-09-22 复核补的。引擎的 `abortedResult()` 刻意给已取消的 run 带结构化 error
     * （取消不是失败，但原因要可查）⇒ `ok === false`。而上面的 join 原本只看 `ok`
     * ⇒ 被中止的那轮在对话视图里被标红「（这一轮失败了…）」，同一个 run 的通知条却写着
     * 「已中止」—— 同一件事在两个表面上说法相反。
     * 但它**不能**被排除掉：框架只在成功路径回写会话 ⇒ 被中止的轮在会话文件里同样不存在，
     * 排除它等于显示一份**少了一轮**的对话（另一种静默不一致，且更难发现）。 */
    const messages = [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
    ];
    const runs = [
      // 形状是生产的 `/api/runs` 项：prompt 在 note 里（见上一条用例的 `run()` 说明）
      {
        traceId: 't1',
        ok: false,
        stopReason: 'aborted',
        sessionId: 'dev',
        note: { prompt: '被中止的问题' },
      },
      {
        traceId: 't2',
        ok: false,
        stopReason: 'error',
        sessionId: 'dev',
        note: { prompt: '真失败的问题' },
      },
    ];
    const turns = L.mergeConversation(messages, runs, 'dev');
    assert.equal(turns.length, 3, `轮数=${turns.length}（中止轮必须留在对话里）`);
    const aborted = turns.find((t) => t.user === '被中止的问题');
    assert.ok(aborted, '中止轮不能从对话视图里消失 —— 用户确实发过它');
    assert.equal(aborted.failed, false, '中止不是失败（不该标红）');
    assert.equal(aborted.aborted, true, '面板要能认出「这一轮是被中止的」');
    assert.equal(aborted.traceId, 't1');
    const failed = turns.find((t) => t.user === '真失败的问题');
    assert.equal(failed.failed, true);
    assert.equal(failed.aborted, false);
  });

  it('runIsFailure：**先认 stopReason 再认 ok**（与通知条同一条语义，两个表面共用）', () => {
    // run 列表的红点与对话视图的红边都走它 —— 各写一份判断就会漂，而漂开的症状是
    // 「同一个 run 在左边标红、在右边说已中止」。
    assert.equal(L.runIsFailure({ ok: false, stopReason: 'aborted' }), false);
    assert.equal(L.runIsFailure({ ok: false, stopReason: 'error' }), true);
    assert.equal(L.runIsFailure({ ok: false }), true, '老 trace 没有 stop_reason ⇒ 只能按 ok 判');
    assert.equal(L.runIsFailure({ ok: true, stopReason: 'end_turn' }), false);
    // 挂起刚加进这条判别：它的 trace 状态是 ok，但「不是成功」不等于「失败」——
    // 列表里它既不该是红点，也不该是「正常跑完」的蓝点（有独立一态）
    assert.equal(L.runIsFailure({ ok: true, stopReason: 'suspended' }), false, '挂着等人不是失败');
  });

  it('对话视图出现条件（chatViewVisible）：三条都满足才显示，不做空壳', () => {
    const dev = { available: true };
    assert.equal(L.chatViewVisible(dev, true, { messages: [] }), true);
    assert.equal(L.chatViewVisible(null, true, { messages: [] }), false, 'dev 还没拿到 ⇒ 不显示');
    assert.equal(
      L.chatViewVisible({ available: false }, true, { messages: [] }),
      false,
      '只读面板 ⇒ 不显示',
    );
    assert.equal(L.chatViewVisible(dev, false, { messages: [] }), false, '单轮 ⇒ 不显示');
    assert.equal(L.chatViewVisible(dev, true, null), false, '工程没配 session ⇒ 不显示');
  });

  it('对话轮折叠键混进 sessionId（turnKey）：清空对话后旧展开态不套到新对话上', () => {
    // 「清空对话」换 sessionId 后对话流下标从 0 重来 —— 只用下标当键，
    // 旧会话第 0 轮的展开态会套到新会话第 0 轮上。
    assert.equal(L.turnKey('dev', 0), 'turn:dev:0');
    assert.notEqual(L.turnKey('dev', 0), L.turnKey('dev-2', 0), '换 sessionId ⇒ 同下标也不同键');
    assert.notEqual(L.turnKey('dev', 0), L.turnKey('dev', 1), '同会话内下标仍区分各轮');
  });

  it('CLI 侧记账有上限：等不到 trace 的 note 也要被淘汰（dev 是长跑进程）', () => {
    /* 为什么需要这条：`noteRun` 记的 traceId 可能**永远进不了** runs —— trace 走
     * `POST /ingest` 另一路投递，sink 失败 / 进程被杀就没有那条 trace。旧实现把淘汰
     * 只挂在「traceId 进 runs」那条路上（注释还写着「与 runs 同步淘汰」）⇒
     * 那些无人认领的 note 只涨不降。 */
    const notes = new Map();
    L.rememberNote(notes, 't1', { prompt: 'a' }, 2);
    L.rememberNote(notes, 't2', { prompt: 'b' }, 2);
    L.rememberNote(notes, 't3', { prompt: 'c' }, 2);
    assert.deepEqual([...notes.keys()], ['t2', 't3'], '超上限按**插入序**淘汰最旧的');
    L.rememberNote(notes, 't3', { prompt: 'c2' }, 2);
    assert.deepEqual([...notes.keys()], ['t2', 't3'], '重复记同一个 traceId 不改变淘汰顺序');
    assert.equal(notes.get('t3').prompt, 'c2', '后写的记账覆盖前一条');
  });

  it('run-done 的反馈语：**先认 stopReason 再认 ok**（中止的 ok 也是 false）', () => {
    // 引擎的 abortedResult() 刻意给已取消的 run 带上结构化 error（取消不是失败，
    // 但原因要可查）⇒ 中止时 ok === false。判别顺序反了，用户按的中止会显示成
    // 一句「run 失败：请求已被取消」—— 这条断言就是钉这个顺序的。
    const aborted = L.runDoneNotice({ ok: false, stopReason: 'aborted', error: 'run 已被取消' });
    assert.equal(aborted.isError, false, '中止不是错误（不该标红）');
    assert.match(aborted.text, /中止/, `应说「中止」，实际：${aborted.text}`);
    assert.doesNotMatch(aborted.text, /失败/, '中止不该被说成失败');

    const failed = L.runDoneNotice({ ok: false, stopReason: 'error', error: '模型 500' });
    assert.equal(failed.isError, true);
    assert.match(failed.text, /失败/);
    assert.match(failed.text, /模型 500/, '原因要带出来，不能只说「失败」');
    assert.match(failed.text, /error/, 'stopReason 也要露出来 —— 同一句文案要能区分不同收尾');
    // error 为空时不能显示成空字符串（那是静默）
    assert.match(L.runDoneNotice({ ok: false, stopReason: 'error', error: null }).text, /未知原因/);

    const done = L.runDoneNotice({ ok: true, stopReason: 'end_turn', error: null });
    assert.equal(done.isError, false);
    assert.match(done.text, /完成/);
    assert.match(done.text, /end_turn/);

    /* 挂起（HITL）：`suspended` 的 trace 状态是 **ok**（挂起段本身没出错），旧文案因此
       落进「run 完成（suspended）」—— 那是在说一件没发生的事：这一轮还挂着等人裁决。 */
    const susp = L.runDoneNotice({ ok: true, stopReason: 'suspended', error: null });
    assert.equal(susp.isError, false, '挂着等人不是失败');
    assert.match(susp.text, /审批/, `应说「停在审批」，实际：${susp.text}`);
    assert.doesNotMatch(susp.text, /完成/, 'suspended 没跑完，不能说「完成」');
  });

  it('stopReasonClass：四个终态，14 个 stop reason 不许在页面里各写一段 if', () => {
    const C = L.stopReasonClass;
    assert.equal(C({ ok: true, stopReason: 'end_turn' }), 'ok');
    assert.equal(C({ ok: true, stopReason: 'stop_sequence' }), 'ok', 'stop_sequence 也是正常收尾');
    assert.equal(C({ ok: false, stopReason: 'aborted' }), 'aborted', '中止不是失败');
    // 挂起：两种 ok 都得认成「等人」—— trace 记 ok，但 ok === false 的宿主也不该被算失败
    assert.equal(C({ ok: true, stopReason: 'suspended' }), 'suspended');
    assert.equal(C({ ok: false, stopReason: 'suspended' }), 'suspended');
    // 被护栏/畸形响应拦下的那些：都算失败，且都要在列表里看得出**为什么**
    for (const sr of [
      'max_tokens',
      'model_context_window_exceeded',
      'refusal',
      'pause_turn',
      'max_iterations',
      'result_missing',
      'budget_exceeded',
      'tool_use_no_blocks',
      'unknown_stop_reason',
      'error',
    ]) {
      assert.equal(C({ ok: false, stopReason: sr }), 'failed', `${sr} 应算「被拦住」`);
    }
    // 框架加了新原因而面板还不认识：落进 failed 并**显示原文** ——
    // 反过来兜底成 ok，症状就是「新护栏被显示成正常收尾」（正是这次要修的错）
    assert.equal(C({ ok: false, stopReason: 'brand_new_reason' }), 'failed');
    assert.equal(L.stopReasonText('brand_new_reason'), 'brand_new_reason', '不认识的串原样显示');
    assert.equal(L.stopReasonText(null), '', '没有 stop_reason 的老 trace ⇒ 空串，不编一个原因');
    assert.equal(L.stopReasonText('budget_exceeded'), '撞到预算护栏');
  });

  it('路径压短只影响显示（发给子进程的永远是完整绝对路径）', () => {
    assert.equal(L.shortenPath('/Users/me/proj/a', { home: '/Users/me' }), '~/proj/a');
    assert.equal(L.shortenPath('/Users/me', { home: '/Users/me' }), '~');
    assert.equal(L.shortenPath('/w/proj/src', { cwd: '/w/proj' }), './src');
    // 不是前缀就原样（'/Users/megan' 不该被 '/Users/me' 吃掉）
    assert.equal(L.shortenPath('/Users/megan/x', { home: '/Users/me' }), '/Users/megan/x');
    assert.equal(L.shortenPath('', { home: '/Users/me' }), '');
  });
});

/**
 * 文件监视：**「改文本资产不用重启」那条承诺的落点**。
 *
 * 旧实现把它交给 `tsx watch`，而 `.md` 不在 tsx 的 import 图里 ⇒ 改 `system.md` /
 * `asset.md` **静默无感**（G3b，实测过）。这里守住新的判据：
 * ① 该看的类型（含 `.md`）看得见；② 不该看的（产物 / 依赖 / 编辑器噪声）看不见；
 * ③ 递归到子目录，且**新建**的子目录也进 watch 范围。
 */
describe('dev 的文件监视（改 .md 要能触发重启）', { skip: SKIP }, () => {
  it('允许清单：代码 / 文本资产 / .env 看，产物与噪声不看', () => {
    // 动态 import dist/dev.js —— 它的模块体没有副作用（副作用都在 devServer() 里）
    return import(new URL('../dist/dev.js', import.meta.url).href).then((D) => {
      for (const yes of [
        '/p/src/main.ts',
        '/p/src/app.ts',
        '/p/src/subagents/x/system.md',
        '/p/src/prompts/y/asset.md',
        '/p/src/registry.ts',
        '/p/tsconfig.json',
        '/p/.env',
        '/p/.env.local',
      ]) {
        assert.equal(D.shouldWatch(yes), true, `应该看：${yes}`);
      }
      for (const no of ['/p/README.md.bak', '/p/.DS_Store', '/p/src/main.ts.swp', '/p/src/x.png']) {
        assert.equal(D.shouldWatch(no), false, `不该看：${no}`);
      }
      // `/p/dist/main.js` **故意不在这里**：shouldWatch 是纯「扩展名 / 文件名」判据，
      // `.js` 本身就在允许清单里，把 `dist` 排除掉的是 watchTree 的目录递归（WATCH_SKIP）。
      // 想用绝对路径段去认 `dist` 是错的：项目根目录自己就叫 dist / node_modules 时会把
      // 整个项目判成「不该看」。所以那条排除在下面的递归用例里断言（那里才有 root）。
      assert.equal(D.shouldWatch('/p/dist/main.js'), true, '扩展名判据不认识目录，这是有意的');
    });
  });

  it('递归 + 新建子目录也在范围内：写 .md 真的回调', async () => {
    const D = await import(new URL('../dist/dev.js', import.meta.url).href);
    const dir = mkdtempSync(join(tmpdir(), 'agentia-watch-'));
    const seen = [];
    const stop = D.watchTree(dir, (abs) => seen.push(abs));
    try {
      // 已存在的子目录里的 .md（递归范围）
      // 新建的子目录 —— 不在初始 readdir 里，靠「新目录动态加入」才看得见
      const sub = join(dir, 'subagents');
      mkdirSync(sub, { recursive: true });
      // 反复写（不是写一次）：监视器建立是异步的，t0 那一次可能整个漏掉 —— 见 writeUntilSeen
      await writeUntilSeen(seen, () => {
        writeFileSync(join(dir, 'asset.md'), 'v1');
        writeFileSync(join(sub, 'system.md'), 'v1');
      });
      assert.ok(seen.length > 0, '写 .md 应该触发回调（旧实现这里静默无感）');
      assert.ok(
        seen.every((p) => D.shouldWatch(p)),
        `回调只该带允许清单里的文件，实际：${JSON.stringify(seen)}`,
      );

      // 目录级排除：这两处里面的文件**扩展名都在允许清单里**，能挡住它们的只有 WATCH_SKIP，
      // 所以这是「递归排除」唯一的有效断言点。
      // ⚠️ 别把这条说成「防 `.agentia` 自噬」就完事：**真正的第一层是监视根** ——
      // `devServer` 只 `watchTree(<projectRoot>/src)`，而 `.agentia` / `dist` 在项目根，
      // 根本不在范围内（`scripts/e2e-dev.ts` 第 12 步钉的是这条）。WATCH_SKIP 是第二层，
      // 防的是「哪天把根改成项目根」—— 那时 `.agentia/session.json` 会立刻变成
      // 「每次多轮 run 重启一次子进程」的自噬循环。
      mkdirSync(join(dir, 'dist'), { recursive: true });
      writeFileSync(join(dir, 'dist', 'out.js'), 'v1'); // .js 是允许清单里的类型
      mkdirSync(join(dir, '.agentia'), { recursive: true });
      writeFileSync(join(dir, '.agentia', 'session.json'), '{}'); // .json 同理
      // 等过 150ms 去抖窗口，让「有事件」也来得及落进 seen —— 否则分不清「没看见」和「还没看见」
      await new Promise((r) => setTimeout(r, 600));
      assert.ok(
        !seen.some((p) => p.includes(`${sep}dist${sep}`)),
        `dist 里的产物不该触发重启，实际：${JSON.stringify(seen)}`,
      );
      // 这条不是洁癖：dev 环自己每轮多轮对话都往 .agentia/session.json 写一次，
      // 一旦它进了 watch 范围，就是「每次 run 都重启一次子进程」的自噬循环。
      assert.ok(
        !seen.some((p) => p.includes(`${sep}.agentia${sep}`)),
        `dev 自己的状态目录不该触发重启（会自噬），实际：${JSON.stringify(seen)}`,
      );
    } finally {
      stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * ⚠️ 上面那条用例**抓不到**下面这个形状（它靠事件合并侥幸通过）：它把 `dist/` 与
   * `.agentia/` 建在「已有一批写入」之后，而 `flush` 只报 pending 里的**第一条**
   * —— 于是那两条目录里的写入被合并掉，断言就绿了。
   *
   * 真正的形状是「**启动之后**才出现的跳过目录」：判据若只写在初始递归那个调用点，
   * 动态新增那条路（watcher 回调里的 `addDir`）就漏了。而 `.agentia/` **必然**属于这一类
   * —— 它是 dev 环自己在第一次多轮 run 时创建的（`FileSessionStore.append` 会 mkdir）。
   * 漏掉的后果就是本文件上面那条注释警告的自噬循环：**每次多轮 run 重启一次子进程**。
   * （生产可达性另说：真跑时 root 是 `<projectRoot>/src`，`.agentia/` 不在范围内 ——
   * 见上面 `mkdirSync(join(dir, 'dist'))` 那段注释。这里测的是 `watchTree` **自己的**契约：
   * 「跳过判据对初始递归与动态新增两条路都成立」。）
   *
   * 所以这条用例刻意把两件事分开、中间等过去抖窗口 —— 不让合并掩盖被测行为。
   */
  it('启动后才出现的 dist/ 与 .agentia/：里面的写入**不该**触发回调（否则自噬）', async () => {
    const D = await import(new URL('../dist/dev.js', import.meta.url).href);
    for (const dirName of ['dist', '.agentia']) {
      const dir = mkdtempSync(join(tmpdir(), 'agentia-watchskip-'));
      const seen = [];
      const stop = D.watchTree(dir, (abs) => seen.push(abs));
      try {
        // 启动时还不存在 —— 这正是 `.agentia` 的真实时序
        mkdirSync(join(dir, dirName), { recursive: true });
        // 等过 150ms 去抖窗口 + 余量，让「建目录」那一批事件先冲完
        await new Promise((r) => setTimeout(r, 500));
        seen.length = 0;
        // 扩展名**在允许清单里**（.js / .json）—— 能挡住它的只有目录级排除
        writeFileSync(join(dir, dirName, dirName === 'dist' ? 'out.js' : 'session.json'), 'v1');
        await new Promise((r) => setTimeout(r, 700));
        assert.equal(
          seen.length,
          0,
          `${dirName}/ 是启动后才出现的跳过目录，里面的写入不该触发重启，实际：${JSON.stringify(seen)}`,
        );
      } finally {
        stop();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('项目根本身叫 dist / .foo 时**仍然要**看（跳过判据只看子目录名，不认路径段）', async () => {
    const D = await import(new URL('../dist/dev.js', import.meta.url).href);
    // 建一个**名字就叫 dist** 的目录当项目根：它自己不该被跳过（否则整个项目静默不监视）
    const parent = mkdtempSync(join(tmpdir(), 'agentia-rootname-'));
    const dir = join(parent, 'dist');
    mkdirSync(dir, { recursive: true });
    const seen = [];
    const stop = D.watchTree(dir, (abs) => seen.push(abs));
    try {
      await writeUntilSeen(seen, () => writeFileSync(join(dir, 'app.ts'), 'v1'));
      assert.ok(
        seen.length > 0,
        '项目根自己叫 dist 时必须照常监视（用绝对路径段认 dist 是错的：根目录可能就叫 dist）',
      );
    } finally {
      stop();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  /**
   * `watchRootEnvFiles`：只盯**项目根**的 `.env` / `.env.local`。
   *
   * ⚠️ 这条**不能**靠 `watchTree` 顶替：`watchTree` 的根是 `<projectRoot>/src`，而 `.env`
   * 在项目根 ⇒ 允许清单里的 `.env` 曾经是一条**够不着**的判据（改 `.env` 静默无感，
   * 与 G3b 同类）。但**「调用点到底接上了没有」只有真跑能验**（根是**调用点**决定的，
   * `watchTree` 自己无从知道该看哪儿）⇒ 那是 `scripts/e2e-dev.ts` 第 9-bis 步的活。
   * 这里测的是它**自己的**契约：名字过滤（非 env 一律不看）与不递归。
   */
  it('watchRootEnvFiles：只看项目根的 .env / .env.local，别的一律不看', async () => {
    const D = await import(new URL('../dist/dev.js', import.meta.url).href);
    const dir = mkdtempSync(join(tmpdir(), 'agentia-envwatch-'));
    const seen = [];
    // 先建好再 watch —— 测「改」而不是「建」，更贴近真实用法（`.env` 早就在了）
    writeFileSync(join(dir, '.env'), 'v0');
    writeFileSync(join(dir, 'README.md'), 'v0');
    const stop = D.watchRootEnvFiles(dir, (abs) => seen.push(abs));
    try {
      await writeUntilSeen(seen, () => writeFileSync(join(dir, '.env'), 'v1'));
      assert.ok(
        seen.some((p) => p.endsWith(`${sep}.env`)),
        `改项目根的 .env 必须触发回调（旧实现里这条事件根本没人接），实际：${JSON.stringify(seen)}`,
      );
      // 等过去抖窗口，清掉 `.env` 那一批，再验「别的文件不看」
      await new Promise((r) => setTimeout(r, 500));
      seen.length = 0;
      // 这两个的扩展名**都在** `WATCH_EXT` 里（`.md` / `.json`）—— 能挡住它们的只有
      // 「只认名字」这一条，所以这是该判据唯一的有效断言点。
      writeFileSync(join(dir, 'README.md'), 'v1');
      writeFileSync(join(dir, 'package.json'), '{}');
      await new Promise((r) => setTimeout(r, 700));
      assert.equal(
        seen.length,
        0,
        `项目根的非 env 文件不该触发（.md / .json 在这里都该被名字过滤挡掉），实际：${JSON.stringify(seen)}`,
      );
    } finally {
      stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * 「清空对话」换到的下一个 id（§6 待定 3）。与上面那组同处一个文件：两者都是
 * `dist/dev.js` 里的**纯件**（无副作用、可脱离子进程单测），而 `dev.ts` 的其余部分
 * 要真起 runner 才有意义（那部分由 `scripts/e2e-dev.ts` 守）。
 */
describe('dev 环的会话 id（清空对话 = 换 id，不删账）', { skip: SKIP }, () => {
  it('dev → dev-2 → dev-3 …（单调递增，不撞旧 id）', async () => {
    const D = await import(new URL('../dist/dev.js', import.meta.url).href);
    assert.equal(D.nextSessionId('dev'), 'dev-2', '首次清空');
    assert.equal(D.nextSessionId('dev-2'), 'dev-3');
    assert.equal(D.nextSessionId('dev-9'), 'dev-10', '两位数照常递增（不是字符串拼接）');
  });

  it('认不出的形状 ⇒ 回到 -2，不抛（一个怪 id 不该让面板坏掉）', async () => {
    const D = await import(new URL('../dist/dev.js', import.meta.url).href);
    // 用户手工改了 .agentia/dev-session-id，或那是别的工程留下的值
    for (const weird of ['', 'other', 'dev-', 'dev-x', 'DEV', 'dev-2x', 'dev-1-2']) {
      assert.equal(D.nextSessionId(weird), 'dev-2', `怪 id「${weird}」应兜到 dev-2`);
    }
  });

  it('base 进正则前被转义（参数化导出 ⇒ 脏值迟早被传进来）', async () => {
    const D = await import(new URL('../dist/dev.js', import.meta.url).href);
    // ⚠️ 断言必须**带序号**才问得出「有没有转义」：`Xdev` 在转义前后都返回 `.dev-2`
    // （前者是「没匹配上」，后者是「匹配上了但没序号」—— 两条路撞在同一个返回值上），
    // 所以那是个**假绿**用例。`Xdev-4` 才分得开：未转义时 `.` 吃掉 `X` ⇒ 认成 `.dev-4` ⇒ `.dev-5`。
    assert.equal(D.nextSessionId('Xdev-4', '.dev'), '.dev-2', '`.dev` 只该匹配字面量 .dev');
    assert.equal(D.nextSessionId('Xdev', '.dev'), '.dev-2', '（这条单独看不区分，留着当形状说明）');
    assert.equal(D.nextSessionId('.dev', '.dev'), '.dev-2');
    assert.equal(D.nextSessionId('.dev-4', '.dev'), '.dev-5');
  });
});

describe('在飞 run 的增量 trace 折回（① 实时右栏）', { skip: SKIP }, () => {
  /**
   * 一次 run 的**事件流**与它收尾的 trace 是同一个事实的两个投影 —— 框架侧钉着
   * 「按 seq 升序折回必须逐字等于 snapshot()」（tests/engine/trace-events.test.ts）。
   * 面板是这条不变量的第二个消费者，所以这里复刻同一条：**手写**一小段事件流与它
   * 对应的收尾 spans，两者对不上就说明面板的折回规则漂了。
   *
   * 为什么值得单测：折回错了在浏览器里的表现是「树缺一个节点 / 少一条事件」，
   * 那是最难从现象反推回代码的一类症状（而且 dev 环本就没有别的守卫）。
   */
  const FINAL_SPANS = [
    {
      spanId: 'r',
      traceId: 'tr-1',
      parentSpanId: null,
      kind: 'run',
      name: 'demo',
      startedAt: 0,
      endedAt: 100,
      status: 'ok',
      attributes: { stop_reason: 'end_turn' },
      events: [],
    },
    {
      spanId: 't',
      traceId: 'tr-1',
      parentSpanId: 'r',
      kind: 'llm.turn',
      name: 'm',
      startedAt: 5,
      endedAt: 50,
      status: 'ok',
      usage: { inputTokens: 10, outputTokens: 5 },
      attributes: { model: 'm' },
      events: [{ name: 'tool.input', time: 6, body: { tool: 'echo', input: { a: 1 } } }],
    },
  ];
  const EVENTS = [
    {
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
    },
    {
      seq: 2,
      type: 'span.begin',
      span: {
        spanId: 't',
        traceId: 'tr-1',
        parentSpanId: 'r',
        kind: 'llm.turn',
        name: 'm',
        startedAt: 5,
        status: 'ok',
        attributes: {},
        events: [],
      },
    },
    {
      seq: 3,
      type: 'span.event',
      spanId: 't',
      event: { name: 'tool.input', time: 6, body: { tool: 'echo', input: { a: 1 } } },
    },
    { seq: 4, type: 'span.attribute', spanId: 't', key: 'model', value: 'm' },
    {
      seq: 5,
      type: 'span.end',
      spanId: 't',
      endedAt: 50,
      status: 'ok',
      usage: { inputTokens: 10, outputTokens: 5 },
    },
    { seq: 6, type: 'span.attribute', spanId: 'r', key: 'stop_reason', value: 'end_turn' },
    { seq: 7, type: 'span.end', spanId: 'r', endedAt: 100, status: 'ok' },
  ];

  const fold = (events) => {
    const acc = L.emptyTraceAccumulator();
    for (const e of events) L.applyTraceEvent(acc, e);
    return L.partialTrace(acc);
  };

  it('按 seq 折回 == 收尾的整棵 trace（框架那条不变量，面板侧复刻）', () => {
    const folded = fold(EVENTS);
    assert.equal(folded.traceId, 'tr-1', 'traceId 从第一个 span.begin 的 span 上读到');
    assert.deepEqual(folded.spans, FINAL_SPANS, '折回结果必须逐字等于收尾的 spans');
  });

  it('乱序 / 重复 / 未知 span：丢得干净，不污染已折回的部分', () => {
    // seq 不前进（重复投递）⇒ 丢：SSE 不保证送达，但送达的那些只能应用一次
    const acc = L.emptyTraceAccumulator();
    assert.equal(L.applyTraceEvent(acc, EVENTS[0]), true);
    assert.equal(L.applyTraceEvent(acc, EVENTS[0]), false, '同一条 seq 再来一次应被丢');
    assert.equal(acc.spans.length, 1, '重复投递不该多出一个 span');
    // 指向未知 spanId（面板连上得晚，前几个 span.begin 没收到）⇒ 丢，不抛
    assert.equal(
      L.applyTraceEvent(acc, {
        seq: 99,
        type: 'span.end',
        spanId: 'nope',
        endedAt: 1,
        status: 'ok',
      }),
      false,
    );
    assert.equal(
      L.applyTraceEvent(acc, { seq: 100, type: 'span.event', spanId: 'nope', event: {} }),
      false,
    );
    assert.equal(acc.spans.length, 1, '未知 span 的事件不该凭空建节点');
    // 后到的 span.begin 对已见过的 spanId ⇒ 原地刷新（重放幂等），不重复挂到树上
    assert.equal(
      L.applyTraceEvent(acc, {
        seq: 101,
        type: 'span.begin',
        span: { ...EVENTS[0].span, name: 'renamed' },
      }),
      true,
    );
    assert.equal(acc.spans.length, 1, '同一个 spanId 不该出现两次');
    assert.equal(acc.spans[0].name, 'renamed', '原地刷新应生效');
    // 空折回：还没收到任何 span.begin 时是空树（右栏据此保留占位，不画一棵假树）
    assert.deepEqual(L.partialTrace(L.emptyTraceAccumulator()).spans, []);
  });

  it('partialTrace 给未收尾的树留出「在飞」的形状（根没有 endedAt ⇒ 渲染层不收尾）', () => {
    const folded = fold(EVENTS.slice(0, 2)); // 只到两个 span.begin
    assert.equal(folded.spans.length, 2);
    assert.equal(folded.spans[0].endedAt, undefined, '在飞时根不该有 endedAt');
    assert.equal(folded.status, 'running');
  });
});

describe('回复正文的归属（② 跑完的回复被自动 open 擦掉）', { skip: SKIP }, () => {
  it('只有「打开的就是这条回复的主人」才保留', () => {
    assert.equal(
      L.replyBelongsTo('t1', 't1'),
      true,
      '同一条 trace ⇒ 保留（run-done 刚写上去的那句）',
    );
    assert.equal(L.replyBelongsTo('t2', 't1'), false, '打开别的 run ⇒ 清（防张冠李戴，原意图）');
    assert.equal(L.replyBelongsTo('t1', null), false, '不知道主人是谁 ⇒ 清（默认安全）');
    assert.equal(L.replyBelongsTo(null, null), false);
  });
});

describe('目录浏览 / 选文件（③）', { skip: SKIP }, () => {
  it('浏览… 总是按输入框的值打开（不是开关）', () => {
    assert.equal(
      L.browseTarget('/x/y', '/w'),
      '/x/y',
      '输入框有值 ⇒ 用它（这就是「敲了路径再点浏览」的用法）',
    );
    assert.equal(L.browseTarget('  /x/y  ', '/w'), '/x/y', '首尾空白不该让路径读错');
    assert.equal(L.browseTarget('', '/w'), '/w', '空 ⇒ 回落缺省工作目录');
    assert.equal(L.browseTarget('   ', '/w'), '/w');
  });

  it('选文件：只在 prompt 为空时填文件名 —— 用户写好的话一个字不动', () => {
    assert.deepEqual(L.promptAfterFilePick('', 'README.md'), { prompt: 'README.md', filled: true });
    assert.deepEqual(
      L.promptAfterFilePick('  ', 'a.md'),
      { prompt: 'a.md', filled: true },
      '空白等于空',
    );
    assert.deepEqual(
      L.promptAfterFilePick('读一下这个', 'a.md'),
      { prompt: '读一下这个', filled: false },
      '已有内容 ⇒ 一个字都不动（悄悄改用户输入比少填一次糟得多）',
    );
    assert.equal(L.promptAfterFilePick('读一下这个', 'a.md').prompt, '读一下这个');
  });
});

describe('消息折叠判定（③ 长正文默认收起）', { skip: SKIP }, () => {
  it('短消息不折叠、且不产生控件文案（短消息上挂「展开」是噪声）', () => {
    const short = L.collapseDecision('读完了，共 42 行。');
    assert.equal(short.collapsed, false);
    assert.equal(short.hint, '', '不折叠时文案必须是空串 —— 面板据此决定挂不挂控件');
    assert.equal(L.collapseDecision('a\nb\nc').collapsed, false);
  });

  it('超行数或超字符数都折叠，文案说明折叠了多少', () => {
    const many = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行`).join('\n');
    const byLines = L.collapseDecision(many);
    assert.equal(byLines.collapsed, true);
    assert.equal(byLines.lines, 20);
    assert.equal(byLines.hint, '展开全文（共 20 行）');
    // 单行超长（模型不换行时很常见）同样折叠 —— 只看行数会漏掉这一类
    const oneLine = 'x'.repeat(2000);
    const byChars = L.collapseDecision(oneLine);
    assert.equal(byChars.collapsed, true);
    assert.equal(byChars.lines, 1);
    assert.equal(byChars.hint, '展开全文（共 2000 字符）', '一行时不该说「共 1 行」');
    // 边界：恰好等于阈值**不**折叠（阈值语义是「超过」）
    assert.equal(L.collapseDecision('a\n'.repeat(12).trim()).collapsed, false);
  });

  it('阈值可覆盖（面板/测试要别的量级时不必抄一份判据）', () => {
    assert.equal(L.collapseDecision('a\nb\nc', { maxLines: 2 }).collapsed, true);
    assert.equal(L.collapseDecision('x'.repeat(50), { maxChars: 100 }).collapsed, false);
    assert.equal(L.collapseDecision('').collapsed, false, '空正文不该折叠（它没有可展开的东西）');
  });
});

describe('面板并排 A/B（档 B）', () => {
  it('toggleCompare：再点已选中的取消它；超过两块挤掉最早那条（不静默丢后来的）', () => {
    if (SKIP) return;
    // 单击 → 选第一块
    assert.deepEqual(L.toggleCompare([], 'a'), ['a']);
    // 再点已选中的 ⇒ 取消（用户要能改主意，不能「凑不满两块就不动」）
    assert.deepEqual(L.toggleCompare(['a'], 'a'), []);
    // 单选态重复点同一条 ⇒ 幂等，不产生 [a, a]
    assert.deepEqual(L.toggleCompare(['a'], 'a'), []);
    // 第二块
    assert.deepEqual(L.toggleCompare(['a'], 'b'), ['a', 'b']);
    // 第三块 ⇒ 挤掉最早（a），保留 b + c
    assert.deepEqual(L.toggleCompare(['a', 'b'], 'c'), ['b', 'c']);
    // 上限常量与行为一致（面板要按它显示「最多选两条」）
    assert.equal(L.COMPARE_MAX, 2);
    assert.equal(L.toggleCompare(['a', 'b'], 'c').length, L.COMPARE_MAX);
  });

  it('comparability：同能力+同目录 ⇒ 可比且**无提示**（不制造噪声）', () => {
    if (SKIP) return;
    const a = { toolSources: ['x', 'y'], workdir: '/w/p' };
    const b = { toolSources: ['y', 'x'], workdir: '/w/p' };
    const r = L.comparability(a, b);
    assert.equal(r.level, 'comparable');
    // ⚠️ 可比时 message 必须是空串 —— 面板据它决定要不要显示提示条。
    // 非空 = 每一次正常 A/B 都飘一条「注意…」噪声 ⇒ 用户会学会无视它。
    assert.equal(r.message, '', '可比时不该有任何提示文案');
  });

  it('comparability：能力全量有null 两种表示，归一化后**不能**判成不同', () => {
    if (SKIP) return;
    // RunNote.toolSources 用 null 表全量；面板侧 normalizeToolSources 回 undefined。
    // 直接比数组会把「全量 vs 全量」判成不同 ⇒ 满屏「能力选择不同」的假警告。
    const a = { toolSources: null, workdir: '/w/p' };
    const b = { toolSources: [], workdir: '/w/p' };
    assert.equal(L.comparability(a, b).level, 'comparable', 'null 与空集都是「全量」');
  });

  it('comparability：跨能力 ⇒ capabilities-differ（跨了进程重启，diff 意义有限）', () => {
    if (SKIP) return;
    const a = { toolSources: ['x'], workdir: '/w/p' };
    const b = { toolSources: ['y'], workdir: '/w/p' };
    const r = L.comparability(a, b);
    assert.equal(r.level, 'capabilities-differ');
    // 提示要说清**差在哪** + 给出可执行的出路
    assert.match(r.message, /能力选择不同/);
    assert.match(r.message, /只改 prompt/, '要告诉用户正确的做法是什么');
  });

  it('comparability：同能力跨目录 ⇒ workdir-differs，且提示里带上两个目录', () => {
    if (SKIP) return;
    const a = { toolSources: null, workdir: '/w/a' };
    const b = { toolSources: null, workdir: '/w/b' };
    const r = L.comparability(a, b);
    assert.equal(r.level, 'workdir-differs', '跨目录是弱可比，不是不可比');
    // ⚠️ 必须显示目录：否则「差在哪」会被读成「模型变了」—— 归因错到根上
    assert.match(r.message, /\/w\/a/);
    assert.match(r.message, /\/w\/b/);
  });

  it('comparability：note 缺失 ⇒ **不猜**，按不可比处理（宁可少给也不给错结论）', () => {
    if (SKIP) return;
    const note = { toolSources: null, workdir: '/w/p' };
    const missA = L.comparability(null, note);
    const missB = L.comparability(note, null);
    assert.equal(missA.level, 'capabilities-differ', '缺 note 不等于「相同」');
    assert.equal(missB.level, 'capabilities-differ');
    assert.match(missA.message, /元信息/, '要说清是「元信息缺失」而不是「能力不同」');
  });
});

describe('面板并排 A/B 的视图与取值判定（从DOM 抽出来的那批）', () => {
  it('compareView：三态，**中间那态必须独立**（选了一条要保留选择）', () => {
    if (SKIP) return;
    // 三态而不是两态的理由（判据错的后果）：
    // 把「选了一条」并进「不并排」⇒ ① 取消选择会连带清掉已选的第一条，
    // ② 或保留选择却显示双栏（一栏的「并排」比不显示更困惑）。
    assert.equal(L.compareView([]), 'single');
    assert.equal(L.compareView(['a']), 'picking', '选了一条 ⇒ picking（单run 视图 + 保留选择）');
    assert.equal(L.compareView(['a', 'b']), 'dual');
    // 超过两块不该出现（toggleCompare 保证 ≤ COMPARE_MAX）；若真发生，按 dual 处理而不是崩
    assert.equal(L.compareView(['a', 'b', 'c']), 'dual', '超量输入按 dual 处理，不抛');
  });

  it('diffSideLabel：缺侧判错会**静默指错方向**（A 独有被说成 B 侧少）', () => {
    if (SKIP) return;
    assert.equal(L.diffSideLabel('a'), 'A', "missing='a' = 只有 A 侧有");
    assert.equal(L.diffSideLabel('b'), 'B');
  });

  it('diffValueText：null/undefined 显示「（无）」，**不许**折成空串或 0', () => {
    if (SKIP) return;
    // ⚠️ 这条是「读不出 vs 读数」那条纪律的字符串版：折成 0/空会让用户以为值真的是那样
    assert.equal(L.diffValueText(null), '（无）');
    assert.equal(L.diffValueText(undefined), '（无）');
    assert.equal(L.diffValueText(0), '0', '**真的是 0** 时要显示 0（那是合法读数）');
    assert.equal(L.diffValueText(''), '', '真的是空串时显示空串（不是「（无）」）');
    assert.equal(L.diffValueText('x'), 'x', '字符串原样（不加工引号）');
    assert.equal(L.diffValueText({ a: 1 }), '{"a":1}');
  });

  it('diffValueText：循环引用的对象回落 String()，不抛', () => {
    if (SKIP) return;
    const cyc = { a: 1 };
    cyc.self = cyc;
    // JSON.stringify 循环引用会抛 TypeError ⇒ 面板不能整块崩掉
    assert.doesNotThrow(() => L.diffValueText(cyc));
    assert.equal(typeof L.diffValueText(cyc), 'string');
  });

  it('diffFetchErrorText：解析失败单独说，**不许**折成「HTTP 500」', () => {
    if (SKIP) return;
    // 折成状态码的后果：token 过期 / 网关插页时显示「服务端故障」，真相是「响应不是 JSON」
    assert.match(
      L.diffFetchErrorText(200, null, true),
      /响应不是合法 JSON/,
      '解析失败要自己说，别伪装成服务端错误',
    );
    assert.match(L.diffFetchErrorText(200, null, true), /200/, '仍要带真实状态码');
    // error 是非空字符串 ⇒ 用它（这是服务端给的真相）
    assert.match(L.diffFetchErrorText(404, { error: 'run 不存在' }, false), /run 不存在/);
    // error 缺失/空串/非字符串 ⇒ 回落状态码（**不能**用 || 把它折成空串显示出去）
    assert.match(L.diffFetchErrorText(500, {}, false), /HTTP 500/);
    assert.match(L.diffFetchErrorText(500, { error: '' }, false), /HTTP 500/);
    assert.match(L.diffFetchErrorText(500, { error: 123 }, false), /HTTP 500/);
  });

  it('autoPairTarget：只在 picking 态自动补第二条（关掉「替用户决定」的三种形态）', () => {
    if (SKIP) return;
    // ① picking 态（已选一条）+ 新收尾的那条 ⇒ 配对（这一跳就是「立刻重跑对照」）
    assert.deepEqual(L.autoPairTarget(['a'], 'b'), ['a', 'b'], 'picking 态必须能自动配上');
    // ② 空选择 ⇒ 不配对。自动切双栏是**替用户决定**，用户没表达意图就不做
    assert.equal(L.autoPairTarget([], 'b'), null, '没表达对比意图时不得自动进双栏');
    // ③ 已选两条 ⇒ 不配对（再塞一条等于挤掉用户刚选的）
    assert.equal(L.autoPairTarget(['a', 'c'], 'b'), null, '已选两条时不许挤掉其中一条');
    // ④ 同一 id ⇒ 不配对（否则会出现 [a, a]）
    assert.equal(L.autoPairTarget(['a'], 'a'), null, '同一条不得与自己配对');
    // ⑤ **纯函数**：不改入参（面板那边拿到的是同一个 state.compare）
    const sel = ['a'];
    L.autoPairTarget(sel, 'b');
    assert.deepEqual(sel, ['a'], '不许就地改入参');
    // ⑥ 返回值长度恒为 2 ⇒ 配对后必进 dual 态（`compareView` 的 dual 分支）
    assert.equal(L.autoPairTarget(['a'], 'b').length, L.COMPARE_MAX);
  });

  /* 三块折叠后的标题栏读数（2026-11-12 ref-panel-panes）。
   * 这几条是「收起不等于失明」那句话的可执行版本：折叠后标题栏是那块唯一的可见内容，
   * 所以它的**数量与单位**必须准 —— 说错数字比不显示更糟（读者会按错的规模判断要不要展开）。 */
  it('traceMeta：span 数如实，千位以上折 k（标题栏只有一行）', () => {
    if (SKIP) return;
    assert.equal(L.traceMeta(0), '0 span');
    assert.equal(L.traceMeta(58), '58 span');
    assert.equal(L.traceMeta(999), '999 span');
    assert.equal(L.traceMeta(1000), '1k span', '整千不留 `.0`（`1.0k` 是给机器看的）');
    assert.equal(L.traceMeta(1234), '1.2k span');
    assert.equal(L.traceMeta(12345), '12k span', '一万以上不保留小数');
    // 非数值（老 trace 的 `spans` 缺失、或面板传了 undefined）不许写出 `NaN span`
    assert.equal(L.traceMeta(undefined), '0 span');
    assert.equal(L.traceMeta(-3), '0 span');
  });

  it('summaryMeta：项数 / 次数 / **只在真有人失败时**才提失败', () => {
    if (SKIP) return;
    assert.equal(L.summaryMeta([]), '0 项', '没有可归因的能力时说 0，不编一行「· 0 次」');
    assert.equal(
      L.summaryMeta([
        { calls: 3, errors: 0 },
        { calls: 21, errors: 0 },
      ]),
      '2 项 · 24 次',
      '没有失败时不许挂「0 失败」—— 每一行都挂等于噪声',
    );
    assert.equal(
      L.summaryMeta([
        { calls: 3, errors: 1 },
        { calls: 21, errors: 1 },
      ]),
      '2 项 · 24 次 · 2 失败',
      '失败数按**行内 errors 求和**（一个能力错两次是 2 次），不是「几个能力出错」',
    );
    // 非数值不许变成 NaN 传染整条 →
    assert.equal(L.summaryMeta([{ calls: undefined, errors: undefined }]), '1 项 · 0 次');
    assert.equal(L.summaryMeta(null), '0 项');
  });

  it('replyMeta：行数与字符数必须与折叠控件同一口径（同一个 split）', () => {
    if (SKIP) return;
    assert.equal(L.replyMeta(''), '0 字符');
    assert.equal(L.replyMeta('单行'), '2 字符', '单行不写「1 行 ·」，那一行没信息');
    assert.equal(L.replyMeta('a\nb\nc'), '3 行 · 5 字符');
    // ⚠️ 与 collapseDecision 同源：两边对「行」的算法必须一致，否则标题说 32 行、
    // 折叠控件说「共 31 行」，用户会以为其中一个是 bug
    const text = 'x'.repeat(1500);
    const d = L.collapseDecision(text);
    assert.equal(L.replyMeta(text), '1.5k 字符', '单行正文不写「1 行 ·」—— 那一行没信息');
    assert.equal(d.chars, 1500);
    assert.match(d.hint, /共 1500 字符/, 'hint 用的仍是精确值（折叠控件按它决定要不要出现）');
  });
});
