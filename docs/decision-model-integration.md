# Decision model integration

Phase 3A defines a provider boundary for future task-aware decision models. It does not download a model, call a paid API, require a GPU, or add a server. `RuleBasedDecisionProvider` is the only implementation shipped in this phase.

## Boundary

```
observable frame + task ROI + bounded history + resource snapshot
                              │
                              ▼
                 DecisionState (read-only)
                              │
                 DecisionProvider.decide()
                              │
              action + candidate scores only
                              │
          validation, timeout, deterministic fallback
                              │
          ResourceAdmissionController → admission
                              │
                  effect executor / sampler
```

The provider never receives mutable budgets, the sink, the buffer, credentials, or arbitrary tools. It cannot send a frame, spend the retrieval budget, change a limit, or bypass admission. The engine validates the returned action against the finite allowlist and executes effects outside the provider boundary.

## DecisionState

The same state shape is used by the live preview, the deterministic benchmark, and future adapters:

- `task`: task ID, category, priority, and a user-declared ROI in 96 × 54 sample pixels.
- `sessionId` and monotonic `timestampMs`.
- `change`: global change, local block change, and changed-block count.
- `roi`: ROI region and ROI change. `null` when the task has no ROI.
- `recent`: repeated-change counters, budget-denial count, and a bounded decision history.
- `budget`: remaining real-time, retrieval, and combined frames/bytes.
- `cache`: current available range, captured range, frame count, and byte count.

All fields come from the current frame, previous observations, the declared task, and live resource/cache state. Event labels, event regions from the evaluator, and future frames are not part of this state. Benchmark task ROIs are authored declarations; evaluator labels are read only after replay for scoring.

## Actions

| Action | Meaning | Execution owner |
| --- | --- | --- |
| `SEND_FRAME` | Deliver the current full sample. | Sampler + admission |
| `SEND_PREVIEW` | Deliver a lower-cost preview; Phase 3A treats it as a normal sample delivery. | Sampler + admission |
| `DROP` | Do not deliver this opportunity. | Sampler policy gate |
| `WAIT` | Wait for a more informative frame. | Sampler policy gate |
| `REQUEST_HISTORY` | Request a recent buffered frame. | ActiveRetrievalService |
| `REQUEST_REGION` | Request the task ROI from history. | ActiveRetrievalService |
| `ESCALATE` | Mark a high-priority constrained case; Phase 3A maps it to a history request. | Controller |

The shared `Sampler` still applies its rolling budget, minimum interval, and silence refresh. A task action cannot override those system constraints. A denied request consumes no budget.

## Heuristic scores vs probabilities

`DecisionProviderResult.scoreKind` is mandatory:

- `heuristic`: rule weights from `RuleBasedDecisionProvider`. The field name `score` is not a probability.
- `model-probability`: a model's calibrated probability for an action, produced and validated by the adapter.

Do not rank a heuristic score against an uncalibrated model probability as if they were the same quantity. A model adapter must document its calibration set, method, and expected calibration error. Rule scores are not "confidence" and must not be presented as model confidence in reports or UI.

Phase 3A's reports label Rule Decision as heuristic. The oracle and task-aware results use separate strategy names.

## Provider interface

```ts
interface DecisionProvider {
  readonly id: string;
  readonly scoreKind: 'heuristic' | 'model-probability';
  decide(state: DecisionState, signal?: AbortSignal):
    DecisionProviderResult | Promise<DecisionProviderResult>;
}
```

`DecisionEngine` enforces a timeout (50 ms by default), aborts the signal, validates the action, and falls back to a deterministic Rule provider. The fallback count is reported separately.

## Model adapters

