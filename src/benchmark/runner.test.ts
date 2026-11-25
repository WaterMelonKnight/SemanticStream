import { describe, expect, it } from 'vitest';
import type { PixelSample } from '../core/sampling';
import { getScenes } from './fixtures';
import {
  BENCHMARK_FRAME_LIMIT,
  BENCHMARK_BUDGET_WINDOW_MS,
  countBudgetViolations,
  evaluateScene,
  runStrategyOnScene,
} from './runner';
import type { BenchmarkScene, ReplayFrame } from './types';

function scene(): BenchmarkScene {
  return getScenes('evaluation').find((entry) => entry.id === 'eval-local-text') as BenchmarkScene;
}

function replayFrame(sequence: number, timestampMs: number): ReplayFrame {
  return { sequence, timestampMs, sample: new Uint8ClampedArray([0, 0, 0, 255]) as PixelSample };
}

describe('budget-aware replay runner', () => {
  it('gives every strategy the same input digest and frame count', () => {
    const results = (['fixed', 'global', 'local', 'hybrid'] as const).map((strategy) =>
      runStrategyOnScene(scene(), strategy));
    const inputDigest = results[0].inputDigest;
    for (const result of results) {
      expect(result.inputs).toBe(results[0].inputs);
      expect(result.inputDigest).toBe(inputDigest);
      expect(result.budgetViolations).toBe(0);
      expect(result.recall).toBeGreaterThanOrEqual(0);
      expect(result.recall).toBeLessThanOrEqual(1);
    }
  });

  it('does not change decisions when event labels are removed', () => {
    const labelled = scene();
    const unlabelled: BenchmarkScene = { ...labelled, events: [] };
    const first = runStrategyOnScene(labelled, 'local');
    const second = runStrategyOnScene(unlabelled, 'local');
    expect(second.decisionDigest).toBe(first.decisionDigest);
    expect(second.sent).toBe(first.sent);
    expect(second.inputs).toBe(first.inputs);
  });

  it('repeats decisions deterministically', () => {
    const first = runStrategyOnScene(scene(), 'hybrid');
    const second = runStrategyOnScene(scene(), 'hybrid');
    expect(second.decisionDigest).toBe(first.decisionDigest);
    expect(second.sent).toBe(first.sent);
  });

  it('counts budget violations independently of the sampler', () => {
    const timestamps = Array.from({ length: 21 }, (_, index) => index * 100);
    expect(countBudgetViolations(timestamps, BENCHMARK_FRAME_LIMIT, BENCHMARK_BUDGET_WINDOW_MS)).toBe(1);
    expect(countBudgetViolations(timestamps.slice(0, 20), BENCHMARK_FRAME_LIMIT, BENCHMARK_BUDGET_WINDOW_MS)).toBe(0);
  });

  it('evaluates recall, latency, outside sends, and unobservable events', () => {
    const events = [
      { id: 'a', kind: 'local-text' as const, startMs: 1_000, endMs: 2_000, region: { x: 0, y: 0, width: 1, height: 1 }, description: 'a' },
      { id: 'b', kind: 'local-text' as const, startMs: 2_000, endMs: 3_000, region: { x: 0, y: 0, width: 1, height: 1 }, description: 'b' },
      { id: 'hidden', kind: 'pause-hidden' as const, startMs: 4_000, endMs: 5_000, region: { x: 0, y: 0, width: 1, height: 1 }, description: 'hidden' },
    ];
    const testScene: BenchmarkScene = {
      id: 'test',
      suite: 'evaluation',
      description: 'test scene',
      frames: [replayFrame(1, 0), replayFrame(2, 1_000), replayFrame(3, 1_500), replayFrame(4, 2_500), replayFrame(5, 5_500)],
      events,
    };
    const evaluation = evaluateScene(
      testScene,
      [
        { sequence: 2, timestampMs: 1_000 },
        { sequence: 4, timestampMs: 2_500 },
        { sequence: 5, timestampMs: 5_500 },
      ],
      [1, 2, 3],
    );
    expect(evaluation.inputs).toBe(5);
    expect(evaluation.events).toBe(3);
    expect(evaluation.observableEvents).toBe(2);
    expect(evaluation.capturedEvents).toBe(2);
    expect(evaluation.missedEvents).toBe(0);
    expect(evaluation.unobservableEvents).toBe(1);
    expect(evaluation.recall).toBe(1);
    expect(evaluation.meanFirstCaptureLatencyMs).toBe(250);
    expect(evaluation.maxFirstCaptureLatencyMs).toBe(500);
    expect(evaluation.sentOutsideEvents).toBe(1);
    expect(evaluation.unobservableEventIds).toEqual(['hidden']);
  });
});
