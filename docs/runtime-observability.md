# Runtime observability and cost dashboard

Phase 4O adds a bounded, page-scoped telemetry protocol and a cost/observability panel to the Live Vision Runtime Lab. It does not create a global event bus and does not pretend that the Runtime Lab and the separate Perception Lab are one end-to-end session.

## Existing metrics audit

| Source | Metric | Unit | Collection point | Lifecycle / aggregation | Previously displayed |
| --- | --- | --- | --- | --- | --- |
| `src/core/metrics.ts` | inputs, sent, filtered %, mean processing | frames, %, ms | `Sampler.process` -> `MetricsCollector` | One collector per sampler/session; cumulative; reset by a new `SamplingSession` | Visual demo counters/rates |
| `src/core/rate.ts` | input/sent rates | frames/s | sampling session rolling rate meters | 2 s rolling window; bounded timestamp storage | Visual demo |
| `src/core/timeline.ts` | decisions | entries | sessions/scheduler journals | Fixed ring; session reset | Timeline / lab records |
| `src/perception/metrics.ts` | batches, observations, queue/stale drops, not-ready skips, effective FPS, P50/P95 inference, long tasks | counts, fps, ms | Perception page, per detection session | Cumulative; reset on session; latency samples capped at 500 | Perception page stats |
| `src/perception/queue.ts` | one in-flight + one latest pending | requests | Perception page | Capacity 2; replacements counted | Perception page |
| `src/inference/runtime-metrics.ts` | per-task dispatch/first-text/effective/upstream/stop latencies, tokens, outcome, reason, stale/blocked, unanswered | ms, tokens, counts | `InferenceScheduler.record` | Per task; bounded to 160 tasks; filtered by scheduler session | Runtime Lab task/request lists |
| `src/inference/scheduler.ts` | records, queue, attempts, slots, peaks, rolling transport, settled/reserved/provisional tokens, unknown usage, quarantined slots, freeze | counts, bytes, tokens | Scheduler journal/snapshot | Journal 160; session-scoped; cumulative token counters | Runtime Lab partially |
| `src/gateway/ledger.ts` | held slots, settled/provisional/reserved nano-USD, accepted count, overrun/frozen | slots, integer nano-USD, count | Gateway process, persistent `.local` ledger | Durable; fsync/rename; restored on restart; capped by config | Not before Phase 4O |
| `src/gateway/server.ts` | `/api/runtime` capabilities + budget snapshot | JSON | Authenticated GET | Reads ledger snapshot; no inference mutation | Runtime Lab had no cost panel |
| `src/inference/gateway-provider.ts` | `budget()` | JSON | Browser fetch of `/api/runtime` | 5 s timeout; per call | Not used by dashboard before |
| `src/runtime-lab.ts` | queue/slots/tokens/task timings | mixed | 200 ms UI render | Display-only | Yes, partial |

### Gaps found

- No USD cost display; the browser showed token counts only.
- No total/settled/reserved/provisional/available/utilization or accepted/limit/frozen cost view.
- No unified event schema across perception, context, decision, scheduler, model and cost.
- No bounded time-series export; only DOM lists.
- P50/P95 were not summarized in a single dashboard view.
- Perception and inference runs were not labeled as independent runtimes.
- Gateway cost polling did not exist; no stale/unavailable distinction.

## Telemetry protocol

`src/observability/types.ts` defines a small, transport-neutral event:

```ts
{
  id, atMs, module, kind, name, value?, unit?, source,
  sessionId?, taskId?, requestId?, providerRequestId?,
  attributes?: lowCardinalityScalars
}
```

- `module`: `perception`, `context`, `decision`, `scheduler`, `model`, `cost`, `runtime`.
- `kind`: `counter`, `gauge`, `histogram`, `event`.
- `source`: `mock`, `fixture`, `real`, `unavailable`.
- Identity fields are separate from low-cardinality attributes. High-cardinality IDs are never placed in `attributes`.
- `TelemetryHub` owns bounded event storage (500 in the Runtime Lab; 320 in Perception), bounded series (180/120 points; at most 24 series names). There is no global event bus.
- `clear()` resets all counters; `clearSession(sessionId)` removes one session's events/series.
- Attributes are truncated and filtered for sensitive/high-cardinality keys (`prompt`, `text`, `image`, `video`, `token`, `secret`, `key`, `authorization`, `payload`, `data`, `cookie`, `password`). Callers still must not pass raw conversation, pixels, credentials, or model output.

