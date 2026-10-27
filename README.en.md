# Agentia

[![CI](https://github.com/migoric/agentia/actions/workflows/ci.yml/badge.svg)](https://github.com/migoric/agentia/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@migor/agentia)](https://www.npmjs.com/package/@migor/agentia) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[中文 README](./README.md) · **English**

**A declarative framework for building production agent services.** You declare four kinds of capability
with decorators + DI and a main agent orchestrates them; every run yields structured output and an
observable call tree (trace, cost, metrics).

**1 package · ≈2 MB · 0 runtime dependencies · 90+ guards** — recomputed by
`tests/docs/scoreboard.test.ts` on every run.

> This is a **summary**, kept short on purpose (a hand-maintained full translation drifts). The
> [website](https://agentia-web.pages.dev/en) is bilingual, but the authoritative long-form
> documentation is Chinese: [`docs/usage-guide.md`](./docs/usage-guide.md) (also served verbatim at
> `/llms-full.txt`).

## Requirements

Node.js **≥ 18** (the only `engines` requirement); CI covers **18 / 20 / 24**. Designed and tested on
Node; **Bun and Deno are verified runnable** (four-step check — import → assemble → HTTP → side
effects — plus minimal mounting code per host and the measured versions, in
[`docs/frameworks.md`](./docs/frameworks.md); the front page deliberately carries no version numbers —
they rot); **edge runtimes remain unverified**.
`SqliteTaskStore` needs Node ≥ 22.5 (`node:sqlite`) and fails with a
readable error at construction — importing the package still works.

## Install

```bash
npm i @migor/agentia          # the framework
npm i -g @migor/cli           # CLI: scaffold / generate / dev inspector

agentia create my-app --minimal  # single entry file + a bare tool; ships .env / .env.example
cd my-app && npm install
$EDITOR .env                     # put ANTHROPIC_API_KEY here (export works too — real env wins)
npm run dev -- "your question"   # tsx src/main.ts: one run, then exit
# optional: ANTHROPIC_BASE_URL (compatible gateways), AGENTIA_MODEL (default claude-opus-5)
```

> The framework does **not** read `.env` on its own: the template entry calls `loadEnvFile()`.
> Real environment variables win over the file unless you pass `{ override: true }`.

## Quick start

### A. CLI

Start with `--minimal` to exercise the model and a bare tool without learning decorators, DI or the HTTP
host first. For the inspector, four capability directories and a production service, use the **default
full template without `--minimal`** (unchanged):

```bash
agentia create my-service
cd my-service && npm install
agentia g tool weather          # create src/tools/weather/index.ts and register it
agentia dev                     # local inspector panel (drive a run, pick capabilities/workdir)
```

In the full template, `src/main.ts` starts the HTTP service and `src/batch.ts` is the one-shot
`npm run start:batch` entry.

Four self-describing directories hold capabilities — the directory name **is** the kind:
`src/tools/` · `src/skills/` · `src/prompts/` · `src/subagents/`; the registry is `src/registry.ts`.

### B. By hand

```ts
import { Tool, createApp, SystemPrompt } from '@migor/agentia';

class WeatherTools {
  @Tool({
    description: 'Look up the weather for a city',
    schema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
  })
  get_weather(input: { city: string }): string {
    return `city=${input.city}`;
  }
}

const app = createApp({
  name: 'weather-app',
  providers: [{ provide: 'weather', useClass: WeatherTools }],
  system: new SystemPrompt().add('role', 'You are a helpful weather assistant.', true),
});

const { result } = await app.run([{ role: 'user', content: 'Weather in Shanghai?' }]);
console.log(result.finalText); // final text
console.log(result.trace);     // call tree + per-step tokens/cost (traceId === runId)
```

Or point `createApp` at the directories instead of passing providers:
`createApp({ discover: ['src/tools', 'src/skills', 'src/prompts', 'src/subagents'], system })`.

### C. Existing service? Add one endpoint

Don't scaffold a new project, and don't rewrite the one you have. Wrap an existing function as a
`@Tool`, then add **one branch** in your existing `createServer`: business routes first (your code
stays untouched), everything else goes to `createHttpHandler` (`/run`, `/tasks`, `/healthz`).
Auth is **the same function** for both, and `drain()` hooks into the SIGTERM flow you already have.

Six steps, roughly 30 lines of glue. Runnable example:
[`examples/agent-endpoint/`](./examples/agent-endpoint/) — an order service that already ships
`GET /api/orders/:id`, with the agent endpoint added alongside; `src/orders.ts` is unchanged.

> Three deliberate calls: **one auth path** (the framework gives you the seam, not the policy);
> **RAG is your tool** (wrap your own `pg.query` / vector client in a `@Tool` — the framework won't
> ship one); **no budget knobs = no fuse** (the example sets all three).

## The four capability kinds

The model picks from one shared "menu" by `description`; the decorator decides **who controls the flow**:

| Kind | Decorator | Who controls the flow | Typical use |
|---|---|---|---|
| Tool | `@Tool` | your code (one call = one function) | deterministic work: DB, math, HTTP |
| Skill | `@Skill` | your code (scripted; model calls only at explicit `ctx.llm()`) | fixed "fetch → let the model write → post-process" pipelines |
| Sub-agent | `@SubAgent` | **the model** (own loop, trimmed context) | multi-step autonomy without polluting the main context |
| Prompt asset | `@Prompt` | pulled by the model on demand | long specs/templates that shouldn't sit in context by default |

## Runtime features

- **Triggering** — `app.run()` (sync RPC) · `AsyncRunner` (idempotency-keyed, retryable, resumable via a
  store) · `Scheduler` (cron-like) · `createHttpHandler` (`POST /run`, `POST /tasks`, `GET /tasks/:id`,
  `GET /healthz`, optional `GET /metrics`, graceful `drain()`)
- **Context budget** — `createBudgetPolicy({ budgetTokens, summarize })`
- **Hard cost caps** — `maxTotalTokens` / `maxCostUsd` (+ `priceOverrides` to price non-Anthropic models)
- **Structured output** — `resultSchema`; `result.typed` is validated, or use `fromZod<T>()` for full type inference
- **Middleware** — an onion chain around every capability call (auth, rate limiting, caching, audit)
- **Cancellation / retries / streaming / tool concurrency** — `signal`, retry policy, `onText`, `maxToolConcurrency`

## Observability & cost

One run == one trace (`traceId === runId`), **built in from turn 0** — not a bolt-on third-party tracing SDK:

- **Per-step accounting** — every span carries model, input/output/cache tokens, cost estimate, status and error type
- **One seam out** — `TraceSink { export(trace) }`, delivered on **both** the success and failure paths; a throwing
  sink never breaks the run. Persistence / sampling / redaction are composed outside the seam
  (`examples/observability/`, [`docs/observability.md`](./docs/observability.md))
- **Cost you can cap** — `priceOverrides` patches the price table; unpriced models emit an explicit
  `usage.unpriced` event (never a silent zero); `maxCostUsd` / `maxTotalTokens` stop the run
- **Replay** — `traceToMessages(trace)` linearises a finished trace back into model messages
- **Export** — `createOtlpExporter({ endpoint })`; `metricsSink()` (Prometheus text or OTLP metrics), zero dependency
- **Locally visible** — `agentia dev` opens an inspector panel sharing one renderer with the website Playground;
  `agentia report <trace.jsonl>` ranks which capability is slow / expensive / error-prone

## Integrations

- **Models** — `createAnthropicClient()` (default) and `createOpenAIClient()` for any OpenAI-compatible
  endpoint (DeepSeek, **Ollama**, gateways). You never need to touch a vendor SDK: pass
  `createAnthropicClient({ baseURL })` / `createOpenAIClient({ baseURL })`.
- **Web framework hosts** — `createHttpHandler` returns a plain `(req, res) => void`, so anything that
  can mount a raw node handler can mount it, with no adapter layer:

  | Host | Minimal mounting | Required config |
  |---|---|---|
  | `node:http` | `createServer(createHttpHandler(app, { runner }))` | none |
  | NestJS 12 (CJS / ESM) | `nestApp.use('/agent', handler)` — 3 lines | CJS mode needs Node ≥ 22.12 (or `await import()`) |
  | Egg 4 | middleware + `ctx.respond = false` | two `ignore` entries (CSRF / bodyParser) — the string form crashes the worker at startup |
  | Bun / Deno | identical to `node:http`, zero changes | Deno's `--allow-net/read/write/run` |

  Under cluster / multi-instance the task store **must** be shared — one in-memory store per worker
  makes polling the same taskId alternate `404 200`. Conclusion table, minimal code and Egg's three
  pitfalls: [`docs/frameworks.md`](./docs/frameworks.md).
- **MCP** — `createStdioMcpConnector()` / `createStreamableHttpMcpConnector()` ship with the framework
  (stdlib only: `node:child_process` + global `fetch`); `mcpTools()` bridges the server's tools into the
  menu. The framework never imports the MCP SDK, and the `McpClientLike` seam stays open
  (bring the official SDK / a remote server / your own transport).
- **Memory** — `memory: { store, keys }` for cross-run state; task stores: memory / JSONL / SQLite / Redis
- **Evals** — `scriptedClient` + `defineEval` turn mocked runs into a first-class diagnostic loop
- **Platforms** — send traces to Langfuse / Phoenix / etc. via OTLP or a tiny custom `TraceSink`
  (see [`docs/observability.md`](./docs/observability.md) §2.6)

## API at a glance

| Export | Purpose |
|---|---|
| `createApp` / `discoverProviders` | assemble an app / scan capability directories |
| `defineModule` | capability package (providers + middleware, distributable) |
| `Tool` / `Skill` / `SubAgent` / `Prompt` | the four capability decorators |
| `CapabilityMiddleware` (the `middleware` option) | interceptor chain around capability calls |
| `asset` | read a text asset inside a capability folder |
| `SystemPrompt` | compose the system prompt (adds the cache breakpoint) |
| `RunContext.current()` | blackboard / runId for the current run |
| `AsyncRunner` / `Scheduler` / `runSync` / `createHttpHandler` | async / scheduled / sync / HTTP triggering |
| `FileTaskStore` / `SqliteTaskStore` / `RedisTaskStore` / `InMemoryTaskStore` | task record stores |
| `createBudgetPolicy` | long-context budget guard |
| `createAnthropicClient` | default ModelClient (Anthropic) |
| `createOpenAIClient` | any OpenAI-compatible endpoint |
| `InMemoryMemoryStore` (the `memory` option) | cross-run memory hydration / write-back |
| `createOtlpExporter` | export traces over OTLP |
| `traceToMessages` | replay a finished trace as model messages |
| `fromZod` | zod schema adapter (optional peer) |
| `runAgent` / `executeRun` | bare engine entry (no assembly) |

## Documentation

| | |
|---|---|
| Usage guide (authoritative, zh) | [`docs/usage-guide.md`](./docs/usage-guide.md) |
| Production observability recipes | [`docs/observability.md`](./docs/observability.md) |
| Database integration (inject your pool / implement `TaskStore` for MySQL) | [`docs/database.md`](./docs/database.md) |
| Framework compatibility (measured: NestJS / Egg / Bun / Deno) | [`docs/frameworks.md`](./docs/frameworks.md) |
| Examples (complete app / minimal deploy / observability) | [`examples/`](./examples/) |
| Design spec & roadmap | [`docs/spec.md`](./docs/spec.md) · [`docs/roadmap.md`](./docs/roadmap.md) |
| Website · Playground | [agentia-web.pages.dev/en](https://agentia-web.pages.dev/en) · [playground](https://agentia-web.pages.dev/en/playground) |

## Stability & versioning

**What `0.x` means here:** versions follow SemVer, but during `0.x` a **minor release may contain a
breaking change**. There is exactly one rule — **a breaking change must leave a trace**: that version's
`CHANGELOG.md` entry carries a dedicated section (its heading contains 「迁移」 or 「破坏性变更」)
stating what **you** have to change.

```bash
grep -nE '^#{3,4} .*(迁移|破坏性)' CHANGELOG.md    # every "you must act" section
```

> The command above is a **lower bound**, not the whole set — early versions didn't follow this format.
> Counts ("N releases / M migrations") are deliberately not printed: they rot.

**Covered by the compatibility promise:** the **named exports** of `@migor/agentia` (`src/index.ts` is
the source of truth) and the `@migor/cli` command surface, plus the Node range in `engines.node` (CI
runs the full chain on every version in it). **Not covered:** deep imports (`dist/**`) — sealed by the
`exports` field in `package.json`, guarded by `package-exports.test.ts` — internal module paths,
`packages/*`, `examples/*`, edge runtimes, and anything a release doesn't spell out in its
migration note. Bun / Deno are **verified runnable but outside the `engines` promise**
([`docs/frameworks.md`](./docs/frameworks.md)). Runtime third-party dependencies are **zero**, enforced by
`no-runtime-deps.test.ts`, not by promise.

**What 1.0 waits for** (all three are checkable): every open item in `docs/spec.md` §11 is either
shipped or explicitly struck out; `docs/guards.md` §2 ("awaiting a guard") is empty; and the public
export surface has gone **three consecutive minors with no breaking change**.

## Performance order of magnitude

Five benchmarks ship with the repo (`scripts/bench-*.ts`). They answer **shape** questions — which
cost you pay under which condition, and what a different implementation could remove — not an SLA:

| Question | Local reading (macOS / Node 24 — **order of magnitude**) | Shape (the part that **does not** move with the machine) | Re-run |
| --- | --- | --- | --- |
| Cost of assembling an app | pure assembly `0.4 ms`; discover + assemble `8.1 ms`; whole-process boot + assemble `4040 ms` (of which cold assembly ≈2963 ms; the bare process boot alone is 1077 ms) | Swapping capability selection in a **resident runner** pays only `S2` (≈8 ms), not `S6b` (≈4 s) ⇒ **~500×**. ~1.1 s of that 4 s is the `tsx` interpreter booting — nothing to do with the framework | `npm run bench:assembly` |
| When an MCP connector costs you | cold (spawn + initialize + list) `279.5 ms`; warm (reused connector, one `tools/list` round trip) `0.3 ms` | Only **rebuilding** the connector pays the cold one ⇒ **~900×**. So whether "rebuilding the app includes an MCP handshake" is true **depends on what the connector's lifetime is** | `npm run bench:assembly` |
| What recording trace content costs | large tool output (≈37 KB/call), 5 calls: default `17.2 KB` / untruncated `233.9 KB` (**13.6×**) / truncate-200 `6.2 KB`; 20 calls: `65 KB → 932 KB` (14.3×) | The default **already truncates** (the ≈14× gap comes from turning truncation off). `traceContent:'full'` is priced **per output byte** — at small output size the measured gap is 1.0× | `PAYLOAD_ROWS=1000 CALLS='[5,20]' npm run bench:trace` |
| Cost of a metrics snapshot / OTLP flush | `snapshot()` `6.56 ms` (30 series × 2 percentiles); `buildOtlpPayload()` `0.073 ms` | Flush cost is **almost entirely `snapshot()`** ⇒ skipping it saves ≈6.5 ms per flush, **proportional to flush frequency**, unrelated to whether OTLP is consumed | `npm run bench:otlp` |
| Scanning suspended tasks for due time | sqlite N=10000: full `list()` `61.9 ms` / due index `listDue` `0.1 ms`; file store N=10000: `load` `69.5 ms`, `list` `0.0 ms` | **Having an index** is structural (**~600×**), not a tuning knob. The file store keeps records in memory ⇒ its expensive pass is the **full `load` at construction** | `npx tsx scripts/bench-resume-scan.ts 10000` |
| Shape of the redis store's `list()` | N=10000: **10001** round trips, **42.1 MB** parsed, `104.1 ms` pure CPU; with a helper ZSET (`score = wakeAt`) ⇒ **1001** round trips | Round-trip count is **structural** (that is what another implementation can remove); no local redis here, so latency is extrapolated only (RTT 0.2 ms ⇒ 2 s) | `npx tsx scripts/bench-redis-due.ts 10000` |

> ⚠️ **The milliseconds are not a promise** — they move with the machine, the Node version and the
> load; copying them as an SLA will be wrong. What is actually constant is the **shape** (how many
> times larger, how many round trips, what scales with what).
>
> The five benchmarks are **deliberately not in CI** (timing benchmarks only add noise) ⇒ nothing
> guards these numbers; re-run the command in the last column.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) — and note that [`AGENTS.md`](./AGENTS.md) is the single
source for this repo's engineering conventions. Security issues: [`SECURITY.md`](./SECURITY.md)
(please don't open a public issue).

## License

[MIT](./LICENSE)
