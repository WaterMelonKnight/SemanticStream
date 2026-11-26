# Architecture

SemanticStream selects context from a live stream for an AI agent operating under limited bandwidth and compute. Phase 0 sampled a procedural visual stream and delivered selected frames to an in-browser mock agent. Phase 1A added a local video adapter that produces the same `StreamFrame<VisualFrame>` sequence. Phase 1B adds a deterministic, budget-aware event evaluation with global, local-block, and hybrid adaptive policies. Phase 2 adds a bounded history buffer and an active retrieval protocol with separate and combined resource budgets. Phase 3A adds a typed task/decision boundary and a unified ex-ante admission gate shared by adaptive real-time sends and retrieval. Phase 3R moves decision applicability into the session, adds atomic reservations and separates delivery from capture in replay. See [runtime architecture v2](docs/runtime-architecture-v2.md).

## Runtime path

```mermaid
flowchart LR
  Demo[Procedural Canvas source] --> SourceCanvas[Source Canvas]
  Video[Local video adapter] --> SourceCanvas
  SourceCanvas --> Fixed[Fixed sampler]
  SourceCanvas --> Adaptive[Adaptive sampler]
  SourceCanvas --> Original[Original view]
  SourceCanvas --> Thumb[Shared 96 × 54 RGBA thumbnail]
  Thumb --> Fixed
  Thumb --> Strategy[AdaptiveStrategyPolicy]
  Strategy --> Global[Global RGB baseline]
  Strategy --> Local[Local block detector]
  Strategy --> Hybrid[Hybrid OR]
  Fixed --> FixedSink[Fixed mock sink]
  Adaptive --> AdaptiveSink[Adaptive mock sink]
  Fixed --> Metrics[Metrics + rates + timeline]
  Adaptive --> Metrics
  FixedSink --> Agent[Selected Agent view]
  AdaptiveSink --> Agent
  SourceCanvas --> Buffer[Bounded ContextBuffer]
  Buffer --> Retrieval[ActiveRetrievalService]
  Retrieval --> Admission[ResourceAdmissionController]
  Strategy --> Decision[DecisionState + DecisionProvider]
  Decision --> Admission
  Admission --> AdaptiveSink
  Admission --> Retrieval
  Retrieval --> Agent
```

Only one source is active. The procedural source draws its deterministic scene into the source Canvas. The video adapter draws the current video frame into the same Canvas, letterboxed to 720 × 405. Both call the same synchronous frame listener. Both samplers evaluate exactly the same capture sequence at runtime. Each has its own policy state, budget, metrics, rates, and mock sink. Selecting an agent view changes which sink and metrics row are visible.

