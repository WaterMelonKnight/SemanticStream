import { evidenceCsvColumns, evidenceCsvValues, evidenceTimingTable } from './evidence-report';
import type { DecisionAction } from '../decision/types';
import type { TaskAggregate, TaskReport, TaskSceneResult, TaskSuiteResult } from './task-types';

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

function actionSummary(actions: Readonly<Record<DecisionAction, number>>): string {
  return (Object.entries(actions) as Array<[DecisionAction, number]>)
    .filter(([, count]) => count > 0)
    .map(([action, count]) => `${action}=${count}`)
    .join('|');
}

function resultRow(result: TaskSceneResult): Array<string | number | null> {
  return [
    result.suite, result.sceneId, result.sceneDescription, result.strategy, result.strategyLabel,
    result.task.taskId, result.task.category, result.task.priority,
    result.inputs, result.observableEvents, result.roiObservableEvents,
    result.realtimeSent, result.retrievalFrames, result.retrievalBytes, result.totalSent, result.totalBytes,
    result.realtimeCapturedEvents, result.realtimeRecall.toFixed(6),
    result.postCapturedEvents, result.postRetrievalRecall.toFixed(6),
    result.roiRealtimeCapturedEvents, result.roiRealtimeRecall.toFixed(6),
    result.roiPostCapturedEvents, result.roiPostRetrievalRecall.toFixed(6),
    result.missedBefore, result.missedAfter, result.roiMissedBefore, result.roiMissedAfter,
    result.realtimeFirstCaptureLatencyMs?.toFixed(3) ?? null,
    result.postFirstCaptureLatencyMs?.toFixed(3) ?? null,
    result.retrievalRequests, result.retrievalDenied,
    result.retrievalLatencyMeanMs?.toFixed(4) ?? null,
    result.peakCacheBytes, result.peakCacheFrames, result.evictions,
    result.realtimeBudgetViolations, result.retrievalBudgetViolations, result.totalBudgetViolations,
    result.decisionRequests, result.decisionFallbacks,
    result.decisionLatencyMeanMs?.toFixed(4) ?? null,
    result.decisionLatencyP95Ms?.toFixed(4) ?? null,
    actionSummary(result.actions),
    result.missedBeforeIds.join('|'), result.missedAfterIds.join('|'),
    result.decisionDigest,
    ...evidenceCsvValues(result),
  ];
}

function aggregateRow(aggregate: TaskAggregate): Array<string | number | null> {
  return [
    'evaluation', 'AGGREGATE', '', aggregate.strategy, aggregate.strategyLabel,
    '', '', '',
    aggregate.inputs, aggregate.observableEvents, aggregate.roiObservableEvents,
    aggregate.realtimeSent, aggregate.retrievalFrames, aggregate.retrievalBytes, aggregate.totalSent, aggregate.totalBytes,
    aggregate.realtimeCapturedEvents, aggregate.realtimeRecall.toFixed(6),
    aggregate.postCapturedEvents, aggregate.postRetrievalRecall.toFixed(6),
    aggregate.roiRealtimeCapturedEvents, aggregate.roiRealtimeRecall.toFixed(6),
    aggregate.roiPostCapturedEvents, aggregate.roiPostRetrievalRecall.toFixed(6),
    aggregate.missedBefore, aggregate.missedAfter, null, null,
    null, null,
    aggregate.retrievalRequests, aggregate.retrievalDenied,
    aggregate.retrievalLatencyMeanMs?.toFixed(4) ?? null,
    aggregate.peakCacheBytes, aggregate.peakCacheFrames, aggregate.evictions,
    aggregate.realtimeBudgetViolations, aggregate.retrievalBudgetViolations, aggregate.totalBudgetViolations,
    aggregate.decisionRequests, aggregate.decisionFallbacks,
    aggregate.decisionLatencyMeanMs?.toFixed(4) ?? null, null,
    actionSummary(aggregate.actions),
    '', '', '',
    ...evidenceCsvValues(aggregate),
  ];
}

