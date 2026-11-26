# Coding agent guide

## Scope

SemanticStream is adaptive context streaming infrastructure for real-time AI agents. Phase 0 is a browser-only visual loop with a procedural source and a mock receiver. Phase 1A adds a local video source behind the same stream contract. Phase 1B adds block-local and hybrid adaptive policies plus a deterministic budget-aware replay benchmark. Phase 2 adds a bounded context buffer, active retrieval, and a separate/combined resource budget. Phase 3A adds a typed task-aware decision boundary and unified ex-ante admission for adaptive real-time sends plus retrieval. Phase 4P.1 adds an isolated, opt-in browser perception experiment. Keep changes scoped to the current phase or the requested task.

## Entry points

- Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing stream contracts, sampling, budgets, video lifecycle, or ownership.
- Start with `src/core/sampler.ts` for the synchronous decision and delivery path.
- `src/app/sampling-session.ts` owns both samplers, session context, task scheduling, the bounded timeline, and rate meters. Browser adapters supply samples and sinks.
- `src/core/local-change.ts` owns the block detector and the global/local/hybrid policy composition. `src/core/sampling.ts` keeps the baseline `meanRgbDifference`.
- `src/core/context-buffer.ts` owns bounded history, ownership copies, eviction, and lookup statuses. `src/core/active-retrieval.ts` owns the retrieval protocol and request log. `src/core/resource-budget.ts` owns rolling frame/byte budgets. `src/core/resource-admission.ts` is the single ex-ante gate for adaptive real-time sends and retrieval: sub-budgets plus the combined total.
- `src/decision/` owns `DecisionState`, the finite action space, the provider boundary, timeout/fallback, the scheduler, and `RuleBasedDecisionProvider`. `src/benchmark/task-runner.ts` and `task-report.ts` own the Phase 3A replay/report; `task-fixtures.ts` owns deterministic task scenes.
- `src/benchmark/` owns deterministic fixtures, replay, evaluation, and JSON/CSV/Markdown reports. Keep it free of DOM and browser APIs. Phase 2 replay is in `retrieval-runner.ts` and `retrieval-report.ts`.
- `src/visual/video-source.ts` owns the video element, Object URL, frame callbacks, seek/load reset, and deduplication. `src/visual/source.ts` owns the procedural adapter. `src/visual/camera-source.ts` owns the camera stream and tracks.
- `perception.html`, `src/perception.ts`, and `src/perception/` own the Phase 4P.1 experiment: `ObjectDetectorProvider`, the MediaPipe worker, 320 × 320 input preparation, bounded queue, fixed/adaptive trigger, `ObjectObservation`, lifecycle, and browser metrics. Reuse `CameraSource`/`VideoSource`; do not refactor the Phase 4A scheduler, provider, or runtime lab for this experiment.
- Find Canvas capture, thumbnail preparation, and the mock sink in `src/visual/`. The browser entry point is `src/main.ts`; the timeline renderer is `src/ui/timeline-view.ts`.
- `src/inference/` owns streaming task lifecycle, output eligibility, snapshots and the browser gateway adapter. `src/gateway/` owns authenticated Node request admission, vendor SSE profiles and the persistent cost ledger.
- Keep core, policy, timeline, rate, and benchmark tests runnable in Node.js. Keep Canvas, video, DOM, and animation scheduling in the browser layer.

## Working agreements

