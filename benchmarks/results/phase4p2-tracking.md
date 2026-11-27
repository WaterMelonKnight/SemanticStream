# Phase 4P.2 · Synthetic object tracking benchmark

> Synthetic ObjectObservation fixtures only. These numbers are not real detector accuracy, and the moving-camera case is image-coordinate change without camera-motion compensation.

| Fixture | Frames | Raw det. | ID switches | Assoc. correct | Events (actual / expected) | Type precision | Type recall | First event ms | Suppressed ev. | Index entries | Processing ms |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| moving-object | 10 | 10 | 0 | 10/10 | 5/2 | 1.000 | 1.000 | 250 | 4 | 1 | 2.989 |
| stationary-jitter | 14 | 14 | 0 | 14/14 | 2/2 | 1.000 | 1.000 | 250 | 0 | 1 | 0.344 |
| crossing-same-category | 5 | 10 | 0 | 10/10 | 7/2 | 0.667 | 1.000 | 250 | 1 | 3 | 19.876 |
| short-occlusion | 5 | 3 | 0 | 3/3 | 4/3 | 0.750 | 1.000 | 250 | 0 | 1 | 0.074 |
| expiry-gap | 5 | 2 | 0 | 2/2 | 3/3 | 1.000 | 1.000 | 250 | 0 | 1 | 0.059 |
| low-confidence | 6 | 6 | 0 | 0/0 | 0/0 | 1.000 | 1.000 | — | 0 | 0 | 0.028 |
| irregular-intervals | 6 | 5 | 0 | 5/5 | 4/3 | 0.750 | 1.000 | 500 | 0 | 1 | 0.073 |
| skipped-vs-empty | 4 | 2 | 0 | 2/2 | 2/2 | 1.000 | 1.000 | 250 | 0 | 1 | 0.037 |
| session-switch | 4 | 4 | 0 | 4/4 | 2/1 | 1.000 | 1.000 | 250 | 0 | 1 | 0.072 |
| camera-pan-ambiguity | 8 | 8 | 0 | 8/8 | 4/2 | 1.000 | 1.000 | 300 | 3 | 1 | 0.086 |

Association correctness is evaluated only for synthetic labels. Crossing and camera-pan fixtures are deliberately ambiguous; they are not a claim of long-term identity recognition.
