import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Provider } from '../container/container.js';
import { isProvider } from '../container/container.js';

/**
 * Agentia —— 能力目录发现（`<目录>/<name>/index.ts` 约定，spec §7 静态校验仍由装配层统一做）。
 *
 * 入参给**一个目录**或**一组目录**：数组拼成一条搜索路径，**顺序即装配顺序**
 * （典型布局是四分类目录 `src/tools` / `src/skills` / `src/prompts` / `src/subagents`）。
 *
 * 约定（对每个目录各自成立）：
 * - 每个子目录 = 一个能力文件夹，入口为 index.ts / index.mts / index.js / index.mjs（按序取先存在者）；
 * - 入口 default export 支持三种形态：
 *   1. 类                → { provide: <文件夹名>, useClass: 该类 }
 *   2. Provider 对象      → 原样使用（可用 useFactory/useValue 自定义 token）
 *   3. Provider 数组      → 展开（一个文件夹暴露多个 provider）
 * - DI token 缺省 = 文件夹名（kebab-case 文件夹即 kebab-case token，能力引用照写）。
 *
 * 与手动 providers 可混用：createApp({ providers, discover }) 合并注册，
 * 重名/引用校验在装配期统一进行（AgentApp 构造函数）。
 *
 * 动态 import 决定本函数是异步的 —— createApp 带 discover 时同样返回 Promise。
 */
export const ENTRY_CANDIDATES = ['index.ts', 'index.mts', 'index.js', 'index.mjs'];

export async function discoverProviders(dir: string | string[]): Promise<Provider[]> {
  const dirs = Array.isArray(dir) ? dir : [dir];
  const providers: Provider[] = [];
  /** 跨目录的重名 token 记账：四个分类目录下同名文件夹会撞 token，装配期后者静默覆盖 —— 留痕 */
  const seen = new Map<string, string>();

  for (const d of dirs) {
    for (const p of await discoverOne(d)) {
      const token = String(p.provide);
      const prev = seen.get(token);
      if (prev !== undefined && prev !== d) {
        console.warn(
          `[agentia:discover] 重名能力 ${token}：先在 ${prev}，后在 ${d} —— 装配期后者覆盖前者，菜单里只剩一个`,
        );
      }
      seen.set(token, d);
      providers.push(p);
    }
  }
  return providers;
}

