# Coding agent guide

## Scope

SemanticStream is adaptive context streaming infrastructure for real-time AI agents. Phase 0 is a browser-only visual loop with a procedural source and a mock receiver. Phase 1A adds a local video source behind the same stream contract. Keep changes scoped to the current phase or the requested task.

## Entry points

- Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing stream contracts, sampling, budgets, video lifecycle, or ownership.
- Start with `src/core/sampler.ts` for the synchronous decision and delivery path.
- `src/app/sampling-session.ts` owns both samplers, both sinks, the bounded timeline, and the rate meters for one session.
- `src/visual/video-source.ts` owns the video element, Object URL, frame callbacks, seek/load reset, and deduplication. `src/visual/source.ts` owns the procedural adapter.
- Find Canvas capture, thumbnail preparation, and the mock sink in `src/visual/`. The browser entry point is `src/main.ts`; the timeline renderer is `src/ui/timeline-view.ts`.
- Keep core, policy, timeline, and rate tests runnable in Node.js. Keep Canvas, video, DOM, and animation scheduling in the browser layer.

## Working agreements

- Use monotonic milliseconds within a session. Evaluate each frame using the current frame and previously accepted state. Never feed video media time to sampler ordering; reset the session on seek/load/restart.
- Preserve identical source frames and budget settings across comparison branches. A mode switch should preserve both histories.
- Charge the rolling frame budget and advance the pixel baseline only after the sink accepts a frame. Keep budget accounting when the limit changes.
- Keep retained media bounded and document ownership. Clone a borrowed image before retaining it beyond capture.
- `VideoSource` owns its Object URL, media listeners, and frame-callback handles. Remove listeners and revoke URLs in `dispose()`. Cancel pending frame callbacks on pause, seek, stop, and load.
- Suppress repeated video frames in both capture modes. A seek must reset the adaptive baseline, budget state, metrics, rates, and timeline for both strategies.
- Describe frame counts as frame counts. Document event misses and the exact timing boundaries of latency, timeline capacity, and rate windows.
- Keep visual data local by default. Build a static site with no credentials, uploads, or service dependencies.
- Do not implement Phase 1B retrieval, event-recall benchmarks, GPU work, or a backend in this phase.

Run `npm ci`, `npm run typecheck`, `npm run test`, and `npm run build` before submitting. Use `npm run preview` to verify the built page when browser automation is available. Report the checks that ran and any gaps. Submit changes on a separate branch without merging unless requested.