| Concept | Runtime contract |
| --- | --- |
| `StreamSource<T>` | Calls a synchronous listener and supports start and stop. The procedural adapter aims for 30 captures per second using `requestAnimationFrame`. The video adapter uses `requestVideoFrameCallback` when available and a `requestAnimationFrame` fallback otherwise. |
| `StreamFrame<T>` | A one-based sequence, a monotonic capture timestamp in milliseconds, and the adapter's payload. The source Canvas is borrowed until the listener returns. |
| `VisualFrame` | The borrowed source Canvas, a source position (`elapsedMs`), optional video `mediaTimeMs`, monotonic `sessionElapsedMs`, and a phase (`Still`, `Slow motion`, `Fast motion`, `Text event`, or `Video`). |
| `ChangeDetector<Sample>` | Mean absolute RGB channel difference, normalized to 0–100%, on matching RGBA thumbnails. `meanRgbDifference` remains the baseline. The shared adapter creates one 96 × 54 sample per input frame. |
| `BlockChangeDetector` | Splits a matching 96 × 54 sample into configurable blocks, computes the same RGB-only normalized difference per block, and reports the maximum difference and the number of changed blocks. Edge blocks may be smaller. |
| `SamplingPolicy<Sample>` | Observes the current sample, session origin, and last delivered sample and timestamp. Fixed sampling targets four 250 ms slots per second. Adaptive sampling compares the current thumbnail with the last one accepted by its sink. |
| `AdaptiveStrategyPolicy` | Selects `global`, `local`, or `hybrid` without replacing the `Sampler`. Hybrid means global change OR changed local blocks. Threshold and block-size setters apply on the next frame. |
| `BudgetController` | Enforces a rolling cap in frames per five seconds. The default cap is 20. A delivery exactly 5,000 ms old has expired. |
| `ContextSink<T>` | Returns whether it synchronously accepted the frame. Each mock sink copies accepted images into its own display Canvas, replacing its previous image. |
| `VideoSource` | Owns the video element listeners, the local Object URL, frame-callback handles, and the `HTMLVideoElement` → Canvas capture path. `dispose()` releases all of them; `stop()` only pauses capture. |
| `SamplingSession` | Owns both samplers, context history, task decision scheduling and diagnostics. Browser adapters supply thumbnails and sinks. |
| `Benchmark replay` | A browser-independent Node/browser-neutral runner that feeds deterministic `ReplayFrame` samples into separately constructed samplers. Event labels are held outside the replay input. |
| `ContextBuffer` | Session-scoped, bounded history of owned 96 × 54 RGBA copies. Enforces max age, max frames, and max bytes; supports latest, sequence, timestamp, range, and region lookups with explicit availability statuses. |
| `ActiveRetrievalService` | Applies a retrieval budget and a combined real-time + retrieval budget, logs bounded request/response records, and returns typed results with session IDs, ranges, latency, and budget snapshots. It exposes the shared `ResourceAdmissionController` for adaptive real-time sends. |
| `RollingResourceBudget` | Rolling frame/byte ledger. Real-time, retrieval, and total ledgers are separate; the total is the sum of admitted real-time and retrieval work. |
| `ResourceAdmissionController` | Single ex-ante check for adaptive real-time sends and retrieval. A request must fit its independent sub-budget and the combined total. It returns no data when denied; a denied request consumes nothing. |
| `DecisionState` | Read-only task-aware view: task/category/priority, declared ROI, global/local/ROI change, repeated-change counters, remaining budgets, cache ranges, and bounded recent decisions. It contains no evaluator labels or future frames. |
| `DecisionProvider` | Pluggable decision boundary returning a finite action and candidate scores. Metric provenance is explicit (`heuristic` or `model-probability`); the provider cannot mutate budgets, buffers, or sinks. |
| `RuleBasedDecisionProvider` | The Phase 3A heuristic provider. It scores `SEND_FRAME`, `SEND_PREVIEW`, `DROP`, `WAIT`, `REQUEST_HISTORY`, `REQUEST_REGION`, and `ESCALATE`; scores are rule weights, not probabilities. |
| `DecisionEngine` | Supervises primary and fallback deadlines, validates both results, propagates cancellation, and caps unsettled calls. |
| `MetricsCollector` | Keeps cumulative counts, per-reason filtered counts, and mean processing latency in constant space for each strategy. |

## Online decisions and time

The procedural adapter samples its deterministic scene using animation time. It stamps a frame with `performance.now()` immediately after drawing. Stream timestamps are nondecreasing within a session and are independent of wall-clock time. RAF capture emits at most one frame per callback. If callbacks pause or miss a slot, capture resumes at the current scene time and skips missed input. Policies can access only the frame being processed and the acceptance state from earlier frames.

The video adapter stamps every emitted frame with `performance.now()`. That value is the sampler's ordering clock. Video media time is a separate field used for display and seek state. It can jump backward or forward when the user seeks, so a load, seek, or restart starts a new sampling session instead of feeding a backward timestamp to a sampler.

The sampler requests delivery for the first frame, for an available frame arriving at least 1,500 ms after the last delivery, or when the selected policy requests it, in that order. Fixed slots are anchored to the first input timestamp and allow a single policy-driven send per slot. A slot without an acceptable frame can expire. Adaptive delivery triggers when the selected rule returns true. Comparing against the last accepted frame lets successive small changes accumulate.

