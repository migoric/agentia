export const AGENTIA_VERSION = '0.10.2';

// core：数据模型
export type {
  Trace,
  Span,
  SpanEvent,
  SpanError,
  SpanId,
  SpanKind,
  SpanLink,
  SpanStatus,
  TraceId,
  TraceContext,
  TraceSink,
  TraceRecordEvent,
  CapabilityType,
  Usage,
  Score,
} from './core/trace.js';
export { attachScore, parseTraceparent } from './core/trace.js';
export type {
  AgentTool,
  ApprovalDecision,
  JsonSchema,
  ModelClient,
  RecorderBackend,
  SchemaInput,
  SchemaType,
  ToolRunContext,
  TypedSchema,
} from './core/tool.js';
export { validateJsonSchema } from './core/schema.js';
export { combineSignals } from './core/abort.js';
// core：消息类型族（自有公共类型，与 @anthropic-ai/sdk 结构兼容；SDK 仅在 devDependencies 做兼容门禁）
export type {
  CacheControl,
  ContentBlock,
  ContentBlockParam,
  ImageBlockParam,
  Message,
  MessageParam,
  MessageUsage,
  Role,
  TextBlock,
  TextBlockParam,
  ThinkingBlock,
  ToolParam,
  ToolResultBlockParam,
  ToolUseBlock,
  ToolUseBlockParam,
} from './core/message.js';

// engine：运行时内核
export { runAgent } from './engine/loop.js';
export { resolveDefaultModel } from './engine/run-config.js';
export { TraceRecorder } from './engine/tracer.js';
export type { TraceLimits, TraceRecorderOptions } from './engine/tracer.js';
// 出站链路传播（spec §9.2）：当前调用期的 W3C traceparent，宿主带给出站请求用。
// 框架只给读取器、不做注入（它不创建出站请求）—— 见 docs/usage-guide.md §6。
export { currentTraceparent } from './engine/span-scope.js';
export { classifyError, isAbortError } from './engine/errors.js';
export { isSuccessStopReason } from './engine/types.js';
export type {
  AgentRunResult,
  AgentStopReason,
  ContextPolicy,
  ModelFallbackLink,
  RunAgentOptions,
  SystemParam,
  SystemTextBlock,
} from './engine/types.js';

// engine：长上下文策略
export {
  defaultEstimateTokens,
  estimateMessages,
  renderMessages,
  trimToolPairs,
  compactMessages,
} from './engine/trimming.js';
export type { CompactOptions, TrimOptions } from './engine/trimming.js';
export { createBudgetPolicy } from './engine/policy.js';
export type { BudgetPolicyOptions } from './engine/policy.js';
export { createBudgetGuard } from './engine/budget.js';
export type { BudgetGuard, BudgetGuardOptions, BudgetSnapshot } from './engine/budget.js';
// engine：用量与成本（F1 价格表可注入 / F2 未定价显式）
export { DEFAULT_PRICING, buildPricing } from './engine/usage.js';
export type { ModelPricing } from './core/tool.js';
export { mapWithConcurrency } from './engine/concurrency.js';
export { DEFAULT_RETRY } from './engine/retry.js';
export type { RetryOptions } from './engine/retry.js';

// run：run 生命周期
export { Run, executeRun } from './runtime/run.js';
export { RunContext, withRunContext } from './runtime/context.js';
export type {
  Blackboard,
  BlackboardKey,
  BlackboardSeed,
  BlackboardValue,
} from './core/blackboard.js';
export { SystemPrompt } from './runtime/systemPrompt.js';
export type { SystemPromptOptions, SystemSection } from './runtime/systemPrompt.js';
export type { ExecuteRunOptions } from './runtime/run.js';
export type { RunMeta, RunStatus, SuspendedReason, TaskEvent } from './core/run.js';

// container：显式 DI
export { Container } from './container/container.js';
export type {
  Provider,
  ClassProvider,
  ValueProvider,
  FactoryProvider,
  Token,
} from './container/container.js';

// toolkit：声明式能力 + 应用装配
export { asset } from './toolkit/asset.js';
export { loadEnvFile } from './toolkit/env.js';
export type { LoadEnvOptions } from './toolkit/env.js';
export { discoverProviders } from './toolkit/discover.js';
export { applyMiddleware } from './toolkit/middleware.js';
export type { CapabilityCall, CapabilityMiddleware, CapabilityNext } from './toolkit/middleware.js';
export { Tool, collectTools } from './toolkit/tool.js';
export type { ToolSpec } from './toolkit/tool.js';
export { SubAgent, collectSubAgents, subagentToTool } from './toolkit/subagent.js';
export type { SubAgentSpec, SubAgentCapability } from './toolkit/subagent.js';
export { Skill, collectSkills, skillToTool } from './toolkit/skill.js';
export type {
  SkillContext,
  SkillLlmOptions,
  SkillLlmResult,
  SkillSpec,
  SkillCapability,
} from './toolkit/skill.js';
export { Prompt, collectPrompts } from './toolkit/prompt.js';
export type { PromptSpec } from './toolkit/prompt.js';
export { createApp, AgentApp, registerDefaultTraceSink } from './toolkit/module.js';
export type { AppOptions, RunAppOptions, AgentRunOutput } from './toolkit/module.js';
export { defineModule } from './toolkit/module.js';
export type { AgentModule } from './toolkit/module.js';
export { fromZod } from './toolkit/zod.js';

