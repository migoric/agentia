import type { JsonSchema } from './tool.js';
import { stringifySafe } from './json.js';
import { zeroClauseOf } from './limits.js';

/**
 * `check()` 的**递归深度背板**（2026-09-28 外部深评 C6 收口）。
 *
 * 这道闸只管一件事：**别让递归钻到 V8 的栈溢出**（`RangeError: Maximum call stack size exceeded`
 * 的症状没有辨识度 —— 调用方看到的是「校验不了」，而不是「这个 schema 有问题」）。
 * 环本身由 `assertNoSchemaCycle()`（前置、与值深度无关）具名抓出来；这里只兜「合法但深到失控」
 * 那种形态（要手搓几千层嵌套 schema 才够，属于事故级输入）。
 *
 * 256 的判据：真实 tool schema 的深度是**个位数**，256 是它的两个数量级以上 ⇒ 不误伤；
 * 而 V8 的栈在几千帧量级 ⇒ 256 足够早地拦住。**数量有界不是用户旋钮**，不进 `core/limits.ts`
 * 的 0 语义表（与 `MAX_DELIVERED_EVENT_IDS` / `MAX_PENDING_EVENTS` 同档）。
 */
const MAX_SCHEMA_DEPTH = 256;

/**
 * Agentia —— 最小 JSON Schema 校验子集（v1 裸 JSON Schema；zod 为可选外挂，
 * 见 toolkit/zod.ts —— schema 上挂 __zodValidate 时先走它，core 本身不依赖 zod）。
 *
 * 用途：engine 在执行 tool.run 前校验模型给出的结构化 input；校验失败直接回
 * is_error 的 tool_result（错误信息含路径，模型可自我修正），不进方法体。
 *
 * 覆盖子集：type（object/array/string/number/integer/boolean/null）、
 * properties、required、additionalProperties:false、enum、items、maxItems。
 * 未覆盖的关键字（format/minimum/oneOf 等）一律放行 —— 护栏不是完整校验器。
 *
 * ⚠️ **maxItems 是语义变更，不是「补个漏」**（2026-11-13 ref-checklist-four）：
 * 它此前属于「未覆盖 ⇒ 一律放行」，工具作者在 schema 上写了 `maxItems: 10` 却
 * 完全没有护栏，而校验器零报错 —— 这是「护栏看起来在、其实不在」。收进来之后
 * 超长数组回 `is_error` 的 tool_result（含路径与长度，模型能自我修正）。
 * `0` 读作「只许空数组」而不是「不限」；坏值抛 TypeError 而不是静默失效
 * （`length > NaN` 恒假会让这道闸无声消失）。口径登记在 `core/limits.ts`。
 *
 * @returns 人类可读的错误描述（含路径）；合法返回 null。
 */
export function validateJsonSchema(schema: JsonSchema, input: unknown): string | null {
  // zod 可选接入（toolkit/zod.ts 的 fromZod 挂的隐藏字段）：存在则先走 zod 校验，
  // 失败即回「$: <首条错误>」（含 zod 路径，前缀与原生分支的 `$` 路径一致）；通过后再叠加 JSON Schema 子集校验。
  const zv = (schema as Record<string, unknown>).__zodValidate;
  if (typeof zv === 'function') {
    const err = (zv as (input: unknown) => string | null)(input);
    if (err) return `$: ${err}`;
  }
  assertNoSchemaCycle(schema);
  return check(schema, input, '$', 0);
}

/**
 * **前置环检测**：`properties` / `items` / `additionalProperties` 这几条边里有环 ⇒ 具名报错。
 *
 * 为什么不是「只靠深度闸」：递归深度 = min(schema 深度, 值深度)，所以**环 + 浅值**根本不会爆栈
 * （照常校验通过）—— 那是作者的一个合法但可疑的写法，不该被当成「输入非法」。真正要防的是
 * 环**配深值**时钻进栈溢出，而那件事用深度闸只能兜住症状；这里直接点出病根（哪条路径上是环）。
 *
 * 用**祖先集**而不是全局 visited：共享子树（DAG，`{a: s, b: s}` 这种）是合法写法，不能报环。
 */
function assertNoSchemaCycle(root: JsonSchema): void {
  const ancestors = new Set<object>();
  const walk = (schema: unknown, path: string): void => {
    if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return;
    if (ancestors.has(schema)) {
      throw new Error(
        `schema 里有**环**（循环引用）：${path} 又指回了它自己的祖先。` +
          '这会按值深度一路递归下去 —— 深值就是 RangeError: Maximum call stack size exceeded。' +
          '修法：把自引用那段拆成不带环的子 schema，或改成显式的深度上限。',
      );
    }
    ancestors.add(schema);
    const s = schema as Record<string, unknown>;
    for (const [key, sub] of Object.entries((s.properties as object | undefined) ?? {})) {
      walk(sub, `${path}.properties.${key}`);
    }
    if (s.items !== undefined) walk(s.items, `${path}.items`);
    if (typeof s.additionalProperties === 'object') {
      walk(s.additionalProperties, `${path}.additionalProperties`);
    }
    ancestors.delete(schema);
  };
  walk(root, '$');
}

