import { setTimeout as sleep } from 'node:timers/promises';
import { InferenceScheduler } from '../inference/scheduler';
import { systemClock } from '../inference/types';
import type { SchedulingPolicy } from '../inference/types';
import type { GatewayStreamingProvider } from '../inference/gateway-provider';

const FIXTURE = [
  { delay: 0, label: 'Background monitor update one', key: 'background', priority: 1 },
  { delay: 25, label: 'Background monitor update two', key: 'background', priority: 1 },
  { delay: 50, label: 'Background monitor update three', key: 'background', priority: 1 },
  { delay: 75, label: 'Background monitor update four', key: 'background', priority: 1 },
  { delay: 100, label: 'Background monitor update five', key: 'background', priority: 1 },
  { delay: 125, label: 'Critical synthetic anomaly. Database replica offline. Suggest one check.', priority: 10 },
];
const SINGLE: readonly { delay: number; label: string; priority: number; key?: string }[] = [{ delay: 0, label: 'Reply with only the word ready.', priority: 1 }];
const QUEUE_LIMIT = 2;

function quantile(values: number[], percentile: number): number | null {
  return values.sort((a, b) => a - b)[Math.ceil(values.length * percentile) - 1] ?? null;
}

export async function evaluateGateway(adapter: GatewayStreamingProvider, compare: boolean, measurement: string) {
  const caps = adapter.capabilities;
  const fixture = compare ? FIXTURE : SINGLE;
  const policies: SchedulingPolicy[] = compare ? ['fifo', 'context-aware'] : ['fifo'];
  const budget = await adapter.budget();
  const requests = fixture.length * policies.length;
  if (budget.held || budget.blocked || budget.requestLimit - budget.accepted < requests
    || budget.limitNanoUsd - budget.settledNanoUsd - budget.provisionalNanoUsd - budget.reservedNanoUsd
      < requests * budget.costPerRequestNanoUsd) {
    throw new Error('Gateway must be idle and able to reserve the full run budget.');
  }
  const variants = [];
  for (const policy of policies) {
    const current = await adapter.budget();
    if (current.held || current.blocked) {
      variants.push({ policy, skipped: 'Previous run left upstream slots held or the gateway budget frozen' });
      continue;
    }
    const runtime = new InferenceScheduler(adapter, systemClock, {
      slots: caps.slots, queue: QUEUE_LIMIT,
      tokensPerTask: caps.outputLimit, inputTokensPerTask: caps.inputReserve,
      totalTokens: fixture.length * (caps.inputReserve + caps.outputLimit),
      transport: { maxFrames: fixture.length, maxBytes: 24_000, windowMs: 5_000 },
    }, policy);
    const origin = systemClock.now();
    for (const event of fixture) {
      if (event.delay) await sleep(Math.max(0, origin + event.delay - systemClock.now()));
      const now = systemClock.now();
      runtime.ingest({ source: 'scenario', label: event.label, reason: 'Fixed comparison fixture', capturedAtMs: now }, {
        channel: event.priority > 1 ? 'response' : 'observation',
        priority: event.priority, ttlMs: caps.timeoutMs, dedupeKey: event.key,
      });
    }
    const waitUntil = systemClock.now() + caps.timeoutMs + 6_000;
    while (systemClock.now() < waitUntil) {
      const state = runtime.snapshot();
      if (!state.queued.length && state.attempts.every((attempt) => attempt.quarantined)) break;
      await sleep(20);
    }
    const state = runtime.snapshot();
    const tasks = runtime.requestMeasurements().map((task) => ({
      ...task, label: fixture[task.id - 1].label,
      unanswered: task.firstEffectiveDelayMs === undefined,
    }));
    const starts = tasks.flatMap((task) => task.startDelayMs === undefined ? [] : [task.startDelayMs!]);
    const responses = tasks.flatMap((task) => task.firstEffectiveDelayMs === undefined ? [] : [task.firstEffectiveDelayMs]);
    variants.push({
      policy, taskCount: tasks.length, startedCount: starts.length, effectiveCount: responses.length,
      unansweredCount: tasks.filter((task) => task.unanswered).length,
      startP50Ms: quantile(starts, 0.5), startP95Ms: quantile(starts, 0.95),
      effectiveP50Ms: quantile(responses, 0.5), effectiveP95Ms: quantile(responses, 0.95),
      peakSlots: state.peakSlots, pendingUpstreamSlots: state.attempts.length,
      knownInputTokens: state.budget.settledInputTokens, knownOutputTokens: state.budget.settledOutputTokens,
      unknownUsageReceipts: state.budget.unknownUsageCount, quarantinedSlots: state.budget.quarantinedSlots,
      blockedPartials: tasks.reduce((sum, task) => sum + task.blocked, 0),
      stalePartialsBlocked: tasks.reduce((sum, task) => sum + task.stale, 0),
      tasks,
    });
  }
  return {
    measurement, model: caps.model, profile: caps.profile, slots: caps.slots, queue: QUEUE_LIMIT,
    worstCaseGatewayReserveNanoUsd: requests * budget.costPerRequestNanoUsd, variants,
  };
}
