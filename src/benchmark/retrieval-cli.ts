/// <reference types="node" />

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runPhase2Benchmark } from './retrieval-runner';
import { formatPhase2Csv, formatPhase2Markdown } from './retrieval-report';
import type { Phase2Aggregate } from './retrieval-types';

const report = runPhase2Benchmark();
const json = JSON.stringify(report, null, 2) + '\n';
const csv = formatPhase2Csv(report);
const markdown = formatPhase2Markdown(report);

const resultsDirectory = resolve(process.cwd(), 'benchmarks/results');
const publicDirectory = resolve(process.cwd(), 'public/benchmark');
mkdirSync(resultsDirectory, { recursive: true });
mkdirSync(publicDirectory, { recursive: true });
writeFileSync(resolve(resultsDirectory, 'phase2.json'), json);
writeFileSync(resolve(resultsDirectory, 'phase2.csv'), csv);
writeFileSync(resolve(resultsDirectory, 'phase2.md'), markdown);
writeFileSync(resolve(publicDirectory, 'phase2.json'), json);

function printAggregates(title: string, aggregates: readonly Phase2Aggregate[]): void {
  console.log(title);
  for (const aggregate of aggregates) {
    console.log(
      `  ${aggregate.strategy.padEnd(23)} realtime=${String(aggregate.realtimeSent).padStart(4)} `
      + `retrieval=${String(aggregate.retrievalFrames).padStart(3)} `
      + `recall=${(100 * aggregate.realtimeRecall).toFixed(1).padStart(5)}%->${(100 * aggregate.postRetrievalRecall).toFixed(1).padStart(5)}% `
      + `cache=${aggregate.peakCacheBytes}B/${aggregate.peakCacheFrames}f `
      + `evict=${aggregate.evictions} `
      + `budget=${aggregate.realtimeBudgetViolations}/${aggregate.retrievalBudgetViolations}/${aggregate.totalBudgetViolations}`
      + `${aggregate.oracle ? ' [ORACLE: label-timed, not autonomous]' : ''}`,
    );
  }
}

console.log(`SemanticStream Phase 2 retrieval benchmark (${report.suites.evaluation.scenes.length} evaluation scenes)`);
console.log(`Selected cue interval: ${report.cueSelection.intervalMs} ms`);
printAggregates('Held-out evaluation:', report.suites.evaluation.aggregates);
printAggregates('Tuning:', report.suites.tuning.aggregates);
console.log(`Wrote ${resultsDirectory}/phase2.{json,csv,md} and ${publicDirectory}/phase2.json`);
