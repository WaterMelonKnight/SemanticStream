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

1. Add a bounded raw-frame buffer with age and byte limits, explicit frame ownership, and eviction.
2. Support retrieval by time range or sequence, including unavailable ranges and eviction reasons.
3. Let the agent request omitted context actively instead of relying only on the live sampler.
4. Evaluate retrieval recall and latency against the Phase 1B event labels and budget.
5. Keep the buffer local and bounded; no backend or model API is required for the core path.

## Later · Sources and sinks

- Add opt-in browser visual sources beyond local files, with explicit permission handling.
- Evaluate asynchronous sinks, tighter resource budgets, and bounded delivery under backpressure.
- Validate the existing abstractions against a concrete log, audio, or sensor source before generalizing them.