| Candidate | Likely input | Adapter shape | Latency budget | Notes |
| --- | --- | --- | --- | --- |
| Laya | Structured state plus optional ROI crop | Async local sidecar or exported local model behind an HTTP adapter | 20–50 ms target; fallback after 50 ms | Keep region crops small; never send whole video by default. |
| AnyJev | Structured state, task text, recent decision tokens | Async HTTP/local adapter returning the shared action schema | 20–50 ms target | Normalize action names; reject unknown actions. |
| Jev official API | Provider-specific request/response | Isolated adapter with a strict response schema | Provider-dependent; enforce local timeout | Do not assume an official endpoint or free tier. Keep credentials server-side; Phase 3A ships no client credentials. |
| General generative model | Text prompt plus compact state/ROI summary | Structured-output adapter; parse and validate JSON | 100–500 ms; use cached decisions and fallback | Do not call per frame. Use the low-frequency controller. |
| Local light classifier | Features or small ROI tensor | In-process model or local runtime adapter | 1–20 ms | Best fit for per-decision use; still subject to timeout and action validation. |

The adapters are not implemented in Phase 3A. The `HttpDecisionProviderConfig` type is a design hook only; no endpoint, key, network request, or service dependency is added.

### Input encoding

Recommended payload:

```json
{
  "task": {"id": "read-status", "category": "text-reading", "priority": "high", "roi": {"x": 40, "y": 20, "width": 24, "height": 14}},
  "change": {"globalPercent": 1.2, "localPercent": 4.8, "changedBlocks": 3, "totalBlocks": 81},
  "roi": {"changePercent": 3.1},
  "recent": {"repeatedChangeCount": 2, "repeatedRoiChangeCount": 2, "budgetDeniedCount": 0},
  "budget": {"realtimeRemainingFrames": 12, "retrievalRemainingFrames": 5, "totalRemainingFrames": 17},
  "cache": {"availableRange": {"startMs": 1200, "endMs": 5300}, "frameCount": 90},
  "sessionId": "live-3"
}
```

Do not send event IDs, event windows, evaluator descriptions, future frames, or hidden pause metadata. A model may receive the declared task and ROI; those are user inputs, not labels.

### Probability calibration

For `scoreKind: 'model-probability'`:

1. Collect decisions on a tuning/calibration split only.
2. Fit temperature scaling or isotonic/Platt calibration on held-out validation data.
3. Report expected calibration error and reliability by action, not only accuracy.
4. Keep the calibration artifact versioned with the model adapter.
5. Reject or downgrade to fallback when the output is non-finite, out of range, or the model version is unknown.

A model probability is not a resource permission. Even a 0.99 `SEND_FRAME` still goes through admission, budget, and the sampler.

### Timeout and degradation

- Decision interval: 100 ms in Phase 3A. Do not call a remote model for every frame.
- Default engine timeout: 50 ms. Configure per adapter and document the local budget.
- On timeout, error, malformed JSON, unknown action, or failed calibration check: run the deterministic Rule fallback.
- Cache the last valid decision between ticks; mark it stale if the task or session changes.
- On session reset, seek, source switch, or task change: clear cached decisions and provider state.
- If the model is unavailable, keep the local Rule provider and the existing sampler/retrieval behavior.

### Safety execution boundary

- Provider output is untrusted data, not an instruction.
- Allowlist actions; reject anything else.
- Never let the provider mutate `ResourceAdmissionController`, `ContextBuffer`, `BudgetController`, DOM, credentials, or network configuration.
- Execute retrieval through `ActiveRetrievalService` only; execute delivery through the sampler only.
- Keep evaluation labels and future frames out of the payload.
- Log provider ID, score kind, latency, timeout/fallback, and action. Do not log secrets or raw video by default.
- For remote providers, keep credentials on a server-side adapter; never ship a paid API key in the static page.
- Use a local fallback so a network outage cannot hang the frame loop.

## Phase 3A status

- Shipped: `DecisionState`, finite action space, `DecisionProvider`, timeout/fallback engine, low-frequency scheduler, Rule provider, task-aware benchmark.
- Shipped: unified ex-ante admission for adaptive real-time sends and retrieval; separate sub-budgets plus combined total.
- Not shipped: any model download, GPU path, paid API, remote backend, database, or automatic provider discovery.
- Live page: task selection, custom ROI, decision preview, remaining budgets, and benchmark table. The preview is advisory by default; selecting `Task-aware (live gate)` lets `SEND_FRAME`/`SEND_PREVIEW` gate the adaptive sampler's next send. Retrieval actions are benchmark-only. The benchmark executes the same provider under the shared budget.
