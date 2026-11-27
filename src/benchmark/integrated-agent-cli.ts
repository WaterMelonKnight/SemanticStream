import { writeFileSync } from 'node:fs';
import { runIntegratedBenchmark } from './integrated-agent';

const report = await runIntegratedBenchmark();
const lines = [
  '# Phase 4I · Integrated Agent replay',
  '',
  'Deterministic simulation using fixture detections, a logical clock and a scripted provider. Actual cost is unavailable.',
  'All modes use the same capture sequence, detector, two logical slots and hard budgets. A uses all eligible events and FIFO.',
  'B uses task-aware filtering and FIFO. SemanticStream uses the same filtering as B with context-aware scheduling.',
  '',
  '| Mode | Authorized coverage | False positives | Misses | Unanswered tasks | Calls | Context bytes | Mock tokens | P50/P95 ms | Budget violations |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...report.variants.map((r) => `| ${r.mode} | ${r.successes}/${r.expected} | ${r.falsePositives} | ${r.misses} | ${r.unanswered} | ${r.calls} | ${r.contextBytes} | ${r.mockTokens} | ${r.p50Ms}/${r.p95Ms} | ${r.violations} |`),
  '',
  'Coverage is the share of expected fixture events that receive at least one authorized partial. The replay does not score answer correctness.',
  'Misses count unanswered expected opportunities, including policy suppression. Unanswered tasks count offered tasks with no effective output.',
  'Latency includes only observed output. Mock tokens are simulated usage and cannot establish real cost savings. JSON includes case outcomes, suppression and stale blocks.',
  '',
];
writeFileSync('benchmarks/results/phase4i-integrated-agent.json', JSON.stringify(report, null, 2) + '\n');
writeFileSync('benchmarks/results/phase4i-integrated-agent.md', lines.join('\n'));
console.log(lines.join('\n'));
