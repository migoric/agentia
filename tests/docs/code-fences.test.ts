/*
 * 元守卫 —— 文档里「照抄就能跑」的代码块，必须**真的编译得过**。
 *
 * 为什么需要它（2026-09-29 实测）：本仓 `docs/**` 的守卫面此前是分层的 ——
 *   - `usage-guide.test.ts` 守**表格首列的名字**（正向 + 反向穷尽各一遍）；
 *   - `run-output-shape.test.ts` 守 `.finalText` 这一种**定向形状**。
 * 而**围栏代码块内的 import / 调用签名 / 选项键**不受任何东西约束 —— 恰恰那一层才是
 * 用户会**逐字照抄**的。首次把 22 个含 `from '@migor/agentia'` 的块对拍一遍，实测 3 个照抄坏掉：
 *   ① `README.md` 的 `scheduler.every(…, { idempotencyKey })` —— `ScheduleEveryOptions` 里
 *      没有这个键（真名 `idempotencyPrefix`）。TS 报错；**JS 用户静默无幂等**，而示例上方的
 *      注释正写着「幂等键去重」。同块上一行的 `runner.submit(…, { idempotencyKey })` 是对的
 *      ⇒ 同一段里两个同名旋钮，一个在一个不在。
 *   ② `usage-guide.md` 的 `ctx!.deferUntil(due)` —— `ToolRunContext.deferUntil` 是**可选成员**，
 *      `!` 只消掉了 `ctx` 的 null ⇒ TS2722。
 *   ③ `usage-guide.md` 那个出站传播片段是**裸方法**（`@Tool` 挂在一个函数声明上）⇒ 根本不是合法 TS。
 * 三条都不是新引入的 —— 是**从未被检查过**。
 *
 * ## 判据
 *
 * 取样面 = 对外阅读面里含 `@migor/agentia` 具名导入的 ```ts 块。
 * 判据不是「文本里出现了某个名字」（那只挡得住已经发生过的那一种），而是**真编译**：
 * 每块落成一个文件，一次性交给 `tsc`，`paths` 指向 `src/index.ts`（**不需要先 build**）。
 *
 * ## 反假阳性（这三条决定了这条守卫能不能用）
 *
 * ① **语法错会连坐，必须迭代剔除**：实测 `tsc 7`（tsgo）**只要程序里存在语法错误就整体跳过
 *    语义阶段** —— 不处理的话，一个不可解析的片段会把其余**全部**错误吞掉、守卫变成静默全绿
 *    （实测：22 个块只报 3 条语法错，其余的 TS2353 / TS2722 一条都不报）。做法是跑一遍 →
 *    把报了语法错（`TS1xxx`，`TS18004` 除外，它是简写属性的语义错）的文件从 `files` 里摘掉 →
 *    再跑，直到没有语法错；**最后断言「被摘掉的块数为 0」**，让不可解析的片段必须当场修好。
 * ② **省略垫片**：文档块故意引用上文块里的 `app` / `messages` / `runner`。先把「名字不存在」
 *    类错误（TS2304/2552/2584/2591/18004）收成 `declare const X: any` 再跑 —— 垫片
 *    **只吃掉「名字不存在」，吃不掉「类型形状不对」**，所以残留的必是真错。
 * ③ **省略记号归一**：三种写法（花括号省略 / 方括号省略 / **块注释形态**，逐条见下面
 *    `ELISIONS` —— 块注释形态的记号这里不写出来，因为它会提前闭合本段注释）的文档含义都是
 *    「此处还有别的属性」。归一成 `{ ...({} as any) }` 而**不是** `{}` —— 后者会因缺必填项
 *    报错，是**守卫自己造的假阳性**（2026-09-29 实测：`createApp({ ... })` 归一成 `{}` 会报缺 `system`）。
 *
 * ## 两条自证（防「守卫悄悄什么都没检查」）
 *
 * - **金丝雀**：程序里固定塞一个**故意写错**的块，并断言它**必须被报出来**（`TS2353`）。
 *   编译链一旦静默退化（哪天 tsgo 改了抑制语义的规则、或 `paths` 断了），金丝雀先红。
 * - **取样下限**：块数跌破下限就报错，防止「文档改了写法 / 文件被移走」之后守卫空转。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 取样面：**对外阅读面**里的 markdown。
 * `docs/plans|reviews|articles` **刻意排除** —— 那些是当日快照，允许与今天的 API 不一致。
 */
