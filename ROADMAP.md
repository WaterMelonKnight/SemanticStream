# Roadmap

## Phase 0 · Foundation

- Ship a local procedural visual source, fixed and adaptive policies, strict rolling frame limits, a mock agent, and a live side-by-side comparison.
- Keep policy tests in Node.js and run a static build in CI.

## Phase 1A · Real visual input

- Add a local browser video adapter (`HTMLVideoElement` → Canvas) behind the existing `StreamSource` contract, with `requestVideoFrameCallback` and an animation-frame fallback.
- Support play, pause, restart, seek, file switching, and return to the built-in procedural demo without leaking listeners or Object URLs.
- Reset the sampling session on load, seek, and restart while keeping monotonic sampler timestamps separate from video media time.
- Add a bounded frame-decision timeline, input/sent rate meters, per-reason filtered counts, and the fixed-vs-adaptive delivery difference to the dashboard.

## Phase 1B · Budget-aware event evaluation

- Keep `meanRgbDifference` as the global baseline.
- Add a configurable block-local change detector and a hybrid global/local policy without changing the `Sampler` or `BudgetController` semantics.
- Build deterministic tuning and held-out evaluation scenes covering local text, brief events, low-contrast changes, slow changes, irrelevant background motion, and capture pauses.
- Replay every strategy over identical frames, timestamps, budget, and timing constraints; keep event labels outside the policy input and never expose future frames.
- Measure frame deliveries, event recall, missed events, first-capture latency, processing time, sends outside events, and independent budget violations.
- Select parameters on the tuning suite only and report held-out results and failure cases.
- Emit real JSON, CSV, and Markdown reports, and show the held-out summary plus live strategy controls in the page.

## Phase 2 · Bounded Context Buffer and Active Retrieval

- Add a session-scoped `ContextBuffer` capped by age, bytes, and frame count, with owned RGBA copies and explicit eviction reasons.
- Support latest, sequence, timestamp, range, and region retrieval with explicit available/evicted/not-yet-captured/nonexistent/wrong-session statuses.
- Reset and dispose the buffer on video seek/load/restart, source switch, demo restart, and page exit; keep sessions isolated.
- Add a retrieval budget and a combined real-time + retrieval ledger so active retrieval cannot bypass the real-time cap.
- Add a live mock-agent demo with history range, cache usage, request log, timeline retrieval, region crop, and failure messages.
- Extend the deterministic replay benchmark to compare fixed, adaptive local, adaptive local + cue retrieval, and a clearly labeled label-timed oracle upper bound.
- Measure real-time and post-retrieval recall, retrieval frames/bytes/latency, cache peak, evictions, total sends, and budget violations; focus on the Phase 1B background-motion miss.

## Phase 3A · Task-Aware Decision Engine

- Add a read-only `DecisionState` containing task/category/priority, user-declared ROI, global/local/ROI change, repeated-change statistics, remaining budgets, cache ranges, and bounded recent decisions.
- Add a pluggable `DecisionProvider` with a finite action space, priority, candidate scores, timeout, and deterministic fallback.
- Ship a `RuleBasedDecisionProvider` whose scores are explicitly heuristic, not calibrated probabilities; add a design-only HTTP adapter contract.
- Add unified ex-ante admission so adaptive real-time sends and retrieval both fit independent sub-budgets and the combined total; cover dynamic limits, rolling boundaries, and duplicate accounting with regression tests.
- Benchmark fixed, local, local + retrieval, and task-aware Rule Decision under the same total budget, with predeclared task ROI, deterministic random task scenes, repeated/overlapping events, and failure reporting.
- Add task selection, ROI editing, live decision records, an optional live send gate, remaining budgets, and Phase 3A evaluation results to the page.
- Document how Laya, AnyJev, Jev API, generic structured-output models, and local classifiers could plug into the provider boundary without changing budgets or safety checks.

## Phase 3R · Runtime foundation

- [Audit](docs/architecture-audit-phase3r.md) the browser and replay execution paths from the merged Phase 3A baseline.
- Isolate session and task revisions, supervise cancellable providers, and bound unresolved work and observation age.
- Reserve real-time and retrieval capacity atomically and settle charges on delivery. Preserve the independent fixed comparison and existing visual sources.
- Correct replay timing and spatial evidence coverage. Version the corrected outputs and preserve the original Phase 1B, 2 and 3A benchmarks.
- Capture extension boundaries in [runtime architecture v2](docs/runtime-architecture-v2.md) and [inference orchestration](docs/inference-orchestration-design.md).

