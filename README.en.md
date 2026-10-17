# Agentia

[![CI](https://github.com/migoric/agentia/actions/workflows/ci.yml/badge.svg)](https://github.com/migoric/agentia/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@migor/agentia)](https://www.npmjs.com/package/@migor/agentia) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[中文 README](./README.md) · **English**

**A declarative framework for building production agent services.** You declare four kinds of capability
with decorators + DI and a main agent orchestrates them; every run yields structured output and an
observable call tree (trace, cost, metrics).

**1 package · ≈2 MB · 0 runtime dependencies · 90+ guards** — the answer to the first question when
choosing a library (how big is the install?): `npm i @migor/agentia` puts exactly **one** package into
`node_modules` and pulls in no vendor SDK. These numbers are recomputed by
`tests/docs/scoreboard.test.ts` on every run; hand-written figures rot.

> This is a **summary**. The [website](https://agentia-web.pages.dev/en) is **bilingual** — the English
> pages mirror the Chinese ones section by section — but the authoritative and always-current
> **long-form** documentation is Chinese:
> [`docs/usage-guide.md`](./docs/usage-guide.md) (API reference, type wiring, known limits; the same
> text is served verbatim at `/llms-full.txt`). We keep this file short on purpose — a hand-maintained
> full translation drifts.

## Requirements

Node.js **≥ 18** (the only `engines` requirement). CI covers **18 / 20 / 24** — the `import-floor`
matrix pins the floor declared in `engines`, every other job follows the current LTS. Deno and edge
runtimes are **not** validated. The only store touching a Node builtin is `SqliteTaskStore` (needs
Node ≥ 22.5 for `node:sqlite`) — it fails with a readable error at construction time, and never breaks
importing the package.

## Install

```bash
npm i @migor/agentia          # the framework
npm i -g @migor/cli           # CLI: scaffold / generate / dev inspector

agentia create my-app         # scaffold ships .env / .env.example
$EDITOR my-app/.env           # put ANTHROPIC_API_KEY here (export works too — real env wins)
# optional: ANTHROPIC_BASE_URL (compatible gateways), AGENTIA_MODEL (default claude-opus-5)
```

> The framework does **not** read `.env` on its own: the scaffolded `src/main.ts` calls
> `loadEnvFile()` on its first line. Real environment variables always win over the file
> (CI / docker / command line), unless you pass `loadEnvFile({ override: true })`.

## Quick start

### A. CLI

```bash
agentia create my-app
cd my-app && npm install
agentia g tool weather          # create src/tools/weather/index.ts and register it
agentia dev                     # local inspector panel (drive a run, pick capabilities/workdir)
```

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
- **MCP** — `createStdioMcpConnector()` / `createStreamableHttpMcpConnector()` ship with the framework
  (stdlib only: `node:child_process` + global `fetch`); `mcpTools()` bridges the server's tools into the
  menu. The framework never imports the MCP SDK, and the `McpClientLike` seam stays open
  (bring the official SDK / a remote server / your own transport).
- **Memory** — `memory: { store, keys }` for cross-run state; task stores: memory / JSONL / SQLite / Redis
- **Evals** — `scriptedClient` + `defineEval` turn mocked runs into a first-class diagnostic loop
- **Platforms** — send traces to Langfuse / Phoenix / etc. via OTLP or a tiny custom `TraceSink`
  (see [`docs/observability.md`](./docs/observability.md) §2.6)

## Documentation

| | |
|---|---|
| Usage guide (authoritative, zh) | [`docs/usage-guide.md`](./docs/usage-guide.md) |
| Production observability recipes | [`docs/observability.md`](./docs/observability.md) |
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

> Honest caveat: this discipline was **tightened over time** — early versions (`0.7.1`, a type-level
> change) put the action in the entry's leading blockquote instead of its own section. The command
> above is a **lower bound**, not the whole set. And this README deliberately prints **no**
> "N releases / M migrations" count: hand-written counts rot, so we ship the command instead.

**What is covered by the compatibility promise:** the **named exports** of `@migor/agentia`
(`src/index.ts` is the source of truth) and the `@migor/cli` command surface, plus the Node range in
`engines.node` — CI runs the full chain on every version in that range. **Not covered:** deep imports
(`dist/**`) — **sealed by the `exports` field** in `package.json` (guarded by
`tests/architecture/package-exports.test.ts`; before `exports` existed they really did resolve) —
internal module paths, `packages/*`, `examples/*`, Deno / Bun / edge runtimes (unvalidated),
and anything a release does not spell out in its migration note. Runtime third-party dependencies are
**zero** — enforced by `tests/architecture/no-runtime-deps.test.ts`, not by promise.

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
> The five benchmarks are **deliberately not in CI** (timing benchmarks only add noise on CI machines;
> `docs/plans/2026-09-22-dev-debug-loop.md` settled on "run them when you want to look") ⇒ nothing
> guards the numbers below — re-run the command in the last column.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) — and note that [`AGENTS.md`](./AGENTS.md) is the single
source for this repo's engineering conventions. Security issues: [`SECURITY.md`](./SECURITY.md)
(please don't open a public issue).

## License

[MIT](./LICENSE)
