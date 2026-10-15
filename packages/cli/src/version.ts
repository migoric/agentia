import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * CLI 版本 = 本包 package.json 的 `version`（**单源**：`scripts/check-release.mjs` 已保证它
 * 与根包一致，所以这里不另存一份常量 —— 常量会漂，读到的文件不会）。
 *
 * 源码直跑（`src/*.ts`）与发布物（`dist/*.js`）的 `../package.json` 都是包根那一份。
 *
 * 抽成模块是因为**三个**命令都要它：`--version`（cli）、写进项目 `AGENTS.md` 的版本标记
 * （create）、以及 `doctor` 拿它比对「说明文档是不是这一版写的」—— 三处各读一次就会漂。
 */
export function readCliVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 项目内 `AGENTS.md` 的版本标记（`create` 写、`doctor` 读）。
 *
 * 为什么需要它：`AGENTS.md` 是 `create` 时从 `docs/usage-guide.md` **拷**进工程的一份
 * **快照**，之后**没有任何命令会更新它**，而它恰恰是「AI 辅助编码的权威入口」——
 * 框架升级后它会静默过期，AI 则照着过期的 API 写代码。有了这个标记，`doctor` 才能把
 * 「说明是哪一版写的」说出口（此前只能靠人记得去对拍）。
 */
export const GUIDE_VERSION_MARKER = (version: string): string =>
  `<!-- agentia-guide-version: ${version} -->`;

/** 匹配上面那个标记（ tolerant：允许标记前后有空行 / 大小写不变） */
export const GUIDE_VERSION_RE = /<!--\s*agentia-guide-version:\s*([^\s-]+)\s*-->/;
