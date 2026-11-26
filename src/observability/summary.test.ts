import { describe, expect, it } from 'vitest';
import { summarizeRuntime } from './summary';
import type { RuntimeMeasurementSnapshot } from '../inference/runtime-metrics';

function measurement(overrides: Partial<RuntimeMeasurementSnapshot>): RuntimeMeasurementSnapshot {
  return {
    id: 1, startedAtMs: 0, usage: 'reported', outcome: 'completed', blocked: 0, stale: 0,
    unanswered: false, inputTokens: 10, outputTokens: 3, firstTextDelayMs: 100,
    firstEffectiveDelayMs: 120, upstreamElapsedMs: 200, ...overrides,
  };
}

describe('runtime summary', () => {
  it('counts outcomes, unknown usage, stale/blocked and P50/P95 samples', () => {
    const summary = summarizeRuntime([
      measurement({ id: 1, firstTextDelayMs: 10, firstEffectiveDelayMs: 20, upstreamElapsedMs: 30 }),
      measurement({ id: 2, firstTextDelayMs: 30, firstEffectiveDelayMs: 40, upstreamElapsedMs: 50 }),
      measurement({ id: 3, firstTextDelayMs: 100, firstEffectiveDelayMs: 110, upstreamElapsedMs: 120 }),
      measurement({ id: 4, outcome: 'rejected', usage: 'pending', firstTextDelayMs: undefined, firstEffectiveDelayMs: undefined, upstreamElapsedMs: undefined, reason: 'Queue full', unanswered: true, stale: 1, blocked: 2 }),
      measurement({ id: 5, outcome: 'failed', usage: 'unknown · held', firstTextDelayMs: undefined, reason: 'All endpoint slots quarantined', unanswered: true }),
    ]);
    expect(summary).toMatchObject({
      tasks: 5, completed: 3, rejected: 1, failed: 1, unanswered: 2,
      staleOutputs: 1, blockedOutputs: 2, knownUsage: 3, unknownUsage: 1,
      inputTokens: 30, outputTokens: 9,
    });
    expect(summary.firstText).toEqual({ count: 3, p50Ms: 30, p95Ms: 100 });
    expect(summary.reasons['Queue full']).toBe(1);
  });

  it('separates no-response tasks from successful latency samples', () => {
    const summary = summarizeRuntime([
      measurement({ id: 1, outcome: 'cancelled', usage: 'pending', firstTextDelayMs: undefined, firstEffectiveDelayMs: undefined, unanswered: true }),
    ]);
    expect(summary.firstText).toEqual({ count: 0, p50Ms: null, p95Ms: null });
    expect(summary.unanswered).toBe(1);
  });
});
