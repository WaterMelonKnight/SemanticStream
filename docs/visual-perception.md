# Phase 4P.1 — Lightweight visual perception

This is an independent browser experiment. It does not refactor the Phase 4A inference scheduler, the `DecisionProvider` boundary, or the runtime lab.

## Goal

Test whether a real browser-side object detector can turn a live visual source into structured observations while keeping the UI responsive:

- MediaPipe Object Detector + EfficientDet-Lite0 int8 is the first implementation.
- The model is **off by default**. The user must click **Enable model**.
- Camera and local-video input reuse the existing `CameraSource` and `VideoSource` adapters.
- Inference runs in a module Web Worker. The main thread only prepares a bounded input and draws results.
- Detection input is a **320 × 320 letterboxed** frame. It is not the existing 96 × 54 sampler thumbnail.
- The detector is behind a model-agnostic `ObjectDetectorProvider` interface.
- No video, frame, or observation image is uploaded. No paid API, account, backend, database, or training is used.

Open `/perception.html` after `npm run dev` or a build.

## Architecture

```
CameraSource / VideoSource / ProceduralSource
                │  borrowed 720 × 405 feed canvas
                ▼
      64 × 36 change probe ──► DetectionTrigger
                │                 fixed interval OR
                │                 change OR periodic floor
                ▼
      320 × 320 letterbox canvas
                │ ImageData (transferable)
                ▼
      one in-flight request + one latest pending request
                │
                ▼
      MediaPipe Web Worker ──► ObjectDetector (TFLite int8, CPU)
                │ detections + inferenceMs
                ▼
      source-pixel box mapping
                │
                ▼
      ObjectObservation[] ──► overlay + bounded table
```

### Provider boundary

`src/perception/provider.ts` defines:

```ts
interface ObjectDetectorProvider {
  id: string;
  version: string;
  load(spec, events?): Promise<{loadMs, modelBytes}>;
  detect(request, pixels): Promise<DetectionResponse>;
  dispose(): void;
}
```

`MediaPipeObjectDetectorProvider` owns a `Worker` and implements the interface. A future ONNX Runtime Web provider can implement the same `load`/`detect`/`dispose` contract without changing source adapters, the queue, observation mapping, or the benchmark. The provider receives only the model input and detection request; it cannot access the source, DOM, budgets, or session lifecycle.

### Bounded work

- Main-thread queue: **one in-flight** request plus **one latest pending** request. A newer pending request replaces the older pending one; the replacement is counted as a queue drop.
- A frame is prepared only after the trigger accepts it. Captured frames are never accumulated without a bound.
- The worker processes one `detect` call at a time. The main thread never sends a second request while one is in flight.
- The worker is terminated on explicit unload and non-bfcache page exit. A late result is rejected by request ID and session ID.

### Trigger

- **Fixed**: submit at `1000 / targetFps`, target 2–5 FPS.
- **Adaptive**: submit when the 64 × 36 change probe is above the configured threshold and the minimum interval has elapsed, **or** when the periodic floor elapses. It never relies solely on frame difference.
- Fixed and adaptive both use the same FPS clamp and the same one-in-flight queue.
- Detection frequency is independent of the source capture rate (typically 30 FPS).

### Model input and box mapping

The 720 × 405 feed is letterboxed into 320 × 320. `SourceTransform` records scale and offsets. Detector boxes are mapped back to source-canvas pixels and clamped to the frame. The observation carries both the source-pixel box and the input transform so a later consumer can reproduce the mapping.

## ObjectObservation

`src/perception/types.ts` defines a stateless observation:

- `sessionId`, `frameSequence`;
- `capturedAtMs`, `submittedAtMs`, `completedAtMs`;
- `detectorId`, `modelVersion`;
- `categoryId`, `categoryName`, `score`;
- source-pixel `box`;
- `evidence`: source kind, frame sequence/time, `frameRef`, and model-input transform.

The browser keeps at most 60 rows for display. It does not retain source frames or object crops for the table. `evidence.frameRef` is an ownership-free reference, not a pixel copy.

## Lifecycle

| Event | Action |
| --- | --- |
| Source switch | Stop old source, invalidate the session, clear pending work and observations, start a new session. |
| Video load | `VideoSource` resets; a new session ID is created. |
| Video seek/restart | `VideoSource.onSessionReset` creates a new session; late results are ignored. |
| Camera stop/ended | Dispose camera, invalidate session, clear overlay/table. |
| Model unload | Dispose worker, reject/ignore outstanding work, keep the source preview running. |
| Worker load failure | Show a retryable error; source and UI remain usable; no main-thread fallback (which would block the UI). |
| Page exit | Dispose worker, source, timers, and long-task observer unless the page is entering bfcache. |
| bfcache restore | The current worker/session is retained; controls refresh. |

## Metrics

Reported live and in the two-phase comparison:

- Download/load: actual downloaded model bytes and wall-clock load time.
- Inference P50/P95: worker `inferenceMs` samples.
- Detection batches and observation count.
- Effective detection FPS: completed batches / elapsed session time.
- Queue drops: pending replacement; not-ready skips during load.
- Stale results: results rejected by session/request identity.
- Long tasks: `PerformanceObserver('longtask')` count and max duration, where supported.
- Source FPS is shown separately from detection FPS.

**No accuracy, precision, recall, or event-recall metrics are reported.** No labeled dataset is used. The procedural scene and local test video are not ground-truth benchmarks.

### Fixed vs adaptive comparison

The page runs eight seconds fixed and eight seconds adaptive, sequentially. Local video restarts before each phase; camera and procedural phases are not the same clip. It reports batches, effective FPS, P50/P95, queue drops, stale results, long tasks, and elapsed time. It explicitly states that this is not an accuracy comparison.

## Future object state design

This phase emits stateless observations only. A future layer could:

1. Assign short-lived track IDs by matching category and box intersection/IoU across observations.
2. Maintain a bounded `ObjectStateIndex` keyed by session and track ID, with last-seen timestamp and state.
3. Emit `OBJECT_APPEARED`, `OBJECT_MOVED`, and `OBJECT_DISAPPEARED` after a confirmation/debounce window (for example, two observations or a minimum age).
4. Expose state transitions as evidence references, not raw frames, with the same session/sequence contract.
5. Keep tracking and event emission out of the detector provider; the provider remains stateless.

No tracking or event emission is implemented in Phase 4P.1.

## Failure modes and limits

- The model is COCO-trained and may miss small, occluded, low-contrast, or non-COCO objects. No accuracy is claimed.
- CPU/Wasm inference latency depends on device, browser, thermal state, and load. The observed load/latency numbers are diagnostic.
- A worker or Wasm-unavailable browser keeps the preview but cannot detect.
- The MediaPipe runtime uses Wasm and may need `wasm-unsafe-eval` in a strict CSP.
- The model is fetched from the official Google Storage URL on enable. Media itself never leaves the browser.
- Camera needs HTTPS or localhost and explicit permission.
- No iPhone or Android real-device test was performed in this environment. Only headless Chromium on the development host was exercised. Camera permission and mobile thermal behavior remain untested.
- The 96 × 54 history buffer from earlier phases is not the detection input.

## Verification

- Unit tests cover geometry, the trigger, the bounded queue, and metrics.
- Typecheck and the production build include the perception page and worker.
- Browser verification covers model load, source input, detection batches, video seek/restart, live metrics, two-phase benchmark, model unload, and a 390 px viewport.
