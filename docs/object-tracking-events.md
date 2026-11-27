# Phase 4P.2 — Object tracking, state index and semantic events

This phase turns the existing stateless object observations into a bounded, session-scoped tracking system. It does not train a model, call a paid API, change the inference scheduler, or claim long-term identity recognition.

## Scope and baseline

- Reuses `ObjectObservation`, its session/frame timestamps, source-pixel box, confidence and `evidence.frameRef`.
- Does **not** reuse or fabricate the separate Perception/Runtime ContextBuffers. Those pages do not share an image session, so evidence is `unavailable` unless a future resolver is explicitly attached.
- Tracking is independent of DOM, MediaPipe and the model provider; it consumes normalized structured observations.
- PR #13 camera background release and session invalidation remain in force.

## Data flow

```
ObjectObservation batch (only status: ok)
        │
        ▼
ObjectTracker (IoU + center distance + time gate + velocity prediction)
        │  tracks, state transitions, valid-empty evidence
        ▼
ObjectEventEngine (movement/stationary hysteresis, cooldown, event types)
        │
        ▼
ObjectStateIndex (bounded tracks, history, events, evidence refs)
        │
        ├── Perception Lab: track IDs, counts, timeline, history, JSON export
        └── ObjectStateReader / SemanticEventSource / EvidenceResolver (Phase 4I)
```

## Lightweight tracker

The tracker is deterministic tracking-by-detection:

- Same-category candidate association.
- Normalized IoU and normalized center-point distance.
- Time-scaled association gate; velocity prediction is optional and bounded to one second.
- Confidence floor; low-confidence detections are counted but do not create/confirm events.
- One-to-one greedy association sorted by deterministic cost/track ID/detection order.
- `TENTATIVE` → `CONFIRMED` after `confirmHits` valid observations.
- A valid empty batch can move tracks to `TEMPORARILY_LOST`, then `EXPIRED` after the time window.
- A skipped or failed detection batch **does not age or remove tracks**.
- A reappearance within the association/expiry window can return to `CONFIRMED`.
- Two same-category objects are never merged merely by category; if overlapping candidates are within the ambiguity margin, `associationUncertain` is set. No ReID/appearance model is used.

Track IDs are page/session-scoped strings such as `perception-camera-3:o1`.

## State machine

| State | Meaning |
| --- | --- |
| `TENTATIVE` | A new track with fewer than `confirmHits`. No semantic appeared event yet. |
| `CONFIRMED` | Enough valid observations; track is current. |
| `TEMPORARILY_LOST` | A valid detection batch had no match beyond the lost gate. It is not proof of removal. |
| `EXPIRED` | The time window elapsed without a valid match. It is **not** proof that the physical object was removed. |

## State index

`ObjectStateIndex` provides:

- `getTrackedObjects(filter)`
- `getObjectById(trackId)`
- `getObjectsInRegion(region)`
- `getObjectHistory(trackId, timeRange)`
- `getObjectEvents(filter)`
- `getObjectEvidence(trackId, timestamp)`
- `snapshot()`

Bounds:

- Max tracks: 100 by default.
- History per track: 80 points / 60 s.
- Event log: 400.
- History stores normalized box, timestamp, confidence, state and evidence reference only; no duplicated video frames.
- Session change resets the index. Old track IDs are not reused as new-session identities.
- Evidence lookup returns `unavailable` when no resolver/image cache is attached.

## Semantic events

Supported:

- `OBJECT_APPEARED`
- `OBJECT_MOVED`
- `OBJECT_STATIONARY`
- `OBJECT_TEMPORARILY_LOST`
- `OBJECT_REAPPEARED`
- `OBJECT_EXPIRED`
- Optional `OBJECT_ENTERED_REGION` / `OBJECT_LEFT_REGION` when a region is configured.

Each event includes `eventId`, `eventType`, `sessionId`, `trackId`, category, `observedAtMs`, previous/current state, confidence, certainty, finite reason code, evidence reference and `schemaVersion: 1`.

Rules:

- Minimum normalized movement threshold.
- Consecutive confirmation hits before `OBJECT_APPEARED`.
- Hysteresis for stationary (one event per stationary episode).
- Per track/event cooldown; suppressed duplicates are counted.
- Low-confidence detections do not create appeared/moved events.
- Missing/skipped detection cannot trigger lost/expired.
- `OBJECT_EXPIRED` reason explicitly says it is not a physical removal.

### Certainty and camera motion

There is no camera-motion compensation in Phase 4P.2. `OBJECT_MOVED` certainty is `image-coordinate-only`: it means the image box changed, not that the physical object moved. Camera pan can produce the same event. The `camera-pan-ambiguity` fixture documents this limitation.

## Perception Lab integration

- Toggle: **Track objects & semantic events**.
- Existing category/score/box columns plus stable Track ID and state.
- Active/tentative/lost/expired/event counts.
- Event timeline and selected-track history.
- Selected-track trail overlay.
- Object index JSON inspection and export.
- Tracking off returns to raw detections for comparison.
- Tracking is reset on source switch, video load/seek/restart, camera stop/ended, session invalidation and page exit/background handling.

