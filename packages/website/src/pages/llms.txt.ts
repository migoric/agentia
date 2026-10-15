import type { APIRoute } from 'astro';
import guide from '../../../../docs/usage-guide.md?raw';

/**
 * /llms.txt —— llms.txt 约定的入口索引（给联网 AI 助手）。
 *
 * - `/llms-full.txt` 是完整使用说明（由仓库单源 docs/usage-guide.md 生成）；
 * - 本站是静态托管，没有后端，因此这里只列事实与链接。
 *
 * ⚠️ 单源用 `?raw` 构建期注入（理由同 `llms-full.txt.ts` 的注释：Astro 7 下 `import.meta.url`
 * 指向产物目录，`readFileSync` + 相对 URL 会在构建期 ENOENT）。
 *
 * ⚠️ 站内链接**必须是绝对地址**：AFDocs 的 `llms-txt-links-resolve` 只统计
 * `http://` / `https://` 开头的链接（源码 `checks/content-discoverability/llms-txt-links-resolve.js`），
 * 根相对链接（`/docs`）会被**整条丢弃** ⇒ 同源链接 0 条、该项只能拿到 WARN，
 * 且 agent 少一个可直接跟随的入口。
 *
 * ⚠️ 路径一律**干净形态**（`/docs`，不是 `/docs.html`）：Cloudflare Pages 对产物里存在的
 * `x.html` 一律 308 到 `/x`（实测 /docs.html → /docs）。给 agent 的清单里应当是可直达的
 * 最终地址，而不是要先跳一次的地址。与 `sitemap.xml.ts` 的清单保持一致。
 */
export const GET: APIRoute = ({ site }) => {
  const origin = (site ?? new URL('https://agentia-web.pages.dev')).origin;
  const abs = (path: string) => new URL(path, origin).href;
  // 从单源里抠出 API 名单，保证这里的清单不会与说明漂移
  const roster = new Map<string, string[]>();
  let heading = '';
  for (const raw of guide.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('###')) {
      heading = line.replace(/^#+\s*/, '').replace(/`/g, '');
      continue;
    }
    const m = /^\|\s*`([A-Za-z_$][\w$]*)`\s*\|/.exec(line);
    if (m && heading) {
      const list = roster.get(heading) ?? [];
      list.push(m[1]);
      roster.set(heading, list);
    }
  }

  const apiLines = [...roster.entries()]
    .map(([h, names]) => `- ${h}: ${names.join(', ')}`)
    .join('\n');

  // 从单源 guide 的 §7 表抠出「已知边界」行 —— 不再维护手抄副本（否则必然滞后）
  const boundaryLines: string[] = [];
  let inBoundary = false;
  for (const raw of guide.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('## ')) {
      inBoundary = line.includes('已知边界');
      continue;
    }
    if (!inBoundary) continue;
    const m = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/.exec(line);
    if (!m) continue;
    if (m[1] === '边界' || /^-+$/.test(m[1])) continue; // 表头 / 分隔行
    // 不额外加 ** 包裹：源能力格自带 `**…**` 时两层会撞出坏粗体
    boundaryLines.push(`- ${m[1]}: ${m[2]}`);
  }

  // 守护单源格式：上面的解析依赖 docs/usage-guide.md 的「### 分节 + 表格行」与「已知边界」节表。
  // 格式微调会让清单静默变空、构建照绿、线上丢整节 —— 这里让构建响亮失败。
  if (!apiLines) {
    throw new Error('llms.txt: 从 docs/usage-guide.md 没抠到任何 API 条目（单源格式变了？）');
  }
  if (boundaryLines.length === 0) {
    throw new Error('llms.txt: 从 docs/usage-guide.md 没抠到「已知边界」表（单源格式变了？）');
  }

  const body = `# Agentia

> 面向应用开发的声明式 agent 服务开发框架：装饰器 + DI 声明四类能力，主 agent 编排执行；每次 run 产出结构化结果与可观测调用树（trace、成本、指标），交付可直接上线的服务。npm 包 \`@migor/agentia\` 与 \`@migor/cli\`；ESM、Node ≥ 18。

本文件是所有内容的纯文本入口。**需要完整说明时读 \`/llms-full.txt\`**（同一份单源的完整版）。

## 文档

- [完整使用说明（供 AI 整篇注入）](${abs('/llms-full.txt')}): API 速查、类型链路、常见错误 —— 由仓库单源 \`docs/usage-guide.md\` 生成
- [官网首页](${abs('/')}): 框架定位与四类能力
- [文档页](${abs('/docs')}): 指南与代码示例
- [API 参考](${abs('/api')}): 导出面清单
- [取舍对照](${abs('/tradeoffs')}): **不做什么**、代价是什么、**什么场景该选别人**（不适用场景）
- [Playground](${abs('/playground')}): 浏览器内跑一次真实 run（自带 Key，直连 Anthropic / DeepSeek）

## Documentation (English)

The site is bilingual. These pages mirror the Chinese ones section by section; the
authoritative long-form guide (\`/llms-full.txt\`) is in Chinese only.

- [Home](${abs('/en')}): positioning and the four capability kinds
- [Docs](${abs('/en/docs')}): the guide and worked examples
- [API reference](${abs('/en/api')}): the exported surface
- [Trade-offs](${abs('/en/tradeoffs')}): what we don't do, what that costs, and when to pick something else
- [Playground](${abs('/en/playground')}): run a real run in the browser (bring your own key)

## 安装与脚手架

\`\`\`bash
npm i @migor/agentia
npx @migor/cli create my-app     # 生成项目（含使用者向 AGENTS.md）
npx @migor/cli dev               # 本地 inspector 面板：输入 prompt 驱动一次 run + 看 trace
npx @migor/cli doctor            # 静态体检
\`\`\`

## 导出面（按说明文档的分节）

${apiLines}

## 已知边界（如实标注）

${boundaryLines.join('\n')}

## 可选

- [GitHub](https://github.com/migoric/agentia)
`;

  return new Response(body, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
};
