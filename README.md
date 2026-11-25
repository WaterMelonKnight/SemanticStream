# SemanticStream

**Less data. More understanding.**

SemanticStream is adaptive context streaming infrastructure for real-time AI agents. It selects context from a continuous stream under constrained bandwidth and compute. The project aims to let agents explicitly retrieve original context when needed.

Phase 0 built a browser-only visual loop with a procedural Canvas source and a mock receiver. Phase 1A added local video input. Phase 1B adds a deterministic, budget-aware event evaluation: configurable local block change detection, a global/local hybrid policy, labeled replay scenes, and real JSON/CSV/Markdown benchmark output.

Everything runs locally in the browser or in Node.js. The selected video is read through a local Object URL and drawn to Canvas; no video or frame is uploaded. The project requires no GPU, backend, database, model API, or paid service.

## Run locally

Use Node.js 24 and npm.

```sh
npm ci
npm run dev
```

Open the URL printed by Vite. The app starts on the procedural demo. The **Adaptive strategy** selector switches the adaptive branch between:

- **Global RGB** — the Phase 0 `meanRgbDifference` baseline.
- **Local blocks** — a configurable block-local detector.
- **Hybrid** — global change OR local blocked change.

The local detector uses the shared 96 × 54 RGBA thumbnail. Its block size (6, 8, or 12 px), threshold, and minimum changed-block count are configurable. The local and hybrid rules are still policies inside the existing `Sampler`; they do not bypass the 125 ms minimum interval, the 1.5 s silence refresh, or the rolling five-second frame budget.

Changing the adaptive strategy keeps both samplers and their histories. The next frame uses the new rule.

## Visual input

Choose **Choose local video** and pick an MP4 or WebM the browser can decode. The file picker is local; the app never sends the file anywhere.

- **Play / Pause** stops and resumes capture without resetting the comparison session.
- **Restart** seeks to the start and resets the sampling session.
- **Seek** resets the sampling session because media time is discontinuous. A seek to the current position also resets.
- **Choose local video** while a video is active switches files, revokes the previous Object URL, and resets the session.
- **Built-in demo** disposes the video adapter, releases its Object URL, and returns to the procedural scene.

Video frames are captured with `requestVideoFrameCallback` when available, with a `requestAnimationFrame` fallback that only emits when media time changes. Sampling timestamps are monotonic `performance.now()` values inside a session; video media time is displayed separately. A backward media-time jump never reaches the sampler because load/seek/restart begin a new session.

Codec support varies by browser. MP4 with H.264/AAC and WebM with VP8/VP9 are the most likely choices. The app checks `canPlayType` before loading and reports media decode errors with an actionable message. iPhone Safari may require a tap on **Play** even though the video is muted.

## Live dashboard

The dashboard reports cumulative inputs, deliveries, filtered share, mean browser processing latency, and rolling input/sent rates for both branches. A separate line shows whether adaptive or fixed delivered more frames from the same input sequence.

Filtered frames are broken down by reason:

- **Policy** — the strategy decided not to send.
- **Interval** — the 125 ms minimum spacing blocked it.
- **Budget** — the rolling five-second cap was full.
- **Busy** — the mock sink declined a frame (backpressure).

The timeline keeps only the latest 150 input-frame decisions. Each column is one shared input frame; the top lane is adaptive and the bottom lane is fixed. The rate meters keep a two-second window.

Frame counts are frame counts. They are not model tokens, API calls, or money. Brief or small visual events can still be missed by capture, sampling, the budget, or a busy sink.

## Budget-aware benchmark

The benchmark replays deterministic fixtures, not a hand-written example:

- 96 × 54 RGBA samples at 30 fps.
- Six tuning scenes and six held-out evaluation scenes.
- Labeled local text, 100 ms brief events, low-contrast changes, slow brightness ramps, irrelevant background motion, and capture pauses.
- Identical frames, timestamps, budget window, frame limit, minimum interval, and silence refresh for every strategy.
- Event labels and regions are consumed only by the evaluator after replay. Policies see only the current sample and their own prior accepted sample.

