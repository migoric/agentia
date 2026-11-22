/*
 * 架构守卫 —— **共同策略字段只声明一次**（2026-11-22，`RunPolicyInput` 抽取时的配套）。
 *
 * 为什么需要它：`RunAgentOptions` 与 `RunInvocationOptions` 此前各声明了同样的 25 个字段，
 * 类型逐字相同。现在它们都 `extends RunPolicyInput`，重复声明没了 —— 但 TypeScript
 * **允许**子接口重声明一个类型兼容的成员（不报错、不警告），所以「谁顺手抄回来一个字段」
 * 会静默通过类型检查，然后把两份声明重新长出来，漂移的窗口又打开了。
 *
 * 本守卫只做一件事：**两个子接口的成员集合与基底不相交**。它不判类型（那是 tsc 的事，
 * 不兼容的重声明 tsc 会红）—— 它判「有没有第二份声明存在」这件事本身。
 *
 * ⚠️ 为什么用文本解析而不是类型体操：`keyof` 拿不到「哪些键是本接口自己声明的」——
 * 继承后 `keyof RunAgentOptions` 包含基底那些键，正好是要区分的东西。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENGINE = fileURLToPath(new URL('../../src/engine/', import.meta.url));

/** 取 `interface <header>` 的成员名（只认行首两空格的 `name?:` / `name:` 声明） */
function membersOf(source: string, header: string): string[] {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `找不到接口 ${header} —— 守卫的输入变了，它已经失效`);
  const open = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let k = open; k < source.length; k++) {
    if (source[k] === '{') depth += 1;
    if (source[k] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = k;
        break;
      }
    }
  }
  assert.notEqual(end, -1, `接口 ${header} 的括号没配平`);
  const names: string[] = [];
  for (const line of source.slice(open + 1, end).split('\n')) {
    const m = line.match(/^ {2}([A-Za-z_][A-Za-z0-9_]*)\??:/);
    if (m?.[1] !== undefined) names.push(m[1]);
  }
  return names;
}

const typesSrc = readFileSync(`${ENGINE}types.ts`, 'utf8');
const specSrc = readFileSync(`${ENGINE}spec.ts`, 'utf8');

const base = membersOf(typesSrc, 'export interface RunPolicyInput {');
const agent = membersOf(typesSrc, 'export interface RunAgentOptions<');
const invoc = membersOf(specSrc, 'export interface RunInvocationOptions extends RunPolicyInput {');

test('真空护栏：三个接口都解析出成员（否则下面的「不相交」是假的）', () => {
  assert.ok(base.length >= 20, `基底只解析到 ${base.length} 个成员（预期 ≥ 20）`);
  assert.ok(agent.length >= 5, `RunAgentOptions 只解析到 ${agent.length} 个自有成员`);
  assert.ok(invoc.length >= 4, `RunInvocationOptions 只解析到 ${invoc.length} 个自有成员`);
});

test('两个子接口不得重声明基底的任何字段', () => {
  const baseSet = new Set(base);
  for (const [label, own] of [
    ['RunAgentOptions', agent],
    ['RunInvocationOptions', invoc],
  ] as const) {
    const dup = own.filter((n) => baseSet.has(n));
    assert.deepEqual(
      dup,
      [],
      `${label} 重声明了 ${dup.join(' / ')} —— 这些键已由 RunPolicyInput 提供。\n` +
        '⚠️ TypeScript 对「类型兼容的重声明」不报错，所以重复会静默长回来；\n' +
        '两份声明漂移的症状是「同一份调用参数，走异步宿主与走程序内行为不同」。\n' +
        '改法：删掉子接口里的那份，若语义要按层补充，写进 RunPolicyInput 的注释（按层分段）。',
    );
  }
});

test('分类器自证：重声明一个基底字段会被抓出来（合成样本）', () => {
  const sample = `
interface Base {
  a?: string;
}
interface Child extends Base {
  a?: string;
  b?: string;
}
`;
  const b = membersOf(sample, 'interface Base {');
  const c = membersOf(sample, 'interface Child extends Base {');
  const bSet = new Set(b);
  assert.deepEqual(b, ['a']);
  assert.deepEqual(
    c.filter((n) => bSet.has(n)),
    ['a'],
    '解析器把重声明的字段漏掉了 —— 守卫会假绿',
  );
  assert.deepEqual(
    c.filter((n) => !bSet.has(n)),
    ['b'],
    '解析器把自有字段也算成重复了 —— 守卫会误报，人会去关掉它',
  );
});