### Current emission coverage

| Module | Emitted in Phase 4O | Source |
| --- | --- | --- |
| Perception | model load start/ready/failure/unload, worker failure, session start/invalidate, detection batch, inference histogram, FPS/batches/drops/long tasks | Perception page, local model (`real`/`unavailable`/`mock`) |
| Context | cache bytes/frames, combined transfer frames/bytes | Runtime Lab sampling session |
| Decision | action and degraded flag at low-frequency decision ticks | Runtime Lab decision scheduler |
| Scheduler | queue depth, slots, settled tokens, unknown usage, task end/outcome/reason events | Runtime Lab scheduler |
| Model | gateway connect/disable, terminal event, provider request ID | Runtime Lab gateway provider |
| Cost | budget updated/invalid/poll failure, settled/available/utilization gauges | Runtime Lab `/api/runtime` polls |
| Runtime | input/adaptive/fixed FPS | Runtime Lab sampling rate meters |

Perception and inference remain independent. The Runtime Lab panel explicitly says that perception telemetry is exported from `/perception.html`; no shared session is fabricated.

## Cost dashboard and admission

The Runtime Lab Cost panel uses `GatewayStreamingProvider.budget()` -> `GET /api/runtime` and `costView()`:

- Total budget, settled, reserved, provisional, available, utilization.
- Accepted / request limit, quarantined slots, and four distinct admission constraints.
- `ledgerOpen` alone is not treated as permission to admit: cost sufficiency, request count and slot capacity are evaluated separately.
- Admission states include `open`, `ledger_frozen`, `cost_exhausted`, `request_limit`, and `slots_full`; multiple reasons can apply.
- Values are integer nano-USD internally; UI formats USD with six decimal places.
- The label states **configured-price estimate, not a vendor invoice**. Actual provider billing can differ.
- Mock mode shows `Unavailable` and `—`, never a synthetic zero.
- A fetch failure leaves the last known values marked stale; failure never throws into the inference path.
- Polling is every 4 s, visible-tab only, and non-overlapping (`BudgetPoller`).
- `GatewayLedger` restart recovery is already covered by the server tests; `/api/runtime` reads the same persisted settled/provisional/held state.

## Privacy and cardinality

- Default: telemetry stays in the page. Export is user-triggered JSON/CSV only.
- No API keys, gateway token, provider key, prompt, conversation, image, video, base64 payload, model output, or raw error body is recorded.
- Low-cardinality attributes are limited to 12 keys, 32-char keys, 64-char values; forbidden names are dropped.
- High-cardinality identities (`sessionId`, `taskId`, `requestId`, `providerRequestId`) are separate fields and must not be used as metric labels in an OTel exporter.
- Event count and each series length are fixed-capacity; overflow counters are retained.

## OpenTelemetry boundary

No exporter, collector, Prometheus, or Grafana is deployed. `telemetryToOpenTelemetryHint` returns separate metric and trace bags:

- metric name: `semanticstream.<module>.<name>`
- `metricAttributes`: source plus low-cardinality attributes only
- `traceAttributes`: session/task/request/provider request IDs for span/event attributes
- session/task/request IDs are **never** metric dimensions
- counters/gauges/histograms map to OTel instruments
- structured runtime events map to span events/log records

A future exporter must be opt-in, bounded, and asynchronous; it must not make the inference path depend on a collector.

## Final-review hardening

