# Roadmap

## Phase 0 · Foundation

- Ship a local procedural visual source, fixed and adaptive policies, strict rolling frame limits, a mock agent, and a live side-by-side comparison.
- Keep policy tests in Node.js and run a static build in CI.

## Phase 1 · Event evaluation and bounded retrieval

1. Add labeled visual fixtures and deterministic replay. Measure brief-event recall and time to detection at the same budget, including under capture stalls.
2. Implement a bounded raw-frame buffer with age and byte limits, explicit frame ownership, and retrieval by time range or sequence. Make eviction and unavailable ranges visible to the caller.
3. Evaluate local-region change against the mean RGB baseline using the same fixtures and delivery budget.

## Later · Sources and sinks

- Add opt-in browser visual sources and explicit permission handling.
- Evaluate asynchronous sinks, tighter resource budgets, and bounded delivery under backpressure.
- Validate the existing abstractions against a concrete log, audio, or sensor source before generalizing them.
