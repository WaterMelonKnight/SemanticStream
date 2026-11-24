# SemanticStream

**Less data. More understanding.**

SemanticStream is an adaptive context streaming infrastructure for real-time AI agents. It selects context from a continuous stream under constrained bandwidth and compute. The project aims to let agents explicitly retrieve original context when needed.

Phase 0 built a browser-only visual loop with a procedural Canvas source and a mock receiver. Phase 1A adds a local video input: choose an MP4 or WebM file, play, pause, restart, seek, switch videos, or return to the built-in scene. Both fixed and adaptive policies see the same captured frames and feed independent mock-agent views.

Everything runs in the browser tab. The selected file is read through a local Object URL and drawn to Canvas; no video or frame is uploaded. The demo requires no GPU, backend, database, model API, or paid service.

## Run locally

Use Node.js 24 and npm.

```sh
npm ci
npm run dev
```

Open the URL printed by Vite. The app starts on the procedural demo:

- **Still**, **slow motion**, **fast motion**, and a brief **text event** cycle continuously.
- **Fixed** targets four deliveries per second.
- **Adaptive** compares each thumbnail with its last accepted frame.
- Both strategies use 125 ms minimum delivery spacing, a 1.5 s silence refresh, and the configured rolling five-second frame cap.

## Local video

Choose **Choose local video** and pick an MP4 or WebM the browser can decode. The file picker is local; the app never sends the file anywhere.

- **Play / Pause** stops and resumes capture without resetting the comparison session.
- **Restart** seeks to the start and resets the sampling session.
- **Seek** resets the sampling session because media time is discontinuous. A seek to the current position also resets.
- **Choose local video** while a video is active switches files, revokes the previous Object URL, and resets the session.
- **Built-in demo** disposes the video adapter, releases its Object URL, and returns to the procedural scene.

Video frames are captured with `requestVideoFrameCallback` when available, with a `requestAnimationFrame` fallback that only emits when media time changes. The capture timestamps used by sampling are monotonic `performance.now()` values inside a session; video media time is displayed separately. A backward media-time jump never reaches the sampler because load/seek/restart begin a new session.

Codec support varies by browser. MP4 with H.264/AAC and WebM with VP8/VP9 are the most likely choices. The app checks `canPlayType` before loading and reports media decode errors with an actionable message. iPhone Safari may require a tap on **Play** even though the video is muted; Android Chrome and mobile layouts are supported with the same controls.

## Read the results

The dashboard reports cumulative inputs, deliveries, filtered share, mean browser processing latency, and rolling input/sent rates for both strategies. A separate line shows whether adaptive or fixed delivered more frames from the same input sequence.

Filtered frames are broken down by reason:

- **Policy** — the strategy decided not to send.
- **Interval** — the 125 ms minimum spacing blocked it.
- **Budget** — the rolling five-second cap was full.
- **Busy** — the mock sink declined a frame (backpressure).

The timeline keeps only the latest 150 input-frame decisions. Each column is one shared input frame; the top lane is adaptive and the bottom lane is fixed. The rate meters keep a two-second window, and all queues, timelines, and cached media are bounded.

Frame counts are frame counts. They are not model tokens, API calls, or money. Brief or small visual events can still be missed by capture, sampling, the budget, or a busy sink. Raw-frame retrieval and event recall evaluation remain future work.

## Verify and build

```sh
npm run typecheck
npm run test
npm run build
npm run preview
```

Tests cover the sampler, budget, change detector, reason counts, rolling rates, the bounded timeline, video file switching, pause/resume, seek reset, duplicate-frame suppression, Object URL release, listener cleanup, and the fallback capture path. The procedural comparison tests remain in the suite.

GitHub Actions runs install, typecheck, tests, and the static build for branch pushes and pull requests. For Cloudflare Pages, use the repository root, `npm run build` as the build command, and `dist` as the build output directory. Set `NODE_VERSION` to `24` for preview and production builds, including when using a Vite preset. The application uses static files and requires no Cloudflare bindings.

### Browser checklist

During Phase 1A development, the built page was exercised in headless Chromium with a generated local WebM (play, pause, seek, file switch, unsupported file, and return to demo). CI does not install a browser. Before a release, also check on real devices:

1. iPhone Safari: choose a camera-roll MP4, confirm the first frame appears, tap **Play**, then pause, seek, and return to the demo.
2. Android Chrome: choose a downloaded WebM and an MP4, switch files while playing, and confirm the previous Object URL is released (no stale playback).
3. Background the tab during playback, return, and confirm capture resumes without a burst of catch-up frames.
4. Rotate a narrow phone and check that the input controls, metrics, and timeline do not overflow horizontally.

## Documentation

Read [ARCHITECTURE.md](ARCHITECTURE.md) for contracts, timing, video lifecycle, and ownership, [ROADMAP.md](ROADMAP.md) for follow-up work, and [AGENTS.md](AGENTS.md) for coding-agent handoff.

## License

Apache License 2.0 is proposed for SemanticStream, pending repository owner confirmation. The repository currently has no project license file.