Recall means **at least one delivered frame timestamp falls inside the event's labeled window**. It does not mean a vision or language model understood the event. Events entirely inside a capture gap are reported separately and excluded from recall. A send outside a labeled event is a diagnostic, not automatically a false positive, because the event set is intentionally sparse.

Run:

```sh
npm run benchmark
```

This writes:

- `benchmarks/results/latest.json` — full machine-readable report.
- `benchmarks/results/latest.csv` — one row per scene/strategy plus suite aggregates.
- `benchmarks/results/latest.md` — readable report with parameter selection, per-scene results, misses, and unobservable events.
- `public/benchmark/latest.json` — the same JSON used by the in-page benchmark panel.

The latest held-out evaluation, with 9 observable events out of 10 labeled events:

| Strategy | Sent | Recall | Missed | Mean first capture | Budget violations |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fixed · 4 fps | 139 | 88.9% (8/9) | 1 | 120.8 ms | 0 |
| Adaptive · global RGB | 45 | 33.3% (3/9) | 6 | 166.7 ms | 0 |
| Adaptive · local blocks | 53 | 88.9% (8/9) | 1 | 4.2 ms | 0 |
| Adaptive · hybrid | 56 | 88.9% (8/9) | 1 | 4.2 ms | 0 |

The new local/hybrid rules are **not uniformly better**:

- Fixed also reaches 8/9 and misses only one 100 ms event that falls between its 250 ms slots.
- Global misses six local/low-contrast events.
- Local and hybrid reach 8/9 with fewer sends, but both miss the event that follows the irrelevant background motion: the motion consumes the rolling 20-frame budget first.
- Hybrid adds three sends over local on the slow-ramp scene without improving recall.

These are real replay results. Parameter selection uses only the tuning suite; the evaluation suite is held out. Processing time is wall-clock time and varies between runs; the frame decisions and input sequences are deterministic.

## Verify and build

```sh
npm run typecheck
npm run test
npm run benchmark
npm run build
npm run preview
```

Tests cover the sampler, budget, global change detector, block-local detector, strategy switching, event evaluation, tuning/evaluation separation, deterministic fixtures, duplicate-frame suppression, video switching, pause/resume, seek reset, Object URL release, listener cleanup, and the bounded timeline. The Phase 0 procedural tests remain in the suite.

GitHub Actions runs install, typecheck, tests, the benchmark CLI, and the static build for branch pushes and pull requests. For Cloudflare Pages, use the repository root, `npm run build` as the build command, and `dist` as the build output directory. Set `NODE_VERSION` to `24` for preview and production builds. The application uses static files and requires no Cloudflare bindings.

### Browser checklist

During development, the built page was exercised in headless Chromium with a generated local WebM and the benchmark panel. CI does not install a browser. Before a release, also check on real devices:

1. iPhone Safari: choose a camera-roll MP4, confirm the first frame appears, tap **Play**, then pause, seek, and return to the demo.
2. Android Chrome: choose a downloaded WebM and an MP4, switch files while playing, and confirm the previous Object URL is released (no stale playback).
3. Background the tab during playback, return, and confirm capture resumes without a burst of catch-up frames.
4. Rotate a narrow phone and check that the input controls, metrics, timeline, and benchmark cards do not overflow horizontally.

## Documentation

Read [ARCHITECTURE.md](ARCHITECTURE.md) for contracts, timing, video lifecycle, local/hybrid policies, benchmark isolation, and ownership; [ROADMAP.md](ROADMAP.md) for follow-up work; and [AGENTS.md](AGENTS.md) for coding-agent handoff.

## License

Apache License 2.0 is proposed for SemanticStream, pending repository owner confirmation. The repository currently has no project license file.