// run：触发传输 + run 存储
export { normalizeMessages } from './engine/spec.js';
export type { RunInput, RunSpec, RunInvocationOptions } from './engine/spec.js';
export { InMemoryTaskStore } from './store/store.js';
export type { TaskRecord, TaskStore } from './store/store.js';
export { FileTaskStore } from './store/fsStore.js';
export { AsyncRunner } from './transport/async.js';
export type {
  AppCallable,
  AsyncRunnerOptions,
  PersistFailureInfo,
  ResumePendingOptions,
  TaskSink,
} from './transport/async.js';
export { Scheduler } from './transport/scheduler.js';
export type { ScheduleEveryOptions, ScheduleHandle } from './transport/scheduler.js';
export { runSync, createSyncHandler } from './transport/transport.js';

// run：宿主与导出（R3/R4）
export { createHttpHandler, HttpException } from './transport/http.js';
export type {
  HttpHandlerOptions,
  HttpHandler,
  HealthResponse,
  RunHttpResponse,
  TaskSubmitBody,
} from './transport/http.js';
export { SqliteTaskStore } from './store/sqliteStore.js';
export { createOtlpExporter } from './integrations/otlp.js';
// JSONL 文件 sink：`agentia report` / `diff` / `harvest` / `export` 的输入格式（一行一条裸 Trace）
export { jsonlTraceSink } from './integrations/file-sink.js';
export { createOpenAIClient } from './integrations/openai.js';
export { createAnthropicClient } from './integrations/anthropic.js';
export type { AnthropicClientOptions } from './integrations/anthropic.js';
export { InMemoryMemoryStore } from './runtime/memory.js';
export type { MemorySnapshot, MemoryStore, MemoryWriteResult } from './runtime/memory.js';
export { InMemorySessionStore } from './runtime/session.js';
export type { SessionStore } from './runtime/session.js';
export { RedisTaskStore } from './store/redisStore.js';
export type { RedisLike, RedisSetOptions, RedisTaskStoreOptions } from './store/redisStore.js';
export type { MaybePromise } from './store/store.js';
export { traceToMessages } from './engine/replay.js';
export type { ReplayOptions } from './engine/replay.js';
export { forkMessages } from './engine/replay.js';
export type { ForkReplayOptions } from './engine/replay.js';
export { diffTraces } from './engine/trace-diff.js';
export type { DiffEntry, SpanDiff, TraceDiff, TraceDiffOptions } from './engine/trace-diff.js';

// integrations：MCP 桥（D1）+ 两个内置连接器（stdio / StreamableHTTP）—— 桥是 duck-typed，
// 连接器只用标准库（`node:child_process` + 全局 `fetch`），**不新增第三方依赖**（spec §10 2026-09-18）
export {
  mcpTools,
  MCP_DEFAULT_TIMEOUT_MS,
  MCP_CLOSE_GRACE_MS,
  createStdioMcpConnector,
  createStreamableHttpMcpConnector,
} from './integrations/mcp.js';
export type {
  McpClientLike,
  McpConnector,
  McpToolInfo,
  McpToolsOptions,
  StdioMcpConnectorOptions,
  StreamableHttpMcpConnectorOptions,
} from './integrations/mcp.js';
// engine：MCP 反向桥（R8-P5）—— 把 app 的能力菜单暴露成 MCP server（stdio / StreamableHTTP，
// 只用标准库）。落 engine 层的理由见该文件头注（integrations 只允许依赖 core，装不下它）
export { createMcpServer } from './engine/mcp-server.js';
export type { McpServer, McpServerApp, McpServerOptions } from './engine/mcp-server.js';
// integrations：指标（D3 → E2/E3/E4/E5）—— 满足 TraceSink 即可接入，能力零新出口
export { metricsSink, DEFAULT_BUCKETS } from './integrations/metrics.js';
export type {
  MetricsSink,
  MetricsSinkOptions,
  MetricsSnapshot,
  ModelMetrics,
  CapabilityMetrics,
  RunLabelMetrics,
  ExemplarSnapshot,
} from './integrations/metrics.js';
// integrations：调优报告（G1）—— 纯函数，从 trace 派生「哪个能力慢/贵/爱失败」
export { buildRunReport, mergeRunReports, renderRunReport } from './integrations/report.js';
export type {
  DurationReport,
  ModelReport,
  RunReport,
  CapabilityReport,
} from './integrations/report.js';

// eval：把 mockClient 提升为一等能力（D2）—— 叶子消费模块，只依赖公共面
export { scriptedClient } from './eval/scripted.js';
export type { ScriptedStep } from './eval/scripted.js';
export { defineEval } from './eval/defineEval.js';
export type {
  EvalCase,
  EvalCaseReport,
  EvalContext,
  EvalDefinition,
  EvalReport,
} from './eval/defineEval.js';
