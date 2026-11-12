import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { distReadyOrLoud } from './dist-guard.mjs';

/*
 * dev 环显式状态机（dist/dev-machine.js）的事件矩阵单测 —— 方案
 * docs/plans/2026-09-23-cli-structure.md §3 B 的配套。
 *
 * 覆盖 §3 B 那张「今天 → 之后」对照表的每一行：
 * - F1（launching 闸）：`run: 'launching'` 是类型里的一相，闸是「非 idle 即拒」——
 *   下面「受理闸」一条逐相位钉死（反向验证记录见文件尾注释）；
 * - F4（同一条错误不广播两帧）：effects 是返回值，启动失败路径上 **child-exit 零 emit**、
 *   restart-failed / boot-failed 各恰好一帧；
 * - G1（errBaseline 归因）：基线是状态字段，child-exit 的迁移规则逐格钉住；
 * - G2（pick 的断开出口）：ui-pick-cancelled 迁移存在且只发 kill-pickers；
 * - pendingRestart 收敛：file-changed 记 → run-done/run-error/run-launch-failed 各补一条 restart。
 */

/* 对构建产物测试（未构建时跳过而非报错）—— 与 dev-logic.test.mjs 同一模式 */
const DIST = fileURLToPath(new URL('../dist/dev-machine.js', import.meta.url));
let M = null;
if (existsSync(DIST)) M = await import(new URL('../dist/dev-machine.js', import.meta.url).href);
const SKIP = !M ? '未构建 packages/cli/dist —— 先跑 npm run build:cli' : false;
/* dist 缺失不许静默：本地醒目警告后照旧 skip；CI（build 先于测试）里直接判失败 */
if (SKIP) distReadyOrLoud(DIST, 'CLI 构建产物');

const BUDGET = { maxCostUsd: 1, maxTotalTokens: 200_000 };

/** 起步状态：项目根 /p、初始会话 dev */
const base = () => M.createInitialState({ projectRoot: '/p', sessionId: 'dev' });

/** 一代已就绪的 runner（starting → ready 走完，菜单 ['hello','read-file']） */
const ready = (over = {}) => {
  let s = base();
  s = M.update(s, { type: 'child-spawned', toolSources: null }).state;
  s = M.update(s, {
    type: 'child-ready',
    capabilities: ['hello', 'read-file'],
    multiTurn: ['hello'],
    defaultWorkdir: '/p',
    budget: { ...BUDGET },
    warning: null,
  }).state;
  return { ...s, ...over };
};

const REQ = { prompt: '跑一下' };

const kinds = (effects) => effects.map((e) => e.kind);
const emits = (effects) => effects.filter((e) => e.kind === 'emit');
const rejects = (effects) => effects.filter((e) => e.kind === 'reject');