The hard minimum of 125 ms applies to all candidates after the first delivery. A candidate then needs a free slot in the rolling budget. A full budget or busy sink can extend silence beyond 1,500 ms. Candidates are discarded immediately and all gates are checked again on the next arrival. A rejected candidate consumes neither budget nor the adaptive baseline.

## Local block detection and strategy composition

`meanRgbDifference` remains the baseline. `BlockChangeDetector` adds a spatially local rule without changing the stream contract:

1. The 96 × 54 RGBA sample is divided into a configurable grid (6, 8, or 12 pixel blocks in the UI; any positive block size in the core).
2. For each block, the sum of absolute RGB differences is normalized by the block's pixel count and 255 per channel, giving a 0–100% block difference.
3. A block counts as changed when its difference is at least the configured local threshold.
4. The local policy triggers when at least `minChangedBlocks` blocks changed. The default is one changed block.

The detector reads only the last accepted sample and the current sample. It receives no event regions, event labels, or future frames. Edge blocks are clipped to the sample dimensions. Alpha is ignored, matching the baseline's RGB-only definition.

`AdaptiveStrategyPolicy` owns one global `AdaptiveSamplingPolicy` and one `LocalSamplingPolicy`:

- `global` uses only the whole-frame mean RGB difference.
- `local` uses only the block detector.
- `hybrid` returns global OR local, short-circuiting when global already triggers.

The strategy is mutable inside the policy object, so switching the live strategy does not replace the `Sampler` or reset either branch. The last accepted sample is still the baseline for the next decision. The rolling budget, minimum interval, silence refresh, metrics, and sink are unchanged.

## Video lifecycle

`VideoSource` is a three-layer adapter: media element, capture scheduler, and Canvas frame producer.

- **Load.** `videoFileProblem` rejects empty files, unknown extensions, and MIME types the browser reports via `canPlayType`. A valid file gets a new Object URL. The previous URL is revoked only after the new `src` is assigned. Load resets the sampling session, clears the source Canvas, and waits for `loadedmetadata` / `loadeddata`.
- **Capture.** In `requestVideoFrameCallback` mode, each presented frame calls the listener once. Repeated callbacks with the same `presentedFrames` value, or a media time within 0.5 ms of the last emitted frame, are suppressed. In fallback mode, `requestAnimationFrame` polls while playing and emits only when the rounded media time changes. Pending callbacks are canceled on pause, seek, load, stop, and dispose.
- **Playback.** Play, pause, restart, and seek are custom controls. The hidden video element is muted and `playsinline` so a mobile browser can start muted playback. If autoplay is blocked, the status asks the user to press Play. Pause cancels capture without resetting sampling state; resume schedules a new callback. There is no catch-up queue for frames presented while paused or hidden.
- **Seek.** A seek cancels the pending callback, suspends capture, resets the sampling session, and assigns `currentTime`. Frames are suppressed until `seeked`; then the target still frame is painted and capture resumes. A seek to the current position still resets. The same path handles a programmatic/native `seeking` event.
- **Switch.** Switching files reuses one adapter and one listener set. `load()` replaces the Object URL, resets the session, and starts capture from the new file.
- **Return to demo.** The app disposes the video adapter, which removes listeners, pauses the element, revokes the Object URL, clears `src`, reloads the empty element, and clears the Canvas. It then creates a fresh procedural source and sampling session.
- **Page lifecycle.** `pagehide` stops capture. If the page is not entering the back-forward cache, the adapter is disposed and the metrics refresh interval is cleared. If `pageshow` restores a persisted page, capture resumes and playback resumes when it was active. A visibility change can cancel and re-request a frame callback without resetting the session.

The app validates a chosen file before switching modes, so a plainly unsupported codec does not tear down an active video. A file that passes `canPlayType` but fails to decode raises a media error, stops capture, and shows a decode message. Codec availability remains browser- and device-specific.

