# SemanticStream

**Less data. More understanding.**

SemanticStream is adaptive context streaming infrastructure for real-time AI agents. It selects context from a continuous stream under constrained bandwidth and compute. Phase 0 built a procedural visual loop. Phase 1A added local video. Phase 1B added deterministic budget-aware event evaluation. Phase 2 added a bounded history buffer and active retrieval. Phase 3A adds a task-aware, pluggable decision boundary. Phase 3R hardens session lifetimes, resource admission and replay while keeping the browser demo local. See the [Phase 3R audit](docs/architecture-audit-phase3r.md) and [runtime architecture](docs/runtime-architecture-v2.md).

Everything runs locally in the browser or in Node.js. The selected video is read through a local Object URL and drawn to Canvas; no video or frame is uploaded. The project requires no GPU, backend, database, model API, or paid service.

## Run locally

Use Node.js 24 and npm.

```sh
npm ci
npm run dev
```

The live demo compares a fixed sampler with a configurable adaptive sampler:

- **Global RGB** — the Phase 0 `meanRgbDifference` baseline.
- **Local blocks** — a configurable block-local detector.
- **Hybrid** — global change OR local blocked change.

Both branches use 125 ms minimum delivery spacing, a 1.5 s silence refresh, and the configured rolling five-second frame cap. The adaptive branch is the agent under test: its real-time deliveries go through the shared ex-ante admission gate and are recorded with the retrieval ledger. The fixed branch is the side-by-side comparison baseline.

## Live Vision Runtime Lab

Open **Live Vision Runtime Lab** from the visual demo or go to `/runtime.html` after starting Vite. Trigger a routine load change or a critical replica anomaly in the synthetic system monitor. Send a text turn during generation or interrupt an in-flight response. Select **Ignore cancel · unknown usage** to see output stop while an upstream slot drains and the token reservation becomes provisional. Use a recent frame sequence to retrieve a thumbnail through the visual budget.

Choose **Serial FIFO**, **Concurrent FIFO**, or **SemanticStream** with one or two slots. Both policies use the same resource caps. Switch policies at the same slot count to compare scheduling and switch slot counts within a policy to compare concurrency. Reload for a fresh cumulative budget. Timeline entries distinguish known simulated monitor events from pixel-change candidates. Camera access requires permission and HTTPS or localhost. Camera and local video stay in the browser.

Run `npm run benchmark:runtime` for the deterministic Node.js experiment. It exercises priority, queue pressure, dependencies, deadlines and ignored cancellation with a scripted provider. The published latencies measure this simulation. [Replay results](benchmarks/results/phase4a-runtime.md)

