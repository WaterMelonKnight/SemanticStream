# SemanticStream

**Less data. More understanding.**

SemanticStream is adaptive context streaming infrastructure for real-time AI agents. It selects context from a continuous stream under constrained bandwidth and compute. Phase 0 built a procedural visual loop. Phase 1A added local video. Phase 1B added deterministic budget-aware event evaluation. Phase 2 adds a bounded history buffer and active retrieval, so an agent can ask for visual evidence that was not sent in real time.

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

Both branches use 125 ms minimum delivery spacing, a 1.5 s silence refresh, and the configured rolling five-second frame cap. The selected agent's real-time deliveries are also recorded in a combined resource ledger.

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

Results distinguish `available`, `partial`, `evicted`, `not-yet-captured`, `nonexistent`, `wrong-session`, `invalid-range`, `region-invalid`, `budget-denied`, and `disposed`. Every response carries the session ID, requested timestamp, latency, available range, captured range, and budget snapshot.

### Retrieval budget

Retrieval has its own rolling budget and shares a combined ledger with real-time sends:

- Retrieval: **6 frames and 2 MB / 5 s**.
- Combined real-time + retrieval: **26 frames and 4 MB / 5 s**.
- Real-time sampler: the existing **20 frames / 5 s** cap.

The live UI records the selected agent's real-time deliveries. A retrieval request is rejected before data leaves the buffer when either the retrieval budget or the combined budget is exhausted. The benchmark independently audits all three limits.

## Live retrieval demo

The page adds:

- Available history range, cache memory, frame count, evictions, and retrieval-budget usage.
- A bounded request/response log.
- Click a recent decision-timeline column to retrieve that buffered frame, including frames neither sampler sent.
- Click the retrieved frame to request a 24 × 16 local pixel crop.
- Explicit messages for evicted frames, budget denials, capture-gap requests, and session resets.

This is a mock agent. It does not call a model or MCP service.

## Deterministic benchmark

`npm run benchmark` runs both the Phase 1B event benchmark and the Phase 2 retrieval benchmark. The retrieval benchmark reuses the same deterministic 30 fps, 96 × 54 replay fixtures and the same real-time sampler.

It compares:

- **A · Fixed 4 fps**
- **B · Adaptive local**
- **C · Adaptive local + cue retrieval**
- **Oracle · local + label-timed retrieval** (upper bound only)

C's only cue is a real system signal: the real-time sampler returned `budget`. It requests the latest buffered frame with a 500 ms minimum spacing. It does not read event labels. The 500 ms value is selected on the tuning suite.

The oracle requests a frame at the midpoint of each labeled event. It exists only to estimate the best case under label-perfect triggering. It also bypasses the production retrieval budget because it is not a deployable strategy. **It is not autonomous discovery.**

### Held-out evaluation

9 observable events out of 10; one event is inside a capture gap.

| Strategy | Realtime recall | Post-retrieval recall | Retrieval frames | Total sent | Cache peak | Violations (rt / ret / total) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A · Fixed 4 fps | 88.9% (8/9) | 88.9% (8/9) | 0 | 139 | 1.87 MB / 90 | 0 / 0 / 0 |
| B · Adaptive local | 88.9% (8/9) | 88.9% (8/9) | 0 | 53 | 1.87 MB / 90 | 0 / 0 / 0 |
| C · Local + cue retrieval | 88.9% (8/9) | 100.0% (9/9) | 5 | 58 | 1.87 MB / 90 | 0 / 0 / 0 |
| Oracle · label-timed | 88.9% (8/9) | 100.0% (9/9) | 9 | 62 | 1.87 MB / 90 | 0 / 0 / 0 |

The key Phase 1B failure was `eval-motion-text`: irrelevant background motion exhausted the 20-frame budget, so the local policy missed the event. The cue strategy recovers it from 0% to 100% with 5 retrieval frames. The oracle recovers the same event with 1 retrieval frame. This demonstrates the value of a bounded buffer, not autonomous semantic understanding.

Results are written to:

- `benchmarks/results/latest.json`, `latest.csv`, `latest.md` — Phase 1B.
- `benchmarks/results/phase2.json`, `phase2.csv`, `phase2.md` — Phase 2.
- `public/benchmark/latest.json` and `public/benchmark/phase2.json` — used by the page.

Recall means a delivered or retrieved frame timestamp falls inside a labeled event window. It does not measure whether a model understood the event. Uncaptured events cannot be recovered. The buffer is short-lived; frames evicted before a request are returned as `evicted`.

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
- Phase 2 cue replay, cache bounds, background-motion recovery, event-label isolation for cue decisions, deterministic digests, and report generation.
- Existing sampler, video lifecycle, Phase 1B fixtures/benchmark, timeline, rate, and formatting tests.

GitHub Actions runs install, typecheck, all tests, both benchmarks, and the static build. For Cloudflare Pages, use the repository root, `npm run build`, and `dist`; set `NODE_VERSION=24`. No Cloudflare bindings are required.

### Browser checklist

The built page was exercised in headless Chromium with a 390 px viewport: timeline click retrieval, region crop, eviction error, retrieval budget denial, both benchmark panels, and no horizontal overflow. CI does not install a browser. Before a release, also check on real devices:

1. iPhone Safari: select a camera-roll MP4, play/pause/seek, click a recent timeline column, and crop a region.
2. Android Chrome: switch video files while playing, then retrieve a frame from the new session; confirm the old session is rejected as `wrong-session`.
3. Background/restore the tab and confirm capture and the bounded buffer resume without a burst.
4. Rotate a narrow phone and check the timeline, retrieval panel, log, and benchmark cards.

## Documentation

Read [ARCHITECTURE.md](ARCHITECTURE.md) for contracts, bounded buffer semantics, budgets, retrieval statuses, benchmark isolation, and ownership; [ROADMAP.md](ROADMAP.md) for phase status; and [AGENTS.md](AGENTS.md) for coding-agent handoff.

## License

Apache License 2.0 is proposed for SemanticStream, pending repository owner confirmation. The repository currently has no project license file.