## Resource and telemetry

- Tracking/event processing P50/P95 histograms.
- Active, tentative, lost, expired counts.
- Index entries/evictions, association failures, event log size and suppressed events.
- Per-event-type counters.
- Input batch/detection and output event counters.
- All through the existing bounded `TelemetryHub`; no track/event/session IDs are metric labels.
- No raw frames, prompts, credentials or model output are recorded.

## Deterministic benchmark

```sh
npm run benchmark:tracking
```

Synthetic ObjectObservation fixtures cover:

1. moving object;
2. stationary jitter;
3. same-category crossing;
4. short occlusion/reappearance;
5. long expiry gap;
6. low confidence;
7. irregular intervals;
8. skipped vs valid empty;
9. session switch;
10. camera pan ambiguity.

The report is written to `benchmarks/results/phase4p2-tracking.json` and `.md`. It reports track-id switches, synthetic-label association correctness, event-type precision/recall, suppressed/duplicate events, index size/evictions and CPU processing time. These are synthetic observations, **not** real detector accuracy, and the camera-pan case is intentionally image-coordinate-only.

Comparison caveat: a raw per-frame detection count is not a tracker; the benchmark reports raw detections next to tracking metrics so the extra association work is visible, but it does not claim a universal accuracy baseline.

## Phase 4I contracts

`src/perception/tracking/contracts.ts` defines:

- `ObjectStateReader` — stable read methods for a future inference scheduler.
- `SemanticEventSource` — local subscribe/unsubscribe, no global bus.
- `EvidenceResolver` — resolves structured evidence refs only when a shared image cache/session is attached.

A future Phase 4I adapter can convert `OBJECT_APPEARED`/`OBJECT_MOVED`/`OBJECT_TEMPORARILY_LOST` into inference task candidates, then use `getObjectHistory`, `getObjectsInRegion` and `getObjectEvidence` to assemble context. No DeepSeek call, model request, heterogeneous model pool or task enqueue is added in this phase.

## Limitations

- No appearance/ReID features; crossing identities can be ambiguous.
- No camera-motion compensation; image movement is not physical movement.
- No real-image evidence cache is shared between Perception Lab and Runtime Lab.
- Synthetic benchmark accuracy is not real model accuracy.
- Real-device long-run thermal/battery behavior remains separate from this functional phase.


## Benchmark snapshot (synthetic)

Latest deterministic run (`npm run benchmark:tracking`):

| Fixture | ID switches | Assoc. correct | Event type P/R | First event | Processing ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| moving-object | 0 | 10/10 | 1.000 / 1.000 | 250 ms | ~2–3 |
| stationary-jitter | 0 | 14/14 | 1.000 / 1.000 | 250 ms | <1 |
| crossing-same-category | 0 | 10/10 | 0.667 / 1.000 | 250 ms | ~20 |
| short-occlusion | 0 | 3/3 | 0.750 / 1.000 | 250 ms | <1 |
| expiry-gap | 0 | 2/2 | 1.000 / 1.000 | 250 ms | <1 |
| low-confidence | 0 | 0/0 | 1.000 / 1.000 | — | <1 |
| irregular-intervals | 0 | 5/5 | 0.750 / 1.000 | 500 ms | <1 |
| skipped-vs-empty | 0 | 2/2 | 1.000 / 1.000 | 250 ms | <1 |
| session-switch | 0 | 4/4 | 1.000 / 1.000 | 250 ms | <1 |
| camera-pan-ambiguity | 0 | 8/8 | 1.000 / 1.000 | 300 ms | <1 |

Processing time is wall-clock and varies. Crossing/camera-pan fixtures are deliberately ambiguous and are not identity-accuracy claims.

## Real-device observation

Preview `https://f6f000f0.semanticstream.pages.dev` on a Redmi 22081212C / Android 14 / Xiaomi Browser 135.0.7049.79:

- Stable tracks for a static scene: two active tracks retained 220+ observations with stable IDs.
- Real image-space events observed: `OBJECT_APPEARED`, `OBJECT_MOVED` (`image-coordinate-only`), `OBJECT_STATIONARY`, `OBJECT_TEMPORARILY_LOST`, `OBJECT_EXPIRED`.
- The ad-hoc hand-occlusion attempt produced temporary loss/expiry but did **not** produce a confirmed `OBJECT_REAPPEARED`; reliable real-device reappearance remains **NOT_TESTED**.
- Object-index JSON export produced a bounded 24.2 KB snapshot. Tracking processing P50/P95 was ~0.1 ms and event processing ~0.0/0.1 ms on this device.
- Backgrounding released the camera and required manual restart. The page reported long tasks from the existing inference/UI workload; tracking processing itself was sub-millisecond. No thermal/power measurement is claimed.
