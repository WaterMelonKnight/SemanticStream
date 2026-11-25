# Coding agent guide

## Scope

SemanticStream is adaptive context streaming infrastructure for real-time AI agents. Phase 0 is a browser-only visual loop with a procedural source and a mock receiver. Phase 1A adds a local video source behind the same stream contract. Phase 1B adds block-local and hybrid adaptive policies plus a deterministic budget-aware replay benchmark. Phase 2 adds a bounded context buffer, active retrieval, and a separate/combined resource budget. Keep changes scoped to the current phase or the requested task.

## Entry points

- Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing stream contracts, sampling, budgets, video lifecycle, or ownership.
- Start with `src/core/sampler.ts` for the synchronous decision and delivery path.
- `src/app/sampling-session.ts` owns both samplers, both sinks, the adaptive strategy policy, the bounded timeline, and the rate meters for one session.
- `src/core/local-change.ts` owns the block detector and the global/local/hybrid policy composition. `src/core/sampling.ts` keeps the baseline `meanRgbDifference`.
- `src/core/context-buffer.ts` owns bounded history, ownership copies, eviction, and lookup statuses. `src/core/active-retrieval.ts` owns the retrieval protocol and request log. `src/core/resource-budget.ts` owns rolling frame/byte budgets.
- `src/benchmark/` owns deterministic fixtures, replay, evaluation, and JSON/CSV/Markdown reports. Keep it free of DOM and browser APIs. Phase 2 replay is in `retrieval-runner.ts` and `retrieval-report.ts`.
- `src/visual/video-source.ts` owns the video element, Object URL, frame callbacks, seek/load reset, and deduplication. `src/visual/source.ts` owns the procedural adapter.
- Find Canvas capture, thumbnail preparation, and the mock sink in `src/visual/`. The browser entry point is `src/main.ts`; the timeline renderer is `src/ui/timeline-view.ts`.
- Keep core, policy, timeline, rate, and benchmark tests runnable in Node.js. Keep Canvas, video, DOM, and animation scheduling in the browser layer.

## Working agreements

- Use monotonic milliseconds within a session. Evaluate each frame using the current frame and previously accepted state. Never feed video media time to sampler ordering; reset the session on seek/load/restart.
- Preserve identical source frames and budget settings across comparison branches. A mode switch should preserve both histories.
- Charge the rolling frame budget and advance the pixel baseline only after the sink accepts a frame. Keep budget accounting when the limit changes.
- Keep retained media bounded and document ownership. Clone a borrowed image before retaining it beyond capture.
- `VideoSource` owns its Object URL, media listeners, and frame-callback handles. Remove listeners and revoke URLs in `dispose()`. Cancel pending frame callbacks on pause, seek, stop, and load.
- Suppress repeated video frames in both capture modes. A seek must reset the adaptive baseline, budget state, metrics, rates, and timeline for both strategies.
- Event labels, event regions, and future frames are evaluator-only. Never pass them into a sampling policy. The benchmark runner must feed the same frames, timestamps, budget, and timing to every strategy.
- Select benchmark parameters only on the tuning suite. Report held-out evaluation results and failure cases even when a new policy loses. Recall means a frame was captured inside a labeled window, not that a model understood the event.
- Keep the replay benchmark deterministic in its inputs and decisions. Processing time is a wall-clock diagnostic and may vary.
- The context buffer owns pixel copies, never Canvas references. Enforce age, byte, and frame caps; count each eviction reason. Reset/dispose the buffer on seek, load, restart, source switch, demo restart, and page exit. Requests from another session must return `wrong-session`.
- Retrieval has its own budget and is also charged to a combined real-time + retrieval budget. A denied request consumes no budget. Do not let retrieval bypass the real-time sampler cap.
- The cue-retrieval experiment may use real system signals such as budget denial, but never event labels. The label-timed oracle is an upper bound only; label it as non-autonomous everywhere.
- Do not cache whole videos or unbounded 30 fps RGBA history. Do not implement model APIs, GPU work, a backend, or Phase 3 in this phase.
- Describe frame counts as frame counts. Document event misses and the exact timing boundaries of latency, timeline capacity, and rate windows.
- Keep visual data local by default. Build a static site with no credentials, uploads, or service dependencies.

Run `npm ci`, `npm run typecheck`, `npm run test`, `npm run benchmark`, and `npm run build` before submitting. Use `npm run preview` to verify the built page when browser automation is available. Report the checks that ran and any gaps. Submit changes on a separate branch without merging unless requested.