## Bounded diagnostics

Each session owns a `BoundedTimeline` with capacity 150. Every input frame produces one entry containing its sequence, monotonic timestamp, media time (or `null`), and both decisions. When full, the ring buffer overwrites the oldest entry. The timeline never stores images and never looks at future frames.

Input and sent rates use `RollingRate` meters with a two-second window. Until the window fills, a meter divides by the observed span (with a 500 ms minimum) so startup is not reported as an artificially low rate. Storage is separately capped: 600 input timestamps and 200 timestamps per sent meter. These meters are display diagnostics; they do not affect sampling, budget, or delivery.

Filtered reasons are counted by `MetricsCollector` as `policy`, `interval`, `budget`, or `backpressure`. The cumulative counts are independent of the bounded timeline, so the reason totals survive after the timeline overwrites old entries. A new session clears both.

## Deterministic benchmark

The benchmark is deliberately separated from the browser UI:

- `src/benchmark/fixtures.ts` builds replay scenes. Each `ReplayFrame` contains only a sequence, a deterministic timestamp, and an RGBA sample. Event annotations are stored on `BenchmarkScene.events`, not in the frames.
- `src/benchmark/runner.ts` constructs a fresh `BudgetController` and `Sampler` per scene/strategy, feeds the same frames in order, and returns deliveries plus measured processing times. It never passes the event list to a policy.
- The evaluator runs after replay and uses the event labels to compute recall, missed events, first-capture latency, outside-event sends, and an independent budget audit.

### Fixtures

- Six tuning scenes and six held-out evaluation scenes, each six seconds at 30 fps, 96 × 54 RGBA.
- Event families: local high-contrast text, 100 ms brief events, low-contrast region changes, slow whole-frame brightness ramps, a local event during irrelevant background motion, and a capture pause containing a hidden event.
- Tuning and evaluation scenes use different timings, positions, text, and contrast values. The evaluation suite is not used to choose parameters.
- A capture pause removes frames from the replay sequence, so a hidden event has no input frame at all.

### Metrics

- **Inputs**: replay frames evaluated by a strategy.
- **Sent**: accepted deliveries.
- **Event recall**: observable events with at least one delivered timestamp inside `[startMs, endMs)`, divided by observable events. A hidden event inside a capture gap is excluded from the denominator and reported separately.
- **Missed**: observable events with no delivery inside their window.
- **First capture latency**: first delivered timestamp in the event window minus `startMs`, averaged only over captured events.
- **Processing time**: wall-clock time around each `Sampler.process` call. It varies between runs; frame decisions do not.
- **Budget violations**: an independent audit counts a sent timestamp as a violation when the previous deliveries in `(t − 5,000, t]` already reach the frame limit. The sampler should produce zero.
- **Sends outside events**: deliveries outside every labeled event window. This is a diagnostic, not a precision score, because the fixture event set is sparse.

### Parameter selection and artifacts

The tuning suite evaluates a small grid of local thresholds and block sizes for both local and hybrid rules. Selection maximizes the worst-case local/hybrid recall, then total recall, then minimizes sends outside labeled events, then total sends. The chosen configuration is applied unchanged to the evaluation suite.

`npm run benchmark` writes the fresh Phase 1B report under `benchmarks/results/phase1b-replay.*`. The browser uses the preserved Phase 1B summary at `public/benchmark/latest.json`. The Phase 2 and Phase 3A runners emit separate corrected artifacts.

## Bounded context buffer

`ContextBuffer` is deliberately independent of the DOM and of the UI. It stores frame pixels, never Canvas references.