- Use monotonic milliseconds within a session. Evaluate each frame using the current frame and previously accepted state. Never feed video media time to sampler ordering; reset the session on seek/load/restart.
- Preserve identical source frames and budget settings across comparison branches. A mode switch should preserve both histories.
- Reserve capacity before the sink and charge the rolling ledger at delivery. Advance the pixel baseline only after sink acceptance. Keep budget accounting when the limit changes.
- Keep retained media bounded and document ownership. Clone a borrowed image before retaining it beyond capture.
- `VideoSource` owns its Object URL, media listeners, and frame-callback handles. Remove listeners and revoke URLs in `dispose()`. Cancel pending frame callbacks on pause, seek, stop, and load.
- Suppress repeated video frames in both capture modes. A seek must reset the adaptive baseline, budget state, metrics, rates, and timeline for both strategies.
- Event labels, event regions, and future frames are evaluator-only. Never pass them into a sampling policy. The benchmark runner must feed the same frames, timestamps, budget, and timing to every strategy. Audit resource use at delivery time and preserve historical reports.
- Select benchmark parameters only on the tuning suite. Report held-out evaluation results and failure cases even when a new policy loses. Recall means a frame was captured inside a labeled window, not that a model understood the event.
- Keep the replay benchmark deterministic in its inputs and decisions. Processing time is a wall-clock diagnostic and may vary.
- The context buffer owns pixel copies, never Canvas references. Enforce age, byte, and frame caps; count each eviction reason. Reset/dispose the buffer on seek, load, restart, source switch, demo restart, and page exit. Requests from another session must return `wrong-session`.
- Retrieval has its own budget and is also charged to a combined real-time + retrieval budget. Adaptive real-time sends reserve through the same `ResourceAdmissionController` before the sink accepts a frame. A denied request consumes no budget. Do not let retrieval bypass the real-time sampler cap or charge one send twice.
- A `DecisionProvider` returns only an action proposal. Keep budget, admission, buffer mutation, and sink execution outside it. Reject unknown actions. Rule scores are heuristic, not probabilities; label `scoreKind` accordingly and never present a heuristic as calibrated confidence.
- Task ROI is a user/task declaration, never generated from evaluator event labels. Keep per-frame feature extraction synchronous and cheap; keep model/decision calls at the low-frequency decision interval. Do not call a remote model on every frame. Fallback must be deterministic.
- The live task decision is an advisory preview unless the adaptive strategy is `task` (Task-aware live gate); then it gates the adaptive sampler's send. Provider retrieval proposals execute only in replay. Manual browser retrieval goes through the same reservation gate. Do not make the preview silently mutate budgets or bypass admission.
- The cue-retrieval experiment may use real system signals such as budget denial, but never event labels. The label-timed oracle is an upper bound only; label it as non-autonomous everywhere.
- Perception accuracy must not be reported without labels. The perception experiment reports only load time, bytes, latency, batch count, effective FPS, drops, and page long tasks. Do not claim detection precision/recall or event recall from the procedural demo or an unlabeled video.
- Treat the MediaPipe runtime/model licenses and deployment limits in `docs/visual-perception-licenses.md` as part of the contract. Do not commit model weights or redistribute uncertain weights. The self-hosted Wasm assets are generated from installed dependencies and ignored by git. Keep the perception model/runtime assets compatible with the gateway's static allowlist, MIME and CSP; if they cannot be served under the existing allowlist, document the deployment boundary rather than weakening the gateway.
- Keep media local and bounded. The opt-in text gateway is the only path to a real model in Phase 4A+1. Never run paid smoke tests automatically. Use local SSE fixtures in tests and CI. Keep credentials outside the static build, logs and repository.
- Preserve a gateway hold until a trustworthy terminal arrives or an operator reconciles authoritative evidence. EOF, HTTP abort and logical task cancellation alone cannot free it.
- Do not cache whole videos or unbounded 30 fps RGBA history. Do not implement remote model APIs, GPU-required paths, a backend, or a paid service. The HTTP decision-provider contract is design-only. The Phase 4P.1 detector is an isolated opt-in exception: default off, explicit user enable, local camera/video media only, no upload, no training, bounded worker queue, source/session invalidation, and a model/runtime license record. Do not turn the perception experiment into a production inference path.
- Describe frame counts as frame counts. Document event misses and the exact timing boundaries of latency, timeline capacity, and rate windows.
- Keep visual data local by default. Build a static site with no credentials, uploads, or service dependencies.

See [runtime architecture v2](docs/runtime-architecture-v2.md) for time, lifecycle and action semantics.

Run `npm ci`, `npm run typecheck`, `npm run test`, `npm run benchmark` (Phase 1B, 2, 3A and 4A), and `npm run build` before submitting. `npm run build` runs `prebuild` and copies the self-hosted MediaPipe Wasm assets. Use `npm run preview` to verify all three pages when browser automation is available. For perception, check model opt-in, worker load, detection, video seek/restart, camera stop if available, model unload, and the two-phase benchmark. Report real-device gaps; do not claim iPhone/Android testing without it. Submit changes on a separate branch without merging unless requested.
