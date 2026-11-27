import { mkdir, writeFile } from 'node:fs/promises';
import { runTrackingBenchmark, trackingReport } from './object-tracking-benchmark';

const results = runTrackingBenchmark();
const json = {
  schema: 'semanticstream.object-tracking-benchmark.v1',
  generatedAt: new Date().toISOString(),
  note: 'Synthetic ObjectObservation fixtures; not real detector accuracy.',
  results,
};
await mkdir('benchmarks/results', { recursive: true });
await writeFile('benchmarks/results/phase4p2-tracking.json', JSON.stringify(json, null, 2) + '\n');
await writeFile('benchmarks/results/phase4p2-tracking.md', trackingReport(results) + '\n');
console.log(trackingReport(results));
