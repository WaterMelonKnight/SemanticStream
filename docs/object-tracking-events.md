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
- Two same-category objects are never merged merely by category; if overlapping candidates are within the ambiguity margin, `associationUncertain` is set. This is **not** model confidence, and no ReID/appearance model is used.

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


## Core-review fixes (P1/P2)

- State index eviction now removes the matching history; entries are evicted expired-first, then lost/tentative, then confirmed.
- Expired tracks are ingested once, not every batch. Expiry transitions are emitted once and tracker no longer retains an unbounded expired array.
- Event-engine cooldown/box/movement/stationary/confirmed state is removed on expiry, capped by `maxStateTracks`, and cleaned by TTL. A 10,000-track churn test asserts tracker, index, history, event-log and event-state bounds.
- Event time semantics:
  - `lastSeenAtMs` is capture time.
  - `lastObservationAtMs` is detection-completion time.
  - `stateChangedAtMs`/`confirmedAtMs` record state transitions.
  - lost/expired/event timestamps use the confirming batch completion time, not `lastSeenAtMs`.
  - `OBJECT_EXPIRED` carries the exact previous state (for example `CONFIRMED` or `TEMPORARILY_LOST`).
- Session switches require explicit reset; late wrong-session batches are rejected. Duplicate frame sequences, non-monotonic capture/completion times, invalid observations, boxes, scores and timestamps are rejected without aging tracks.
- TENTATIVE tracks cannot emit `OBJECT_REAPPEARED`.
- Evidence lookup never returns a future history point and distinguishes `available`, `unavailable`, `expired` and `wrong-session`.
- `associationUncertain` is documented and carried on events as an association diagnostic, never as model confidence.

## Benchmark snapshot (synthetic, v2)

`npm run benchmark:tracking` runs both **fixture-tuned** and **production-default** configurations. The report distinguishes:

- **Type P/R** — only the set of event types present.
- **Instance P/R** — one-to-one matching by session, synthetic label, event type and a time window; FP/FN, duplicate events and mean latency are reported.
- Fixtures where identity is deliberately ambiguous are marked **NOT_MEASURED**, not scored as zero.

Latest fixture-tuned result: instance macro precision `0.906`, recall `0.917`. Latest production-default result: precision `0.938`, recall `0.721`. The default configuration intentionally misses low-frequency short occlusions; that is reported as a miss, not hidden.

Notable rows:

| Fixture | Association correct / all detections | Reappearance switches | Instance P/R |
| --- | ---: | ---: | --- |
| moving-object | 10/10 | 0 | 1.000/1.000 tuned; 1.000/0.600 default |
| short-occlusion | 3/3 | 0 | 1.000/1.000 tuned; 1.000/0.333 default |
| occlusion-id-switch | 4/6 | 2 | NOT_MEASURED |
| low-confidence | 0/6 | 0 | 1.000/1.000 (no object event) |
| skipped-vs-empty | 2/2 | 0 | 1.000/1.000 tuned; 1.000/0.500 default |
| crossing-same-category | 10/10 | 0 | NOT_MEASURED |
| camera-pan-ambiguity | 8/8 | 0 | NOT_MEASURED |

Association denominator includes every detection, including unmatched and low-confidence observations. Processing time is wall-clock only.

## Real-device observation

Preview `https://cdf5ad87.semanticstream.pages.dev` (review-fix build, commit `037656a`) on a Redmi 22081212C / Android 14 / Xiaomi Browser 135.0.7049.79. The earlier pre-review build was `c8aa861a`.

- Pre-review build: stable tracks for a static scene retained 220+ observations with stable IDs; real image-space events included `OBJECT_APPEARED` 6, `OBJECT_MOVED` 15, `OBJECT_STATIONARY` 8, `OBJECT_TEMPORARILY_LOST` 4, `OBJECT_EXPIRED` 4.
- Review-fix build: the page exercised 75 received/accepted detection batches, one active track (`perception-camera-2:o1`) and two events (`OBJECT_APPEARED`, `OBJECT_STATIONARY`); tracking status stayed `ok`. This was a brief regression, not a new long-run performance test.
- The ad-hoc hand-occlusion attempt on the pre-review build produced temporary loss/expiry but no confirmed `OBJECT_REAPPEARED`; real-device reappearance remains **NOT_TESTED**. The review-fix category-id issue was found during this regression: MediaPipe can return an opaque non-default category index; the worker now normalizes it and the tracker accepts opaque safe-integer category ids.
- Object-index JSON export produced a bounded 24.2 KB snapshot.
- Tracking processing P50/P95 was ~0.1 ms; event processing ~0.0/0.1 ms.
- Backgrounding released the camera and required manual restart. Page long tasks came from the existing inference/UI workload; no controlled tracking-on/off delta was measured.
- Latest review fixes: `npm ci`, typecheck, 208 serialized tests, all benchmarks and build pass; CI push/PR success for `037656a`. No full long-run performance repeat.

## Phase 4I integration

The Agent attaches the real shared image cache through the existing evidence resolver contract. Category association is namespaced. Batches and observations use identical frame identity and timing. Historic lookup separates state-known time from the evidence capture time. [Integrated contracts](integrated-agent-runtime.md)
