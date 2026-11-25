import { describe, expect, it } from 'vitest';
import { formatTaskCsv, formatTaskMarkdown } from './task-report';
import { runTaskBenchmark } from './task-runner';

describe('task-aware benchmark report', () => {
  it('compares baselines and task-aware decisions under shared budgets', async () => {
    const report = await runTaskBenchmark();
    expect(report.phase).toBe('3A-corrected');
    expect(report.suites.evaluation.scenes).toHaveLength(9);
    expect(report.suites.evaluation.aggregates).toHaveLength(4);
    for (const aggregate of report.suites.evaluation.aggregates) {
      expect(aggregate.totalBudgetViolations).toBe(0);
      expect(aggregate.realtimeBudgetViolations).toBe(0);
      expect(aggregate.retrievalBudgetViolations).toBe(0);
      expect(aggregate.roiObservableEvents).toBeGreaterThan(0);
      expect(aggregate.peakCacheBytes).toBeLessThanOrEqual(3_000_000);
    }
    const taskAware = report.suites.evaluation.aggregates.find((aggregate) => aggregate.strategy === 'task-aware');
    expect(taskAware?.decisionRequests).toBeGreaterThan(0);
    expect(taskAware?.decisionFallbacks).toBe(0);
    expect(taskAware?.decisionLatencyMeanMs).not.toBeNull();
  }, 30_000);

  it('serializes task, ROI, decision, and failure metrics', async () => {
    const report = await runTaskBenchmark();
    const csv = formatTaskCsv(report);
    const markdown = formatTaskMarkdown(report);
    expect(csv.startsWith('suite,scene,scene_description,strategy')).toBe(true);
    expect(csv).toContain('AGGREGATE');
    expect(csv).toContain('task-aware');
    expect(markdown).toContain('Task-Aware Decision Engine');
    expect(markdown).toContain('Task declarations');
    expect(markdown).toContain('D · Task-aware Rule Decision');
    expect(markdown).toContain('not evidence that the new policy is uniformly better');
  }, 30_000);
});
