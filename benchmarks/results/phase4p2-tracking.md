# Phase 4P.2 · Tracking benchmark — fixture-tuned

> Synthetic ObjectObservation fixtures only. These numbers are not real detector accuracy. Moving-camera events are image-coordinate changes without camera-motion compensation.

**Metric scope:** type precision/recall is only the set of event types present. Instance precision/recall matches each expected event by session, synthetic identity, event type and a time window; it is marked NOT_MEASURED where identity is deliberately ambiguous.

**Instance macro precision:** 0.906 · **recall:** 0.917

| Fixture | Config | Sessions | Raw det. | Assoc. correct / denominator | ID switches | Reappear switches | Type P/R | Instance P/R | FP/FN | Dup. | Mean latency ms | Index entries | Processing ms |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| moving-object | fixture-tuned | moving-object | 10 | 10/10 | 0 | 0 | 1.000/1.000 | 1.000/1.000 | 0/0 | 0 | 80 | 1 | 3.954 |
| stationary-jitter | fixture-tuned | stationary-jitter | 14 | 14/14 | 0 | 0 | 1.000/1.000 | 1.000/1.000 | 0/0 | 0 | 275 | 1 | 0.375 |
| crossing-same-category | fixture-tuned | crossing-same-category | 10 | 10/10 | 0 | 0 | 0.667/1.000 | NOT_MEASURED | — | 0 | — | 3 | 17.526 |
| short-occlusion | fixture-tuned | short-occlusion | 3 | 3/3 | 0 | 0 | 1.000/1.000 | 1.000/1.000 | 0/0 | 0 | 150 | 1 | 0.077 |
| occlusion-id-switch | fixture-tuned | occlusion-id-switch | 6 | 4/6 | 2 | 2 | 1.000/1.000 | NOT_MEASURED | — | 0 | — | 2 | 0.109 |
| expiry-gap | fixture-tuned | expiry-gap | 2 | 2/2 | 0 | 0 | 1.000/1.000 | 1.000/1.000 | 0/0 | 0 | 917 | 1 | 0.072 |
| low-confidence | fixture-tuned | low-confidence | 6 | 0/6 | 0 | 0 | 1.000/1.000 | 1.000/1.000 | 0/0 | 0 | — | 0 | 0.042 |
| irregular-intervals | fixture-tuned | irregular-intervals | 5 | 5/5 | 0 | 0 | 0.750/1.000 | 0.250/0.333 | 3/2 | 0 | 300 | 1 | 1.620 |
| skipped-vs-empty | fixture-tuned | skipped-vs-empty | 2 | 2/2 | 0 | 0 | 1.000/1.000 | 1.000/1.000 | 0/0 | 0 | 125 | 1 | 0.056 |
| session-switch | fixture-tuned | session-switch,second | 4 | 4/4 | 0 | 0 | 1.000/1.000 | 1.000/1.000 | 0/0 | 0 | 50 | 1 | 0.075 |
| camera-pan-ambiguity | fixture-tuned | camera-pan-ambiguity | 8 | 8/8 | 0 | 0 | 1.000/1.000 | NOT_MEASURED | — | 0 | — | 1 | 0.089 |

Association denominator includes every synthetic detection, including unmatched and low-confidence detections. Crossing and camera-pan identity/event instances are NOT_MEASURED, not silently treated as zero. The separate production-default run uses no fixture-tuned thresholds.

# Phase 4P.2 · Tracking benchmark — production default

> Synthetic ObjectObservation fixtures only. These numbers are not real detector accuracy. Moving-camera events are image-coordinate changes without camera-motion compensation.

**Metric scope:** type precision/recall is only the set of event types present. Instance precision/recall matches each expected event by session, synthetic identity, event type and a time window; it is marked NOT_MEASURED where identity is deliberately ambiguous.

**Instance macro precision:** 0.938 · **recall:** 0.721

| Fixture | Config | Sessions | Raw det. | Assoc. correct / denominator | ID switches | Reappear switches | Type P/R | Instance P/R | FP/FN | Dup. | Mean latency ms | Index entries | Processing ms |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| moving-object | production-default | moving-object | 10 | 10/10 | 0 | 0 | 1.000/1.000 | 1.000/0.600 | 0/2 | 0 | 67 | 1 | 0.110 |
| stationary-jitter | production-default | stationary-jitter | 14 | 14/14 | 0 | 0 | 1.000/1.000 | 1.000/1.000 | 0/0 | 0 | 900 | 1 | 0.220 |
| crossing-same-category | production-default | crossing-same-category | 10 | 10/10 | 0 | 0 | 1.000/1.000 | NOT_MEASURED | — | 0 | — | 3 | 0.128 |
| short-occlusion | production-default | short-occlusion | 3 | 3/3 | 0 | 0 | 1.000/0.333 | 1.000/0.333 | 0/2 | 0 | 50 | 1 | 0.057 |
| occlusion-id-switch | production-default | occlusion-id-switch | 6 | 4/6 | 2 | 2 | 1.000/0.333 | NOT_MEASURED | — | 0 | — | 2 | 0.070 |
| expiry-gap | production-default | expiry-gap | 2 | 2/2 | 0 | 0 | 1.000/1.000 | 1.000/1.000 | 0/0 | 0 | 1917 | 1 | 0.057 |
| low-confidence | production-default | low-confidence | 6 | 0/6 | 0 | 0 | 1.000/1.000 | 1.000/1.000 | 0/0 | 0 | — | 0 | 0.030 |
| irregular-intervals | production-default | irregular-intervals | 5 | 5/5 | 0 | 0 | 0.500/0.333 | 0.500/0.333 | 1/2 | 0 | 300 | 1 | 0.055 |
| skipped-vs-empty | production-default | skipped-vs-empty | 2 | 2/2 | 0 | 0 | 1.000/0.500 | 1.000/0.500 | 0/1 | 0 | 50 | 1 | 0.025 |
| session-switch | production-default | session-switch,second | 4 | 4/4 | 0 | 0 | 1.000/1.000 | 1.000/1.000 | 0/0 | 0 | 50 | 1 | 0.035 |
| camera-pan-ambiguity | production-default | camera-pan-ambiguity | 8 | 8/8 | 0 | 0 | 1.000/1.000 | NOT_MEASURED | — | 0 | — | 1 | 0.078 |

Association denominator includes every synthetic detection, including unmatched and low-confidence detections. Crossing and camera-pan identity/event instances are NOT_MEASURED, not silently treated as zero. The separate production-default run uses no fixture-tuned thresholds.
