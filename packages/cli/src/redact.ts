/**
 * trace 脱敏 —— `examples/observability/src/index.ts` 的 `redactSink` 的**纯函数版**
 * （去类型移植：CLI 零运行时依赖，不能 import `examples/`，正文与那边逐行同形）。
 *
 * 为什么放在 CLI 而不是框架：`src/core/trace.ts:79` 把脱敏划在 **sink 缝外**（spec §9.3），
 * `docs/observability.md` §2.4 的措辞是「**宿主职责**」，且明写「顶部『不内建』表里它仍标 ❌，
 * 不要当成待办把它搬回框架」。CLI 正是宿主 ⇒ 这里**执行**那条既定缝，`src/` 零改动。
 *
 * 为什么 `agentia view` 要脱敏：它的产物是**单文件 HTML**，而这类产物的默认命运是
 * 「贴进 PR / 发给同事」（业界 telltrace / claude-tap / AgentCanvas 都默认 redact，
 * LangSmith 在分享页正文第一句就警告敏感信息）。不脱敏 = 把 prompt 与工具 IO 原样交出去。
 *
 * ⚠️ **best-effort**：正则只覆盖常见凭证形态，不能替代人工检查。所以产物里必须**可见地**
 * 标出「已脱敏 · best-effort」（`view.ts` 的 banner），`--raw` 关闭时也要在 stderr 出声。
 *
 * 与 `examples/observability` 的**唯一差异**（刻意的）：那边只处理 `span.events`，
 * 这里额外覆盖**顶层 `events`**。手写 / 外来的 trace 可能把事件挂在顶层；探针实测框架
 * trace 的事件在 `spans[].events[].body`（敏感串正是落在 `body.content`），
 * 而**漏脱敏的代价是泄密、多脱敏没有代价** ⇒ 这半行不等对拍测试来教，直接覆盖。
 */
/** CLI 侧的 trace 形状镜像（宽松：只在读字段，字段都可缺省 —— 外来 trace 不保证齐全） */
export interface SpanLike {
  spanId?: string;
  parentSpanId?: string | null;
  kind?: string;
  name?: string;
  attributes?: unknown;
  events?: Array<{ name?: string; body?: unknown; [k: string]: unknown }>;
  error?: { message?: string } | undefined;
  [k: string]: unknown;
}

export interface TraceLike {
  traceId?: string;
  rootSpanId?: string;
  status?: string;
  spans?: SpanLike[];
  events?: unknown;
  totalUsage?: Record<string, unknown> | undefined;
  [k: string]: unknown;
}

/** `keys` 命中的字段整体抹成的文案（不看值，最严的一档） */
export const REDACTED = '[REDACTED]';

/**
 * 内置正则预设（脱敏面 = agent 服务最常见的四类泄密：LLM key / 令牌 / PII）。
 * 每条预设的替换文案带**类别标签**（`[REDACTED:email]`）—— 让「这里被改过、改的是哪类」
 * 在 trace 里可见：静默替换会让下游排查误以为数据本来如此。
 * 预设按数组序依次应用（bearer 先于 jwt —— `Bearer eyJ…` 整体归 bearer，不被 jwt 截走）。
 *
 * ⚠️ 与 `examples/observability/src/index.ts` 的 `REDACT_PRESETS` **逐字同形**，
 * 由 `packages/cli/test/view.test.mjs` 的对拍守着（改任一处必须两边同步）。
 */
export const REDACT_PRESETS = [
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'llm-api-key', re: /\bsk-[A-Za-z0-9]{16,}\b/g },
  { name: 'email', re: /[\w.+-]+@[\w-]+\.[\w.]+/g },
  { name: 'phone-cn', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
] as const;

export type RedactPresetName = (typeof REDACT_PRESETS)[number]['name'];

export interface RedactOptions {
  /** 命中的字段名（不分大小写、子串匹配）整个抹成 `[REDACTED]`，最严的一档 */
  keys?: readonly string[];
  /** 预设选择；`false` = 一个都不用；缺省 = 全用 */
  presets?: false | readonly RedactPresetName[];
}

function hitKey(key: string, keys: readonly string[]): boolean {
  const k = key.toLowerCase();
  return keys.some((needle) => k.includes(needle.toLowerCase()));
}

/** 应用一组「正则 → 替换文案」规则；规则 regex 带 /g，跨字符串复用前必须重置 lastIndex */
function applyRules(s: string, rules: ReadonlyArray<{ re: RegExp; label: string }>): string {
  let out = s;
  for (const { re, label } of rules) {
    re.lastIndex = 0;
    out = out.replace(re, label);
  }
  return out;
}

/** 递归深拷贝 + 抹值：原 trace 不被改动（调用方可能还要拿原文） */
function redactValue(
  value: unknown,
  keys: readonly string[],
  rules: ReadonlyArray<{ re: RegExp; label: string }>,
): unknown {
  if (typeof value === 'string') return applyRules(value, rules);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, keys, rules));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = hitKey(k, keys) ? REDACTED : redactValue(v, keys, rules);
  }
  return out;
}

function buildRules(presets: RedactOptions['presets']): Array<{ re: RegExp; label: string }> {
  if (presets === false) return [];
  const selected = presets ?? REDACT_PRESETS.map((p) => p.name);
  return REDACT_PRESETS.filter((p) => (selected as readonly string[]).includes(p.name)).map(
    (p) => ({ re: p.re, label: `[REDACTED:${p.name}]` }),
  );
}

/** 预设名（供产物里「已脱敏 · 覆盖 X 类」那句话用） */
export function activePresetNames(presets: RedactOptions['presets']): readonly string[] {
  return presets === false ? [] : (presets ?? REDACT_PRESETS.map((p) => p.name));
}

/**
 * 脱敏一条 trace（**返回副本**，不改入参）。
 *
 * 规则顺序：预设（默认全开）→ 字段级 `keys`（后者整字段抹平，最严）。
 */
export function redactTrace(trace: TraceLike, opts: RedactOptions = {}): TraceLike {
  const keys = opts.keys ?? [];
  const rules = buildRules(opts.presets);
  const spans = (trace.spans ?? []).map((span) => ({
    ...span,
    attributes: redactValue(span.attributes, keys, rules) as typeof span.attributes,
    events: (span.events ?? []).map((e) => ({ ...e, body: redactValue(e.body, keys, rules) })),
    ...(span.error
      ? { error: { ...span.error, message: applyRules(span.error.message ?? '', rules) } }
      : {}),
  }));
  return {
    ...trace,
    totalUsage: trace.totalUsage ? { ...trace.totalUsage } : trace.totalUsage,
    spans,
    // 见文件头注：比 examples 多覆盖的一层（手写 trace 可能有顶层 events）
    ...(Array.isArray(trace.events)
      ? { events: redactValue(trace.events, keys, rules) as TraceLike['events'] }
      : {}),
  };
}