const SAMPLE = [
  'README.md',
  'README.en.md',
  'docs/usage-guide.md',
  'docs/observability.md',
  'docs/eval-gate.md',
  'docs/roadmap.md',
  // 2026-10-17 ref-frameworks-compat：该页承诺「照抄可跑」的最小接入代码，
  // 且它踩过真坑（CJS 片段写成裸顶层 await，探针报 TS1309）⇒ 纳入取样面。
  'docs/frameworks.md',
  'examples/README.md',
  ...readdirSync(join(repoRoot, 'examples'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `examples/${e.name}/README.md`)
    .filter((p) => existsSync(join(repoRoot, p))),
];

const PKG = '@migor/agentia';

/** 只看「真的从包里 import 了东西」的块 —— 那才是「照抄可跑」的候选 */
const IMPORT_STMT = new RegExp(`import\\s+(?:type\\s+)?\\{[^}]*\\}\\s*from\\s*['"]${PKG}['"]`, 's');

/**
 * 「此处还有别的属性」的三种文档写法 ⇒ 归一成**展开 any**（形状不可知），而不是空容器 ——
 * 见头注 ③。吞掉的只有「本来就没打算检查的东西」，残留错误仍是真错误。
 */
const ELISIONS: [RegExp, string][] = [
  [/\{\s*\.\.\.\s*\}/g, '{ ...({} as any) }'],
  [/\[\s*\.\.\.\s*\]/g, '[...({} as any)]'],
  [/\/\*\s*(?:…|\.\.\.)\s*\*\//g, '...({} as any),'],
];

/** 「文档省略标记」：名字不存在 + 简写属性悬空。垫片吃得掉，形状错吃不掉。 */
const SHIMMABLE: Record<string, RegExp> = {
  TS2304: /Cannot find name '([^']+)'/,
  TS2552: /Cannot find name '([^']+)'/,
  TS2584: /Cannot find name '([^']+)'/,
  TS2591: /Cannot find name '([^']+)'/,
  TS18004: /shorthand property '([^']+)'/,
};

interface Block {
  doc: string;
  line: number;
  body: string;
}
interface Diag {
  file: string;
  line: number;
  code: string;
  msg: string;
}

function sampleBlocks(): Block[] {
  const out: Block[] = [];
  for (const rel of SAMPLE) {
    const lines = readFileSync(join(repoRoot, rel), 'utf8').split('\n');
    let i = 0;
    while (i < lines.length) {
      const open = /^```([\w+-]*)\s*$/.exec(lines[i] ?? '');
      if (!open) {
        i += 1;
        continue;
      }
      const lang = (open[1] ?? '').toLowerCase();
      const start = i + 1;
      let j = start;
      while (j < lines.length && !(lines[j] ?? '').startsWith('```')) j += 1;
      if (lang === 'ts' || lang === 'typescript' || lang === 'tsx') {
        let body = lines.slice(start, j).join('\n');
        if (IMPORT_STMT.test(body)) {
          for (const [pat, rep] of ELISIONS) body = body.replace(pat, rep);
          out.push({ doc: rel, line: start + 1, body });
        }
      }
      i = j + 1;
    }
  }
  return out;
}

const WORK = join(tmpdir(), 'agentia-doc-fence-guard');
const SHIM = 'shim.d.ts';
const CANARY = 'canary.ts';

/**
 * 金丝雀：**故意**用一个不存在的选项键（`ScheduleEveryOptions` 里没有 `idempotencyKey`）。
 * 它必须出现在诊断里 —— 不出现 = 这次编译根本没做语义检查，整条守卫是假的。
 */
const CANARY_SRC = `// 本文件由 tests/docs/code-fences.test.ts 生成，**故意写错**，勿修。
import { Scheduler } from '${PKG}';
declare const canaryScheduler: Scheduler;
canaryScheduler.every(60_000, 'canary', { idempotencyKey: 'canary' });
`;

function writeShim(names: string[]): void {
  writeFileSync(
    join(WORK, SHIM),
    `// 由 tests/docs/code-fences.test.ts 生成：文档块省略掉的上下文，按 any 垫上。\n${names
      .map((n) => `declare const ${n}: any;`)
      .join('\n')}\n`,
  );
}

function writeTsconfig(files: string[]): void {
  writeFileSync(
    join(WORK, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2022'],
          strict: true,
          exactOptionalPropertyTypes: true,
          esModuleInterop: true,
          skipLibCheck: true,
          noEmit: true,
          types: ['node'],
          typeRoots: [join(repoRoot, 'node_modules', '@types')],
          // ⚠️ TS 7 已移除 baseUrl（TS5102）；paths 相对本 tsconfig 解析。
          // 指向 src 而不是 dist：守卫**不依赖先 build**，也就不会在「没构建」时误红。
          // `@migor/agentia-observability` 的映射与 tsconfig.tests.json 同口径（那是本地小包）。
          paths: {
            [PKG]: [join(repoRoot, 'src', 'index.ts')],
            '@migor/agentia-observability': [
              join(repoRoot, 'examples', 'observability', 'src', 'index.ts'),
            ],
          },
        },
        files: [SHIM, CANARY, ...files],
      },
      null,
      2,
    ),
  );
}

