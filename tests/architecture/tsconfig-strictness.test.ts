/*
 * 架构守卫 —— 「承重的 tsconfig 开关不得被悄悄关掉」的可执行版本。
 *
 * 为什么需要它：`exactOptionalPropertyTypes` 不是一个风格选项，它**根除了一整类缺陷**
 * （2026-09-18 第七轮迁移，39 处，见 docs/spec.md §10）。关掉它，防线不是「变弱」而是
 * **无声消失** —— 代码照常编译，`{foo: maybeUndefined}` 又能悄悄赋给 `foo?: T`，
 * 而 `retry.ts` 的「显式 undefined 覆盖缺省」正是这么发生的。
 *
 * 这个开关的承重性已经**反向验证**过：关掉它 ⇒ 本文件红，同时 `tsc` 会重新放过
 * `{foo: x | undefined}` → `foo?: T`。所以本文件是它的门禁。
 *
 * 射程（2026-10-13 扩）：此前只读根 tsconfig.json —— CLI 包（packages/cli）与脚手架
 * 模板的两份配置**没开**这个开关却照样天天编译，等于防线只罩住了一半代码。现在
 * 守卫覆盖 CONFIGS 里的每一份（含发给用户的模板 tsconfig —— 它决定用户项目的口径）。
 *
 * 同样钉住另外三个「看着像顺手改，实际会拆掉一层保证」的开关：
 * - `strict`：整条严格性谱系的根；
 * - `types: ["node"]`：全仓 @types/node 的显式来源（此前靠 import SDK 类型的传递链偶然
 *   进编译程序，SDK 退出运行时依赖后只能靠它，见 AGENTS.md）；
 * - `forceConsistentCasingInFileNames`：跨平台（大小写不敏感 FS）拼错路径的闸门。
 *
 * ⚠️ 刻意**不**钉的开关（对照根 tsconfig 逐项核过，免得下一个人重新纠结）：
 * - `lib` / `esModuleInterop`：由 `target` / `module: NodeNext` 隐含，写出来是冗余；
 * - `declaration` / `sourceMap`：是框架包**发布产物形状**的决定（CLI 只发 bin，不发类型），
 *   不属于「承重开关」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 承重开关必须在场的全部 tsconfig。新增一份编译入口（新包 / 新模板档）要登记进来 ——
 * 不登记的配置不在防线内（这正是 2026-10-13 之前 CLI 两份配置的漏法）。
 */
const CONFIGS = [
  'tsconfig.json',
  'packages/cli/tsconfig.json',
  'packages/cli/tsconfig.templates.json',
  'packages/cli/templates/tsconfig.json',
];

/** 读一个 tsconfig（容忍**整行** `//` 注释 —— tsconfig.templates.json 的头注就是这种；
 *  行尾注释不认，免得误伤字符串里的 `//`） */
function compilerOptions(relPath: string): Record<string, unknown> {
  const raw = readFileSync(join(repoRoot, relPath), 'utf8');
  const stripped = raw
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n');
  return (
    (JSON.parse(stripped) as { compilerOptions?: Record<string, unknown> }).compilerOptions ?? {}
  );
}

test('exactOptionalPropertyTypes 必须开启（关掉 = 一整类静默失效的防线无声消失）', () => {
  for (const cfg of CONFIGS) {
    const opts = compilerOptions(cfg);
    assert.equal(
      opts.exactOptionalPropertyTypes,
      true,
      `${cfg} 的 exactOptionalPropertyTypes 被关了。它不是风格选项：` +
        '关掉后 `{foo: maybeUndefined}` 又能赋给 `foo?: T`，' +
        '「显式 undefined 覆盖缺省」这类缺陷（详见 docs/spec.md §10 2026-09-18 第七轮）会重新变成合法代码。' +
        '要关请先在 spec §10 记决策，并删掉 docs/guards.md §1 的对应条目。',
    );
  }
});

test('strict / types:["node"] / forceConsistentCasingInFileNames 必须保留（各自承重，理由见文件头）', () => {
  for (const cfg of CONFIGS) {
    const opts = compilerOptions(cfg);
    assert.equal(opts.strict, true, `${cfg}：strict 是整条严格性谱系的根，不得关`);
    assert.deepEqual(
      opts.types,
      ['node'],
      `${cfg}：@types/node 的显式来源 —— 删掉后全仓会缺 Node 类型（SDK 退出运行时依赖后已无传递链）`,
    );
    assert.equal(
      opts.forceConsistentCasingInFileNames,
      true,
      `${cfg}：跨平台大小写拼写闸门（macOS 上拼错能编过、Linux CI 上才炸的那类）`,
    );
  }
});
