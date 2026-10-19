/**
 * `agentia view <trace.jsonl>` —— 落盘 trace → **单文件自包含 HTML**（无外链、离线可开、可转发）。
 *
 * 补的是「事后看一棵树」这一整段：`agentia dev` 的面板是**在飞**的（run 列表是内存 ring，
 * 重启即空），而落盘 / 生产的 trace 此前只有文本侧（`report` 排行 / `diff` 差异 /
 * `harvest` / `export`）—— 没有一处能把它**画出来**。业界 2026 已收敛到同一形态
 * （agentskit / telltrace / claude-tap / AgentCanvas 全是「文件 → 单文件 HTML」）。
 *
 * 形态上的三条硬约束（缺一条就不是这个形态）：
 * 1. **零外链**：bundle 与 CSS **内联**，没有 server、没有 CDN ⇒ 双击就能开、转发即完整。
 * 2. **安全**：trace 含模型输出 = 不可信输入 ⇒ 内联 JSON 必须转义 `<`（防 `</script>` 提前闭合
 *    注入脚本），所有用户可控文本（文件名等）进 HTML 前必须 esc。
 * 3. **默认脱敏**：产物的默认命运是「被转发」⇒ 默认 `redactTrace`，且产物里**可见地**标明
 *    「已脱敏 · best-effort」。`--raw` 关闭时 stderr 出声 + 产物打水印（对齐 LangSmith
 *    分享页那条「确认没有敏感信息」的纪律）。
 *
 * ⚠️ **不许静默截断**：`--limit` 超了必须明说（stdout + 产物 banner 各一处）——
 * 「少给了还不说」会让看报告的人以为文件里就这些，是本仓最忌的形状。
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { extractTrace } from './report.js';
import { activePresetNames, redactTrace, type TraceLike } from './redact.js';

export const USAGE =
  '用法：agentia view <trace.jsonl> [-o <out.html>] [--open] [--raw] [--limit N] [--trace-id <id>] [--redact-key <字段名>]';

/** 默认一次最多内联多少条 trace（与 `agentia dev` 面板的 ring 50 对齐，超了明说） */
export const DEFAULT_LIMIT = 50;

/** 默认不带 `--limit` 时的兜底上限（字节）—— 长对话的 trace 可能很大，防止产出几百 MB 的 HTML */
const MAX_INLINE_BYTES = 32 * 1024 * 1024;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * 内联进 `<script>` 的 JSON：把 `<` 转成 `\u003c`。
 * 没有这一步，trace 里出现 `</script>` 就会**提前闭合脚本块**，其后内容被当 HTML 解析
 * ⇒ 任意脚本注入。JSON 里 `\u003c` 解析回来仍是 `<`，对数据零影响。
 */
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** 打开浏览器（失败要出声 —— 「你说 --open 了我没打开」不能是静默的） */
function openInBrowser(file: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  const child = spawn(cmd, [file], { stdio: 'ignore', detached: true });
  child.on('error', () => {
    console.error(`[agentia] --open 失败：找不到 "${cmd}"，请手动打开 ${file}`);
  });
  child.unref();
}

/** 读构建期拷进 dist/inspector/ 的 trace-view 单文件 bundle（同源派生，不是第二份实现） */
async function readAsset(rel: string): Promise<string> {
  try {
    return await readFile(new URL(`./inspector/${rel}`, import.meta.url), 'utf8');
  } catch (e) {
    throw new Error(
      `缺少 CLI 资源（inspector/${rel}）：${(e as Error).message}；请先 \`npm run build:cli\``,
    );
  }
}

/**
 * 把 bundle 尾部那句 `export { ... };` 剥掉 —— 内联进**普通 `<script>`**（不是 module）：
 * `file://` 下 module script 走 CORS 那条路，双击打开有失败风险，普通 script 没有。
 * ⚠️ 剥不干净要**响亮报错**：残留 `export` 在普通 script 里是 SyntaxError ⇒ 整页白屏。
 */
function stripExports(bundle: string): string {
  const out = bundle.replace(/\nexport\s*\{[^}]*\};\s*$/, '\n');
  if (/\bexport\s*\{/.test(out) || /^\s*export\s/m.test(out)) {
    throw new Error(
      'trace-view bundle 里仍有 export 语句 —— 内联进普通 <script> 会是 SyntaxError（整页白屏）；' +
        '请检查 packages/trace-view/scripts/bundle.mjs 的产物形状',
    );
  }
  return out;
}