- A session is identified by `sessionId`. Offering a frame from another session or querying with another session ID is rejected. The app creates a new buffer on video seek, load, restart, source switch, demo restart, and every new sampling session.
- `offer` validates the RGBA dimensions and clones the caller's pixel array. Retrieval returns another clone, so a caller cannot mutate stored history.
- Bounds are enforced in this order: age eviction (`timestamp < now − maxAgeMs`), frame-count eviction, then byte-count eviction. Each reason is counted separately.
- The buffer tracks both the **retained range** and the **captured range**. A request can therefore be distinguished as `available`, `evicted`, `not-yet-captured`, `nonexistent`, or `wrong-session`; range requests can also be `partial` or `invalid-range`, and regions can be `region-invalid`.
- Optional decimation is available, but the live demo and benchmark store every offered frame within the bounds. The live buffer is capped at 3 s / 90 frames / 3 MB; this is explicitly **not** a whole-video cache.
- `dispose()` clears all pixel arrays and marks the buffer disposed. Page exit disposes the live buffer; a back-forward-cache restore keeps it because the page was not unloaded.

The UI offers ownership-safe retrieval by clicking a decision-timeline column, using the frame's sequence. It shows the available range, cache bytes/frames, eviction reasons, request logs, and explicit error states.

## Active retrieval protocol

`ActiveRetrievalService` sits between the buffer and a mock agent:

- `getLatestFrame(sessionId)`
- `getFrameBySequence(sessionId, sequence)`
- `getFrameAtTimestamp(sessionId, timestampMs, toleranceMs?)`
- `getFramesBetween(sessionId, startMs, endMs, {maxFrames})`
- `getRegion(sessionId, locator, {x, y, width, height})`

Every response carries a request ID, session ID, method, status, request start and completion, delivery time on success, latency, retained/captured ranges, and a budget snapshot. Frame and range responses include owned pixel copies; region responses include only the cropped pixels and source-frame metadata. Requests are recorded in a bounded log.

The shared admission controller owns three rolling ledgers:

- Real-time sub-budget: 20 frames / 1 MB per five seconds in the live app and replay.
- Retrieval sub-budget: 6 frames and 2 MB per five seconds.
- Combined real-time + retrieval: 26 frames and 4 MB per five seconds.

Adaptive delivery and retrieval reserve their lane and the combined total together. Successful delivery commits at the monotonic delivery timestamp. Refusal or a sink exception releases the hold. A rejected retrieval returns `budget-denied`. The fixed live comparison has its own frame ledger. In replay, every strategy uses a fresh shared-lane admission controller.

The live page uses this protocol for timeline retrieval and a 24 × 16 region crop. It does not claim that the mock agent is a model.

## Phase 2 benchmark

The Phase 2 benchmark reuses the Phase 1B fixtures and the same 30 fps, 96 × 54 samples. It compares:

- **A** fixed 4 fps.
- **B** adaptive local.
- **C** adaptive local plus cue retrieval.
- **Oracle** adaptive local plus label-timed retrieval.

C is the only candidate for autonomous behavior. Its cue is a real-time sampler decision of `budget`; it requests the latest buffered frame with a minimum spacing selected on the tuning suite. It never reads event labels or future frames.

The oracle uses event midpoint labels to request a frame. It is an upper-bound experiment only, not autonomous discovery, and is marked as such in JSON, CSV, Markdown, and the page.

The benchmark measures real-time recall, post-retrieval recall, missed events before/after, retrieval frame and byte counts, total sends/bytes, retrieval latency, cache peak, evictions and reasons, and real-time / retrieval / total budget violations. It focuses on the Phase 1B `eval-motion-text` failure where background motion exhausted the real-time budget. The corrected artifacts are `benchmarks/results/phase2-corrected.{json,csv,md}` and `public/benchmark/phase2-corrected.json`.

Events entirely inside a capture gap remain unobservable. The oracle cannot recover them either. Retrieval can only return a frame that was captured and is still retained.

## Phase 3A decision boundary

`src/decision/` is DOM-free and browser-neutral. `DecisionFeatureExtractor` derives global, local, and ROI change only from the current and previous accepted sample plus the user-declared ROI. `DecisionState` adds budgets from `ResourceAdmissionController`, cache ranges from `ContextBuffer`, and a bounded recent-decision list. It never receives event labels, evaluator regions, or future frames.

