# Phase 4A+1 · Streaming text provider

The static site defaults to the scripted provider. The opt-in Node gateway serves the built Lab on loopback, including the independently built perception page, and forwards only text. Enabling real mode checks gateway availability. A text submission or a synthetic monitor button triggers a model request. Camera, video, routine pixel changes, page load and the deterministic benchmark make zero upstream requests. The perception page may download its own detector only after explicit enable. The local evidence preview, retrieval, and optional local detector remain available.

## Provider profiles

The gateway hosts a text-only Chat Completions adapter. It chooses the model and endpoint from server configuration and forwards one request per accepted attempt. The DeepSeek profile sends `max_tokens` and disables thinking. DeepSeek puts usage on the final choice chunk. The OpenAI profile sends `max_completion_tokens` and reads a usage-only chunk with empty choices when usage is requested. Both profiles currently require a consistent completion ID, a final choice and `[DONE]`. Missing or inconsistent usage means unknown usage. A gateway claiming API compatibility needs the corresponding SSE format. [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) · [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/) · [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat)

The browser sends a request UUID. The gateway streams normalized frames with that UUID, incrementing text indexes, the upstream completion ID when available, and a terminal or unconfirmed outcome. Output arbitration still checks the active attempt and its session, interaction, channel, order and deadline. A repeated terminal cannot settle the same hold twice. Completed visible user turns contribute up to three preceding exchanges to the next immutable text snapshot. Each retained assistant turn is capped at 700 characters. Partial, interrupted and superseded answers stay out of the next prompt. A sampling/session reset clears conversation history.

## Accounting and cancellation

| Observation | Slot | Usage |
| --- | --- | --- |
| Gateway rejects before dispatch | Available | Zero upstream exposure |
| Valid terminal and usage | Available | Settle actual input and output against configured price ceilings |
| Valid terminal without usable usage or an explicit upstream 4xx rejection | Available | Keep the full reservation as provisional |
| Timeout, disconnect, invalid stream, EOF without terminal, or ambiguous upstream failure | Quarantined | Keep the original liability reserved |
| Actual input or output exceeds its reservation | Settle after reliable terminal | Book the full reported amount and freeze new admissions |

A user interrupt or scope change revokes visible output synchronously and notifies the gateway. The gateway briefly continues reading for a reliable final marker and usage. It aborts the upstream HTTP request if the grace period elapses. An acknowledgement of the cancel request, an aborted fetch, and a disconnected socket are insufficient evidence of upstream stop. The reviewed Chat Completions contract exposes no per-completion cancellation acknowledgement. Unconfirmed requests remain fenced across browser sessions and gateway restarts. When all available slots are quarantined, new work is rejected and queued work is retired. A late, trustworthy terminal can settle its own hold exactly once. [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)

The gateway uses a private, atomically written ledger and exclusive process lock. It reserves a worst-case amount against integer USD nanodollar price ceilings before sending a request. The request count and two-slot limit also apply across all clients of one gateway process. Prices and the prompt token ceiling are operator settings. The prompt-size check uses UTF-8 bytes plus fixed framing headroom and the configured upstream completion limit. A provider can still exceed assumptions. Set a provider-side spending or credit limit and use current uncached input/output prices. A cap breach freezes the ledger after booking the full receipt. Keep one gateway and one ledger per controlled budget.

If reliable terminal proof becomes available after quarantine, stop the gateway and reconcile using the gateway UUID from the request metrics or the local ledger. With the same configuration, run:

```sh
SS_CONFIRM_TERMINAL=YES npm run gateway:reconcile -- REQUEST_UUID INPUT_TOKENS OUTPUT_TOKENS
SS_CONFIRM_TERMINAL=YES npm run gateway:reconcile -- REQUEST_UUID unknown
```

Use the second form when termination is confirmed and usage is unavailable. It releases the slot and retains provisional cost. A process crash can leave a `.lock.local` file. Confirm the previous process has exited before removing that lock. Preserve the ledger itself and reload the Lab after restarting a reconciled gateway. A permanently unconfirmed request continues to reserve capacity.

## Run locally

Build with `npm run build`. Export the settings below through your local secret store or shell. A random bearer token scoped to the loopback gateway is separate from the provider key. Generate at least 32 characters and enter the bearer token only in the Lab's gateway field. The frontend never reads the provider key.

