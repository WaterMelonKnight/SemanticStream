# Inference orchestration design

SemanticStream schedules work against current evidence, user intent, deadlines and budgets. Inference engines such as vLLM and SGLang own model execution, batching and device scheduling. An API gateway such as LiteLLM can own provider routing and protocol translation. SemanticStream supplies an immutable evidence snapshot and manages application-level request eligibility and output.

## Contracts

| Contract | Responsibilities |
| --- | --- |
| `InferenceTask` | Immutable task and request IDs, session generation, interaction epoch, task revision, context snapshot ID and watermarks, required capabilities, priority, deadline, resource bounds, output destination and idempotency key. |
| `InferenceProvider` | Describe model capabilities and accepted modalities, dispatch requests with cancellation and deadline metadata, and expose ordered partials, a terminal status and available usage evidence. Transport-specific session control belongs in the adapter. |
| `InferenceScheduler` | Admission to bounded queues, deadline and cancellation checks, prioritization, endpoint selection, resource acquisition, dispatch, retry policy and cleanup. |
| `ModelPool` | Track logical capacity per endpoint/tenant/model, capabilities, health, throttling, latency and availability. Track replica identity only when the provider exposes it. |
| `OutputCoordinator` | Arbitrate streams by output target and interaction epoch. Enforce active scope at every visible chunk, track order, and suppress terminal writes from canceled or superseded requests. |
| `ResourceReservation` | Acquire short-lived logical slots and spend/usage holds appropriate to the task before dispatch. Release each according to its own terminal evidence. |
| `UsageSettlement` | Reconcile reserved estimates with authoritative provider usage, provisional upper bounds or late reconciliation events. Deduplicate by task/attempt and provider receipt. |

## Task and output lifecycle

A proposed action passes deterministic scope and policy checks and selects a bounded context snapshot. The runtime freezes per-source watermarks and captures task revision and interaction epoch. Later inputs can form new snapshots while the in-flight task keeps its own consistent view. A new observation does not by itself obsolete a response. An interrupting user turn, task revision, session reset, explicit supersession, or crossed deadline can revoke output eligibility. Context-specific effects also check their evidence pointer and retention or pin at use.

An inference attempt moves through admitted, queued, running, and a terminal state such as completed, failed, expired or canceled. Before queueing and dispatch, check remaining deadline and resource fit. Bounded queues can reject new work or replace strictly older queued work according to an explicit policy. Prefer earlier deadlines within priority classes and include an aging/fairness policy before enabling multiple tenants. No speculative fan-out is needed for the first adapter.

Cancellation propagates to the adapter, halts visible output immediately and requests upstream stop. A cancellation can finish the logical user task before upstream work stops. Keep physical endpoint capacity accounted for until the adapter confirms the terminal event or supervisor recovery removes the endpoint from service. Preempt running work only when policy authorizes it and the provider offers a viable stop or a prompt output handover. Retry only while the deadline and budget allow, with a new attempt identity and idempotency policy. If visible text has already streamed, do not silently replay it as one continuous generation.

An output target has a single active writer per interaction epoch. Before each chunk the coordinator checks the current writer, epoch, sequence and deadline. The first allowed partial is distinct from final success. User barge-in advances the epoch and lets the user see or hear the new turn immediately. An ordinary turn-based LLM can support an application-level full-duplex experience this way: input and evidence ingestion continue during generation, and the orchestrator overlaps eligible turns or independent tasks while arbitrating user-visible output. An upstream native session may also change state continuously; the adapter must map its response and input IDs into the same runtime lifecycle.

## Adapter topologies

| Topology | Integration |
| --- | --- |
| Request/response LLM with streamed output | One dispatch creates one response stream. Map network chunks to attempt-scoped partials and final status. Tie upstream cancellation and usage receipts to the attempt. |
| Concurrent calls to one endpoint | Allocate distinct logical slots on the same endpoint and correlate output by attempt ID. Tune limits against observed throttling and latency, and coordinate application output separately. |
| Multiple instances of one model | Pool compatible endpoints or a load-balanced endpoint. Route by availability and deadline. Explicit replica affinity applies only when exposed. |
| Heterogeneous models/endpoints | Filter by modality, output schema and required capabilities. Choose among eligible endpoints using capacity, cost, deadline and measured quality. |
| OpenAI-compatible gateway | Use one adapter per published contract. Discover capabilities per routed model, respect gateway limits, and settle from reported usage. Gateway failover stays within the task's budget and capability constraints. |
| Direct inference engine | Translate engine-specific request IDs, cancellation and usage while leaving batching, scheduling on accelerators and model memory with the engine. |
| Native bidirectional streaming | One transport session carries overlapping input and response events. Track both transport and application epochs, correlate partials by response ID, and bound input buffers and in-flight turns. |

Logical concurrency slots are admission units. One physical replica may serve multiple logical tasks through batching, and a gateway endpoint may conceal many replicas. Track independent limits for concurrent operations, tokens or bytes in rolling windows, and monetary exposure. A scheduler slot is released on provider completion evidence or controlled endpoint recovery. It does not imply token, byte or monetary settlement.

## Cancellation and usage

Reserve a conservative estimate before dispatch and group retries under the logical task. Settle reported final usage exactly once per attempt. If cancellation or a transport error leaves final usage unknown, retain a provisional liability under a configurable policy. Reconcile when an authoritative receipt arrives. Record an explicit unresolved outcome when the provider cannot supply a final receipt, and keep that exposure inside the relevant spend cap. Request cancellation alone is insufficient evidence of zero cost. Implement real monetary settlement only with a concrete provider, usage contract and owner.

Jev-style models can score evidence relevance, urgency, dispatch proposals, or when to respond. Deterministic code validates recommendations, snapshots admitted inputs, enforces concurrency and spending caps, and decides which partials can reach the user.

## Phase 4A

Phase 4A implements the in-process, single-endpoint lifecycle with one- and two-slot modes, bounded queues and the same output coordinator for both schedulers. The scripted adapter provides ordered partials, delayed terminal evidence, cancellation faults and unknown usage. The [Phase 4A implementation](phase4a-duplex-runtime.md) documents the concrete API and future adapter requirements.
