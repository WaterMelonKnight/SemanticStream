# Phase 3R architecture audit

## Baseline

Audited main at `1e0602a` (merge of PR #6) with Node 24.22.3. A clean install, typecheck, all 100 tests across 22 files, the three benchmarks and the Vite production build passed.

| Held-out replay | Baseline results |
| --- | --- |
| Phase 1B, six scenes | Fixed/global/local/hybrid sent 139/45/53/56 frames and covered 8/3/8/8 of 9 observable events. Tuning chose 2.5% and 8×8 blocks. |
| Phase 2, six scenes | Fixed/local/cue/oracle sent 139/53/53/53 real-time frames and 0/0/5/9 retrieval frames. Post-retrieval coverage was 8/8/9/9 of 9. Tuning chose 500 ms. |
| Phase 3A, nine scenes | Fixed/local/cue/task sent 211/113/113/77 real-time frames and 0/0/16/22 retrieval frames. Post-retrieval coverage was 17/16/18/17 of 18. |

All reported baseline violation counts were zero. Wall-clock processing, provider and retrieval timings vary. Zero violations in the historical fixtures do not validate the time field used by the independent audit.

## Runtime paths inspected

The browser's procedural animation callback or video frame callback enters `src/main.ts` through `onFrame`. `src/app/sampling-session.ts` reads a thumbnail once and calls both synchronous samplers. In `src/core/sampler.ts`, first-frame and silence refresh can bypass the candidate policy, followed by minimum spacing, admission and the Canvas sink. The browser then computes decision features and starts an asynchronous preview before inserting the current thumbnail into the context buffer. Timeline clicks use a session-scoped retrieval service and region clicks request a second, separately charged crop. Video load, native/programmatic seek, restart and source switch recreate the comparison state. The buffer owns its pixel copies.

Phase 1B replays directly through the sampler; Phase 2 offers each frame before sampling and optionally retrieves on a budget cue or an explicitly label-driven oracle. Phase 3A baselines reuse Phase 2, while the task policy offers the current frame, awaits its rule decision and executes effects before sampling. No production path uses future frames or evaluator labels. The Phase 2 oracle uses event midpoint labels and queries only after replay reaches the midpoint.

## Findings

| Classification | Severity | Source, reproduction and proposed fix |
| --- | --- | --- |
| Confirmed bug | High | `src/decision/engine.ts`, `DecisionScheduler.evaluate`: call twice before either promise resolves, complete the second first, then resolve the first. Startup calls overlap even within the interval and late writes win. Admit one active evaluation per scope, suppress obsolete writes and expose observation/request provenance. |
| Confirmed bug | High | `src/main.ts`, `resetTaskPreview` and `updateLiveDecision`: start a delayed decision, reset or edit a custom ROI, then resolve the old result. The old closure checks only task ID and clears the current pending bit. Use a session lifetime, task revision, cancellation and result applicability checks. |
| Confirmed bug | High | `src/decision/engine.ts`, `DecisionEngine.decide`: time out the primary and inspect the fallback signal. It inherits an aborted signal, has no deadline and its result is unvalidated. Supply a fresh deadline and signal to each attempt, validate complete results and use a built-in WAIT for failed fallback. |
| Reproducible risk | High | `src/decision/engine.ts`: repeatedly time out an adapter whose promises never settle. A race bounds the caller, while unresolved provider work accumulates. Bound unsettled calls per provider instance and degrade immediately when saturated. JavaScript cannot forcibly stop adapter work. |
| Confirmed bug | High | `src/core/resource-budget.ts`, `record`: lower an eight-frame ledger to one, then account for another already accepted frame. The truncation silently drops valid spend. Backward times also break FIFO expiration. Remove truncation, admit all production work through atomic reservations, require finite monotonic accounting time and keep increasing-window changes out of the contract. |
| Reproducible risk | High | `src/core/sampler.ts`, `src/core/resource-admission.ts`: both checks and writes are separate. Two callers can observe the same remaining capacity, including via an asynchronous or reentrant sink. Reserve both sub-budget and total before invoking effects; commit on acceptance, release on decline/throw. The original path is synchronous, so ordinary non-reentrant effects do not race. |
| Confirmed bug | High | `src/benchmark/retrieval-runner.ts` and `src/benchmark/task-runner.ts`: retrieved frame timestamps drive audits and capture-based metrics are described as delivery. Retrieve a frame captured near 0 at 4,999 ms, then another at 5,000 ms. A capture-time audit can expire the earlier delivery almost a full window too early. Record delivery time separately and add deadline/latency metrics. |
| Confirmed bug | Medium | `src/benchmark/task-runner.ts`: a region delivery is evaluated like a full frame. Deliver a crop outside the annotated event on the same frame. It still counts as coverage. Require overlap with delivered pixels for spatial coverage and report temporal evidence availability separately. |
| Confirmed bug | Medium | `src/core/active-retrieval.ts`: successful response budget is captured before spending, and clock reads differ between check and record. Compare a successful response's budget with the service stats at the same tick. Use one completion/accounting timestamp and return a post-commit snapshot. |
| Confirmed bug | Medium | `src/main.ts`, `onFrame`: the decision snapshot excludes the input that supplied its features. Insert the current thumbnail before observing it so feature, cache and observation provenance agree. |
| Reproducible risk | Medium | Adaptive live and Phase 2/3 replay currently enter two real-time frame caps. Totals are charged once on the normal path, so this is redundant enforcement rather than a demonstrated double charge. The unused direct real-time recording entry point can introduce duplicate charges. Route each branch through exactly one admission path. Fixed live remains an independent comparison. |
| Confirmed bug | Medium | `src/main.ts`, timeline click handler: once the ring fills, advance it between paints and click an on-screen column. The handler used the newest ring index and could retrieve a different frame. Resolve clicks against the last drawn timeline snapshot. |
| Future design concern | Medium | Task sends have different lifetimes in browser and replay. Replay treats ESCALATE as a historical lookup, and preview currently uses normal frame delivery. Make these mappings explicit, keep cadence/first-frame rules as deterministic policy and reserve real escalation for an inference integration. |
| Future design concern | Low | Cache age is relative to capture progress. A paused source retains bounded evidence for manual inspection. A future freshness policy should consider capture age at lookup independently from memory retention. |

The first audit commit runs six red regressions with `npx vitest run src/decision/engine.test.ts src/core/resource-admission.test.ts`. They cover overlap, session and ROI races, malformed fallback, ledger truncation and backward accounting time.

## Abstraction decisions

| Abstraction | Decision |
| --- | --- |
| `StreamSource`, `StreamFrame`, Canvas/video adapters, `ContextSink` | Retain the synchronous borrowed-payload boundary. Put DOM work in adapters and keep sample ownership explicit. |
| Sampling policies, detector, sampler | Retain existing sampling and comparison; refine the sampler admission and delivery timestamp boundary. |
| `BudgetController`, `RollingResourceBudget` | Keep the frame-only adapter for independent comparisons and share rolling ledger arithmetic. Give admitted spend one authoritative ledger per scope. |
| `ResourceAdmissionController` | Refine split check/record into one reservation; keep independent real-time/retrieval and combined caps. |
| `ContextBuffer`, `ActiveRetrievalService` | Retain pixel ownership and bounded lookup. Refine response timing, settlement and denial paths. |
| Decision state/features, provider, rule provider | Retain the proposal boundary and reusable feature extraction. Validate provider data and carry completion provenance outside proposals. |
| `DecisionEngine`, `DecisionScheduler` | Keep provider supervision separate from applicability. Replace browser pending flags and task-ID-only checks with the scheduler. |
| `SamplingSession`, browser entry point | Move admission, observation, task gates and session memory into a DOM-free session. Keep source control, Canvas preparation, rendering and event handlers in browser adapters/UI. |
| Timeline, rates, metrics, benchmark runners and reports | Retain bounded diagnostics and deterministic replays. Share evidence evaluation and rolling audit where semantics match. Version corrected reports. |

## Corrected results

| Held-out strategy | Real-time | Retrieved | Captured spatial evidence | Delivered before event end |
| --- | ---: | ---: | ---: | ---: |
| Phase 2 fixed | 139 | 0 | 8/9 | 8/9 |
| Phase 2 local | 53 | 0 | 8/9 | 8/9 |
| Phase 2 cue | 53 | 5 | 9/9 | 9/9 |
| Phase 2 oracle | 53 | 9 | 9/9 | 9/9 |
| Phase 3A fixed | 211 | 0 | 17/18 | 17/18 |
| Phase 3A local | 113 | 0 | 16/18 | 16/18 |
| Phase 3A cue | 113 | 16 | 18/18 | 18/18 |
| Phase 3A task-aware | 77 | 22 | 16/18 | 16/18 |

The corrected Phase 3A task strategy still covers 16/17 declared-ROI events. Overall coverage drops from the historical 17/18 to 16/18 because the crop used to count for `overlap-distractor` lacks overlapping pixels. All held-out strategies report zero real-time, retrieval, and total violations. The delayed-delivery regression demonstrates a case that changes when rolling usage is audited at delivery time.

The reports separate successful retrieval requests, returned captures in the event window, captured and delivered spatial evidence, first evidence delivery latency and event-end deadlines. Phase 2’s selected 500 ms cue interval and Phase 1B’s deterministic counts and coverage match the baseline. The corrected runners use a tick clock for provider and retrieval time, so synchronous operations have zero simulated service duration. Phase 1B still reports variable wall-clock processing diagnostics. The corrected benchmark records ESCALATE proposals without simulating a history request, and the task-aware strategy still sends 77 real-time and 22 retrieval frames on these fixtures.

[Corrected Phase 2 report](../benchmarks/results/phase2-corrected.md) · [Corrected Phase 3A report](../benchmarks/results/phase3a-corrected.md)

## Compatibility and remaining limits

- The repository is a private package and the changed sampler/admission contracts are internal. New effect call sites reserve before dispatch and settle once. A scheduler evaluation returns a newly published result or null, and its `applicable()` method provides a freshness-checked result for a later effect.
- Replay consumers select the new filenames and schema versions (3 for Phase 2, 4 for Phase 3A). Historical report files retain their original schemas. The browser still renders all three benchmark panels.
- A provider that ignores cancellation occupies a slot until it settles. Saturation produces deterministic fallback and eventually safe WAIT when both provider lanes are full. Synchronous callbacks remain subject to browser thread stalls.
- Rolling admission serializes within one JavaScript runtime. Pending holds require explicit settlement. Distributed admission, durable usage settlement and inference scheduling remain future work.
- The retained cache is bounded by capture progress and memory limits, so a paused video can still be manually inspected. The browser smoke flow uses generated local media and covers Chromium. Native codecs vary by browser.
