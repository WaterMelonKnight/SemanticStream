import { describe, expect, it } from 'vitest';
import { getScenes } from './fixtures';
import { runPhase2StrategyOnScene } from './retrieval-runner';
import type { BenchmarkScene } from './types';

function motionScene(): BenchmarkScene {
  return getScenes('evaluation').find((scene) => scene.id === 'eval-background-motion') as BenchmarkScene;
}

describe('Phase 2 retrieval replay', () => {
  it('gives every strategy the same input digest and bounds the cache', () => {
    const scene = motionScene();
    const results = (['fixed', 'local', 'local-retrieval', 'local-oracle-retrieval'] as const)
      .map((strategy) => runPhase2StrategyOnScene(scene, strategy));
    const digest = results[0].inputDigest;
    for (const result of results) {
      expect(result.inputDigest).toBe(digest);
      expect(result.inputs).toBe(results[0].inputs);
      expect(result.peakCacheBytes).toBeLessThanOrEqual(3_000_000);
      expect(result.peakCacheFrames).toBeLessThanOrEqual(90);
      expect(result.realtimeBudgetViolations).toBe(0);
      expect(result.retrievalBudgetViolations).toBe(0);
      expect(result.totalBudgetViolations).toBe(0);
    }
    expect(results[0].retrievalFrames).toBe(0);
    expect(results[1].retrievalFrames).toBe(0);
    expect(results[2].retrievalFrames).toBeGreaterThan(0);
    expect(results[3].retrievalFrames).toBeGreaterThan(0);
    expect(results[3].oracle).toBe(true);
  });

  it('recovers the Phase 1B background-motion miss with a budget-denial cue', () => {
    const scene = motionScene();
    const baseline = runPhase2StrategyOnScene(scene, 'local');
    const cue = runPhase2StrategyOnScene(scene, 'local-retrieval');
    const oracle = runPhase2StrategyOnScene(scene, 'local-oracle-retrieval');
    expect(baseline.realtimeRecall).toBe(0);
    expect(baseline.postRetrievalRecall).toBe(0);
    expect(cue.realtimeRecall).toBe(0);
    expect(cue.postRetrievalRecall).toBe(1);
    expect(cue.retrievalFrames).toBeGreaterThan(0);
    expect(oracle.postRetrievalRecall).toBe(1);
    expect(oracle.retrievalFrames).toBeGreaterThan(0);
    expect(cue.retrievalLog.length).toBeGreaterThan(0);
  });

  it('does not let event labels change a cue decision digest', () => {
    const labelled = motionScene();
    const unlabelled: BenchmarkScene = { ...labelled, events: [] };
    const first = runPhase2StrategyOnScene(labelled, 'local-retrieval');
    const second = runPhase2StrategyOnScene(unlabelled, 'local-retrieval');
    expect(second.decisionDigest).toBe(first.decisionDigest);
    expect(second.retrievalFrames).toBe(first.retrievalFrames);
    expect(second.totalSent).toBe(first.totalSent);
  });

  it('repeats cue decisions deterministically', () => {
    const first = runPhase2StrategyOnScene(motionScene(), 'local-retrieval');
    const second = runPhase2StrategyOnScene(motionScene(), 'local-retrieval');
    expect(second.decisionDigest).toBe(first.decisionDigest);
    expect(second.retrievalFrames).toBe(first.retrievalFrames);
    expect(second.realtimeSent).toBe(first.realtimeSent);
  });
});
