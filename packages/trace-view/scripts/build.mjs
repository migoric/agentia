import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle } from './bundle.mjs';

/* trace-view 产物 = src 下的 .js 与 .css 原样拷到 dist，外加一份**单文件 bundle**。
 * 纯 ESM、零依赖、无编译步骤 —— 官网（Astro 打包）与 CLI inspector（静态提供）都直接消费
 * 分文件；`agentia view` 出的单文件自包含 HTML 内联 bundle（见 bundle.mjs 头注）。 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const f of readdirSync(src)) {
  cpSync(join(src, f), join(dist, f));
}
// 单文件 bundle（同源派生，不是第二份实现）
const bundlePath = join(dist, 'trace-view.bundle.js');
writeFileSync(bundlePath, buildBundle(src));
console.log('[trace-view] dist 已生成：' + readdirSync(dist).sort().join(', '));