/** 扫描单个目录（缺目录即报错：显式给出的搜索路径不该静默落空） */
async function discoverOne(dir: string): Promise<Provider[]> {
  const root = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
  if (!existsSync(root)) {
    throw new Error(`能力目录不存在: ${root}（先创建或用 CLI: agentia g <type> <name>）`);
  }
  if (!statSync(root).isDirectory()) {
    // 存在但是普通文件：readdirSync 会抛原始 ENOTDIR，信息量低且不像配置错误
    throw new Error(`能力目录不是文件夹: ${root}`);
  }

  const providers: Provider[] = [];
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((e) => isDirLike(join(root, e.name), e))
    .map((e) => e.name)
    .sort(); // 排序保证装配顺序稳定（菜单顺序 = 目录名序，可复现）

  for (const name of entries) {
    const candidates = ENTRY_CANDIDATES.map((f) => join(root, name, f)).filter(existsSync);
    if (candidates.length === 0) {
      // 静默跳过过一次（无入口的目录视为非能力目录，如 assets/）：
      // 但「菜单莫名少一个能力」需要留痕，否则只能靠猜
      console.warn(`[agentia:discover] 跳过 ${name}/：无 ${ENTRY_CANDIDATES.join(' / ')} 入口`);
      continue;
    }
    // 候选按序尝试（.ts 优先 —— tsx dev 下必须能选中源码），失败后回落下一候选：
    // 源码与 in-place 编译产物（index.ts + index.js）并存的目录，纯 node 选 .ts 会加载
    // 失败，此时应回落 .js 而非直接报「入口加载失败」；全部失败则列出每个候选与各自原因。
    let mod: unknown;
    let lastError: unknown;
    const failures: string[] = [];
    for (const entry of candidates) {
      try {
        mod = await import(pathToFileURL(entry).href);
        break;
      } catch (e) {
        lastError = e;
        failures.push(`${entry}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (failures.length === candidates.length) {
      throw new Error(
        `能力 ${name} 入口加载失败：\n${failures.map((f) => `  - ${f}`).join('\n')}`,
        { cause: lastError },
      );
    }
    if (failures.length > 0) {
      // 回落成功不等于没事：若刚改过 .ts 源码，命中的 .js 可能是陈旧编译产物 —— 留痕
      console.warn(
        `[agentia:discover] 能力 ${name} 首选入口加载失败，已回落（命中的是 ${candidates[failures.length]!}；若刚改过源码，注意它可能是陈旧编译产物）:\n` +
          failures.map((f) => `  - ${f}`).join('\n'),
      );
    }
    const exported = (mod as { default?: unknown }).default;
    providers.push(...normalizeExport(name, exported, candidates[failures.length]!));
  }
  return providers;
}

/**
 * 目录判定：**软链目录**（pnpm store / monorepo 里 `src/tools/foo` 常是软链）的
 * `isDirectory()` 为 false，直接用会把真能力目录静默漏掉、菜单空着却不报错 ——
 * 软链要 stat 解引用后再判。悬空软链按非目录处理。
 */
function isDirLike(
  full: string,
  e: { isDirectory(): boolean; isSymbolicLink(): boolean },
): boolean {
  if (e.isDirectory()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    return statSync(full).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 读能力类的 `static deps`（可选的依赖声明）。
 *
 * 只认「字符串数组」这一种形状：别的是用户自己的字段（或继承来的），静默当没有 ——
 * 写错了（比如 `deps = 'WORKDIR'`）不报错、也不注入，那正是要避免的静默失效，
 * 所以这里**响亮报错**（装配期比运行期便宜得多）。
 */
function staticDepsOf(cls: unknown): string[] | undefined {
  const raw = (cls as { deps?: unknown } | undefined)?.deps;
  if (raw === undefined) return undefined;
  if (Array.isArray(raw) && raw.every((d) => typeof d === 'string')) return raw as string[];
  throw new Error(
    `能力类的 static deps 必须是字符串数组（如 static readonly deps = ['WORKDIR']），` +
      `实际：${JSON.stringify(raw)}`,
  );
}

function normalizeExport(name: string, exported: unknown, entry: string): Provider[] {
  if (typeof exported === 'function') {
    const cls = exported as new () => object;
    // 能力类可以**自带依赖声明**（`static readonly deps = ['WORKDIR']`）。
    //
    // 为什么需要（2026-10-16 ref-di-dup-loud）：此前 discover 对「default export
    // 是类」只产 `{ useClass }`（没有 deps），于是**需要注入的能力必须挪出 discover**、改到
    // 显式 `providers` 里再注册一遍 —— 结果同一 token 出现两次（一次无 deps、一次有），
    // 靠「后注册覆盖先注册」碰巧成立，顺序一变就静默失效。能力文件夹本来就该是
    // 「能力 + 它的依赖」的完整单元，依赖声明写在类旁边，装配文件不必知道。
    // 与 Folder 直接导出 Provider 对象那条路并列（本函数下面两行），多一个更轻的选择。
    const deps = staticDepsOf(cls);
    return deps ? [{ provide: name, useClass: cls, deps }] : [{ provide: name, useClass: cls }];
  }
  if (isProvider(exported)) {
    return [exported];
  }
  if (Array.isArray(exported) && exported.every(isProvider)) {
    return exported;
  }
  throw new Error(
    `能力入口 ${entry} 的 default export 形态非法：应为「类 / Provider / Provider[]」，实际 ${describe(exported)}`,
  );
}

function describe(x: unknown): string {
  if (x === undefined) return 'undefined（缺少 default export？）';
  if (x === null) return 'null';
  return typeof x;
}