The action space is finite: `SEND_FRAME`, `SEND_PREVIEW`, `DROP`, `WAIT`, `REQUEST_HISTORY`, `REQUEST_REGION`, `ESCALATE`. `DecisionEngine` enforces separate deadlines, validates both providers and uses deterministic WAIT when neither produces valid output. A provider returns only an action proposal. The sampler, `ActiveRetrievalService`, and admission controller execute effects; the provider cannot change a budget or bypass admission.

`RuleBasedDecisionProvider` prioritizes ROI change, suppresses repeated ROI/background change, reacts to low real-time budget or prior denial with history/region requests, and recommends escalation in high-priority constrained cases. Its `score` values are heuristic weights. The result carries `scoreKind: 'heuristic'`; it is never presented as a calibrated probability.

The live page evaluates the same provider at a 100 ms interval. By default it is an advisory preview. Selecting the `Task-aware (live gate)` adaptive strategy makes the decision gate the adaptive sampler's next send; `DROP`/`WAIT` do not override the sampler's silence refresh. History and region proposals execute in replay. The live preview displays them and the browser exposes manual retrieval. The benchmark runs the decision as a gate on a fresh `Sampler` and runs retrieval actions through the shared service, so the benchmark result is an execution result rather than a UI-only annotation. The task panel also shows remaining real-time/retrieval budget and the current declared ROI.

### Task-aware benchmark

The Phase 3A benchmark uses the original six evaluation scenes plus three deterministic task scenes (random ROI, repeated event, overlapping event). Task definitions and ROIs are authored per scene. Evaluator labels are used only after replay for overall and ROI recall. Every strategy gets the same total frames/bytes budget, cache bounds, sampler timing, and retrieval sub-budget.

- A: fixed 4 fps through admission.
- B: adaptive local through admission.
- C: adaptive local + cue retrieval through admission.
- D: adaptive local + task-aware Rule Decision; one decision per 100 ms, with `SEND_FRAME`/`SEND_PREVIEW` gating the sampler and retrieval actions executed through the service.

D is not guaranteed to beat the baselines. It misses the capture-pause visible event in the current held-out run while C recovers it; the report includes the loss. Decision scores are heuristic, not calibrated probabilities. The shared sampler's silence refresh still applies, so a `DROP`/`WAIT` preview cannot suppress the system refresh.

The corrected artifacts are `benchmarks/results/phase3a-corrected.{json,csv,md}` and `public/benchmark/phase3a-corrected.json`. They track actual replay delivery times and spatial coverage. The historical reports remain available.

## Phase 4O · Runtime observability and cost

`src/observability/` defines a page-scoped, transport-neutral telemetry protocol: bounded events, counter/gauge/histogram records, bounded series, explicit source provenance (`mock`, `fixture`, `real`, `unavailable`), and separate high-cardinality identity fields. It is not a global event bus and is not shared between pages.

The Runtime Lab now renders a server cost view from the authenticated `GET /api/runtime` through `GatewayStreamingProvider.budget()`:

- integer nano-USD internally; USD only at the display edge;
- total/settled/reserved/provisional/available/utilization;
- accepted/request limit, quarantined slots, admission frozen;
- configured-price estimate, explicitly not a vendor invoice;
- unavailable/stale states shown as unavailable, never as zero;
- 4 s visible-tab, non-overlapping polling; network failure is returned as data and cannot block inference.

The unified panel includes FPS, cache/transfer, queue/slots, task outcomes/reasons, P50/P95 first-text/effective/upstream latency, known/unknown token usage, stale/blocked output counts, and the cost snapshot. Perception and inference are separate runtimes; the Perception Lab exports its own detector/model telemetry and the Runtime Lab explicitly labels the separation. Exports are user-triggered, bounded JSON/CSV. No prompts, media, credentials, raw model output or evidence payloads are recorded. `telemetryToOpenTelemetryHint` is the design boundary for a future opt-in exporter; no collector or external monitoring platform is deployed.