The next integration is a server-side DeepSeek streaming adapter for text and terminal usage, followed by opt-in bounded evidence for a vision-capable model. Optional TTS would consume only coordinator-authorized output. [Adapter requirements](docs/phase4a-duplex-runtime.md#next-adapters)

## Bounded context buffer

Each sampling session owns a bounded, local history of frames that were actually captured. It is not a video cache.

- Default live bounds: **3 s**, **90 frames**, **3 MB**.
- Frames are stored as owned 96 × 54 RGBA copies. The buffer never retains a Canvas that a later frame can overwrite, and every lookup returns another copy.
- Eviction happens by age, frame count, and byte count, in that order. The UI and report show the eviction count and the reason breakdown.
- Video seek, restart, file switch, source switch, demo restart, and a new sampling session dispose the old buffer and create a new session ID.
- Page exit disposes the buffer. A back-forward-cache restore keeps the session because the page was not unloaded.
- Cross-session requests return `wrong-session`; they never leak frames from another session.

The buffer can answer:

```text
getLatestFrame(sessionId)
getFrameBySequence(sessionId, sequence)
getFrameAtTimestamp(sessionId, timestampMs, toleranceMs?)
getFramesBetween(sessionId, startMs, endMs, { maxFrames })
getRegion(sessionId, {sequence} | {timestampMs}, {x, y, width, height})
```

Results distinguish `available`, `partial`, `evicted`, `not-yet-captured`, `nonexistent`, `wrong-session`, `invalid-range`, `region-invalid`, `budget-denied`, and `disposed`. Every response carries the session ID, request start and completion, delivery time on success, latency, available range, captured range, and budget snapshot.

### Retrieval budget

Retrieval has its own rolling budget and shares a combined ledger with real-time sends:

- Retrieval: **6 frames and 2 MB / 5 s**.
- Combined real-time + retrieval: **26 frames and 4 MB / 5 s**.

Real-time adaptive sends and retrieval both pass a single ex-ante `ResourceAdmissionController`. It reserves capacity in the relevant sub-budget and combined total before delivery, commits on acceptance and releases on refusal. The fixed live comparison uses an independent ledger. The benchmark independently audits all three limits.

## Live retrieval demo

The page adds:

- Available history range, cache memory, frame count, evictions, and retrieval-budget usage.
- A bounded request/response log.
- Click a recent decision-timeline column to retrieve that buffered frame, including frames neither sampler sent.
- Click the retrieved frame to request a 24 × 16 local pixel crop.
- Explicit messages for evicted frames, budget denials, capture-gap requests, and session resets.

This is a mock agent. It does not call a model or MCP service.

## Task-aware decisions

Phase 3A adds a task-aware decision layer above the sampler:

- A typed `DecisionState` with task category, declared ROI, global/local/ROI change, repeated-change counters, remaining real-time/retrieval/total budget, cache range, and recent decisions.
- A finite action space: `SEND_FRAME`, `SEND_PREVIEW`, `DROP`, `WAIT`, `REQUEST_HISTORY`, `REQUEST_REGION`, `ESCALATE`.
- A pluggable `DecisionProvider` with mandatory score provenance. `RuleBasedDecisionProvider` returns heuristic weights; it does not pretend they are calibrated probabilities.
- Separate primary and fallback deadlines, validated proposals, cancellation across session or task changes, and a deterministic WAIT when both providers fail.
- A 100 ms decision interval so expensive model calls are never made on every frame. The shared sampler still owns budget, spacing, and silence refresh.
- No provider can mutate resource budgets or bypass admission.

The live page lets you choose a task, edit a custom ROI, inspect the decision log, and see remaining budget. The same provider is advisory by default; selecting **Task-aware (live gate)** lets an applicable `SEND_FRAME`/`SEND_PREVIEW` proposal permit a discretionary adaptive send. History and region proposals execute in the corrected replay. In the browser, users request history and crops through the timeline. The shared sampler still applies its budget, interval, and silence refresh.

See [docs/decision-model-integration.md](docs/decision-model-integration.md) for the Laya, AnyJev, Jev API, generic structured-output, and local-classifier adapter design, calibration requirements, latency budgets, degradation, and safety boundaries. Phase 3A ships no model, GPU work, paid API, or network provider.

## Deterministic benchmark

`npm run benchmark` runs the Phase 1B event benchmark and the corrected Phase 2 and Phase 3A replays, then the Phase 4A runtime simulation. The three visual suites reuse the same deterministic 30 fps, 96 × 54 replay fixtures where applicable.

Phase 2 compares:

- **A · Fixed 4 fps**
- **B · Adaptive local**
- **C · Adaptive local + cue retrieval**
- **Oracle · local + label-timed retrieval** (upper bound only)

C's only cue is a real system signal: the real-time sampler returned `budget`. It requests the latest buffered frame with a 500 ms minimum spacing. It does not read event labels. The 500 ms value is selected on the tuning suite.

The oracle requests a frame at the midpoint of each labeled event. It exists only to estimate the best case under label-perfect triggering. It also bypasses the production retrieval budget because it is not a deployable strategy. **It is not autonomous discovery.**

### Phase 2 held-out evaluation

9 observable events out of 10; one event is inside a capture gap.

| Strategy | Realtime recall | Post-retrieval recall | Retrieval frames | Total sent | Cache peak | Violations (rt / ret / total) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A · Fixed 4 fps | 88.9% (8/9) | 88.9% (8/9) | 0 | 139 | 1.87 MB / 90 | 0 / 0 / 0 |
| B · Adaptive local | 88.9% (8/9) | 88.9% (8/9) | 0 | 53 | 1.87 MB / 90 | 0 / 0 / 0 |
| C · Local + cue retrieval | 88.9% (8/9) | 100.0% (9/9) | 5 | 58 | 1.87 MB / 90 | 0 / 0 / 0 |
| Oracle · label-timed | 88.9% (8/9) | 100.0% (9/9) | 9 | 62 | 1.87 MB / 90 | 0 / 0 / 0 |

The key Phase 1B failure was `eval-motion-text`: irrelevant background motion exhausted the 20-frame budget, so the local policy missed the event. The cue strategy recovers it from 0% to 100% with 5 retrieval frames. The oracle recovers the same event with 1 retrieval frame. This demonstrates the value of a bounded buffer, not autonomous semantic understanding.

Results are written to:

- `benchmarks/results/phase1b-replay.{json,csv,md}` holds fresh local Phase 1B results, including wall-clock processing diagnostics.
- `benchmarks/results/phase2-corrected.{json,csv,md}` and `benchmarks/results/phase3a-corrected.{json,csv,md}` hold the versioned corrected replays.
- Historical Phase 1B (`latest.*`), Phase 2 (`phase2.*`) and Phase 3A (`phase3.*`) reports are preserved in `benchmarks/results/`. The page loads the historical Phase 1B summary and both corrected summaries from `public/benchmark/`.

The corrected replay uses captured evidence for spatial coverage, delivery before event end for deadline coverage, and delivery time for rolling spend. Simulated provider and retrieval durations come from the replay clock. See the [benchmark comparison](docs/architecture-audit-phase3r.md#corrected-results).

### Historical Phase 3A held-out evaluation

Phase 3A adds 9 held-out scenes: the original 6 plus deterministic task-ROI, repeated-event, and overlapping-event scenes. It compares A, B, C, and **D · Task-aware Rule Decision** under the same total frames/bytes budget, cache bounds, and time constraints. Task ROI is authored per scene; evaluator event regions are not used to create the ROI at decision time.

| Strategy | Realtime recall | Post-retrieval recall | ROI realtime recall | ROI post-retrieval | Retrieval frames | Total sent | Cache peak | Violations (rt / ret / total) | Decision latency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A · Fixed 4 fps | 94.4% (17/18) | 94.4% (17/18) | 94.1% (16/17) | 94.1% (16/17) | 0 | 211 | 1.87 MB / 90 | 0 / 0 / 0 | — |
| B · Adaptive local | 88.9% (16/18) | 88.9% (16/18) | 88.2% (15/17) | 88.2% (15/17) | 0 | 113 | 1.87 MB / 90 | 0 / 0 / 0 | — |
| C · Local + retrieval | 88.9% (16/18) | 100.0% (18/18) | 88.2% (15/17) | 100.0% (17/17) | 16 | 129 | 1.87 MB / 90 | 0 / 0 / 0 | — |
| D · Task-aware Rule Decision | 72.2% (13/18) | 94.4% (17/18) | 76.5% (13/17) | 94.1% (16/17) | 22 | 99 | 1.87 MB / 90 | 0 / 0 / 0 | 0.037 ms |

D sends fewer total frames than B or C and improves its own real-time recall after retrieval, but it is not uniformly better: C reaches 100% overall and ROI recall on this held-out suite, while D misses some events. The benchmark reports the loss rather than hiding it. The decision score is a heuristic weight, not a calibrated model probability.

The historical recall uses the capture timestamp of each delivered or retrieved frame against the labeled event window. The corrected replay also checks the delivered crop footprint. Uncaptured events cannot be recovered. The buffer is short-lived; frames evicted before a request are returned as `evicted`. Task ROI recall is a separate metric over events whose annotated region intersects the authored task ROI.

## Verify and build

```sh
npm run typecheck
npm run test
npm run benchmark
npm run build
npm run preview
```

Tests cover:

- Buffer time/byte/frame limits, ownership copies, eviction reasons, lookup statuses, ranges, regions, disposal, and cross-session isolation.
- Retrieval budget, combined budget, denial, request logs, regions, wrong-session, and disposal.
- Unified ex-ante admission: sub-budget vs total, dynamic limits, rolling-window boundary, duplicate-accounting prevention, and sampler denial.
- Phase 2 cue replay, cache bounds, background-motion recovery, event-label isolation for cue decisions, deterministic digests, and report generation.
- Decision features, rule scoring, heuristic-vs-probability labeling, timeout/fallback, invalid-action rejection, low-frequency scheduling, task-aware replay, task ROI metrics, and Phase 3A report generation.
- Existing sampler, video lifecycle, Phase 1B fixtures/benchmark, timeline, rate, and formatting tests.
- Inference snapshot ownership, queue/dependency behavior, stale partial suppression, terminal evidence, reservations and deterministic replay across four scheduler/capacity combinations.

GitHub Actions runs install, typecheck, all tests, the four replay suites, and the two-page static build. For Cloudflare Pages, use the repository root, `npm run build`, and `dist`; set `NODE_VERSION=24`. No Cloudflare bindings are required.

### Browser checklist

The built page was exercised in headless Chromium with a 390 px viewport: timeline click retrieval, region crop, eviction error, retrieval budget denial, task selection/ROI editing, live decision log and gate, all benchmark panels, and no horizontal overflow. CI does not install a browser. Before a release, also check on real devices:

1. iPhone Safari: select a camera-roll MP4, play/pause/seek, click a recent timeline column, and crop a region.
2. Android Chrome: switch video files while playing, then retrieve a frame from the new session; confirm the old session is rejected as `wrong-session`.
3. Background/restore the tab and confirm capture and the bounded buffer resume without a burst.
4. Rotate a narrow phone and check the timeline, retrieval panel, task panel, decision log, and benchmark cards.

## Documentation

Read [ARCHITECTURE.md](ARCHITECTURE.md) for contracts, bounded buffer semantics, budgets, retrieval statuses, decision boundaries, benchmark isolation, and ownership; [docs/decision-model-integration.md](docs/decision-model-integration.md) for future model adapters; [ROADMAP.md](ROADMAP.md) for phase status; and [AGENTS.md](AGENTS.md) for coding-agent handoff.

## License

Apache License 2.0 is proposed for SemanticStream, pending repository owner confirmation. The repository currently has no project license file.
