# Coding agent guide

## Scope

SemanticStream is adaptive context streaming infrastructure for real-time AI agents. Phase 0 is a browser-only visual loop with a procedural source and a mock receiver. Keep changes scoped to the current phase or the requested task.

## Entry points

- Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing stream contracts, sampling, budgets, or ownership.
- Start with `src/core/sampler.ts` for the synchronous decision and delivery path.
- Find Canvas capture, thumbnail preparation, and the mock sink in `src/visual/`. The browser entry point is `src/main.ts`.
- Keep core and policy tests runnable in Node.js. Keep Canvas, DOM, and animation scheduling in the browser layer.

## Working agreements

- Use monotonic milliseconds within a session. Evaluate each frame using the current frame and previously accepted state.
- Preserve identical source frames and budget settings across comparison branches. A mode switch should preserve both histories.
- Charge the rolling frame budget and advance the pixel baseline only after the sink accepts a frame. Keep budget accounting when the limit changes.
- Keep retained media bounded and document ownership. Clone a borrowed image before retaining it beyond capture.
- Describe frame counts as frame counts. Document event misses and the exact timing boundaries of latency metrics.
- Keep visual data local by default. Build a static site with no credentials or service dependencies.

Run `npm ci`, `npm run typecheck`, `npm run test`, and `npm run build` before submitting. Use `npm run preview` to verify the built page when browser automation is available. Report the checks that ran and any gaps. Submit changes on a separate branch without merging unless requested.
