/** 任意值 → 字符串：string 原样，其余 JSON.stringify，循环引用等异常回落 String()。 */
export function stringifySafe(x: unknown): string {
  if (typeof x === 'string') return x;
  try {
    return JSON.stringify(x) ?? String(x);
  } catch {
    return String(x);
  }
}

/** 截断到上限字符、超长加省略标记 `…(+N)`。trace 展示（engine/loop）与 replay 共用同一格式。 */
export function truncateWithMark(s: string, n: number): string {
  // n <= 0 = 截到零长度（`maxEventChars` / `maxToolResultChars` 的 limits 表口径）。
  // 此前 0 会走 `slice(0,0) + 省略标记`，回给模型的是 `…(+N)` 而不是空串。
  if (n <= 0) return '';
  return s.length > n ? `${s.slice(0, n)}…(+${s.length - n})` : s;
}