| Server setting | Meaning |
| --- | --- |
| `SS_ENABLE_REAL=YES` | Allows the gateway to start |
| `SS_PROVIDER_KEY`, `SS_GATEWAY_TOKEN` | Upstream credential and distinct local access token |
| `SS_PROVIDER_MODEL` | Operator-selected model, for example `deepseek-flash` |
| `SS_PROVIDER_PROFILE`, `SS_PROVIDER_URL` | Default `deepseek` and `https://api.deepseek.com/chat/completions`; an `openai` profile requires an explicit compatible HTTPS URL |
| `SS_STATE_FILE` | Private persistent path ending in `.local`, with an existing parent directory |
| `SS_MAX_CONCURRENCY`, `SS_MAX_REQUEST_BYTES` | Set one or two slots and an HTTP body cap |
| `SS_INPUT_TOKEN_RESERVE`, `SS_MAX_OUTPUT_TOKENS` | Per-request input ceiling and provider output limit |
| `SS_MAX_REQUESTS`, `SS_BUDGET_NANO_USD` | Cumulative accepted-request and estimated expense caps |
| `SS_INPUT_NANO_USD_PER_TOKEN`, `SS_OUTPUT_NANO_USD_PER_TOKEN` | Positive price ceilings. Multiply USD per million tokens by 1,000 and round up |
| `SS_PORT`, `SS_UPSTREAM_TIMEOUT_MS`, `SS_CANCEL_GRACE_MS` | Optional. Default to 4180, 40,000 ms and 1,500 ms |

Run `npm run gateway` and open `http://127.0.0.1:4180/runtime.html`. The server checks the loopback Host and same-origin browser Origin, requires a bearer token for API endpoints, and serves an explicit static allowlist from `dist`: `index.html`, `runtime.html`, `perception.html`, Vite assets, benchmark JSON, and exactly the MediaPipe module Wasm files. The API path remains same-origin. Keep secrets out of client environment prefixes, source, logs and build outputs.

### Static pages, CSP and the perception experiment

- The versioned MediaPipe module path is served with native `.js`/`.wasm` MIME types; model weights are **not** in `dist` and are not served by the gateway.
- `index.html` and `runtime.html` keep the original CSP (`default-src 'self'`; no `wasm-unsafe-eval`, no external connect).
- `perception.html` gets a page-specific CSP that additionally permits `script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self' blob:`, and `connect-src 'self' https://storage.googleapis.com` for the optional EfficientDet-Lite0 download. No other cross-origin connect is allowlisted.
- The perception model is fetched only after the user clicks **Enable model**. Media upload remains absent; the gateway's text API is the only path to a real text model.
- The static build also emits `public/_headers` for Cloudflare Pages. It intentionally does not override MIME for the Wasm directory (native `.js`/`.wasm` types are used), scopes immutable caching to the versioned runtime path, and applies the same CSP to `/perception` and `/perception.html`. Cloudflare Pages does not run the Node gateway, so its index/runtime pages stay in Mock mode unless another backend is explicitly configured.
- The gateway's text gateway and the perception detector are independent: the detector does not call the gateway, and the gateway does not proxy model weights. The comparison and smoke clients send no data until explicitly launched. [DeepSeek models and pricing](https://api-docs.deepseek.com/quick_start/pricing/)

## Evaluate

- `npm run test` uses local HTTP SSE fixtures for both profiles, including cancellation, quarantined capacity, persisted holds, late chunks, unknown usage, overrun and admission guards.
- `npm run gateway:fixture` launches local fixtures and prints a network measurement labeled as simulation. Both policies use the same fixture, endpoint, two slots, clock schedule, queue and budget. A representative run observed 2/6 unanswered in FIFO and 4/6 in SemanticStream after coalescing background work. FIFO rejected the critical request when its queue filled. SemanticStream answered it. These observations depend on the scripted workload and local timer behavior.
- `SS_RUN_REAL_SMOKE=YES npm run gateway:smoke` requests one short answer from the configured endpoint and may incur charges. Use an idle gateway and the same local token and port configuration.
- `SS_RUN_REAL_SMOKE=YES npm run gateway:smoke -- --compare` sends a matched six-event trace per strategy, with at most twelve upstream requests. It checks that the gateway can reserve the whole run budget and stops the paired comparison if an arm leaves capacity fenced or spend frozen. Avoid other traffic while running the comparison.

Reports include monotonic client start, gateway dispatch acknowledgement, time to first streamed text, event-to-authorized-output delay, coordinator output-stop latency, stop-to-terminal wait, known input/output token counts, unknown usage and counts for stale and other blocked partials. First streamed text is the observable proxy for first token. Statistics include P50/P95 over observed samples, alongside counts and reasons for tasks with no effective response. Browser timings and server-measured upstream durations remain in separate clock domains. The Lab retains measurements by task independently of its bounded event timeline. Offline tests and fixture measurements do not establish real provider latency, cancellation success or billable usage.

## Cloudflare Workers assessment

SSE can stream through Workers using the Streams API, with the vendor credential stored as a Worker secret and operator access enforced at the edge. A deployment would need an authenticated route and a Durable Object keyed by endpoint/account to serialize global holds, deduplication and cost across Worker isolates. Persist uncertain reservations in Durable Object storage and verify disconnect behavior, cancellation grace and upstream timeouts on the deployed platform before opening paid access. The current Node process and file ledger serve the local validation path. [Workers Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/) · [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/) · [Durable Objects](https://developers.cloudflare.com/durable-objects/)