function check(schema: JsonSchema, value: unknown, path: string, depth = 0): string | null {
  if (depth > MAX_SCHEMA_DEPTH) {
    throw new Error(
      `schema 递归超过 ${MAX_SCHEMA_DEPTH} 层（路径 ${path}）—— 校验在这里中止。` +
        '（环由 assertNoSchemaCycle 前置抓；这里兜的是「合法但深到失控」的形态。）',
    );
  }
  // 每个 schema 都过这一层（含嵌套的 items / properties），所以坏 maxItems 即使
  // 这次的值不是数组也会被具名拒掉 —— 不把「配置错」藏在「这次没走到那条分支」后面。
  const maxItems = maxItemsOf(schema, path);
  const en = schema.enum;
  if (Array.isArray(en) && !en.some((v) => deepEqual(v, value))) {
    return `${path}: 值不在 enum 允许范围内（得到 ${preview(value)}）`;
  }

  switch (schema.type) {
    case 'object':
      return checkObject(schema, value, path, depth);
    case 'array':
      return checkArray(schema, value, path, depth, maxItems);
    case 'string':
      return typeof value === 'string' ? null : `${path}: 期望 string，得到 ${typeOf(value)}`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : `${path}: 期望 number，得到 ${typeOf(value)}`;
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
        ? null
        : `${path}: 期望 integer，得到 ${typeOf(value)}`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path}: 期望 boolean，得到 ${typeOf(value)}`;
    case 'null':
      return value === null ? null : `${path}: 期望 null，得到 ${typeOf(value)}`;
    default:
      return null; // 未声明/未覆盖的 type 放行
  }
}

function checkObject(
  schema: JsonSchema,
  value: unknown,
  path: string,
  depth: number,
): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `${path}: 期望 object，得到 ${typeOf(value)}`;
  }
  const obj = value as Record<string, unknown>;

  for (const key of schema.required ?? []) {
    // 用 Object.hasOwn 而非 `in`：后者会命中原型链，required:['constructor'] 就恒通过了
    if (!Object.hasOwn(obj, key)) return `${path}: 缺少必需属性 "${key}"`;
  }

  const properties = schema.properties ?? {};
  for (const [key, sub] of Object.entries(properties)) {
    if (Object.hasOwn(obj, key)) {
      const err = check(sub, obj[key], `${path}.${key}`, depth + 1);
      if (err) return err;
    }
  }

  if (schema.additionalProperties === false) {
    // 同上：`k in properties` 会把 toString 之类的原型键当成「已声明」放行
    const extra = Object.keys(obj).filter((k) => !Object.hasOwn(properties, k));
    if (extra.length > 0) {
      return `${path}: 存在 schema 未声明的属性 ${extra.map((k) => `"${k}"`).join(', ')}`;
    }
  }
  return null;
}

/**
 * `maxItems` 的取值校验。**坏值必须抛，而不是放行**：判据是 `value.length > maxItems`，
 * `NaN` / `undefined` 那一类会让比较恒假 ⇒ 闸静默失效（与 `metricsSink.maxLabelValues`
 * 登记的是同一种事故）；`0` 是真值（只许空数组），不能拿 `||` 或 `Math.max(1, …)` 抬走。
 */
function maxItemsOf(schema: JsonSchema, path: string): number | undefined {
  const raw = schema.maxItems;
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw new TypeError(
      `${path}: maxItems 必须是非负安全整数（${zeroClauseOf('JsonSchema.maxItems')}），收到 ${String(raw)}`,
    );
  }
  return raw;
}

function checkArray(
  schema: JsonSchema,
  value: unknown,
  path: string,
  depth: number,
  maxItems: number | undefined,
): string | null {
  if (!Array.isArray(value)) return `${path}: 期望 array，得到 ${typeOf(value)}`;
  // 先判长度再逐项校验：模型要修的是「少给几项」，一条含长度的错误比第 11 项的
  // 类型错误更直接。只对 type:'array' 生效（非数组 schema 上写了它按规范放行）。
  if (maxItems !== undefined && value.length > maxItems) {
    return `${path}: 数组长度 ${value.length} 超过 maxItems ${maxItems}`;
  }
  const items = schema.items;
  if (items && typeof items === 'object' && !Array.isArray(items)) {
    for (let i = 0; i < value.length; i++) {
      const err = check(items as JsonSchema, value[i], `${path}[${i}]`, depth + 1);
      if (err) return err;
    }
  }
  return null;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function preview(value: unknown): string {
  const s = stringifySafe(value);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return (
    ka.length === kb.length &&
    ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}