Deployment hardening (Phase 4O.0):

- MediaPipe runtime files live under the versioned `mediapipe/wasm/1.2.3/` path; the cache is immutable only for that version.
- `public/_headers` no longer overrides MIME for the whole Wasm directory. Native JavaScript/Wasm MIME is used; `_headers` scopes caching and the `/perception` + `/perception.html` CSP.
- The Node gateway serves the versioned module Wasm with `application/wasm`, scopes CSP to HTML documents (so the worker inherits the page policy), and keeps model weights out of the static allowlist.
- Cloudflare Pages serves the three static pages, the generated versioned Wasm and the page-specific CSP; the Node gateway is not part of the static Cloudflare deployment.

## Concurrency, ownership, and measurement

Capture, thumbnail preparation, sampling decisions and sink copies run synchronously on the browser main thread. Task proposal supervision is asynchronous and scoped to the session. There is no frame queue or catch-up work. A busy sink can decline a candidate via its return value. A slow synchronous sink delays the animation or video callback and can reduce the capture rate for both branches. Future asynchronous sinks will need explicit ownership transfer and a bounded overflow policy.

A capture reuses the original source Canvas. The renderer, thumbnail Canvas, two mock-sink Canvases, the hidden video element, and a constant number of thumbnail samples are the retained media. The history buffer adds a bounded set of owned RGBA copies, never borrowed Canvas references. The video element owns its decoder. `VideoSource` owns the Object URL and media listeners; the app owns the source and session lifetimes. The rolling budget keeps a bounded set of recent delivery timestamps. Stopping or restarting cancels the active callback. Restart or seek clears the sink views and drops the old samplers and their retained samples. Canvas and decoder storage are managed by the browser. The stream stops on page exit.

The reported mean processing latency includes capture-to-session preparation once per branch and that branch’s synchronous decision and any accepted Canvas copy. It excludes scene or video rendering, the other branch's work, and UI updates. Input counts are captured frames each sampler evaluates; both samplers see the same sequence. Filtered share is (input − accepted) / input. It includes policy omissions, interval and budget blocks, and sink declines.

The benchmark processes one scene at a time and retains only the current scene's samples, delivery list, processing samples, and decisions. Its arrays are bounded by fixture length. The generated JSON/CSV/Markdown files are static artifacts; the app does not run the benchmark in the browser. The dashboard's processing numbers are wall-clock diagnostics, not token or cost measurements.

## Limits

Low-area changes, brief text, and RGB changes attenuated by downsampling can fall below a global threshold. A local block detector can react to irrelevant local motion as readily as to a labeled event. The benchmark demonstrates one such failure: background motion consumes the rolling budget before a later event, so local and hybrid miss it even though they send many frames. A fixed schedule, a compressed local event, or a capture gap can also hide an event entirely. Maximum silence provides refresh opportunities and cannot recover an event.

Recall measures only whether a frame was delivered inside a defined visual event window. It does not measure whether a vision model or language model understood the event, and it does not measure task success. The synthetic fixtures are small, 96 × 54, and intentionally sparse. The event labels are evaluator-only; a real deployment would need an independent labeling and evaluation pipeline.

Phase 2 does not implement a whole-video archive, GPU inference, model APIs, a backend, or a semantic understanding model. The buffer is a short-lived evidence cache, not a replacement for the source. The oracle result is not evidence of autonomous event discovery.

Phase 3A does not deploy a model, download weights, call a paid API, or run on a GPU. Phase 4P.1 is an isolated opt-in browser experiment with no accuracy claim and no production model API; it does not alter the Phase 3A decision path. The live task decision is advisory by default and can gate sends when the task-aware strategy is selected; the benchmark is the full execution proof for sends and retrieval actions. Task ROI is a declared user input, not a label. The decision heuristic can lose to the baselines; the held-out report shows both wins and misses. The live page only gates sends when the task-aware strategy is selected; retrieval actions remain benchmark-only. Later work may add opt-in sources, asynchronous sinks, a real adapter, calibrated probabilities, and broader resource policies.

