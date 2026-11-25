import { mkdirSync, writeFileSync } from 'node:fs';
import { runRuntimeReplay } from './runtime-replay';

const report = runRuntimeReplay();
const ratio = (value: number) => (value * 100).toFixed(1) + '%';
const heading = [
  'Strategy', 'Start P50/P95 ms', 'First output P50/P95 ms', 'Deadline expiries', 'Leaks / blocked',
  'Peak slots / queue', 'Invalid started', 'Bytes dispatched', 'Settled / provisional tokens', 'Critical alert start / output ms',
];
const lines = [
  '# Phase 4A · Duplex runtime simulation',
  '',
  report.description,
  '',
  'Every run replays the same ' + report.variants[0].taskCount + ' task requests and scripted timings. Capacity-matched comparisons use FIFO and',
  'SemanticStream at either slot count. Within each policy, the one-slot and two-slot runs isolate concurrency.',
  'All runs use a three-place pending queue, three dispatches / 360 bytes per 500 ms, and a simulated cumulative',
  '320-token cap with a 32-token reservation per attempt. Sample payloads are synthetic text.',
  '',
  '| ' + heading.join(' | ') + ' |',
  '| ' + heading.map(() => '---').join(' | ') + ' |',
  ...report.variants.map((variant) => '| ' + [
    variant.name,
    variant.startLatency.p50Ms + ' / ' + variant.startLatency.p95Ms + ' (n=' + variant.startLatency.count + ')',
    variant.firstOutputLatency.p50Ms + ' / ' + variant.firstOutputLatency.p95Ms + ' (n=' + variant.firstOutputLatency.count + ')',
    variant.expiries + '/' + variant.taskCount + ' (' + ratio(variant.deadlineViolationRate) + ')',
    variant.staleOutputLeaks + ' / ' + variant.blockedPartials,
    variant.peakSlots + ' / ' + variant.peakQueue,
    variant.invalidInferenceCount + '/' + variant.starts + ' (' + ratio(variant.invalidInferenceShare) + ')',
    variant.usage.bytesDispatched,
    variant.usage.tokensSettled + ' / ' + variant.usage.tokensProvisional,
    (variant.critical.startDelayMs ?? 'miss') + ' / ' + (variant.critical.firstOutputDelayMs ?? 'miss'),
  ].join(' | ') + ' |'),
  '',
  'Latency starts at event ingest. Percentiles use nearest rank and include only measured starts or first authorized',
  'partials respectively. JSON includes per-event latencies and misses. Deadline rate counts logical expiry over all requests.',
  'Queue peak counts waiting work after immediate dispatch. Invalid inference means a dispatched attempt either failed to',
  'complete logically or had no authorized output. Leaks count partials published after logical termination, at or after a deadline,',
  'or after a newer writer claimed the same channel. Blocked partials count attempted writes denied by the runtime.',
  '',
  '## Failures and policy omissions',
  '',
  ...report.variants.flatMap(({ name, failures }) => [
    '### ' + name, '',
    ...failures.map(({ event, id, outcome, reason }) => '- #' + id + ' ' + event + ' · ' + outcome + ' · ' + reason),
    '',
  ]),
];
const folder = 'benchmarks/results';
mkdirSync(folder, { recursive: true });
writeFileSync(folder + '/phase4a-runtime.json', JSON.stringify(report, null, 2) + '\n');
writeFileSync(folder + '/phase4a-runtime.md', lines.join('\n'));
console.log(lines.slice(0, 11 + report.variants.length).join('\n'));