function buildHtml(opts: {
  traces: TraceLike[];
  css: string;
  bundle: string;
  source: string;
  redacted: boolean;
  presetNames: readonly string[];
  extraKeys: readonly string[];
  truncated: number;
}): string {
  const { traces, css, bundle, source, redacted, presetNames, extraKeys, truncated } = opts;
  /* ⚠️ 「已脱敏」必须**说清覆盖什么**：只写「覆盖 6 类」读者无从判断自己的敏感字段在不在内
   * —— 实测里 `password=hunter2` 就不在任何预设里（预设只管凭证/PII 的固定形态）。
   * 与其偷偷加规则（会与 examples/observability 的 6 类漂移），不如把类名与边界都摆出来。 */
  /* ⚠️ 两档脱敏是**两种机制**，别写成一档：`presets` 是「值内凭证形态」的正则替换，
   * `--redact-key` 是「按字段名」整字段抹平（不看值）。实测里 `password=hunter2` 落在
   * 字符串值内部 ⇒ `--redact-key password` 拦不住它（除非字段名恰好叫 password）。
   * 与其让 banner 暗示「加了 key 就都解决了」，不如把两档各自能干什么摆清楚。 */
  const banner = redacted
    ? `已脱敏 · best-effort · 覆盖 ${presetNames.length} 类值内凭证形态：<code>${esc(presetNames.join(' / '))}</code>` +
      (extraKeys.length > 0
        ? `；另按字段名整字段抹平：<code>${esc(extraKeys.join(' / '))}</code>`
        : '') +
      ' —— <b><code>password=</code> 这类值内形态不在预设内（要它请用 <code>--redact-key</code> 按字段名处理），不能替代人工检查</b>'
    : '<b>⚠️ 未脱敏（--raw）</b> —— 含完整 prompt 与工具出入参，<b>转发前请自行检查</b>';
  const bannerCls = redacted ? 'ok' : 'warn';
  const truncNote =
    truncated > 0
      ? `<div class="note">⚠️ 源文件共 ${truncated + traces.length} 条，本页只含前 ${traces.length} 条（<code>--limit</code> 调整）</div>`
      : '';

  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>agentia trace — ${esc(source)}</title>
<style>
${css}
</style>
<style>
  body { margin: 0; font: 13px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  header { padding: 10px 14px; border-bottom: 1px solid #ddd; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  header .title { font-weight: 600; }
  header .spacer { flex: 1; }
  #banner { padding: 6px 14px; font-size: 12px; }
  #banner.ok { background: #eef7ee; color: #264; }
  #banner.warn { background: #fdf3e2; color: #742; }
  .note { padding: 6px 14px; font-size: 12px; background: #fff8e1; color: #742; }
  #pick { max-width: 30em; }
  main { padding: 12px 14px; }
  code { background: #f2f2f2; padding: 0 3px; }
</style>
</head>
<body>
<header>
  <span class="title">agentia trace</span>
  <span>${esc(source)}</span>
  <span class="spacer"></span>
  <select id="pick" aria-label="选择 trace"></select>
</header>
<div id="banner" class="${bannerCls}">${banner}</div>
${truncNote}
<main><div id="tree"></div></main>
<script type="application/json" id="agentia-traces">${inlineJson(traces)}</script>
<script>
${stripExports(bundle)}
</script>
<script>
(function () {
  var traces = JSON.parse(document.getElementById('agentia-traces').textContent);
  var pick = document.getElementById('pick');
  var view = createTraceView(document.getElementById('tree'), {});
  traces.forEach(function (t, i) {
    var o = document.createElement('option');
    o.value = String(i);
    o.textContent = (t.traceId ? String(t.traceId).slice(0, 8) : '#') + (i + 1) +
      ' · ' + (t.status || '?') + ' · ' + (t.spans ? t.spans.length : 0) + ' spans';
    pick.appendChild(o);
  });
  function show(i) {
    var t = traces[i];
    if (!t) return;
    playTrace(view, t);
    try { location.hash = String(i); } catch (e) {}
  }
  pick.addEventListener('change', function () { show(Number(pick.value)); });
  var start = 0;
  var h = parseInt(String(location.hash || '').replace('#', ''), 10);
  if (Number.isFinite(h) && traces[h]) start = h;
  pick.value = String(start);
  show(start);
})();
</script>
</body>
</html>
`;
}

export async function viewCommand(args: string[]): Promise<number> {
  let file: string | undefined;
  let out: string | undefined;
  let open = false;
  let raw = false;
  let limit: number | undefined;
  let traceId: string | undefined;
  /** 业务自有敏感字段（可重复）—— 预设管不到 `password=` 这类，这里是使用者的兜底口子 */
  const extraKeys: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === '--open') {
      open = true;
    } else if (a === '--raw') {
      raw = true;
    } else if (a === '-o' || a === '--out') {
      out = args[i + 1];
      if (out === undefined) throw new Error(`-o 需要一个文件参数\n${USAGE}`);
      i += 1;
    } else if (a === '--limit') {
      const n = Number(args[i + 1]);
      if (args[i + 1] === undefined || !Number.isInteger(n) || n <= 0) {
        throw new Error(`--limit 需要一个正整数\n${USAGE}`);
      }
      limit = n;
      i += 1;
    } else if (a === '--trace-id') {
      traceId = args[i + 1];
      if (traceId === undefined) throw new Error(`--trace-id 需要一个 traceId\n${USAGE}`);
      i += 1;
    } else if (a === '--redact-key') {
      const k = args[i + 1];
      if (k === undefined) throw new Error(`--redact-key 需要一个字段名\n${USAGE}`);
      extraKeys.push(k);
      i += 1;
    } else if (a.startsWith('--')) {
      throw new Error(`未知参数：${a}\n${USAGE}`);
    } else if (file === undefined) {
      file = a;
    } else {
      throw new Error(USAGE);
    }
  }
  if (file === undefined) throw new Error(USAGE);

  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    throw new Error(`读不到文件 ${file}（${(e as Error).message}）`);
  }

  // 解析 + 按 traceId 去重（append-only 落盘里同一棵树会写多次，同 `report` 的口径：留最后一行）
  const byId = new Map<string, TraceLike>();
  let badLines = 0;
  let total = 0;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let parsed: TraceLike | null;
    try {
      parsed = extractTrace(JSON.parse(s)) as TraceLike | null;
    } catch {
      parsed = null;
    }
    if (!parsed) {
      badLines += 1;
      continue;
    }
    total += 1;
    const key = parsed.traceId ?? `__anon_${byId.size}`;
    byId.set(key, parsed);
  }
  if (byId.size === 0) {
    throw new Error(
      `${file} 里没有可识别的 trace（支持裸 Trace 或含 result.trace / trace 的记录）` +
        (badLines > 0 ? `；另有 ${badLines} 行无法解析` : ''),
    );
  }

  let traces = [...byId.values()];
  if (traceId !== undefined) {
    const hit = traces.filter((t) => t.traceId === traceId);
    if (hit.length === 0) {
      throw new Error(`${file} 里没有 traceId 为 ${traceId} 的 trace（共 ${traces.length} 条）`);
    }
    traces = hit;
  }

  const cap = limit ?? DEFAULT_LIMIT;
  let truncated = 0;
  if (traces.length > cap) {
    truncated = traces.length - cap;
    traces = traces.slice(0, cap);
  }

  // 字节兜底：长对话的 trace 可能极大，静默产出几百 MB 的 HTML 不如响亮报错
  let bytes = traces.reduce((s, t) => s + JSON.stringify(t).length, 0);
  if (bytes > MAX_INLINE_BYTES) {
    const keep: TraceLike[] = [];
    bytes = 0;
    for (const t of traces) {
      const size = JSON.stringify(t).length;
      if (bytes + size > MAX_INLINE_BYTES) break;
      keep.push(t);
      bytes += size;
    }
    truncated += traces.length - keep.length;
    traces = keep;
    console.error(
      `[agentia] 内联体积超过 ${Math.floor(MAX_INLINE_BYTES / 1024 / 1024)} MiB，只取前 ${traces.length} 条（--limit 调整）`,
    );
  }
  if (traces.length === 0)
    throw new Error('没有可内联的 trace（单条就超过体积上限，请用 --limit 1 或拆分文件）');

  if (!raw) traces = traces.map((t) => redactTrace(t, { keys: extraKeys }));
  const presetNames = raw ? [] : activePresetNames(undefined);

  const [css, bundle] = await Promise.all([
    readAsset('trace-view.css'),
    readAsset('trace-view.bundle.js'),
  ]);
  const html = buildHtml({
    traces,
    css,
    bundle,
    source: file,
    redacted: !raw,
    presetNames,
    extraKeys: raw ? [] : extraKeys,
    truncated,
  });

  const target = out ?? `${file.replace(new RegExp(`${extname(file)}$`), '')}.html`;
  await writeFile(target, html, 'utf8');

  console.log(
    `已生成 ${target}（${traces.length} 条 trace，${(html.length / 1024).toFixed(1)} KiB，单文件自包含）`,
  );
  if (truncated > 0) {
    console.log(
      `⚠️ 源文件共 ${total} 行记录 / ${truncated + traces.length} 条 trace，本页只含前 ${traces.length} 条 —— 用 --limit 调整`,
    );
  }
  if (badLines > 0) console.log(`⚠️ 另有 ${badLines} 行无法解析（已跳过）`);
  if (raw) {
    console.error('⚠️ --raw：产物未脱敏，含完整 prompt 与工具出入参 —— 转发前请自行检查');
  }
  if (open) openInBrowser(target);
  return 0;
}
