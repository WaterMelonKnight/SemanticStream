import { evidenceCsvColumns, evidenceCsvValues, evidenceTimingTable } from './evidence-report';
import type {
  Phase2Aggregate,
  Phase2Report,
  Phase2SceneResult,
  Phase2SuiteResult,
} from './retrieval-types';

function percent(value: number): string {
  return `${(100 * value).toFixed(1)}%`;
}

function number(value: number, digits = 2): string {
  return value.toFixed(digits);
}

function bytes(value: number): string {
  if (value < 1_000) return `${value} B`;
  if (value < 1_000_000) return `${number(value / 1_000, 1)} KB`;
  return `${number(value / 1_000_000, 2)} MB`;
}

function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function sceneRow(result: Phase2SceneResult): Array<string | number | null> {
  return [
    result.suite,
    result.sceneId,
    result.sceneDescription,
    result.strategy,
    result.strategyLabel,
    String(result.oracle),
    result.inputs,
    result.observableEvents,
    result.unobservableEvents,
    result.realtimeSent,
    result.retrievalFrames,
    result.retrievalBytes,
    result.totalSent,
    result.totalBytes,
    result.realtimeCapturedEvents,
    result.realtimeRecall.toFixed(6),
    result.postCapturedEvents,
    result.postRetrievalRecall.toFixed(6),
    result.missedBefore,
    result.missedAfter,
    result.realtimeFirstCaptureLatencyMs?.toFixed(3) ?? null,
    result.postFirstCaptureLatencyMs?.toFixed(3) ?? null,
    result.retrievalRequests,
    result.retrievalDenied,
    result.retrievalLatencyMeanMs?.toFixed(4) ?? null,
    result.retrievalLatencyP95Ms?.toFixed(4) ?? null,
    result.peakCacheBytes,
    result.peakCacheFrames,
    result.evictions,
    result.evictionsByAge,
    result.evictionsByFrames,
    result.evictionsByBytes,
    result.realtimeBudgetViolations,
    result.retrievalBudgetViolations,
    result.totalBudgetViolations,
    result.outsideRealtime,
    result.outsideRetrieval,
    result.missedBeforeIds.join('|'),
    result.missedAfterIds.join('|'),
    result.inputDigest,
    result.decisionDigest,
    ...evidenceCsvValues(result),
  ];
}

function aggregateRow(suite: string, aggregate: Phase2Aggregate): Array<string | number | null> {
  return [
    suite,
    'AGGREGATE',
    '',
    aggregate.strategy,
    aggregate.strategyLabel,
    String(aggregate.oracle),
    aggregate.inputs,
    aggregate.observableEvents,
    aggregate.unobservableEvents,
    aggregate.realtimeSent,
    aggregate.retrievalFrames,
    aggregate.retrievalBytes,
    aggregate.totalSent,
    aggregate.totalBytes,
    aggregate.realtimeCapturedEvents,
    aggregate.realtimeRecall.toFixed(6),
    aggregate.postCapturedEvents,
    aggregate.postRetrievalRecall.toFixed(6),
    aggregate.missedBefore,
    aggregate.missedAfter,
    aggregate.realtimeFirstCaptureLatencyMs?.toFixed(3) ?? null,
    aggregate.postFirstCaptureLatencyMs?.toFixed(3) ?? null,
    aggregate.retrievalRequests,
    aggregate.retrievalDenied,
    aggregate.retrievalLatencyMeanMs?.toFixed(4) ?? null,
    null,
    aggregate.peakCacheBytes,
    aggregate.peakCacheFrames,
    aggregate.evictions,
    null,
    null,
    null,
    aggregate.realtimeBudgetViolations,
    aggregate.retrievalBudgetViolations,
    aggregate.totalBudgetViolations,
    aggregate.outsideRealtime,
    aggregate.outsideRetrieval,
    '',
    '',
    '',
    '',
    ...evidenceCsvValues(aggregate),
  ];
}

