/* 跨包口径守卫：框架的 `AgentStopReason`（`src/engine/types.ts`）与面板的中文短语表
 * （`panel-logic.ts` 的 `STOP_REASON_TEXT`）必须对得上。
 *
 * 为什么需要一条**读源码**的守卫（而不是普通的单测）：两张表分处两个包，CLI 零运行时依赖、
 * 不能 import 框架（trace 来自**用户工程**里那份 @migor/agentia），所以类型层面没有连接点。
 * 漂移的样子又是静默的 —— 框架加了第 15 个 stop reason：
 *   - 面板把它归进「被拦住」（保守，不算说谎），
 *   - 但列表第二行会露出裸标识符 `new_reason`，用户不知道那是「预算撞了」还是「模型拒答」。
 * 而如果新原因其实属于正常收尾，蓝点会消失、变成红点 —— 那才是「成功显示成失败」。
 * 单测里也没法盯：那需要把框架的联合类型抄一份进来，抄的那份正是会腐化的东西。
 *
 * 这条守卫的判据是「**源码里的成员**」：谁往 `AgentStopReason` 加一个成员，
 * 这里就多一条断言，面板不表态就红。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as L from '../dist/panel-logic.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/cli/test → packages/cli → packages → 仓库根 */
const TYPES_TS = join(HERE, '..', '..', '..', 'src', 'engine', 'types.ts');

/**
 * 从 `export type AgentStopReason = …;` 里摘出成员名。
 *
 * 只认**行首 `|`** 的字符串字面量 —— 那个联合体的注释里散落着 `'aborted'`、`'suspended'`
 * 之类的例子（讲语义时必然要提），按裸正则全文扫会把注释里的词也算成成员。
 */
function agentStopReasonMembers() {
  const src = readFileSync(TYPES_TS, 'utf8');
  const at = src.indexOf('export type AgentStopReason');
  assert.ok(
    at >= 0,
    `在 ${TYPES_TS} 里找不到 \`export type AgentStopReason\` —— 改名了？那这条守卫要跟着改`,
  );
  const end = src.indexOf(';', at);
  assert.ok(end > at, 'AgentStopReason 的声明没有以 `;` 结束，解析器看不懂了');
  const body = src.slice(at, end);
  const members = [...body.matchAll(/^\s*\|\s*'([^']+)'/gm)].map((m) => m[1]);
  assert.ok(members.length >= 13, `只解析到 ${members.length} 个成员，多半是解析器坏了`);
  return members;
}

it('框架每加一个 stop reason，面板都必须给出中文说法', () => {
  const members = agentStopReasonMembers();
  for (const m of members) {
    const text = L.stopReasonText(m);
    assert.ok(text, `${m} 在面板里没有显示文案（列表会显示成空白）`);
    // `error` 是唯一允许原样显示的成员：它本身就是给人读的词，翻成中文反而绕
    if (m !== 'error') {
      assert.notEqual(
        text,
        m,
        `${m} 只能原样显示 —— 面板还没给它中文短语（请补 STOP_REASON_TEXT）`,
      );
    }
  }
});

it('面板认识的原因，框架里都必须有（防止面板自己编一个）', () => {
  const members = new Set(agentStopReasonMembers());
  // 从源码里读面板的那张表：导出面没有它，而且这条守卫要看的就是「表里有什么」
  const src = readFileSync(join(HERE, '..', 'src', 'panel-logic.ts'), 'utf8');
  const at = src.indexOf('const STOP_REASON_TEXT');
  assert.ok(at >= 0, '找不到 STOP_REASON_TEXT —— 改名了？那这条守卫要跟着改');
  const end = src.indexOf('\n};', at);
  const keys = [...src.slice(at, end).matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]);
  assert.ok(keys.length >= 13, `只解析到 ${keys.length} 个短语，多半是解析器坏了`);
  for (const k of keys) {
    assert.ok(
      members.has(k),
      `面板里的 ${k} 在 AgentStopReason 里不存在（拼错了？还是框架删了？）`,
    );
  }
});