describe('dev 环显式状态机（dev-machine）', { skip: SKIP }, () => {
  it('boot ⇒ spawn-child（全量）；初始相位 absent/idle', () => {
    const s = base();
    assert.equal(s.child, 'absent');
    assert.equal(s.run, 'idle');
    const r = M.update(s, { type: 'boot' });
    assert.deepEqual(r.effects, [{ kind: 'spawn-child', toolSources: null }]);
    assert.equal(r.state, s, 'boot 不改状态（状态由 child-spawned 迁移）');
  });

  it('child-spawned ⇒ starting：菜单/预算回落初值、errBaseline 记下此刻的 lastError（G1 基线）', () => {
    const s0 = { ...ready(), lastError: '上一代留下的旧错误', toolSources: ['hello'] };
    const r = M.update(s0, { type: 'child-spawned', toolSources: ['read-file'] });
    assert.equal(r.state.child, 'starting');
    assert.deepEqual(r.state.toolSources, ['read-file']);
    assert.deepEqual(r.state.capabilities, [], '就绪前只能给初值空菜单');
    assert.deepEqual(r.state.budget, BUDGET);
    assert.equal(r.state.defaultWorkdir, '/p', 'defaultWorkdir 回落项目根');
    assert.equal(r.state.warning, null);
    assert.equal(r.state.errBaseline, '上一代留下的旧错误', '基线 = spawn 那一刻的 lastError');
    assert.deepEqual(r.effects, []);
  });

  it('child-ready ⇒ ready：菜单落账 + emit runner-ready；有 warning 时先 log', () => {
    const s = M.update(base(), { type: 'child-spawned', toolSources: null }).state;
    const r = M.update(s, {
      type: 'child-ready',
      capabilities: ['hello'],
      multiTurn: [],
      defaultWorkdir: '/p/wd',
      budget: { maxCostUsd: 2, maxTotalTokens: 1 },
      warning: '会话文件读不出来',
    });
    assert.equal(r.state.child, 'ready');
    assert.deepEqual(r.state.capabilities, ['hello']);
    assert.equal(r.state.defaultWorkdir, '/p/wd');
    assert.deepEqual(r.state.budget, { maxCostUsd: 2, maxTotalTokens: 1 });
    assert.equal(r.state.warning, '会话文件读不出来');
    assert.deepEqual(r.effects, [
      { kind: 'log', level: 'warn', message: '[agentia] 会话文件读不出来' },
      { kind: 'emit', event: { kind: 'runner-ready' } },
    ]);
    // 无 warning ⇒ 只有 emit 一条
    const r2 = M.update(s, {
      type: 'child-ready',
      capabilities: [],
      multiTurn: [],
      defaultWorkdir: '/p',
      budget: { ...BUDGET },
      warning: null,
    });
    assert.deepEqual(r2.effects, [{ kind: 'emit', event: { kind: 'runner-ready' } }]);
  });

  it('受理闸（F1）：launching / running / aborting 相一律 409，只有 idle 放行', () => {
    const mk = (run) =>
      M.update(
        { ...ready(), run },
        { type: 'ui-run-requested', req: REQ, workdir: '/p', workdirExists: true },
      );
    for (const run of ['launching', 'running', 'aborting']) {
      const r = mk(run);
      assert.deepEqual(
        rejects(r.effects).map((e) => e.status),
        [409],
        `run=${run} 必须 409（F1：launching 窄窗口也算在飞）`,
      );
      assert.equal(r.state.run, run, '被拒的请求不改相位');
    }
    const ok = mk('idle');
    assert.deepEqual(rejects(ok.effects), []);
    assert.equal(ok.state.run, 'launching', '受理 ⇒ 进入 launching 占位相');
  });

  it('ui-run-requested（同菜单）：不重启，effects = disarm + send-ipc；pendingNote 挂好', () => {
    const r = M.update(ready(), {
      type: 'ui-run-requested',
      req: REQ,
      workdir: '/p',
      workdirExists: true,
    });
    assert.deepEqual(kinds(r.effects), ['disarm-abort-timer', 'send-ipc']);
    const send = r.effects[1];
    assert.deepEqual(send.message, {
      type: 'run',
      request: {
        prompt: '跑一下',
        workdir: '/p',
        multiTurn: true, // hello 声明了多轮 ⇒ 缺省开（OR 规则，multiTurnDefault）
        sessionId: 'dev', // 会话 id 由父进程给，不是面板传上来的
        toolSources: null,
      },
    });
    assert.deepEqual(r.state.pendingNote, {
      prompt: '跑一下',
      workdir: '/p',
      toolSources: null,
      multiTurn: true,
    });
  });

  it('ui-run-requested（收窄菜单 / 子进程缺席）⇒ restart 在 send-ipc 之前', () => {
    const narrowed = M.update(ready(), {
      type: 'ui-run-requested',
      req: { prompt: '只要 hello', toolSources: ['hello'] },
      workdir: '/p',
      workdirExists: true,
    });
    assert.deepEqual(kinds(narrowed.effects), ['disarm-abort-timer', 'restart', 'send-ipc']);
    assert.deepEqual(narrowed.effects[1], {
      kind: 'restart',
      reason: '能力选择变化（toolSources）',
      toolSources: ['hello'],
    });
    assert.equal(narrowed.effects[2].message.request.toolSources.join(','), 'hello');
    // 子进程缺席 ⇒ 同样是先起再发
    const absent = M.update(base(), {
      type: 'ui-run-requested',
      req: REQ,
      workdir: '/p',
      workdirExists: true,
    });
    assert.deepEqual(kinds(absent.effects), ['disarm-abort-timer', 'restart', 'send-ipc']);
    assert.equal(absent.effects[1].toolSources, null);
  });

  it('ui-run-requested（目录不存在）⇒ 400；与旧代码同序：闸之后才判目录', () => {
    const r = M.update(ready(), {
      type: 'ui-run-requested',
      req: { prompt: 'x', workdir: '/nope' },
      workdir: '/nope',
      workdirExists: false,
    });
    assert.deepEqual(r.effects, [
      { kind: 'disarm-abort-timer' },
      { kind: 'reject', status: 400, message: '工作目录不存在或不是文件夹：/nope' },
    ]);
    assert.equal(r.state.run, 'idle', '400 不占位（占位期间不会有 400 把相位留在 launching）');
    // 闸先于目录：running 时即使目录坏也是 409
    const busy = M.update(
      { ...ready(), run: 'running' },
      {
        type: 'ui-run-requested',
        req: { prompt: 'x', workdir: '/nope' },
        workdir: '/nope',
        workdirExists: false,
      },
    );
    assert.deepEqual(
      rejects(busy.effects).map((e) => e.status),
      [409],
    );
  });

  it('run-launched ⇒ running + emit run-start（取自 pendingNote）', () => {
    const s = M.update(ready(), {
      type: 'ui-run-requested',
      req: REQ,
      workdir: '/p',
      workdirExists: true,
    }).state;
    const r = M.update(s, { type: 'run-launched' });
    assert.equal(r.state.run, 'running');
    assert.deepEqual(r.effects, [
      {
        kind: 'emit',
        event: {
          kind: 'run-start',
          prompt: '跑一下',
          workdir: '/p',
          toolSources: null,
          multiTurn: true,
        },
      },
    ]);
  });

  it('run-launch-failed ⇒ 复位（idle + pendingNote 清空）+ reject 500；攒着 pendingRestart 就当场补重启', () => {
    const launching = M.update(ready(), {
      type: 'ui-run-requested',
      req: REQ,
      workdir: '/p',
      workdirExists: true,
    }).state;
    const plain = M.update(launching, { type: 'run-launch-failed', message: 'runner 起不来' });
    assert.equal(plain.state.run, 'idle');
    assert.equal(plain.state.pendingNote, null, 'pendingNote 不留（否则挂到下一轮的 traceId 上）');
    assert.deepEqual(plain.effects, [{ kind: 'reject', status: 500, message: 'runner 起不来' }]);

    const withPending = M.update(
      { ...launching, pendingRestart: '文件变更：src/a.ts' },
      { type: 'run-launch-failed', message: 'runner 起不来' },
    );
    // 「没发成功 ⇒ 立刻补上延后重启」（旧 finally 的职责）：restart 先于 reject
    assert.deepEqual(kinds(withPending.effects), ['restart', 'reject']);
    assert.deepEqual(withPending.effects[0], {
      kind: 'restart',
      reason: '文件变更：src/a.ts',
      toolSources: null,
    });
    assert.equal(withPending.state.pendingRestart, null, 'pendingRestart 收敛：迁出即清空');
  });

  it('ipc-run-start ⇒ running', () => {
    const r = M.update({ ...ready(), run: 'launching' }, { type: 'ipc-run-start' });
    assert.equal(r.state.run, 'running');
    assert.deepEqual(r.effects, []);
  });

  it('ipc-run-done（成功）⇒ idle + disarm + note-run + emit run-done；lastError 摘旧（G1 的清零点）', () => {
    const launched = M.update(ready(), {
      type: 'ui-run-requested',
      req: REQ,
      workdir: '/p',
      workdirExists: true,
    }).state;
    const s = { ...launched, run: 'running', lastError: '上一轮留下的旧错误' };
    const r = M.update(s, {
      type: 'ipc-run-done',
      traceId: 't1',
      ok: true,
      stopReason: 'end_turn',
      error: null,
      finalText: '回话',
    });
    assert.equal(r.state.run, 'idle');
    assert.equal(r.state.lastError, null, '成功 ⇒ 旧错误从告警条摘下');
    assert.equal(r.state.pendingNote, null);
    assert.deepEqual(kinds(r.effects), ['disarm-abort-timer', 'note-run', 'emit']);
    // 回复正文必须**跟着 note 落账**：`finalText` 只活在这一帧 IPC 消息里（trace 上没有它），
    // 不存下来的话，面板切到别的 run 再切回来就再也取不到这一轮的结论了。
    assert.deepEqual(r.effects[1], {
      kind: 'note-run',
      traceId: 't1',
      note: {
        prompt: '跑一下',
        workdir: '/p',
        toolSources: null,
        multiTurn: true,
        finalText: '回话',
      },
    });
    assert.deepEqual(r.effects[2].event, {
      kind: 'run-done',
      traceId: 't1',
      ok: true,
      stopReason: 'end_turn',
      error: null,
      finalText: '回话',
    });
  });

  it('ipc-run-done（中止）⇒ 不留 lastError（中止不是「环坏了」）；（失败非中止）⇒ lastError = error', () => {
    const s = { ...ready(), run: 'running' };
    const aborted = M.update(s, {
      type: 'ipc-run-done',
      traceId: 't1',
      ok: false,
      stopReason: 'aborted',
      error: 'run aborted',
      finalText: '',
    });
    assert.equal(aborted.state.lastError, null, 'aborted 的 ok=false 也不该上告警条');
    const failed = M.update(s, {
      type: 'ipc-run-done',
      traceId: 't2',
      ok: false,
      stopReason: 'error',
      error: 'api 400',
      finalText: '',
    });
    assert.equal(failed.state.lastError, 'api 400');
    // traceId 为 null ⇒ 不记 note，但 pendingNote 仍要清
    const withNote = {
      ...s,
      pendingNote: { prompt: 'p', workdir: '/p', toolSources: null, multiTurn: false },
    };
    const noTrace = M.update(withNote, {
      type: 'ipc-run-done',
      traceId: null,
      ok: true,
      stopReason: 'end_turn',
      error: null,
      finalText: '',
    });
    assert.deepEqual(kinds(noTrace.effects), ['disarm-abort-timer', 'emit']);
    assert.equal(noTrace.state.pendingNote, null);
  });

  it('ipc-run-done：没有回复时不写 `finalText` 键（「没回复」与「回复丢了」要能区分）', () => {
    const s = {
      ...ready(),
      run: 'running',
      pendingNote: { prompt: 'p', workdir: '/p', toolSources: null, multiTurn: false },
    };
    const r = M.update(s, {
      type: 'ipc-run-done',
      traceId: 't1',
      ok: true,
      stopReason: 'end_turn',
      error: null,
      finalText: '',
    });
    const noteEffect = r.effects.find((e) => e.kind === 'note-run');
    assert.ok(noteEffect, '有 note 就该落账（否则连 prompt 都丢了）');
    assert.ok(
      !('finalText' in noteEffect.note),
      '空回复不该写 `finalText: undefined` —— 面板要靠「键在不在」判这一轮有没有回复',
    );
  });

  it('pendingRestart 收敛：run-done / run-error 收尾时各补一条 restart（afterRun）', () => {
    const pending = { ...ready(), run: 'running', pendingRestart: '文件变更：src/a.ts' };
    const done = M.update(pending, {
      type: 'ipc-run-done',
      traceId: null,
      ok: true,
      stopReason: 'end_turn',
      error: null,
      finalText: '',
    });
    assert.deepEqual(kinds(done.effects), ['disarm-abort-timer', 'emit', 'restart']);
    assert.deepEqual(done.effects[2], {
      kind: 'restart',
      reason: '文件变更：src/a.ts',
      toolSources: null,
    });
    assert.equal(done.state.pendingRestart, null);

    const err = M.update(pending, { type: 'ipc-run-error', message: '装配失败' });
    assert.deepEqual(kinds(err.effects), ['disarm-abort-timer', 'emit', 'restart']);
    assert.equal(err.state.pendingRestart, null);
    // closing ⇒ 不重启
    const closing = M.update(
      { ...pending, closing: true },
      { type: 'ipc-run-error', message: 'x' },
    );
    assert.deepEqual(kinds(closing.effects), ['disarm-abort-timer', 'emit']);
  });

  it('ipc-run-error ⇒ idle + pendingNote 清空 + lastError + emit runner-error（恰好一帧）', () => {
    const s = {
      ...ready(),
      run: 'running',
      pendingNote: { prompt: 'p', workdir: '/p', toolSources: null, multiTurn: false },
    };
    const r = M.update(s, { type: 'ipc-run-error', message: '装配失败：x' });
    assert.equal(r.state.run, 'idle');
    assert.equal(r.state.pendingNote, null);
    assert.equal(r.state.lastError, '装配失败：x');
    assert.deepEqual(emits(r.effects), [
      { kind: 'emit', event: { kind: 'runner-error', message: '装配失败：x' } },
    ]);
  });

  it('child-exit（starting = 启动失败）：G1 归因 + **零 emit**（F4：发射权在等 spawn 的那侧）', () => {
    const spawn = (lastError) => {
      let s = base();
      s = { ...s, lastError };
      return M.update(s, { type: 'child-spawned', toolSources: null }).state;
    };
    // 这一代没写出新原因（lastError === errBaseline）⇒ 通用文案 —— G1 的核心：
    // 「上一代的旧错误」不能被当成这一代退出的原因（`??` 的旧写法在这里就错）
    const same = M.update(spawn('上一代旧错误'), { type: 'child-exit', how: 'code=1' });
    assert.equal(
      same.state.lastError,
      M.startupExitMessage('code=1'),
      'lastError === errBaseline 是「没写新原因」，要用通用文案（G1）',
    );
    assert.equal(same.state.child, 'absent');
    assert.deepEqual(emits(same.effects), [], '启动失败路径零 emit（F4）');
    assert.deepEqual(kinds(same.effects), ['disarm-abort-timer']);
    // 这一代写出了新原因（≠ 基线）⇒ 用那句人话
    const newer = M.update(
      { ...spawn(null), lastError: '装配失败：esbuild 报错' },
      { type: 'child-exit', how: 'code=1' },
    );
    assert.equal(newer.state.lastError, '装配失败：esbuild 报错');
    assert.deepEqual(emits(newer.effects), []);
  });

  it('child-exit（ready = 意外退出）：归因 + 恰好一帧 runner-error；closing ⇒ 静默摘除', () => {
    const s = { ...ready(), run: 'running' };
    const r = M.update(s, { type: 'child-exit', how: 'code=null, signal=SIGSEGV' });
    assert.equal(r.state.child, 'absent');
    assert.equal(r.state.toolSources, null, '进程没了 ⇒ 「它跑的是什么选择」一起没了');
    assert.equal(r.state.run, 'idle');
    assert.equal(r.state.lastError, 'dev runner 意外退出（code=null, signal=SIGSEGV）');
    assert.deepEqual(emits(r.effects), [
      {
        kind: 'emit',
        event: {
          kind: 'runner-error',
          message: 'dev runner 意外退出（code=null, signal=SIGSEGV）',
        },
      },
    ]);
    // closing：摘掉当代即可，不归因、不广播（旧代码 `if (!isCurrent || closing) return`）
    const c = M.update(
      { ...s, closing: true, lastError: '留着' },
      { type: 'child-exit', how: 'code=0' },
    );
    assert.equal(c.state.child, 'absent');
    assert.equal(c.state.lastError, '留着');
    assert.deepEqual(c.effects, []);
    // absent：防御性无操作（接线层本不该派发这种）
    const a = M.update(base(), { type: 'child-exit', how: 'code=0' });
    assert.equal(a.state.child, 'absent');
    assert.deepEqual(a.effects, []);
  });

  it('child-stopped（主动停）⇒ run 相位落下（running/aborting → idle），launching 不动', () => {
    const r = M.update({ ...ready(), run: 'aborting' }, { type: 'child-stopped' });
    assert.equal(r.state.child, 'absent');
    assert.equal(
      r.state.run,
      'idle',
      '子进程没了 ⇒ 不可能再有在飞 run（旧代码漏过这行 ⇒ 面板永久 409）',
    );
    assert.deepEqual(kinds(r.effects), ['disarm-abort-timer']);
    const l = M.update({ ...ready(), run: 'launching' }, { type: 'child-stopped' });
    assert.equal(l.state.run, 'launching', 'launching 归 launch 流程自己收（run-launch-failed）');
  });

  it('中止流：idle 拒 409；running ⇒ send run-abort + arm(5s) + aborting；再点幂等；发不出去退回 running', () => {
    const idle = M.update(ready(), { type: 'ui-abort-requested' });
    assert.deepEqual(
      rejects(idle.effects).map((e) => e.status),
      [409],
    );
    // running 但子进程缺席 ⇒ 同样 409（与旧代码 `!running || !child` 同口径）
    const noChild = M.update({ ...base(), run: 'running' }, { type: 'ui-abort-requested' });
    assert.deepEqual(
      rejects(noChild.effects).map((e) => e.status),
      [409],
    );

    const s = { ...ready(), run: 'running' };
    const r = M.update(s, { type: 'ui-abort-requested' });
    assert.equal(r.state.run, 'aborting');
    assert.deepEqual(r.effects, [
      { kind: 'send-ipc', message: { type: 'run-abort' } },
      { kind: 'arm-abort-timer', ms: M.ABORT_GRACE_MS },
    ]);
    assert.equal(M.ABORT_GRACE_MS, 5_000, '兜底宽限是 5s（语义变更要过脑）');
    // 幂等：aborting 相再点 ⇒ 空效果（不再挂第二个计时器）
    const again = M.update(r.state, { type: 'ui-abort-requested' });
    assert.deepEqual(again.effects, []);
    assert.equal(again.state.run, 'aborting');
    // send 没发出去 ⇒ 相位退回 running（中止没生效，run 还在飞）
    const back = M.update(r.state, { type: 'abort-send-failed', message: '通道断' });
    assert.equal(back.state.run, 'running');
    assert.deepEqual(back.effects, []);
  });

  it('abort-grace-expired：aborting ⇒ lastError + restart（带当代菜单）；其它相位 ⇒ 空操作', () => {
    const s = { ...ready(), run: 'aborting', toolSources: ['hello'] };
    const r = M.update(s, { type: 'abort-grace-expired' });
    assert.equal(r.state.run, 'idle');
    assert.equal(
      r.state.lastError,
      '中止超时（工具不响应 signal）⇒ 已重启 runner 兜底：这次 run 的 trace 丢了',
    );
    assert.deepEqual(r.effects, [
      {
        kind: 'restart',
        reason: '中止超时：run 不响应 signal（工具可能不可取消）',
        toolSources: ['hello'],
      },
    ]);
    for (const run of ['idle', 'launching', 'running']) {
      const stale = M.update({ ...ready(), run }, { type: 'abort-grace-expired' });
      assert.deepEqual(stale.effects, [], `run=${run} 的迟到期是残余（已被 disarm）`);
      assert.equal(stale.state.lastError, null);
    }
  });

  it('ui-clear-session：在飞 409；空闲换 id + 落盘效果；launching 窗口内允许（旧口径）', () => {
    const busy = M.update({ ...ready(), run: 'running' }, { type: 'ui-clear-session' });
    assert.deepEqual(
      rejects(busy.effects).map((e) => e.status),
      [409],
    );
    const aborting = M.update({ ...ready(), run: 'aborting' }, { type: 'ui-clear-session' });
    assert.deepEqual(
      rejects(aborting.effects).map((e) => e.status),
      [409],
    );
    const r = M.update(ready(), { type: 'ui-clear-session' });
    assert.equal(r.state.sessionId, 'dev-2');
    assert.deepEqual(r.effects, [{ kind: 'persist-session-id', id: 'dev-2' }]);
    const launching = M.update({ ...ready(), run: 'launching' }, { type: 'ui-clear-session' });
    assert.equal(
      launching.state.sessionId,
      'dev-2',
      'sessionId 在 send-ipc 那一刻才读 ⇒ 窗口内换 id 安全',
    );
  });

  it('pick 串行化 + G2 断开出口：在飞 ⇒ 409；cancel ⇒ kill-pickers；resolved ⇒ 落下', () => {
    const r = M.update(ready(), { type: 'ui-pick-requested' });
    assert.equal(r.state.picking, true);
    assert.deepEqual(r.effects, [{ kind: 'pick-folder' }]);
    const dup = M.update(r.state, { type: 'ui-pick-requested' });
    assert.deepEqual(
      rejects(dup.effects).map((e) => e.status),
      [409],
    );
    // G2：客户端在等待期间断开 ⇒ 出口存在且只发 kill-pickers（picking 由随后的 resolved 落下）
    const cancel = M.update(r.state, { type: 'ui-pick-cancelled' });
    assert.deepEqual(cancel.effects, [{ kind: 'kill-pickers' }]);
    assert.equal(cancel.state.picking, true, 'picking 由 resolved 落，不由 cancel 落');
    const resolved = M.update(r.state, { type: 'ui-pick-resolved' });
    assert.equal(resolved.state.picking, false);
    assert.deepEqual(resolved.effects, []);
    // 没在飞时 cancel 是空操作
    const noop = M.update(ready(), { type: 'ui-pick-cancelled' });
    assert.deepEqual(noop.effects, []);
    // 平台不支持 ⇒ 501 + 落下
    const failed = M.update(r.state, { type: 'ui-pick-failed', message: '该平台没有原生选择器' });
    assert.equal(failed.state.picking, false);
    assert.deepEqual(failed.effects, [
      { kind: 'reject', status: 501, message: '该平台没有原生选择器' },
    ]);
  });

  it('file-changed：空闲 ⇒ restart（带当代菜单与文件名）；在飞/launching ⇒ pendingRestart 延后；closing ⇒ 忽略', () => {
    const s = { ...ready(), toolSources: ['hello'] };
    const r = M.update(s, { type: 'file-changed', rel: 'src/a.ts' });
    assert.deepEqual(r.effects, [
      { kind: 'restart', reason: '文件变更：src/a.ts', toolSources: ['hello'] },
    ]);
    assert.equal(r.state.pendingRestart, null);
    for (const run of ['running', 'launching', 'aborting']) {
      const d = M.update({ ...s, run }, { type: 'file-changed', rel: 'src/b.md' });
      assert.equal(
        d.state.pendingRestart,
        '文件变更：src/b.md',
        `run=${run} 在飞 ⇒ 延后（F1 同源判据）`,
      );
      assert.deepEqual(d.effects, []);
    }
    const c = M.update({ ...s, closing: true }, { type: 'file-changed', rel: 'src/c.ts' });
    assert.deepEqual(c.effects, []);
    assert.equal(c.state.pendingRestart, null);
  });

  it('restart-failed / boot-failed：lastError 落账 + 各自**恰好一帧** runner-error（boot 多一条终端 error）', () => {
    const rf = M.update(ready(), { type: 'restart-failed', message: '起不来' });
    assert.equal(rf.state.lastError, '起不来');
    assert.deepEqual(rf.effects, [
      { kind: 'emit', event: { kind: 'runner-error', message: '起不来' } },
    ]);
    const bf = M.update(ready(), { type: 'boot-failed', message: '起不来' });
    assert.equal(bf.state.lastError, '起不来');
    assert.deepEqual(bf.effects, [
      { kind: 'log', level: 'error', message: '[agentia] 起不来' },
      { kind: 'emit', event: { kind: 'runner-error', message: '起不来' } },
    ]);
  });

  it('child-spawn-failed / child-ready-timeout：摘掉当代 + lastError；超时多一条 kill-child', () => {
    const starting = M.update(base(), { type: 'child-spawned', toolSources: ['hello'] }).state;
    const sf = M.update(starting, { type: 'child-spawn-failed', message: 'spawn node ENOENT' });
    assert.equal(sf.state.child, 'absent');
    assert.equal(sf.state.toolSources, null);
    assert.equal(sf.state.lastError, '启动 dev runner 失败：spawn node ENOENT');
    assert.deepEqual(sf.effects, [], '失败的那帧由 restart-failed / boot-failed 发（F4）');
    const to = M.update(starting, { type: 'child-ready-timeout' });
    assert.equal(to.state.child, 'absent');
    assert.equal(
      to.state.lastError,
      `dev runner 启动超时（${M.READY_TIMEOUT_MS} ms 内没有就绪信号）`,
    );
    assert.deepEqual(to.effects, [{ kind: 'kill-child' }]);
  });

  it('shutdown：第一次 ⇒ closing + 收尾四件（按序）；第二次 ⇒ exit-now（按不动的 Ctrl+C 是大忌）', () => {
    const r = M.update(ready(), { type: 'shutdown' });
    assert.equal(r.state.closing, true);
    assert.deepEqual(kinds(r.effects), [
      'stop-watchers',
      'kill-pickers',
      'stop-child',
      'close-inspector',
    ]);
    const again = M.update(r.state, { type: 'shutdown' });
    assert.deepEqual(again.effects, [{ kind: 'exit-now' }]);
  });

  it('trace-event：原样转发成一条 emit（父进程零解释）', () => {
    const ev = {
      seq: 1,
      type: 'span.begin',
      span: {
        spanId: 's',
        traceId: 't',
        parentSpanId: null,
        kind: 'run',
        name: 'run',
        startedAt: 1,
        status: 'running',
        attributes: {},
        events: [],
      },
    };
    const r = M.update(ready(), { type: 'trace-event', event: ev });
    assert.deepEqual(r.effects, [{ kind: 'emit', event: { kind: 'trace-event', event: ev } }]);
  });

  it('runGateFlags 折算：aborting 算 running（旧布尔口径），launching 单列', () => {
    const f = (run) => M.runGateFlags({ ...ready(), run });
    assert.deepEqual(f('idle'), { running: false, launching: false });
    assert.deepEqual(f('launching'), { running: false, launching: true });
    assert.deepEqual(f('running'), { running: true, launching: false });
    assert.deepEqual(f('aborting'), { running: true, launching: false });
  });

  it('resolveWorkdir：空值回落缺省目录（fs 判定是接线层的事，机器只收事实）', () => {
    assert.equal(M.resolveWorkdir({ prompt: 'x' }, '/p'), '/p');
    assert.equal(M.resolveWorkdir({ prompt: 'x', workdir: '' }, '/p'), '/p');
    assert.equal(M.resolveWorkdir({ prompt: 'x', workdir: '/w' }, '/p'), '/w');
  });

  it('nextSessionId：dev → dev-2 → dev-3（从 dev.ts 迁来，dist/dev.js 仍 re-export）', () => {
    assert.equal(M.nextSessionId('dev'), 'dev-2');
    assert.equal(M.nextSessionId('dev-2'), 'dev-3');
    assert.equal(M.nextSessionId('weird'), 'dev-2');
  });
});

/*
 * ⚠️ 反向验证记录（本文件落地时真做过，不是口头承诺；每次做完都改了回去并重建转绿）：
 *
 * G1（归因判据）：把 dev-machine.ts 的 child-exit（starting 分支）临时改回旧语义
 *   `lastError ?? generic`（即删掉 exitReason 调用）⇒ 重新 build:cli 后，
 *   「child-exit（starting = 启动失败）」一条红：`lastError === errBaseline` 的用例
 *   拿到的是上一代旧错误而不是通用文案 —— 正是 G1 的归因误导。
 *
 * F1（launching 闸）：把 runGateFlags 临时改成 `launching: false`（闸只判 running 的
 *   旧写法）⇒ 重新 build:cli 后红了三条：「受理闸（F1）」（launching 相的请求被放行，
 *   没有 409）、「file-changed」（launching 窗口内的文件变更不再延后）、
 *   「runGateFlags 折算」—— 窄窗口从三条独立断言同时暴露。
 */
