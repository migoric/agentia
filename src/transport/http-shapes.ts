import type { Trace, SpanError } from '../core/trace.js';
import type { RunStatus } from '../core/run.js';
import type { TaskEvent } from '../core/run.js';
import type { AgentRunResult, AgentStopReason } from '../engine/types.js';
import type { RunInvocationOptions } from '../engine/spec.js';
import type { ApprovalDecisions } from './async.js';

/**
 * Agentia —— HTTP 宿主的**出入站形状口径**（transport/http.ts 的拆分第一步）。
 *
 * 三条边界在这里定形，别处（`http.ts` 的路由分支）只做编排：
 *   - 入站 `POST /tasks`：body 是不是 `{ input, … }`（`toTaskSubmitBody`）；
 *   - 入站 `POST /tasks/<id>/approve`：body 是不是
 *     `{ decisions: { <id>: { approved, reason? } }, decidedBy? }`（`parseApproveBody`）；
 *   - 出站：run 产物 → HTTP 响应体（`toHttpBody`，JSON 与 SSE 的 `run.end` **共用同一形状**）。
 *
 * 三条都是**纯形状判定**：只读参数、只回值，不碰 req/res、不写响应、不抛异常
 * （形状不合法一律回 `undefined`，由调用方选状态码 —— 400 还是别的，是路由的语义）。
 * 判定刻意做窄且**全有或全无**：一处不合法就整条拒掉，不做「能救则救」的部分接受 ——
 * 半接受的审批体比拒掉更危险（缺哪个 tool_use 的决定，只有调用方知道）。
 */

/** POST /run 的响应形态 */
export interface RunHttpResponse {
  runId: string;
  status: RunStatus;
  stopReason: AgentStopReason;
  finalText: string;
  /** 结构化结果（R2 起应用可携带；无则为 undefined，字段在场） */
  typed: unknown;
  trace: Trace;
  error: SpanError | undefined;
}

/** POST /tasks 的请求体形态 */
export interface TaskSubmitBody {
  input: unknown;
  idempotencyKey?: string;
  options?: RunInvocationOptions;
}

/** 把 app.run 的产物收成 HTTP 响应体（JSON 与 SSE 的 run.end 共用同一形状） */
export function toHttpBody(out: {
  run: { runId: string; status: RunStatus };
  result: AgentRunResult;
}): RunHttpResponse {
  return {
    runId: out.run.runId,
    // status 取 **run 状态机**的口径（它才知道 suspended 不是终态），
    // 不从 stopReason 反推 —— 两者语义不同，反推会把挂起当成失败
    status: out.run.status,
    stopReason: out.result.stopReason,
    finalText: out.result.finalText,
    typed: (out.result as { typed?: unknown }).typed,
    trace: out.result.trace,
    error: out.result.error,
  };
}

/**
 * `POST /tasks` 的 body 形状闸：必须是**纯对象**（`null` / 数组 / 标量都不算）。
 * 返回**同一个引用**（不是副本）—— 后续 `runner.submit` 拿到的就是请求里那个对象。
 */
export function toTaskSubmitBody(body: unknown): TaskSubmitBody | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return body as TaskSubmitBody;
}

/**
 * 解析 `POST /tasks/<id>/approve` 的 body；形状不合法返回 undefined（调用方回 400）。
 * `decisions` 必须是纯对象，每个值是 `{ approved: boolean, reason?: string }`。
 */
export function parseApproveBody(
  body: unknown,
): { decisions: ApprovalDecisions; decidedBy?: string } | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const o = body as { decisions?: unknown; decidedBy?: unknown };
  if (!o.decisions || typeof o.decisions !== 'object' || Array.isArray(o.decisions)) {
    return undefined;
  }
  if (o.decidedBy !== undefined && typeof o.decidedBy !== 'string') return undefined;
  const decisions: ApprovalDecisions = {};
  for (const [id, d] of Object.entries(o.decisions)) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return undefined;
    const v = d as { approved?: unknown; reason?: unknown };
    if (typeof v.approved !== 'boolean') return undefined;
    if (v.reason !== undefined && typeof v.reason !== 'string') return undefined;
    decisions[id] = {
      approved: v.approved,
      ...(v.reason !== undefined ? { reason: v.reason } : {}),
    };
  }
  return {
    decisions,
    ...(o.decidedBy !== undefined ? { decidedBy: o.decidedBy as string } : {}),
  };
}

/**
 * 解析 `POST /tasks/<id>/events` 的 body（2026-09-28 ref-run-event-input，run 事件投入口）；
 * 形状不合法返回 undefined（调用方回 400）。
 *
 * **白名单**（B1）：只接受 `{ eventId?, type, payload }` 三个键，**多一个字段即拒** ——
 * 这是外部输入第一次进入消息历史，「能救则救」在这里等于放行协议注入面
 * （与 parseApproveBody 的「全有或全无」同一条纪律）。三个值全是字符串：
 * 外部永远不能构造消息块。
 */
export function parseEventBody(body: unknown): TaskEvent | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const o = body as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key !== 'eventId' && key !== 'type' && key !== 'payload') return undefined;
  }
  if (typeof o.type !== 'string' || o.type === '') return undefined;
  if (typeof o.payload !== 'string') return undefined;
  if (o.eventId !== undefined && (typeof o.eventId !== 'string' || o.eventId === '')) {
    return undefined;
  }
  return {
    type: o.type,
    payload: o.payload,
    ...(o.eventId !== undefined ? { eventId: o.eventId as string } : {}),
  };
}
