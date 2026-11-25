/// <reference types="node" />

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runTaskBenchmark } from './task-runner';
import { formatTaskCsv, formatTaskMarkdown } from './task-report';
import type { TaskAggregate } from './task-types';

const report = await runTaskBenchmark();
const json = JSON.stringify(report, null, 2) + '\n';
const csv = formatTaskCsv(report);
const markdown = formatTaskMarkdown(report);

const resultsDirectory = resolve(process.cwd(), 'benchmarks/results');
const publicDirectory = resolve(process.cwd(), 'public/benchmark');
mkdirSync(resultsDirectory, { recursive: true });
mkdirSync(publicDirectory, { recursive: true });
writeFileSync(resolve(resultsDirectory, 'phase3a-corrected.json'), json);
writeFileSync(resolve(resultsDirectory, 'phase3a-corrected.csv'), csv);
writeFileSync(resolve(resultsDirectory, 'phase3a-corrected.md'), markdown);
writeFileSync(resolve(publicDirectory, 'phase3a-corrected.json'), json);

function printAggregates(title: string, aggregates: readonly TaskAggregate[]): void {
  console.log(title);
  for (const aggregate of aggregates) {
    console.log(
      `  ${aggregate.strategy.padEnd(15)} realtime=${String(aggregate.realtimeSent).padStart(4)} `
      + `retrieval=${String(aggregate.retrievalFrames).padStart(3)} `
      + `recall=${(100 * aggregate.realtimeRecall).toFixed(1).padStart(5)}%->${(100 * aggregate.postRetrievalRecall).toFixed(1).padStart(5)}% `
      + `roi=${(100 * aggregate.roiRealtimeRecall).toFixed(1).padStart(5)}%->${(100 * aggregate.roiPostRetrievalRecall).toFixed(1).padStart(5)}% `
      + `cache=${aggregate.peakCacheBytes}B/${aggregate.peakCacheFrames}f `
      + `budget=${aggregate.realtimeBudgetViolations}/${aggregate.retrievalBudgetViolations}/${aggregate.totalBudgetViolations} `
      + `decision=${aggregate.decisionLatencyMeanMs === null ? '—' : aggregate.decisionLatencyMeanMs.toFixed(3) + 'ms'} `
      + `fallback=${aggregate.decisionFallbacks}`,
    );
  }
}

console.log(`SemanticStream Phase 3A task-aware benchmark, corrected (${report.suites.evaluation.scenes.length} evaluation scenes)`);
printAggregates('Held-out evaluation:', report.suites.evaluation.aggregates);
console.log(`Wrote ${resultsDirectory}/phase3a-corrected.{json,csv,md} and ${publicDirectory}/phase3a-corrected.json`);
