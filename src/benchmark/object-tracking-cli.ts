import { mkdir, writeFile } from 'node:fs/promises';
import { runTrackingBenchmark, trackingReport, TRACKING_FIXTURES } from './object-tracking-benchmark';

const tuned = runTrackingBenchmark();
const defaults = runTrackingBenchmark(TRACKING_FIXTURES, { defaultConfig: true });
const json = {
  schema: 'semanticstream.object-tracking-benchmark.v2',
  generatedAt: new Date().toISOString(),
  note: 'Synthetic ObjectObservation fixtures; not real detector accuracy. Instance matching uses synthetic identity, event type, session and a time window. NOT_MEASURED is explicit.',
  configs: {
    'fixture-tuned': tuned,
    'production-default': defaults,
  },
};
await mkdir('benchmarks/results', { recursive: true });
await writeFile('benchmarks/results/phase4p2-tracking.json', JSON.stringify(json, null, 2) + '\n');
await writeFile('benchmarks/results/phase4p2-tracking.md',
  trackingReport(tuned, 'Phase 4P.2 · Tracking benchmark — fixture-tuned')
  + '\n\n'
  + trackingReport(defaults, 'Phase 4P.2 · Tracking benchmark — production default')
  + '\n');
console.log(trackingReport(tuned));
console.log('\n\n' + trackingReport(defaults));