## Phase 4A · Duplex inference

The independent Live Vision Runtime Lab connects Phase 3R's admitted evidence to a DOM-free inference scheduler. The browser retains source ownership. Overlapping requests use one scripted endpoint, immutable snapshots, one writer per output channel, and terminal-evidence-based release of physical capacity. Each visual source reset invalidates the inference session while preserving slots still in flight. The original visual comparison and its historical benchmarks remain available.

See [Phase 4A runtime architecture](docs/phase4a-duplex-runtime.md) for task, output, usage and browser-source contracts.

## Phase 4P.1 · Lightweight visual perception

`perception.html` is an independent experiment. It reuses `CameraSource`, `VideoSource`, and `ProceduralSource` but does not change the Phase 4A scheduler, the `DecisionProvider` boundary, or the runtime lab. The model is **off by default** and the user must explicitly enable it.

The `ObjectDetectorProvider` boundary in `src/perception/provider.ts` exposes `load`, `detect`, and `dispose`. The first implementation is MediaPipe Tasks Vision with EfficientDet-Lite0 int8 in a module Web Worker. A future ONNX Runtime Web/YOLOX provider can implement the same contract.

- Input is 320 × 320 letterboxed in a dedicated Canvas; the existing 96 × 54 sampling thumbnail is not the detector input.
- The main thread keeps one in-flight request and one latest pending request. A replacement increments the queue-drop count. There is no unbounded frame queue.
- `DetectionTrigger` uses a fixed interval or an adaptive change probe plus a periodic floor, both clamped to 2–5 FPS.
- Detector boxes are mapped from the model input back to 720 × 405 source pixels. `ObjectObservation` carries session/frame/time/category/score/source-box/evidence/transform.
- Source switch, video load/seek/restart, camera stop, model unload, worker failure, and page exit invalidate the session. Results are accepted only when both request ID and session ID match.
- The worker is terminated on unload and non-bfcache exit. Model load failure keeps the source preview usable and exposes a retry.
- The live comparison runs 8 s fixed + 8 s adaptive and reports load time, model bytes, P50/P95 inference, batches, effective FPS, queue/stale drops, long tasks, and elapsed time. It does not report accuracy because no labeled dataset exists.

The self-hosted Wasm assets are copied from `node_modules` by `scripts/prepare-mediapipe-wasm.mjs` on `predev`/`prebuild`; the model is downloaded only after user opt-in. Runtime/model versions, sizes, license status, CSP and deployment limits are in [visual-perception-licenses.md](docs/visual-perception-licenses.md). Architecture, lifecycle and future tracking/state-index design are in [visual-perception.md](docs/visual-perception.md). Observed single-run numbers and real-device gaps are in [visual-perception-results.md](docs/visual-perception-results.md).

## Phase 4A+1 · Streaming text integration

The browser still owns admission policy, snapshots and output arbitration. The opt-in Node gateway owns provider credentials, authenticated request admission, persistent endpoint holds and cumulative cost exposure. It translates vendor SSE into a small request-scoped streaming protocol. The gateway quarantines capacity when upstream closure is ambiguous and preserves unknown usage in its ledger. User text can carry a bounded history of completed visible turns. Pixel evidence stays local.

The gateway's static allowlist explicitly serves `perception.html` and only the versioned MediaPipe module files, with `.wasm` MIME and page-specific CSP. `index.html`/`runtime.html` keep the original CSP; `perception.html` alone adds `wasm-unsafe-eval`, `worker-src`, and `connect-src` for the pinned Google Storage model. No model weights or arbitrary static paths are served. The text gateway and perception detector are independent. The default gateway mode is the scripted/mock provider; a real paid call requires explicit operator configuration and smoke invocation.

[Provider contract, recovery and deployment assessment](docs/real-streaming-provider.md)
