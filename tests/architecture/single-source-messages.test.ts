/*
 * 架构守卫 —— 三处「同一句话写在很多地方」的**单源化**（2026-11-22，复杂度评审）。
 *
 * ## 不守会怎样
 *
 * - `task 不存在: …` 曾出现在 **7 个文件**（SSE 订阅、取消、两条 HTTP 404、等待器、
 *   审批、信号）。它是**对外契约的一半**：使用者会 grep 它、宿主会拿它拼提示。改措辞漏一处
 *   的结果不是崩溃，而是「同一件事两种说法」，**没有任何测试会红**。
 * - `MCP 连接器已 close …` 同上，4 处。更糟的是调用方想「close 了就重建」只能**比对字符串**。
 * - `'AbortError'` 的判定曾分散在 4 个文件（engine 一份 + integrations 三份）。根因不是
 *   疏忽，而是**分层**：`integrations` 只许依赖 `core`，而谓词当时住在 `engine`。谓词下沉
 *   `core/timeout.ts` 后三份消失 —— 这条也钉住，否则下次有人为了「省一次 import」再写一遍。
 * - `（本次无文本输出）` 曾在**两个会话回写点**各写一份（`runtime/run.ts` 的常量 +
 *   `transport/async.ts` 的裸字面量），而两处都只读 `finalText` ⇒ 结构化结果在两条路径上
 *   一起丢（2026-11-25，见 `core/session-reply.ts` 头注）。文案与取值现在都单源，
 *   两个都守 —— 只守文案的话，下次有人「省一次函数调用」在调用点自己判空就又分叉了。
 *
 * ## 为什么不用 `lib/source-scan.ts`
 *
 * 它把字符串逐字遮蔽掉（它的职责是读模块说明符）。这里要找的恰恰是**代码里的字面量** ——
 * 但它旁边全是**注释里的同一句话**（本仓注释会引述文案）。所以需要的是「只抹注释、
 * 保留字符串」的遮蔽器，方向与它相反。下面自带一个最小实现，并用自证样本钉住它真能区分。
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(repoRoot, 'src');

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

/**
 * 把注释抹成空格（换行保留，行号不变），**字符串字面量原样保留**。
 *
 * 手写状态机而不是正则：`//` 会出现在字符串里（URL）、引号会出现在注释里，
 * 正则两种都会错，而错的方向恰好是「把要猎的东西抹掉」（假阴性）。
 */
function maskComments(src: string): string {
  const out = src.split('');
  type State = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl';
  let st: State = 'code';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (st === 'code') {
      if (c === '/' && n === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i++;
        st = 'line';
        continue;
      }
      if (c === '/' && n === '*') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i++;
        st = 'block';
        continue;
      }
      if (c === "'") st = 'sq';
      else if (c === '"') st = 'dq';
      else if (c === '`') st = 'tpl';
      continue;
    }
    if (st === 'line') {
      if (c === '\n') st = 'code';
      else out[i] = ' ';
      continue;
    }
    if (st === 'block') {
      if (c === '*' && n === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i++;
        st = 'code';
      } else if (c !== '\n') {
        out[i] = ' ';
      }
      continue;
    }
    // 字符串内：只处理转义与收尾，其余原样
    if (c === '\\') {
      i++;
      continue;
    }
    if ((st === 'sq' && c === "'") || (st === 'dq' && c === '"') || (st === 'tpl' && c === '`')) {
      st = 'code';
    }
  }
  return out.join('');
}

interface Hit {
  readonly file: string;
  readonly line: number;
}

function hitsOf(needle: string): Hit[] {
  const out: Hit[] = [];
  for (const abs of walk(SRC)) {
    const text = maskComments(readFileSync(abs, 'utf8'));
    let idx = text.indexOf(needle);
    while (idx !== -1) {
      out.push({
        file: relative(repoRoot, abs),
        line: text.slice(0, idx).split('\n').length,
      });
      idx = text.indexOf(needle, idx + needle.length);
    }
  }
  return out;
}

test('遮蔽器自证：看得见代码里的字面量，看不见注释里的同一句话', () => {
  const sample = [
    "const a = 'task 不存在: 1'; // task 不存在: 注释里",
    '/* task 不存在: 块注释',
    "   仍然在块注释里 */ const b = 'ok';",
    'const url = "https://x//y"; // 双斜杠在字符串里不是注释',
  ].join('\n');
  const masked = maskComments(sample);
  assert.equal(masked.split('task 不存在').length - 1, 1, '只该看见代码里那一处');
  assert.ok(masked.includes('https://x//y'), '字符串里的 // 不能被当注释抹掉');
  assert.equal(masked.split('\n').length, sample.split('\n').length, '行数必须不变');
});

test('task 不存在 —— 措辞只有一处定义，别处必须调 taskNotFound()', () => {
  const hits = hitsOf('task 不存在');
  const home = 'src/transport/task-not-found.ts';
  assert.deepEqual(
    hits.filter((h) => h.file !== home),
    [],
    `这句话只能写在 ${home}：其余位置请调 taskNotFound()，否则改措辞时会漏`,
  );
  assert.equal(hits.filter((h) => h.file === home).length, 1, '定义处应恰好一处模板字面量');
});

test('MCP 连接器已 close —— 只有一个形状', () => {
  const hits = hitsOf('MCP 连接器已 close');
  const home = 'src/integrations/mcp-protocol.ts';
  assert.deepEqual(
    hits.filter((h) => h.file !== home),
    [],
    `这句话只能写在 ${home}：其余位置请调 mcpClosedError()`,
  );
  assert.equal(hits.filter((h) => h.file === home).length, 1);
});

test("'AbortError' 判定只住在 core/timeout.ts —— integrations 别再手写", () => {
  const hits = hitsOf("'AbortError'");
  const files = [...new Set(hits.map((h) => h.file))];
  assert.deepEqual(
    files,
    ['src/core/timeout.ts'],
    '谓词与它的造法必须同处一地（形状与判据一起改）',
  );
  assert.ok(hits.length >= 2, '`abortError()` 与 `isAbortError()` 各一处，少一条说明被合并坏了');
});

test('（本次无文本输出）—— 占位文案只有一处定义，回写点必须调 sessionReplyContent()', () => {
  // 这条文案的下游是**可识别的**：宿主会按字符串认出它是占位符（用于展示「这一轮没说话」）。
  // 2026-11-25 的教训不是文案写错，而是它在两个回写点各写了一份、两处都只读 finalText ⇒
  // 结构化结果在两条路径上一起丢。文案单源 + 取值单源，两个都守，别只守一个。
  const hits = hitsOf('（本次无文本输出）');
  const home = 'src/core/session-reply.ts';
  assert.deepEqual(
    hits.filter((h) => h.file !== home),
    [],
    `这句文案只能写在 ${home}：其余位置请调 sessionReplyContent()（或引用 EMPTY_REPLY_MARK），` +
      '否则改文案时会有一条路径漏改 —— 而下游是按字符串识别它的',
  );
  assert.equal(hits.filter((h) => h.file === home).length, 1, '定义处应恰好一处字面量');
});
