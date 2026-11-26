# Visual perception — observed browser measurements

These are one-run diagnostics from headless Chromium on the development host on **2026-11-26**. They are not deterministic benchmarks, not mobile measurements, and not accuracy results.

## Environment

- Source: built page `/perception.html`, local preview server.
- Browser: Playwright headless Chromium 1.65.1; Linux development host.
- Model: MediaPipe EfficientDet-Lite0 int8, CPU delegate.
- Runtime: `@mediapipe/tasks-vision` 1.2.3; self-hosted module Wasm.
- Input: procedural demo (720 × 405 source, 320 × 320 letterboxed model input).
- Target detection rate: 3 FPS.
- No labeled data.

## Model load

| Measurement | Observed |
| --- | ---: |
| Model file downloaded | 4,602,795 bytes (4.60 MB) |
| Model + runtime load (observed runs) | ~1.6–2.7 s |
| Self-hosted module Wasm | 14,665,738 bytes |
| Bundled worker JS | 156.20 kB |

The worker reported a successful load and `INFO: Created TensorFlow Lite XNNPACK delegate for CPU.` to the console. That INFO line is emitted by MediaPipe, not by the page.

## Live detection run

Procedural source, ~4 seconds after enabling detection:

| Measurement | Observed |
| --- | ---: |
| Completed detection batches | 7–12 |
| Structured observations | 7–12 |
| Effective detection FPS | 2.96–3.03 fps |
| Inference P50 | 152–182 ms |
| Inference P95 | 304–380 ms |
| Queue drops | 0 |
| Stale results | 0 |
| Long tasks / max | 0 / — |
| 390 px horizontal overflow | 0 px |

## Two-phase scheduling comparison

The page's 2 × 8 s comparison on the procedural source, fixed 3 FPS vs change + 1.5 s periodic:

| Phase | Batches | Effective FPS | P50 | P95 | Queue drops | Stale | Long tasks | Elapsed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Fixed | 23 | 2.86 fps | 148.9 ms | 151.1 ms | 0 | 1 | 0 | 8.0 s |
| Adaptive | 6 | 0.76 fps | 149.9 ms | 160.1 ms | 0 | 0 | 0 | 7.9 s |

The adaptive phase ran on a mostly static procedural scene, so the 1.5 s periodic floor dominated. This shows scheduling behavior, not quality.

## Video/seek checks

A local 6 s WebM was loaded after model enable. Detection produced batches and observations; seeking to 3 s reset the session and detection continued; restarting reset it again. No media upload occurred.

## Not measured

- Detection accuracy, precision, recall, or any event metric: no labels.
- Real iPhone Safari or Android Chrome camera behavior.
- Thermal throttling, battery use, mobile GPU delegates, or sustained multi-minute performance.
- Total network bytes for the Wasm runtime and model under a cold HTTP cache.
