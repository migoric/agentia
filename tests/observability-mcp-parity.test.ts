/*
 * 「会话归组口径」第四份移植副本的守护 —— `examples/observability-mcp/src/traces.ts`
 * ↔ `packages/cli/src/report.ts`（真源）。
 *
 * 前三份移植副本（harvest / diffTraces / export）配的是**运行时逐字对拍**
 * （packages/cli/test 里 import 两边 dist 比产物）；这一份做不到同款，两个硬约束：
 * ① 示例必须可整目录拷走单用（README 明写「拷走 examples/observability-mcp/ 整个目录」）⇒
 *    示例侧代码不能反向 import `../../packages/cli`；
 * ② 示例的 dist 在 `npm test` 时未构建（verify-all 步序：build:cli 在步 5，示例构建在步 7 的
 *    e2e-examples 里）⇒ CLI 套件 import 示例 dist 会在 CI 里永久 skip（真空变绿）。
 *
 * ⇒ 退一格用**源码级双钉**（与 tests/transport/http-boundary-guard.test.ts 同族）：把
 * 「分组键三级回退」「taskId 提取」「(无会话) 桶名」三段 canonical 行钉成两份源码里
 * 逐字都在场 —— 任一侧改回退顺序 / 丢掉 taskId 层 / 改桶名，本文件红。
 * 行为面两边各有断言守着：CLI 侧 `packages/cli/test/report.test.mjs`（taskId 回退键用例）、
 * 示例侧 `examples/observability-mcp/src/verify.ts` §8。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const CLI_SRC = 'packages/cli/src/report.ts';
const EXAMPLE_SRC = 'examples/observability-mcp/src/traces.ts';

/* canonical 行段（含缩进 —— 两份源码同一套 Biome 风格，逐字可比） */
const GROUP_KEY = [
  '  const attrs = rootSpanOf(t)?.attributes as Record<string, unknown> | undefined;',
  "  const sid = attrs?.['session.id'];",
  "  if (typeof sid === 'string' && sid.length > 0) return sid;",
  '  return taskKey ?? NO_SESSION;',
].join('\n');
const TASK_KEY = [
  '  const id = (v as Record<string, unknown>).taskId;',
  "  return typeof id === 'string' && id.length > 0 ? id : null;",
].join('\n');
const NO_SESSION_CONST = "export const NO_SESSION = '(无会话)';";

describe('observability-mcp ↔ CLI 的会话归组口径（源码级双钉）', () => {
  const cli = readFileSync(CLI_SRC, 'utf8');
  const example = readFileSync(EXAMPLE_SRC, 'utf8');

  it('分组键三级回退在两份源码里逐字同体（session.id → taskId → (无会话)）', () => {
    assert.ok(cli.includes(GROUP_KEY), `CLI 侧分组键口径变了，示例侧要同步（${CLI_SRC}）`);
    assert.ok(example.includes(GROUP_KEY), `示例侧分组键口径变了，CLI 侧要同步（${EXAMPLE_SRC}）`);
  });

  it('taskId 提取（外层 wrapper 的顶层 taskId）在两份源码里逐字同体', () => {
    assert.ok(cli.includes(TASK_KEY), `CLI 侧 taskId 提取变了（${CLI_SRC}）`);
    assert.ok(example.includes(TASK_KEY), `示例侧 taskId 提取变了（${EXAMPLE_SRC}）`);
  });

  it('(无会话) 桶名是同一个常量、同一个字面量', () => {
    assert.ok(cli.includes(NO_SESSION_CONST), `CLI 侧桶名变了（${CLI_SRC}）`);
    assert.ok(example.includes(NO_SESSION_CONST), `示例侧桶名变了（${EXAMPLE_SRC}）`);
  });
});
