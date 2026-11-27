# Phase 4P.2 · Tracking benchmark — fixture-tuned

> Synthetic ObjectObservation fixtures only. These numbers are not real detector accuracy. Moving-camera events are image-coordinate changes without camera-motion compensation.

**Metric scope:** type precision/recall is only the set of event types present. Instance precision/recall matches each expected event by session, synthetic identity, event type and a time window; it is marked NOT_MEASURED where identity is deliberately ambiguous.

**Instance macro precision:** 0.906 · **recall:** 0.917

| Fixture | Config | Sessions | Raw det. | Assoc. correct / denominator | ID switches | Reappear switches | Type P/R | Instance P/R | FP/FN | Dup. | Mean latency ms | Index entries | Processing ms |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| moving-object | fixture-tuned | moving-object | 10 | 10/10 | 0 | 0 | 1.000/1.000 | 1.000/1.000 | 0/0 | 0 | 80 | 1 | 2.943 |
| stationary-jitter | fixture-tuned | stationary-jitter | 14 | 14/14 | 0 | 0 | 1.000/1.000 | 1.000/1.000 | 0/0 | 0 | 275 | 1 | 0.519 |
| crossing-same-category | fixture-tuned | crossing-same-category | 10 | 10/10 | 0 | 0 | 0.667/1.000 | NOT_MEASURED | — | 0 | — | 3 | 21.281 |
| short-occlusion | fixture-tuned | short-occlusion | 3 | 3/3 | 0 | 0 | 1.000/1.000 | 1.000/1.000 | 0/0 | 0 | 150 | 1 | 0.109 |
| occlusion-id-switch | fixture-tuned | occlusion-id-switch | 6 | 4/6 | 2 | 2 | 1.000/1.000 | NOT_MEASURED | — | 0 | — | 2 | 0.140 |
| expiry-gap | fixture-tuned | expiry-gap | 2 | 2/2 | 0 | 0 | 1.000/1.000 | 1.000/1.000 | 0/0 | 0 | 917 | 1 | 0.104 |
| low-confidence | fixture-tuned | low-confidence | 6 | 0/6 | 0 | 0 | 1.000/1.000 | 1.000/1.000 | 0/0 | 0 | — | 0 | 0.051 |
| irregular-intervals | fixture-tuned | irregular-intervals | 5 | 5/5 | 0 | 0 | 0.750/1.000 | 0.250/0.333 | 3/2 | 0 | 300 | 1 | 0.086 |
| skipped-vs-empty | fixture-tuned | skipped-vs-empty | 2 | 2/2 | 0 | 0 | 1.000/1.000 | 1.000/1.000 | 0/0 | 0 | 125 | 1 | 0.054 |
| session-switch | fixture-tuned | session-switch,second | 4 | 4/4 | 0 | 0 | 1.000/1.000 | 1.000/1.000 | 0/0 | 0 | 50 | 1 | 0.071 |
| camera-pan-ambiguity | fixture-tuned | camera-pan-ambiguity | 8 | 8/8 | 0 | 0 | 1.000/1.000 | NOT_MEASURED | — | 0 | — | 1 | 0.108 |

Association denominator includes every synthetic detection, including unmatched and low-confidence detections. Crossing and camera-pan identity/event instances are NOT_MEASURED, not silently treated as zero. The separate production-default run uses no fixture-tuned thresholds.

# Phase 4P.2 · Tracking benchmark — production default

> Synthetic ObjectObservation fixtures only. These numbers are not real detector accuracy. Moving-camera events are image-coordinate changes without camera-motion compensation.

**Metric scope:** type precision/recall is only the set of event types present. Instance precision/recall matches each expected event by session, synthetic identity, event type and a time window; it is marked NOT_MEASURED where identity is deliberately ambiguous.

**Instance macro precision:** 0.938 · **recall:** 0.721

| Fixture | Config | Sessions | Raw det. | Assoc. correct / denominator | ID switches | Reappear switches | Type P/R | Instance P/R | FP/FN | Dup. | Mean latency ms | Index entries | Processing ms |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| moving-object | production-default | moving-object | 10 | 10/10 | 0 | 0 | 1.000/1.000 | 1.000/0.600 | 0/2 | 0 | 67 | 1 | 0.130 |
| stationary-jitter | production-default | stationary-jitter | 14 | 14/14 | 0 | 0 | 1.000/1.000 | 1.000/1.000 | 0/0 | 0 | 900 | 1 | 0.313 |
| crossing-same-category | production-default | crossing-same-category | 10 | 10/10 | 0 | 0 | 1.000/1.000 | NOT_MEASURED | — | 0 | — | 3 | 0.337 |
| short-occlusion | production-default | short-occlusion | 3 | 3/3 | 0 | 0 | 1.000/0.333 | 1.000/0.333 | 0/2 | 0 | 50 | 1 | 0.087 |
| occlusion-id-switch | production-default | occlusion-id-switch | 6 | 4/6 | 2 | 2 | 1.000/0.333 | NOT_MEASURED | — | 0 | — | 2 | 0.122 |
| expiry-gap | production-default | expiry-gap | 2 | 2/2 | 0 | 0 | 1.000/1.000 | 1.000/1.000 | 0/0 | 0 | 1917 | 1 | 0.071 |
| low-confidence | production-default | low-confidence | 6 | 0/6 | 0 | 0 | 1.000/1.000 | 1.000/1.000 | 0/0 | 0 | — | 0 | 0.051 |
| irregular-intervals | production-default | irregular-intervals | 5 | 5/5 | 0 | 0 | 0.500/0.333 | 0.500/0.333 | 1/2 | 0 | 300 | 1 | 0.085 |
| skipped-vs-empty | production-default | skipped-vs-empty | 2 | 2/2 | 0 | 0 | 1.000/0.500 | 1.000/0.500 | 0/1 | 0 | 50 | 1 | 0.035 |
| session-switch | production-default | session-switch,second | 4 | 4/4 | 0 | 0 | 1.000/1.000 | 1.000/1.000 | 0/0 | 0 | 50 | 1 | 0.061 |
| camera-pan-ambiguity | production-default | camera-pan-ambiguity | 8 | 8/8 | 0 | 0 | 1.000/1.000 | NOT_MEASURED | — | 0 | — | 1 | 0.096 |

Association denominator includes every synthetic detection, including unmatched and low-confidence detections. Crossing and camera-pan identity/event instances are NOT_MEASURED, not silently treated as zero. The separate production-default run uses no fixture-tuned thresholds.
