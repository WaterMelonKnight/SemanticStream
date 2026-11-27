# Phase 4I · Integrated Agent replay

Deterministic simulation using fixture detections, a logical clock and a scripted provider. Actual cost is unavailable.
All modes use the same capture sequence, detector, two logical slots and hard budgets. A uses all eligible events and FIFO.
B uses task-aware filtering and FIFO. SemanticStream uses the same filtering as B with context-aware scheduling.

| Mode | Authorized coverage | False positives | Misses | Unanswered tasks | Calls | Context bytes | Mock tokens | P50/P95 ms | Budget violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all-eligible-fifo | 9/12 | 4 | 3 | 9 | 21 | 9277 | 228 | 190/1190 | 0 |
| task-aware-fifo | 9/12 | 0 | 3 | 4 | 16 | 6895 | 168 | 190/1190 | 0 |
| semanticstream | 10/12 | 0 | 2 | 4 | 16 | 7086 | 168 | 190/1025 | 0 |

Coverage is the share of expected fixture events that receive at least one authorized partial. The replay does not score answer correctness.
Misses count unanswered expected opportunities, including policy suppression. Unanswered tasks count offered tasks with no effective output.
Latency includes only observed output. Mock tokens are simulated usage and cannot establish real cost savings. JSON includes case outcomes, suppression and stale blocks.
