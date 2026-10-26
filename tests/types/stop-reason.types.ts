/*
 * 「stop reason 的成败分类是**穷尽式**的」—— 类型级守卫（外部深评 E5）。
 *
 * 只做类型检查（文件名不是 `*.test.ts`，`node:test` 不收）：由 **`npm run typecheck:types`**
 * 校验（`tsconfig.types.json` 的 `include: ["tests/types"]`；⚠️ **不是** `typecheck:tests` ——
 * 那个 tsconfig 明确 `exclude: ["tests/types"]`，照错的命令跑本文件一个字都不会被检查）。
 *
 * 守的是什么：`src/engine/types.ts` 的 `SUCCESS_STOP_REASON` 是
 * `Record<AgentStopReason, boolean>` —— **往联合里加一个成员而没在表里表态**，`tsc` 当场报缺属性。
 * 于是三处消费者（`runtime/run.ts` 的 run 状态 / `engine/loop.ts` 的 trace 状态 /
 * `toolkit/subagent.ts` 的交回判定）不可能各说各话 —— 那正是 `stop_sequence` 落地时踩过的坑
 * （loop 判成功、Run 判失败）。E5 的原判是「要加 `never` 穷尽断言」；实际做成了**表**，
 * 因为表比运行期 `never` 断言更强：**编译期**就拦，且新增成员时逼你补一行语义。
 *
 * ⚠️ 下面那条 `@ts-expect-error` 是**正控**，不是装饰：它证明「Record 要求完整性」这件事真的在岗。
 * 谁把表放宽成 `Partial<Record<…>>`（或给它加 `?? false` 兜底），这条指令就变成**未使用** ⇒
 * `TS2578: Unused '@ts-expect-error' directive` ⇒ 类型检查红。少了它，守卫退化成一句注释。
 */
import { isSuccessStopReason } from '../../src/engine/types.js';
import type { AgentStopReason } from '../../src/engine/types.js';

/* ============ 正向：编译过 == 「表覆盖了联合的每一个成员」 ============ */

/** 与 `SUCCESS_STOP_REASON` 同形的完整表；**少一个成员就编译不过**（这就是那条护栏） */
const allClassified: Record<AgentStopReason, boolean> = {
  end_turn: true,
  stop_sequence: true,
  max_tokens: false,
  refusal: false,
  pause_turn: false,
  max_iterations: false,
  result_missing: false,
  aborted: false,
  budget_exceeded: false,
  tool_use_no_blocks: false,
  unknown_stop_reason: false,
  error: false,
  suspended: false, // 既不是成功也不是失败：这一列只回答「算不算成功」
};

/** 公开面：判定返回 `boolean`（三处消费者都按 boolean 用） */
const verdict: boolean = isSuccessStopReason('end_turn');

/* ============ @ts-expect-error：不该过的 ============ */

// @ts-expect-error 缺成员的表**不是** Record<AgentStopReason, boolean> —— E5 要的编译期护栏就是它
const incomplete: Record<AgentStopReason, boolean> = { end_turn: true, stop_sequence: true };

// @ts-expect-error 判定只收联合成员：stop reason 拼错一个字母，就必须当场红，不能静默当「失败」
const bogus: boolean = isSuccessStopReason('not_a_stop_reason');

void allClassified;
void verdict;
void incomplete;
void bogus;