- Cloudflare `_headers` now contains two independent full CSP blocks for `/perception` and `/perception.html`; tests parse the rule blocks rather than searching for a shared path line.
- Budget polling and the cost timer are stopped on `pagehide`, generation-invalidated, and recreated on a persisted `pageshow`; late results cannot update the restored/old session.
- Telemetry retains critical terminal events in a separate bounded ring, filters scheduler/model records by the current runtime session, and does not clear all history on a visual reset.
- Series capacity uses replacement of the oldest session series rather than dropping every new session.
- Telemetry error attributes use the finite `DiagnosticCode` set; no free-text scheduler/provider reason is exported.
- OTel metric and trace attribute sets are separate; IDs are trace-only.
- The cost view distinguishes ledger-open from actually admissible (cost, request count, slots).
- Node gateway docs use GET response headers because the gateway has no HEAD route.

## Tests

- `src/observability/telemetry.test.ts`: bounded events/series, critical terminal reserve, old-session series eviction, reset/session isolation, sensitive-attribute filtering, JSON/CSV, metric-vs-trace OTel mapping.
- `src/observability/diagnostics.test.ts`: finite reason-to-code mapping and free-text rejection.
- `src/observability/cost.test.ts`: nano-USD arithmetic, available/utilization, frozen/quarantine, cost/request/slot admission separation, invalid ledger.
- `src/observability/budget-poller.test.ts`: no overlapping fetches, error-as-data.
- `src/observability/summary.test.ts`: outcome counts, P50/P95, known/unknown usage, stale/blocked, unanswered.
- Gateway tests cover ledger persistence, quarantine, overrun/frozen, and `/api/runtime` budget.
- Browser smoke covers Mock cost unavailability, gateway cost, observability panel, bounded events/series, export buttons, 390 px layout.

## Actual measured dashboard values

A seeded local gateway ledger and an actual browser session showed:

- Total **$1.000000**, settled **$0.080000**, reserved **$0.000002**, provisional **$0.010000**, available **$0.909998**, utilization **9.0%**.
- Accepted **1 / 2**, quarantined **1**, admission **open**.
- Mock mode correctly showed **Unavailable** and `—` rather than zero.
- These are configured-price fixture values, not a vendor bill and not a paid model call.

## Deployment verification

### Local Node gateway

```sh
npm ci
npm run build
# Configure SS_* as documented, then:
npm run gateway
# The gateway has no HEAD route; use GET and discard the body.
curl -s -D - -o /dev/null http://127.0.0.1:4180/perception.html
curl -s -D - -o /dev/null http://127.0.0.1:4180/mediapipe/wasm/1.2.3/vision_wasm_module_internal.wasm
curl -s -D - -o /dev/null http://127.0.0.1:4180/mediapipe/wasm/1.2.3/vision_wasm_module_internal.js
```

Expect HTML CSP only on documents, `.wasm` = `application/wasm`, `.js` = `text/javascript`, and model-weight URLs 404. A seeded ledger can produce the cost values above without any paid call.

### Cloudflare Pages

Online verification: **NOT_RUN**. No authorized Cloudflare Preview Deployment was available. Reproduce locally with:

```sh
npm run build
npx --yes wrangler@4.168.0 pages dev dist --ip 127.0.0.1 --port 8788
curl -s -D - -o /dev/null http://127.0.0.1:8788/perception
curl -s -D - -o /dev/null http://127.0.0.1:8788/perception.html
curl -s -D - -o /dev/null http://127.0.0.1:8788/mediapipe/wasm/1.2.3/vision_wasm_module_internal.wasm
curl -s -D - -o /dev/null http://127.0.0.1:8788/mediapipe/wasm/1.2.3/vision_wasm_module_internal.js
```

**Wrangler local verification attempt:** Wrangler **4.168.0** was invoked, but `workerd` failed in this proot environment with a tcmalloc virtual-address/OOM error before serving a port. Therefore Wrangler header/redirect verification is also **NOT_RUN**; no successful local Pages result is claimed.

Check `/perception` and `/perception.html` both receive the page CSP, the JS file is not mislabeled as Wasm, the Wasm file is `application/wasm`, navigation between `/`, `/runtime.html`, `/perception` works, the worker starts, the model downloads only after opt-in, and camera permission works on HTTPS. Then run the same checks in a Cloudflare Preview Deployment before release. Static hosting does not run the Node gateway; index/runtime remain Mock unless another backend is configured.
