import { describe, expect, it } from 'vitest';
import { formatReportCsv, formatReportMarkdown } from './report';
import { runBenchmark } from './runner';

describe('benchmark report artifacts', () => {
  it('produces evaluation and tuning summaries with zero budget violations', () => {
    const report = runBenchmark();
    expect(report.phase).toBe('1B');
    expect(report.suites.tuning.scenes.length).toBeGreaterThan(0);
    expect(report.suites.evaluation.scenes.length).toBeGreaterThan(0);
    expect(report.suites.evaluation.aggregates).toHaveLength(4);
    expect(report.selection.candidates.length).toBeGreaterThan(0);
    for (const suite of [report.suites.tuning, report.suites.evaluation]) {
      for (const aggregate of suite.aggregates) {
        expect(aggregate.budgetViolations).toBe(0);
        expect(aggregate.recall).toBeGreaterThanOrEqual(0);
        expect(aggregate.recall).toBeLessThanOrEqual(1);
        expect(aggregate.inputs).toBeGreaterThan(0);
      }
    }
    expect(report.failureCases.some((failure) => failure.suite === 'evaluation')).toBe(true);
  }, 30_000);

  it('serializes a real report to CSV and a readable Markdown report', () => {
    const report = runBenchmark();
    const csv = formatReportCsv(report);
    const markdown = formatReportMarkdown(report);
    expect(csv.startsWith('suite,scene,scene_description,strategy')).toBe(true);
    expect(csv).toContain('AGGREGATE');
    expect(csv.split('\n').filter(Boolean).length).toBeGreaterThan(20);
    expect(markdown).toContain('Held-out evaluation suite');
    expect(markdown).toContain('How to read recall');
    expect(markdown).toContain('Selected');
    expect(markdown).toContain('Budget-Aware Event Evaluation');
  }, 30_000);
});