function compile(): Diag[] {
  let out = '';
  try {
    out = execFileSync(
      process.execPath,
      [
        join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
        '--noEmit',
        '-p',
        'tsconfig.json',
      ],
      {
        cwd: WORK,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      },
    );
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const diags: Diag[] = [];
  for (const raw of out.split('\n')) {
    const m = /^(.*)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(raw.trim());
    if (!m) continue;
    diags.push({
      file: basename(m[1] ?? ''),
      line: Number(m[2]),
      code: m[4] ?? '',
      msg: m[5] ?? '',
    });
  }
  return diags;
}

describe('文档围栏代码块与源码一致（真编译）', () => {
  it('含 @migor/agentia 导入的块全部编译通过', () => {
    const blocks = sampleBlocks();
    // 取样面自检：写法变了 / 文件被移走时要报出来，否则这条守卫会悄悄变成「什么都没检查」
    assert.ok(blocks.length >= 20, `只抽到 ${blocks.length} 个块，取样面可能已失效`);

    mkdirSync(WORK, { recursive: true });
    writeFileSync(join(WORK, 'package.json'), '{ "type": "module" }\n');
    writeFileSync(join(WORK, CANARY), CANARY_SRC);

    const rel = (n: number) => `blocks/b${String(n).padStart(3, '0')}.ts`;
    const byFile = new Map<string, Block>();
    blocks.forEach((b, n) => {
      mkdirSync(join(WORK, 'blocks'), { recursive: true });
      writeFileSync(join(WORK, rel(n)), `${b.body}\n`);
      byFile.set(basename(rel(n)), b);
    });

    let files = blocks.map((_b, n) => rel(n));
    const shimmed = new Set<string>();
    const unparsable: Block[] = [];
    let canaryDiags: Diag[] = [];
    let residual: Diag[] = [];

    for (let round = 0; round < 10; round++) {
      writeShim([...shimmed].sort());
      writeTsconfig(files);
      const diags = compile();

      // ① 语法错连坐：把语法不自洽的块摘出去（否则它会吞掉全程序的语义诊断）
      const broken = new Set(
        diags.filter((d) => /^TS1\d\d\d$/.test(d.code) && d.code !== 'TS18004').map((d) => d.file),
      );
      if (broken.size > 0) {
        for (const f of broken) {
          const b = byFile.get(f);
          if (b) unparsable.push(b);
        }
        files = files.filter((f) => !broken.has(basename(f)));
        continue;
      }

      // ② 省略标记：垫上 `declare const X: any` 再来一轮
      const missing = new Set<string>();
      for (const d of diags) {
        const re = SHIMMABLE[d.code];
        const m = re?.exec(d.msg);
        if (m?.[1]) missing.add(m[1]);
      }
      const fresh = [...missing].filter((n) => !shimmed.has(n));
      if (fresh.length > 0) {
        for (const n of fresh) shimmed.add(n);
        continue;
      }

      // ③ 收敛：剩下的只可能是真错
      canaryDiags = diags.filter((d) => d.file === CANARY);
      residual = diags.filter((d) => d.file !== CANARY);
      break;
    }

    const locate = (d: Diag) => {
      const b = byFile.get(d.file);
      return b ? `${b.doc}:${b.line}（块内第 ${d.line} 行）` : d.file;
    };

    // 自证打头：先证明这次编译**真的在做语义检查**，否则下面的「无残留」没有意义
    assert.ok(
      canaryDiags.some((d) => d.code === 'TS2353'),
      `金丝雀没被报出来（实际诊断：${JSON.stringify(canaryDiags)}）—— 编译链静默退化了，` +
        '这条守卫此刻**什么都没检查**，先修编译链再看结论。',
    );

    assert.deepEqual(
      unparsable.map((b) => `${b.doc}:${b.line}`),
      [],
      '以下块**语法不自洽**，因此无法被编译检查（`tsc 7` 会因它整体跳过语义阶段）：\n' +
        `${unparsable.map((b) => `  ${b.doc}:${b.line}`).join('\n')}\n` +
        '请把它们补成完整、可编译的片段（例如把裸方法放回 class 里、补上必填的 schema）。',
    );

    assert.deepEqual(
      residual.map((d) => `${locate(d)} ${d.code} ${d.msg}`),
      [],
      `以下文档代码块**照抄编译不过**（文档承诺了、源码里没有）：\n${residual
        .map((d) => `  ${locate(d)}  ${d.code}  ${d.msg}`)
        .join('\n')}\n` + '要么改文档，要么改源码 —— 两者必须一致。',
    );
  });
});
