# Roadmap

## Phase 0 · Foundation

- Ship a local procedural visual source, fixed and adaptive policies, strict rolling frame limits, a mock agent, and a live side-by-side comparison.
- Keep policy tests in Node.js and run a static build in CI.

## Phase 1A · Real visual input

- Add a local browser video adapter (`HTMLVideoElement` → Canvas) behind the existing `StreamSource` contract, with `requestVideoFrameCallback` and an animation-frame fallback.
- Support play, pause, restart, seek, file switching, and return to the built-in procedural demo without leaking listeners or Object URLs.
- Reset the sampling session on load, seek, and restart while keeping monotonic sampler timestamps separate from video media time.
- Add bounded frame-decision timeline, input/sent rate meters, per-reason filtered counts, and the fixed-vs-adaptive delivery difference to the dashboard.
- Cover video switching, pause/resume, seek reset, duplicate-frame suppression, resource release, budget limits, shared input sequences, and bounded timeline storage.

## Phase 1B · Event evaluation and bounded retrieval

1. Add labeled visual fixtures and deterministic replay for both procedural and video-derived frames. Measure brief-event recall and time to detection at the same budget, including under capture stalls.
2. Implement a bounded raw-frame buffer with age and byte limits, explicit frame ownership, and retrieval by time range or sequence. Make eviction and unavailable ranges visible to the caller.
3. Evaluate local-region change against the mean RGB baseline using the same fixtures and delivery budget.

## Later · Sources and sinks

- Add opt-in browser visual sources beyond local files, with explicit permission handling.
- Evaluate asynchronous sinks, tighter resource budgets, and bounded delivery under backpressure.
- Validate the existing abstractions against a concrete log, audio, or sensor source before generalizing them.
