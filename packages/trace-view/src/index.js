/* @migor/trace-view —— Agentia trace 调用树渲染器（框架无关、零依赖）。
 * 官网 playground 与 CLI inspector 共用同一份，避免两处渲染漂移。 */

export {
  createTraceView,
  capabilityTypeOf,
  CAP_ICO,
  fmtArg,
  rawArg,
  fmtNum,
  fmtMs,
} from './view.js';
export { playTrace } from './fromTrace.js';
export { summarizeTrace, renderSummary } from './summary.js';
/* 结构化正文块（2026-11-11）：`full` 是容器时，渲染器会给展开行挂上这个块；
 * 2026-11-12 起「装着 JSON 的字符串」也走这条路（`hasStructuredBody` 是同一个判据，
 * 宿主自己判断要不要挂块时用得上）。单独导出是因为它是**纯函数式的 DOM 构造**
 * （入参 → 元素），宿主可以拿它渲染任意值 —— 而 bundle 的导出面必须与这里逐字一致
 * （`test/bundle.test.js`），所以内部件不进公共面、这两件必须进。 */
export { createFullView, hasStructuredBody } from './full-view.js';
