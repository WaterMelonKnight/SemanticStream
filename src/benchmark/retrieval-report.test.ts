import { describe, expect, it } from 'vitest';
import { runPhase2Benchmark } from './retrieval-runner';
import { formatPhase2Csv, formatPhase2Markdown } from './retrieval-report';

describe('Phase 2 benchmark report', () => {
  it('runs tuning and held-out suites with cue and oracle results', () => {
    const report = runPhase2Benchmark();
    expect(report.phase).toBe('2');
    expect(report.cueSelection.intervalMs).toBeGreaterThan(0);
    expect(report.suites.evaluation.scenes.length).toBe(6);
    expect(report.suites.evaluation.aggregates).toHaveLength(4);
    const cue = report.suites.evaluation.aggregates.find((aggregate) => aggregate.strategy === 'local-retrieval');
    const local = report.suites.evaluation.aggregates.find((aggregate) => aggregate.strategy === 'local');
    const oracle = report.suites.evaluation.aggregates.find((aggregate) => aggregate.strategy === 'local-oracle-retrieval');
    expect(cue?.postRetrievalRecall).toBeGreaterThan(local?.postRetrievalRecall ?? 0);
    expect(oracle?.oracle).toBe(true);
    expect(cue?.totalBudgetViolations).toBe(0);
    expect(report.focus.some((focus) => focus.strategy === 'local-retrieval' && focus.postRetrievalRecall === 1)).toBe(true);
    expect(report.focus.some((focus) => focus.strategy === 'local' && focus.postRetrievalRecall === 0)).toBe(true);
  }, 30_000);

  it('serializes a readable report and CSV', () => {
    const report = runPhase2Benchmark();
    const csv = formatPhase2Csv(report);
    const markdown = formatPhase2Markdown(report);
    expect(csv.startsWith('suite,scene,scene_description,strategy')).toBe(true);
    expect(csv).toContain('AGGREGATE');
    expect(markdown).toContain('Bounded Context Buffer and Active Retrieval');
    expect(markdown).toContain('Cue vs oracle');
    expect(markdown).toContain('Oracle · local + label-timed retrieval');
    expect(markdown).toContain('not evidence of autonomous discovery');
  }, 30_000);
});