export function formatTaskCsv(report: TaskReport): string {
  const header = [
    'suite', 'scene', 'scene_description', 'strategy', 'strategy_label',
    'task_id', 'task_category', 'task_priority',
    'inputs', 'observable_events', 'roi_observable_events',
    'realtime_sent', 'retrieval_frames', 'retrieval_bytes', 'total_sent', 'total_bytes',
    'realtime_captured', 'realtime_recall', 'post_captured', 'post_recall',
    'roi_realtime_captured', 'roi_realtime_recall', 'roi_post_captured', 'roi_post_recall',
    'missed_before', 'missed_after', 'roi_missed_before', 'roi_missed_after',
    'realtime_first_capture_ms', 'post_first_capture_ms',
    'retrieval_requests', 'retrieval_denied', 'retrieval_latency_mean_ms',
    'peak_cache_bytes', 'peak_cache_frames', 'evictions',
    'realtime_budget_violations', 'retrieval_budget_violations', 'total_budget_violations',
    'decision_requests', 'decision_fallbacks', 'decision_latency_mean_ms', 'decision_latency_p95_ms',
    'actions', 'missed_before_ids', 'missed_after_ids', 'decision_digest',
    ...evidenceCsvColumns,
  ];
  const rows: Array<Array<string | number | null>> = [header];
  const evaluation = report.suites.evaluation;
  for (const result of evaluation.results) rows.push(resultRow(result));
  for (const aggregate of evaluation.aggregates) rows.push(aggregateRow(aggregate));
  return rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

function aggregateTable(aggregates: readonly TaskAggregate[]): string {
  const lines = [
    '| Strategy | Realtime recall | Post-retrieval recall | ROI realtime recall | ROI post-retrieval | Retrieval frames | Total sent | Cache peak | Budget violations | Decision latency | Fallbacks |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const aggregate of aggregates) {
    lines.push(
      `| ${aggregate.strategyLabel} | ${percent(aggregate.realtimeRecall)} (${aggregate.realtimeCapturedEvents}/${aggregate.observableEvents}) `
      + `| ${percent(aggregate.postRetrievalRecall)} (${aggregate.postCapturedEvents}/${aggregate.observableEvents}) `
      + `| ${percent(aggregate.roiRealtimeRecall)} (${aggregate.roiRealtimeCapturedEvents}/${aggregate.roiObservableEvents}) `
      + `| ${percent(aggregate.roiPostRetrievalRecall)} (${aggregate.roiPostCapturedEvents}/${aggregate.roiObservableEvents}) `
      + `| ${aggregate.retrievalFrames} | ${aggregate.totalSent} | ${bytes(aggregate.peakCacheBytes)} / ${aggregate.peakCacheFrames} frames `
      + `| ${aggregate.realtimeBudgetViolations} / ${aggregate.retrievalBudgetViolations} / ${aggregate.totalBudgetViolations} `
      + `| ${aggregate.decisionLatencyMeanMs === null ? '—' : number(aggregate.decisionLatencyMeanMs, 3) + ' ms'} `
      + `| ${aggregate.decisionFallbacks} |`,
    );
  }
  return lines.join('\n');
}

function taskTable(report: TaskReport): string {
  const lines = [
    '| Scene | Task | Category | Priority | ROI |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const scene of report.suites.evaluation.scenes) {
    const roi = scene.task.roi
      ? `${scene.task.roi.x},${scene.task.roi.y} ${scene.task.roi.width}×${scene.task.roi.height}`
      : 'full frame';
    lines.push(`| ${scene.id} | ${scene.task.taskId} | ${scene.task.category} | ${scene.task.priority} | ${roi} |`);
  }
  return lines.join('\n');
}

function sceneTable(suite: TaskSuiteResult): string {
  const lines = [
    '| Scene | Strategy | Realtime | Post | ROI realtime | ROI post | Retrieval | Total sent | Budget |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  const order = new Map(suite.scenes.map((scene, index) => [scene.id, index]));
  const strategyOrder = new Map([['fixed', 0], ['local', 1], ['local-retrieval', 2], ['task-aware', 3]]);
  const results = [...suite.results].sort((left, right) => {
    const scene = (order.get(left.sceneId) ?? 0) - (order.get(right.sceneId) ?? 0);
    return scene !== 0 ? scene : (strategyOrder.get(left.strategy) ?? 0) - (strategyOrder.get(right.strategy) ?? 0);
  });
  for (const result of results) {
    lines.push(
      `| ${result.sceneId} | ${result.strategyLabel} | ${percent(result.realtimeRecall)} | ${percent(result.postRetrievalRecall)} `
      + `| ${percent(result.roiRealtimeRecall)} | ${percent(result.roiPostRetrievalRecall)} `
      + `| ${result.retrievalFrames} | ${result.totalSent} `
      + `| ${result.realtimeBudgetViolations} / ${result.retrievalBudgetViolations} / ${result.totalBudgetViolations} |`,
    );
  }
  return lines.join('\n');
}

function missedTable(report: TaskReport): string {
  const lines = [
    '| Scene | Strategy | Missed before | Missed after | ROI missed before | ROI missed after |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const result of report.suites.evaluation.results) {
    if (!result.missedBeforeIds.length && !result.missedAfterIds.length) continue;
    lines.push(
      `| ${result.sceneId} | ${result.strategyLabel} | ${result.missedBeforeIds.join(', ') || '—'} `
      + `| ${result.missedAfterIds.join(', ') || '—'} | ${result.roiMissedBefore} | ${result.roiMissedAfter} |`,
    );
  }
  return lines.join('\n');
}

export function formatTaskMarkdown(report: TaskReport): string {
  const evaluation = report.suites.evaluation;
  const taskAware = evaluation.aggregates.find((aggregate) => aggregate.strategy === 'task-aware');
  const local = evaluation.aggregates.find((aggregate) => aggregate.strategy === 'local');
  return `# SemanticStream Phase 3A corrected replay — Task-Aware Decision Engine

Generated by \`npm run benchmark\`. This is a real deterministic replay result, not a hand-written example.

## Configuration

- Samples: ${report.configuration.sampleWidth} × ${report.configuration.sampleHeight} RGBA at ${report.configuration.frameRate} fps
- Real-time budget: ${report.configuration.realtimeFrameLimit} frames / 5 s; minimum interval ${report.configuration.minimumIntervalMs} ms; silence refresh ${report.configuration.maximumSilenceMs} ms
- Local policy: ${report.configuration.localThreshold}% per ${report.configuration.localBlockWidth}×${report.configuration.localBlockHeight} block
- Buffer: ${report.configuration.bufferMaxAgeMs} ms / ${report.configuration.bufferMaxFrames} frames / ${bytes(report.configuration.bufferMaxBytes)}
- Retrieval budget: ${report.configuration.retrievalMaxFrames} frames / ${bytes(report.configuration.retrievalMaxBytes)} per 5 s
- Combined budget: ${report.configuration.totalMaxFrames} frames / ${bytes(report.configuration.totalMaxBytes)} per 5 s
- Decision interval: ${report.configuration.decisionIntervalMs} ms

## Task declarations

Task ROI is authored below and is not derived from evaluator event labels. Event labels are used only after replay to score recall.

${taskTable(report)}

## Held-out evaluation

${evaluation.scenes.length} scenes, ${evaluation.aggregates[0]?.observableEvents ?? 0} observable events.

${aggregateTable(evaluation.aggregates)}

${evidenceTimingTable(evaluation.aggregates)}

### Task-aware vs baselines

${local && taskAware
  ? `D's overall post-retrieval recall is ${percent(taskAware.postRetrievalRecall)} versus ${percent(local.postRetrievalRecall)} for B. Its ROI post-retrieval recall is ${percent(taskAware.roiPostRetrievalRecall)} versus ${percent(local.roiPostRetrievalRecall)}. It sent ${taskAware.totalSent} frames versus ${local.totalSent}. This is not evidence that the new policy is uniformly better; see the per-scene and failure tables.`
  : 'No comparison available.'}

### Per-scene results

${sceneTable(evaluation)}

### Misses

${missedTable(report)}

## Action space

D uses the heuristic Rule Decision provider at a 100 ms interval. Its action counts across the evaluation are:

${taskAware
  ? (Object.entries(taskAware.actions) as Array<[DecisionAction, number]>).filter(([, count]) => count > 0).map(([action, count]) => `- **${action}**: ${count}`).join('\n')
  : 'No task-aware results.'}

Decision scores are rule weights, not calibrated probabilities. The provider returns only actions; admission, budgets, and effect execution remain outside the model boundary.

## Notes

${report.notes.map((note) => `- ${note}`).join('\n')}
`;
}
