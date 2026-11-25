/// <reference types="node" />

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runBenchmark } from './runner';
import { formatReportCsv, formatReportMarkdown } from './report';
import type { StrategyAggregate } from './types';

const report = runBenchmark();
const json = JSON.stringify(report, null, 2) + '\n';
const csv = formatReportCsv(report);
const markdown = formatReportMarkdown(report);

const resultsDirectory = resolve(process.cwd(), 'benchmarks/results');
const publicDirectory = resolve(process.cwd(), 'public/benchmark');
mkdirSync(resultsDirectory, { recursive: true });
mkdirSync(publicDirectory, { recursive: true });
writeFileSync(resolve(resultsDirectory, 'latest.json'), json);
writeFileSync(resolve(resultsDirectory, 'latest.csv'), csv);
writeFileSync(resolve(resultsDirectory, 'latest.md'), markdown);
writeFileSync(resolve(publicDirectory, 'latest.json'), json);

function printAggregates(title: string, aggregates: readonly StrategyAggregate[]): void {
  console.log(title);
  for (const aggregate of aggregates) {
    console.log(
      `  ${aggregate.strategy.padEnd(7)} sent=${String(aggregate.sent).padStart(4)} `
      + `recall=${(100 * aggregate.recall).toFixed(1).padStart(5)}% `
      + `missed=${aggregate.missedEvents} `
      + `first=${aggregate.meanFirstCaptureLatencyMs === null ? '—' : aggregate.meanFirstCaptureLatencyMs.toFixed(1) + 'ms'} `
      + `outside=${aggregate.sentOutsideEvents} `
      + `budget=${aggregate.budgetViolations}`,
    );
  }
}

console.log(`SemanticStream Phase 1B benchmark (${report.suites.evaluation.scenes.length} evaluation scenes)`);
console.log(`Selected local detector: ${report.selection.local.threshold}% / ${report.selection.local.blockWidth}×${report.selection.local.blockHeight}`);
printAggregates('Held-out evaluation:', report.suites.evaluation.aggregates);
printAggregates('Tuning:', report.suites.tuning.aggregates);
console.log(`Wrote ${resultsDirectory}/latest.{json,csv,md} and ${publicDirectory}/latest.json`);
