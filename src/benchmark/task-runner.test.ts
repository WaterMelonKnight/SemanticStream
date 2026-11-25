import { describe, expect, it } from 'vitest';
import { getScenes } from './fixtures';
import { getTaskScenes, getTaskForScene } from './task-fixtures';
import { runTaskAwareScene } from './task-runner';

describe('task-aware replay', () => {
  it('uses the same bounded cache, admission budgets, and decision interval', async () => {
    const scene = getScenes('evaluation').find((entry) => entry.id === 'eval-background-motion')!;
    const result = await runTaskAwareScene(scene);
    expect(result.strategy).toBe('task-aware');
    expect(result.task.taskId).toBe('read-roi-while-moving');
    expect(result.inputs).toBe(scene.frames.length);
    expect(result.peakCacheBytes).toBeLessThanOrEqual(3_000_000);
    expect(result.peakCacheFrames).toBeLessThanOrEqual(90);
    expect(result.realtimeBudgetViolations).toBe(0);
    expect(result.retrievalBudgetViolations).toBe(0);
    expect(result.totalBudgetViolations).toBe(0);
    expect(result.decisionRequests).toBeGreaterThan(0);
    expect(result.decisionFallbacks).toBe(0);
    expect(result.decisionLatencyMeanMs).not.toBeNull();
    expect(result.postRetrievalRecall).toBeGreaterThanOrEqual(result.realtimeRecall);
    expect(result.actions.SEND_FRAME + result.actions.SEND_PREVIEW + result.actions.WAIT).toBeGreaterThan(0);
  });

  it('provides deterministic seeded task scenes and predeclared tasks', () => {
    const first = getTaskScenes();
    const second = getTaskScenes();
    expect(first).toHaveLength(3);
    expect(first.map((scene) => scene.id)).toEqual(['task-random-roi', 'task-repeated', 'task-overlap']);
    expect(first[0].frames[10].sample).toEqual(second[0].frames[10].sample);
    for (const scene of first) {
      const task = getTaskForScene(scene.id);
      expect(task.roi).not.toBeNull();
      expect(task.label.length).toBeGreaterThan(0);
    }
  });
});
