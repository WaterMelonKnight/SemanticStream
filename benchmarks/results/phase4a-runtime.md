# Phase 4A · Duplex runtime simulation

Deterministic scripted inference. These timings do not measure LLM performance.

Every run replays the same 23 task requests and scripted timings. Capacity-matched comparisons use FIFO and
SemanticStream at either slot count. Within each policy, the one-slot and two-slot runs isolate concurrency.
All runs use a three-place pending queue, three dispatches / 360 bytes per 500 ms, and a simulated cumulative
320-token cap with a 32-token reservation per attempt. Sample payloads are synthetic text.

| Strategy | Start P50/P95 ms | First output P50/P95 ms | Deadline expiries | Leaks / blocked | Peak slots / queue | Invalid started | Bytes dispatched | Settled / provisional tokens | Critical alert start / output ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Serial FIFO | 5 / 747 (n=12) | 105 / 847 (n=12) | 4/23 (17.4%) | 0 / 2 | 1 / 3 | 3/12 (25.0%) | 416 | 42 / 32 | miss / miss |
| Concurrent FIFO | 0 / 380 (n=12) | 100 / 480 (n=11) | 2/23 (8.7%) | 0 / 5 | 2 / 3 | 4/12 (33.3%) | 388 | 38 / 32 | miss / miss |
| SemanticStream | 0 / 245 (n=11) | 100 / 345 (n=10) | 2/23 (8.7%) | 0 / 4 | 2 / 3 | 3/11 (27.3%) | 368 | 36 / 32 | 0 / 20 |
| SemanticStream single-slot | 5 / 748 (n=11) | 105 / 848 (n=11) | 3/23 (13.0%) | 0 / 2 | 1 / 3 | 2/11 (18.2%) | 393 | 40 / 32 | miss / miss |

Latency starts at event ingest. Percentiles use nearest rank and include only measured starts or first authorized
partials respectively. JSON includes per-event latencies and misses. Deadline rate counts logical expiry over all requests.
Queue peak counts waiting work after immediate dispatch. Invalid inference means a dispatched attempt either failed to
complete logically or had no authorized output. Leaks count partials published after logical termination, at or after a deadline,
or after a newer writer claimed the same channel. Blocked partials count attempted writes denied by the runtime.

## Failures and policy omissions

### Serial FIFO

- #5 Pixel noise · rejected · Queue full
- #6 Pixel noise · rejected · Queue full
- #7 Pixel noise · rejected · Queue full
- #8 Pixel noise · rejected · Queue full
- #9 Critical alert · rejected · Queue full
- #10 Short deadline · rejected · Queue full
- #2 Pixel noise · expired · Deadline expired
- #3 Pixel noise · expired · Deadline expired
- #4 Pixel noise · expired · Deadline expired
- #13 Ignores cancellation · invalidated · Channel superseded
- #14 Depends on superseded parent · invalidated · Dependency did not complete
- #16 Late terminal · expired · Deadline expired
- #18 Scripted failure · failed · Scripted provider error
- #23 Transfer burst E · rejected · Queue full

### Concurrent FIFO

- #6 Pixel noise · rejected · Queue full
- #7 Pixel noise · rejected · Queue full
- #8 Pixel noise · rejected · Queue full
- #9 Critical alert · rejected · Queue full
- #10 Short deadline · rejected · Queue full
- #4 Pixel noise · rejected · Rolling request/byte budget exhausted
- #5 Pixel noise · rejected · Rolling request/byte budget exhausted
- #3 Pixel noise · expired · Deadline expired
- #13 Ignores cancellation · invalidated · Channel superseded
- #14 Depends on superseded parent · invalidated · Dependency did not complete
- #16 Late terminal · expired · Deadline expired
- #17 Independent task during cancellation · rejected · Rolling request/byte budget exhausted
- #18 Scripted failure · failed · Scripted provider error
- #22 Transfer burst D · rejected · Rolling request/byte budget exhausted
- #23 Transfer burst E · rejected · Rolling request/byte budget exhausted

### SemanticStream

- #2 Pixel noise · rejected · Repeated event coalesced
- #3 Pixel noise · rejected · Repeated event coalesced
- #4 Pixel noise · rejected · Repeated event coalesced
- #5 Pixel noise · rejected · Repeated event coalesced
- #6 Pixel noise · rejected · Repeated event coalesced
- #7 Pixel noise · rejected · Repeated event coalesced
- #8 Pixel noise · rejected · Repeated event coalesced
- #10 Short deadline · expired · Deadline expired
- #13 Ignores cancellation · invalidated · Channel superseded
- #14 Depends on superseded parent · invalidated · Dependency did not complete
- #16 Late terminal · expired · Deadline expired
- #17 Independent task during cancellation · rejected · Rolling request/byte budget exhausted
- #18 Scripted failure · failed · Scripted provider error
- #21 Transfer burst C · rejected · Rolling request/byte budget exhausted
- #22 Transfer burst D · rejected · Rolling request/byte budget exhausted

### SemanticStream single-slot

- #2 Pixel noise · rejected · Repeated event coalesced
- #3 Pixel noise · rejected · Repeated event coalesced
- #4 Pixel noise · rejected · Repeated event coalesced
- #5 Pixel noise · rejected · Repeated event coalesced
- #6 Pixel noise · rejected · Repeated event coalesced
- #7 Pixel noise · rejected · Repeated event coalesced
- #8 Pixel noise · rejected · Repeated event coalesced
- #10 Short deadline · expired · Deadline expired
- #9 Critical alert · expired · Deadline expired
- #13 Ignores cancellation · invalidated · Channel superseded
- #14 Depends on superseded parent · invalidated · Dependency did not complete
- #16 Late terminal · expired · Deadline expired
- #18 Scripted failure · failed · Scripted provider error
- #22 Transfer burst D · invalidated · Displaced by higher priority