## Phase 4A · Duplex inference and Live Vision Runtime Lab

- Ship a bounded, Node-testable scheduler with a scripted streaming endpoint, FIFO and context-aware policies, dependencies, and one- and two-slot modes.
- Freeze selected evidence per task, arbitrate streaming output per channel, and keep physical slots reserved through logical cancellation until upstream termination is confirmed.
- Connect the Phase 3R sampling and retrieval pipeline to the independent Lab with a synthetic system monitor, procedural source, local files and an opt-in camera.
- Replay identical simulated events under equivalent budgets. Publish per-event latencies, failures, stale suppression and usage accounting in [the Phase 4A report](benchmarks/results/phase4a-runtime.md).

## Phase 4P.1 · Lightweight visual perception experiment

- Add an independent `/perception.html` experiment that reuses camera/local-video adapters and leaves the Phase 4A scheduler, provider, and runtime lab unchanged.
- Put a model-agnostic `ObjectDetectorProvider` boundary in front of MediaPipe Object Detector + EfficientDet-Lite0 int8 inside a module Web Worker.
- Keep the model off by default; require an explicit user enable, show load/failure states, and keep the source preview usable when inference is unavailable.
- Prepare 320 × 320 letterboxed input, bound work to one in-flight plus one latest pending request, and combine fixed 2–5 FPS with change-triggered + periodic scheduling.
- Emit structured `ObjectObservation` records with session, frame, capture/submission/completion time, category, score, source box, detector/model version, and evidence reference.
- Correctly invalidate sessions on source switch, video load/seek/restart, camera stop, worker unload, and page exit; reject late results.
- Benchmark fixed vs adaptive scheduling for load time, model bytes, P50/P95 inference, batches, effective FPS, drops, and page long tasks; do not report accuracy without labels.
- Record runtime/model licenses, versions, sizes, deployment limits, and the YOLOX-Nano + ONNX Runtime Web feasibility.

## Phase 4A+1 · Streaming text gateway

- Add opt-in DeepSeek and OpenAI-compatible SSE profiles behind a local Node gateway. Keep credentials and persistent cost admission server-side.
- Bound multi-turn text context and measure gateway dispatch, first text, effective output, stop latency, terminal wait and token use. Report rejected and unanswered tasks in matched policy runs.
- Validate the adapter without paid calls and provide explicit smoke commands for an operator-configured endpoint.
- Quarantine attempts without reliable terminal evidence, preserve provisional costs and document operator reconciliation.

## Phase 4O.0 · Deployment compatibility hardening

- Remove the Wasm MIME wildcard that mislabeled MediaPipe JavaScript.
- Version the self-hosted MediaPipe runtime path and scope immutable caching to that version.
- Add the perception CSP to both `/perception` and `/perception.html` for Cloudflare pretty URLs, without weakening index/runtime.
- Extend the Node gateway static allowlist for the exact versioned module files and apply worker-safe page-specific CSP.
- Document the Cloudflare Pages route/header boundary and mark a real preview deployment as required before release.

## Phase 4O · Runtime observability and cost dashboard

- Audit existing core, perception, scheduler, runtime-task, gateway-ledger and Runtime Lab metrics; record units, lifecycle, sources, aggregation and gaps in `docs/runtime-observability.md`.
- Add a bounded page-scoped telemetry protocol with counter, gauge, histogram and structured event records; explicit source and high-cardinality identity separation; JSON/CSV export; reset/session isolation.
- Add a gateway cost panel using the authenticated `/api/runtime` budget: total/settled/reserved/provisional/available/utilization, accepted/limit, quarantined, frozen.
- Keep polling low-frequency, visible-tab, non-overlapping and failure-isolated; label configured estimates versus vendor invoices and never show unknown cost as zero.
- Show actual FPS, cache/transfer, queue/slots, task outcomes/reasons, P50/P95 latency, tokens, stale/blocked outputs and cost; keep perception and inference sessions explicitly separate.
- Add unit tests for cost arithmetic, poll overlap/error handling, telemetry bounds/privacy/session isolation, and runtime summaries; add browser smoke for Mock, seeded-gateway and mobile layouts.

## Next · Deployed validation and additional modalities


- Validate the gateway against a real, explicitly authorized endpoint and evaluate a Workers relay with durable shared admission.
- Add opt-in image transfer to a vision-capable model using bounded snapshots and separate upload and provider budgets. Evaluate visual semantics separately from frame selection.
- Optionally add TTS behind the output coordinator with bounded, interruptible playback.
- Defer heterogeneous pools, GPU execution, native bidirectional model transport and training.
