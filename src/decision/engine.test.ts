import { describe, expect, it } from 'vitest';
import { DecisionEngine, DecisionScheduler } from './engine';
import type { DecisionProvider, DecisionProviderResult, DecisionState } from './types';

function state(timestampMs = 1_000): DecisionState {
  return {
    sessionId: 'test',
    timestampMs,
    task: { id: 'task', label: 'Task', category: 'text-reading', priority: 'high', roi: null },
    change: { globalPercent: 0, localPercent: 0, changedBlocks: 0, totalBlocks: 1 },
    roi: null,
    recent: { repeatedChangeCount: 0, repeatedRoiChangeCount: 0, budgetDeniedCount: 0, recentDecisions: [] },
    budget: {
      realtimeRemainingFrames: 10,
      realtimeRemainingBytes: 1_000,
      retrievalRemainingFrames: 3,
      retrievalRemainingBytes: 1_000,
      totalRemainingFrames: 13,
      totalRemainingBytes: 2_000,
    },
    cache: { availableRange: null, capturedRange: null, frameCount: 0, byteCount: 0 },
  };
}

function result(action: DecisionProviderResult['action']): DecisionProviderResult {
  return { action, candidates: [{ action, score: 0.5, priority: 10, reason: 'test' }], scoreKind: 'heuristic', reason: 'test' };
}

const fallback: DecisionProvider = {
  id: 'fallback',
  scoreKind: 'heuristic',
  decide: () => result('WAIT'),
};

describe('decision engine', () => {
  it('returns a synchronous heuristic provider result without degradation', async () => {
    const provider: DecisionProvider = { id: 'rule', scoreKind: 'heuristic', decide: () => result('SEND_FRAME') };
    const engine = new DecisionEngine(provider, fallback, { timeoutMs: 50, now: () => 0 });
    const decision = await engine.decide(state());
    expect(decision.action).toBe('SEND_FRAME');
    expect(decision.providerId).toBe('rule');
    expect(decision.scoreKind).toBe('heuristic');
    expect(decision.degraded).toBe(false);
  });

  it('uses the deterministic fallback on timeout', async () => {
    const provider: DecisionProvider = {
      id: 'slow',
      scoreKind: 'model-probability',
      decide: () => new Promise(() => undefined),
    };
    const engine = new DecisionEngine(provider, fallback, { timeoutMs: 10, now: () => 0 });
    const decision = await engine.decide(state());
    expect(decision.action).toBe('WAIT');
    expect(decision.providerId).toBe('fallback');
    expect(decision.degraded).toBe(true);
    expect(decision.timeoutMs).toBe(10);
  });

  it('rejects an invalid action and falls back', async () => {
    const provider = {
      id: 'bad',
      scoreKind: 'heuristic' as const,
      decide: () => ({ ...result('SEND_FRAME'), action: 'MUTATE_BUDGET' as never }),
    };
    const engine = new DecisionEngine(provider, fallback, { timeoutMs: 50, now: () => 0 });
    const decision = await engine.decide(state());
    expect(decision.action).toBe('WAIT');
    expect(decision.degraded).toBe(true);
  });

  it('schedules provider calls at most once per interval', async () => {
    let calls = 0;
    const provider: DecisionProvider = {
      id: 'count',
      scoreKind: 'heuristic',
      decide: () => { calls += 1; return result('SEND_FRAME'); },
    };
    const engine = new DecisionEngine(provider, fallback, { timeoutMs: 50, now: () => 0 });
    const scheduler = new DecisionScheduler(engine, 100);
    await scheduler.evaluate(state(0));
    await scheduler.evaluate(state(50));
    expect(calls).toBe(1);
    await scheduler.evaluate(state(100));
    expect(calls).toBe(2);
  });
});

function deferredProvider() {
  const calls: Array<{ resolve: (value: DecisionProviderResult) => void; signal?: AbortSignal }> = [];
  const provider: DecisionProvider = {
    id: 'controlled',
    scoreKind: 'heuristic',
    decide: (_state, signal) => new Promise((resolve) => calls.push({ resolve, signal })),
  };
  return { calls, provider };
}

describe('decision lifecycle regressions', () => {
  it('does not start overlapping evaluations for an unchanged task', async () => {
    const { calls, provider } = deferredProvider();
    const scheduler = new DecisionScheduler(new DecisionEngine(provider, fallback), 100);
    const older = scheduler.evaluate(state(0));
    const newer = scheduler.evaluate(state(100));
    expect(calls).toHaveLength(1);
    calls[0].resolve(result('SEND_FRAME'));
    await older;
    await newer;
    expect(scheduler.latest?.action).toBe('SEND_FRAME');
  });

  it.each(['session', 'roi'])('ignores a late response after changing %s', async (changed) => {
    const { calls, provider } = deferredProvider();
    const scheduler = new DecisionScheduler(new DecisionEngine(provider, fallback), 100);
    const initial = state(0);
    const old = scheduler.evaluate(initial);
    const next = changed === 'session'
      ? { ...initial, sessionId: 'next' }
      : { ...initial, task: { ...initial.task, roi: { x: 0, y: 0, width: 1, height: 1 } } };
    const current = scheduler.evaluate({ ...next, timestampMs: 100 });
    calls[1].resolve(result('DROP'));
    await current;
    calls[0].resolve(result('SEND_FRAME'));
    await old;
    expect(calls[0].signal?.aborted).toBe(true);
    expect(scheduler.latest?.action).toBe('DROP');
  });

  it('rejects malformed candidate metadata from both providers', async () => {
    const invalid: DecisionProvider = {
      ...fallback,
      decide: () => ({ ...result('SEND_FRAME'), candidates: [{ ...result('SEND_FRAME').candidates[0], score: NaN }] }),
    };
    const decision = await new DecisionEngine(invalid, invalid).decide(state());
    expect(decision.action).toBe('WAIT');
    expect(decision.degraded).toBe(true);
  });
});