export function formatPhase2Csv(report: Phase2Report): string {
  const header = [
    'suite', 'scene', 'scene_description', 'strategy', 'strategy_label', 'oracle',
    'inputs', 'observable_events', 'unobservable_events',
    'realtime_sent', 'retrieval_frames', 'retrieval_bytes', 'total_sent', 'total_bytes',
    'realtime_captured', 'realtime_recall', 'post_captured', 'post_retrieval_recall',
    'missed_before', 'missed_after', 'realtime_first_capture_ms', 'post_first_capture_ms',
    'retrieval_requests', 'retrieval_denied', 'retrieval_latency_mean_ms', 'retrieval_latency_p95_ms',
    'peak_cache_bytes', 'peak_cache_frames', 'evictions', 'evictions_age', 'evictions_frames', 'evictions_bytes',
    'realtime_budget_violations', 'retrieval_budget_violations', 'total_budget_violations',
    'outside_realtime', 'outside_retrieval', 'missed_before_ids', 'missed_after_ids',
    'input_digest', 'decision_digest',
    ...evidenceCsvColumns,
  ];
  const rows: Array<Array<string | number | null>> = [header];
  for (const suite of ['tuning', 'evaluation'] as const) {
    const result = report.suites[suite];
    for (const sceneResult of result.results) rows.push(sceneRow(sceneResult));
    for (const aggregate of result.aggregates) rows.push(aggregateRow(suite, aggregate));
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

function aggregateTable(aggregates: readonly Phase2Aggregate[]): string {
  const lines = [
    '| Strategy | Oracle? | Realtime recall | Post-retrieval recall | Realtime sent | Retrieval frames | Retrieval bytes | Retrieval latency | Total sent | Cache peak | Evictions | Violations (rt / ret / total) |',
    '| --- | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const aggregate of aggregates) {
    lines.push(
      `| ${aggregate.strategyLabel} | ${aggregate.oracle ? 'yes' : 'no'} `
      + `| ${percent(aggregate.realtimeRecall)} (${aggregate.realtimeCapturedEvents}/${aggregate.observableEvents}) `
      + `| ${percent(aggregate.postRetrievalRecall)} (${aggregate.postCapturedEvents}/${aggregate.observableEvents}) `
      + `| ${aggregate.realtimeSent} | ${aggregate.retrievalFrames} | ${bytes(aggregate.retrievalBytes)} `
      + `| ${aggregate.retrievalLatencyMeanMs === null ? '—' : number(aggregate.retrievalLatencyMeanMs, 3) + ' ms'} `
      + `| ${aggregate.totalSent} | ${bytes(aggregate.peakCacheBytes)} / ${aggregate.peakCacheFrames} frames `
      + `| ${aggregate.evictions} | ${aggregate.realtimeBudgetViolations} / ${aggregate.retrievalBudgetViolations} / ${aggregate.totalBudgetViolations} |`,
    );
  }
  return lines.join('\n');
}

function focusTable(report: Phase2Report): string {
  const lines = [
    '| Strategy | Realtime recall | Post-retrieval recall | Retrieved frames | Before miss | After miss |',
    '| --- | ---: | ---: | ---: | --- | --- |',
  ];
  for (const focus of report.focus) {
    lines.push(
      `| ${focus.strategyLabel} | ${percent(focus.realtimeRecall)} | ${percent(focus.postRetrievalRecall)} `
      + `| ${focus.retrievalFrames} | ${focus.missedBeforeIds.join(', ') || '—'} | ${focus.missedAfterIds.join(', ') || '—'} |`,
    );
  }
  return lines.join('\n');
}

function sceneTable(suite: Phase2SuiteResult): string {
  const lines = [
    '| Scene | Strategy | Oracle | Realtime recall | Post-retrieval recall | Retrieved | Cache peak | Evictions |',
    '| --- | --- | :---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  const order = new Map(suite.scenes.map((scene, index) => [scene.id, index]));
  const strategyOrder = new Map([
    ['fixed', 0], ['local', 1], ['local-retrieval', 2], ['local-oracle-retrieval', 3],
  ]);
  const results = [...suite.results].sort((left, right) => {
    const scene = (order.get(left.sceneId) ?? 0) - (order.get(right.sceneId) ?? 0);
    return scene !== 0 ? scene : (strategyOrder.get(left.strategy) ?? 0) - (strategyOrder.get(right.strategy) ?? 0);
  });
  for (const result of results) {
    lines.push(
      `| ${result.sceneId} | ${result.strategyLabel} | ${result.oracle ? 'yes' : 'no'} `
      + `| ${percent(result.realtimeRecall)} | ${percent(result.postRetrievalRecall)} `
      + `| ${result.retrievalFrames} | ${bytes(result.peakCacheBytes)} | ${result.evictions} |`,
    );
  }
  return lines.join('\n');
}

function cueSelectionTable(report: Phase2Report): string {
  const lines = [
    '| Cue interval | Tuning post-retrieval recall | Tuning retrieval frames | Tuning denials |',
    '| ---: | ---: | ---: | ---: |',
  ];
  for (const candidate of report.cueSelection.candidates) {
    lines.push(
      `| ${candidate.intervalMs} ms | ${percent(candidate.postRetrievalRecall)} `
      + `| ${candidate.retrievalFrames} | ${candidate.retrievalDenied} |`,
    );
  }
  return lines.join('\n');
}

export function formatPhase2Markdown(report: Phase2Report): string {
  const { configuration, cueSelection } = report;
  const evaluation = report.suites.evaluation;
  const local = evaluation.aggregates.find((aggregate) => aggregate.strategy === 'local');
  const cue = evaluation.aggregates.find((aggregate) => aggregate.strategy === 'local-retrieval');
  const oracle = evaluation.aggregates.find((aggregate) => aggregate.strategy === 'local-oracle-retrieval');
  return `# SemanticStream Phase 2 corrected replay — Bounded Context Buffer and Active Retrieval

Generated by \`npm run benchmark\`. This report is a real deterministic replay result, not a hand-written example.

## Configuration

- Samples: ${configuration.sampleWidth} × ${configuration.sampleHeight} RGBA at ${configuration.frameRate} fps
- Real-time budget: ${configuration.realtimeFrameLimit} frames / 5 s; minimum interval ${configuration.minimumIntervalMs} ms; silence refresh ${configuration.maximumSilenceMs} ms
- Local policy: ${configuration.localThreshold}% per ${configuration.localBlockWidth}×${configuration.localBlockHeight} block
- Buffer bounds: ${configuration.bufferMaxAgeMs} ms / ${configuration.bufferMaxFrames} frames / ${bytes(configuration.bufferMaxBytes)}
- Retrieval budget: ${configuration.retrievalMaxFrames} frames and ${bytes(configuration.retrievalMaxBytes)} per ${configuration.retrievalWindowMs / 1_000} s
- Combined real-time + retrieval budget: ${configuration.totalMaxFrames} frames and ${bytes(configuration.totalMaxBytes)} per ${configuration.retrievalWindowMs / 1_000} s
- Selected cue interval: ${configuration.cueIntervalMs} ms

## Cue selection

${cueSelection.rule}

${cueSelectionTable(report)}

**Selected:** ${cueSelection.intervalMs} ms.

## Held-out evaluation

${evaluation.scenes.length} scenes, ${evaluation.aggregates[0]?.observableEvents ?? 0} observable events, ${evaluation.aggregates[0]?.unobservableEvents ?? 0} event inside a capture gap.

${aggregateTable(evaluation.aggregates)}

${evidenceTimingTable(evaluation.aggregates)}

### Phase 1B failure recovery: background motion

The Phase 1B local policy missed \`eval-motion-text\` because irrelevant background motion exhausted the budget. This is the target case for active retrieval.

${focusTable(report)}

### Per-scene evaluation

${sceneTable(evaluation)}

## Cue vs oracle

- **C · Local + cue retrieval** uses only a real system signal: a real-time decision that failed the rolling budget. It requests the latest buffered frame with a ${configuration.cueIntervalMs} ms minimum spacing. It does not read event labels.
- **Oracle · local + label-timed retrieval** reads event midpoint labels and requests the corresponding frame. It is an **upper-bound experiment only**. It is not evidence that an agent can discover those events autonomously.

The cue strategy improves the held-out post-retrieval recall from ${local ? percent(local.postRetrievalRecall) : '—'} to ${cue ? percent(cue.postRetrievalRecall) : '—'} while adding ${cue?.retrievalFrames ?? 0} retrieval frames and ${bytes(cue?.retrievalBytes ?? 0)}. The oracle reaches ${oracle ? percent(oracle.postRetrievalRecall) : '—'} with ${oracle?.retrievalFrames ?? 0} retrieval frames, but it bypasses the production retrieval budget. It is headroom evidence, not a deployable result.

## Cache behavior

The buffer is bounded by age, byte count, and frame count. It stores owned RGBA copies, not Canvas references. Peak memory and evictions are per scene; the aggregate uses the maximum peak and the sum of evictions.

- No whole-video cache is created.
- A frame that was never captured (for example during a capture pause) cannot be recovered by retrieval. The hidden pause event remains unreachable.
- Requests for evicted, not-yet-captured, nonexistent, or wrong-session data return explicit statuses instead of empty success.

## Notes

${report.notes.map((note) => `- ${note}`).join('\n')}

### Strategy labels

${report.configuration.strategies.map((strategy) => `- **${strategy.id}**: ${strategy.label} — ${strategy.cue}`).join('\n')}
`;
}
