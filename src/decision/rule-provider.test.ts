import { describe, expect, it } from 'vitest';
import { RuleBasedDecisionProvider } from './rule-provider';
import type { DecisionState } from './types';

const provider = new RuleBasedDecisionProvider();

function state(overrides: Partial<DecisionState> = {}): DecisionState {
  return {
    sessionId: 'session',
    timestampMs: 1_000,
    task: { id: 'task', label: 'Task', category: 'text-reading', priority: 'high', roi: { x: 0, y: 0, width: 20, height: 20 } },
    change: { globalPercent: 0.5, localPercent: 0.5, changedBlocks: 0, totalBlocks: 20 },
    roi: { region: { x: 0, y: 0, width: 20, height: 20 }, changePercent: 0.5 },
    recent: { repeatedChangeCount: 0, repeatedRoiChangeCount: 0, budgetDeniedCount: 0, recentDecisions: [] },
    budget: {
      realtimeRemainingFrames: 10,
      realtimeRemainingBytes: 10_000,
      retrievalRemainingFrames: 3,
      retrievalRemainingBytes: 10_000,
      totalRemainingFrames: 13,
      totalRemainingBytes: 20_000,
    },
    cache: { availableRange: null, capturedRange: null, frameCount: 0, byteCount: 0 },
    ...overrides,
  };
}

describe('rule based decision provider', () => {
  it('selects SEND_FRAME for a hot task ROI', () => {
    const decision = provider.decide(state({ roi: { region: { x: 0, y: 0, width: 20, height: 20 }, changePercent: 9 } }));
    expect(decision.action).toBe('SEND_FRAME');
    expect(decision.scoreKind).toBe('heuristic');
    expect(decision.candidates.every((candidate) => candidate.score >= 0 && candidate.score <= 1)).toBe(true);
  });

  it('suppresses repeated ROI motion when the real-time budget is low', () => {
    const decision = provider.decide(state({
      roi: { region: { x: 0, y: 0, width: 20, height: 20 }, changePercent: 9 },
      recent: { repeatedChangeCount: 8, repeatedRoiChangeCount: 8, budgetDeniedCount: 2, recentDecisions: [] },
      budget: {
        realtimeRemainingFrames: 1,
        realtimeRemainingBytes: 100,
        retrievalRemainingFrames: 3,
        retrievalRemainingBytes: 10_000,
        totalRemainingFrames: 4,
        totalRemainingBytes: 20_000,
      },
      cache: { availableRange: { startMs: 0, endMs: 1_000 }, capturedRange: { startMs: 0, endMs: 1_000 }, frameCount: 10, byteCount: 1_000 },
    }));
    expect(decision.action).not.toBe('SEND_FRAME');
    expect(['REQUEST_HISTORY', 'REQUEST_REGION', 'ESCALATE']).toContain(decision.action);
  });

  it('waits when nothing actionable changed', () => {
    expect(['WAIT', 'DROP']).toContain(provider.decide(state()).action);
  });
});
