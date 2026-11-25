import type {
  BenchmarkFailureCase,
  BenchmarkReport,
  BenchmarkStrategyId,
  SceneSuiteResult,
  StrategyAggregate,
  StrategySceneResult,
} from './types';

function percent(value: number): string {
  return `${(100 * value).toFixed(1)}%`;
}

function number(value: number, digits = 2): string {
  return value.toFixed(digits);
}

function latency(value: number | null): string {
  return value === null ? '—' : `${number(value, 1)} ms`;
}

function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function resultRow(result: StrategySceneResult): Array<string | number | null> {
  return [
    result.suite,
    result.sceneId,
    result.sceneDescription,
    result.strategy,
    result.strategyLabel,
    result.inputs,
    result.sent,
    result.events,
    result.observableEvents,
    result.capturedEvents,
    result.missedEvents,
    result.unobservableEvents,
    result.recall.toFixed(6),
    result.meanFirstCaptureLatencyMs?.toFixed(3) ?? null,
    result.maxFirstCaptureLatencyMs?.toFixed(3) ?? null,
    result.sentOutsideEvents,
    result.meanProcessingMs.toFixed(4),
    result.p95ProcessingMs.toFixed(4),
    result.budgetViolations,
    result.missedEventIds.join('|'),
    result.inputDigest,
    result.decisionDigest,
  ];
}

function aggregateRow(suite: string, aggregate: StrategyAggregate): Array<string | number | null> {
  return [
    suite,
    'AGGREGATE',
    '',
    aggregate.strategy,
    aggregate.strategyLabel,
    aggregate.inputs,
    aggregate.sent,
    aggregate.events,
    aggregate.observableEvents,
    aggregate.capturedEvents,
    aggregate.missedEvents,
    aggregate.unobservableEvents,
    aggregate.recall.toFixed(6),
    aggregate.meanFirstCaptureLatencyMs?.toFixed(3) ?? null,
    aggregate.maxFirstCaptureLatencyMs?.toFixed(3) ?? null,
    aggregate.sentOutsideEvents,
    aggregate.meanProcessingMs.toFixed(4),
    null,
    aggregate.budgetViolations,
    '',
    '',
    '',
  ];
}

export function formatReportCsv(report: BenchmarkReport): string {
  const header = [
    'suite',
    'scene',
    'scene_description',
    'strategy',
    'strategy_label',
    'inputs',
    'sent',
    'events',
    'observable_events',
    'captured_events',
    'missed_events',
    'unobservable_events',
    'recall',
    'mean_first_capture_latency_ms',
    'max_first_capture_latency_ms',
    'sent_outside_events',
    'mean_processing_ms',
    'p95_processing_ms',
    'budget_violations',
    'missed_event_ids',
    'input_digest',
    'decision_digest',
  ];
  const rows: Array<Array<string | number | null>> = [header];
  for (const suite of ['tuning', 'evaluation'] as const) {
    const result = report.suites[suite];
    for (const sceneResult of result.results) rows.push(resultRow(sceneResult));
    for (const aggregate of result.aggregates) rows.push(aggregateRow(suite, aggregate));
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

function aggregateTable(aggregates: readonly StrategyAggregate[]): string {
  const lines = [
    '| Strategy | Sent | Recall | Missed | Unobservable | First capture (mean / max) | Sends outside events | Mean processing | Budget violations |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const aggregate of aggregates) {
    lines.push(
      `| ${aggregate.strategyLabel} | ${aggregate.sent} | ${percent(aggregate.recall)} `
      + `(${aggregate.capturedEvents}/${aggregate.observableEvents}) | ${aggregate.missedEvents} | ${aggregate.unobservableEvents} `
      + `| ${latency(aggregate.meanFirstCaptureLatencyMs)} / ${latency(aggregate.maxFirstCaptureLatencyMs)} `
      + `| ${aggregate.sentOutsideEvents} | ${number(aggregate.meanProcessingMs, 3)} ms | ${aggregate.budgetViolations} |`,
    );
  }
  return lines.join('\n');
}

function sceneTable(suite: SceneSuiteResult): string {
  const lines = [
    '| Scene | Strategy | Sent | Captured | Recall | First capture | Outside events | Budget violations |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  const sceneOrder = new Map(suite.scenes.map((scene, index) => [scene.id, index]));
  const results = [...suite.results].sort((left, right) => {
    const order = (sceneOrder.get(left.sceneId) ?? 0) - (sceneOrder.get(right.sceneId) ?? 0);
    if (order !== 0) return order;
    return left.strategy.localeCompare(right.strategy);
  });
  for (const result of results) {
    lines.push(
      `| ${result.sceneId} | ${result.strategyLabel} | ${result.sent} `
      + `| ${result.capturedEvents}/${result.observableEvents} | ${percent(result.recall)} `
      + `| ${latency(result.meanFirstCaptureLatencyMs)} | ${result.sentOutsideEvents} | ${result.budgetViolations} |`,
    );
  }
  return lines.join('\n');
}

function failureAnalysis(report: BenchmarkReport): string {
  const evaluation = report.suites.evaluation;
  const failures = report.failureCases.filter((failure) => failure.suite === 'evaluation');
  if (!failures.length) return 'No observable events were missed in the held-out suite.';
  const lines: string[] = [];
  const fixedMisses = failures.filter((failure) => failure.strategy === 'fixed');
  const globalMisses = failures.filter((failure) => failure.strategy === 'global');
  const localMisses = failures.filter((failure) => failure.strategy === 'local');
  const hybridMisses = failures.filter((failure) => failure.strategy === 'hybrid');
  const globalAggregate = evaluation.aggregates.find((aggregate) => aggregate.strategy === 'global');
  const motionLocal = evaluation.results.find(
    (result) => result.sceneId === 'eval-background-motion' && result.strategy === 'local',
  );
  const motionHybrid = evaluation.results.find(
    (result) => result.sceneId === 'eval-background-motion' && result.strategy === 'hybrid',
  );

  if (fixedMisses.length) {
    lines.push(`- **Fixed** missed ${fixedMisses.map((failure) => `'${failure.sceneId}/${failure.eventId}'`).join(', ')}. The 100 ms brief event can fall between the 250 ms fixed slots.`);
  }
  if (globalMisses.length && globalAggregate) {
    lines.push(`- **Global RGB** missed ${globalAggregate.missedEvents} of ${globalAggregate.observableEvents} observable events. Its 1.5% whole-frame gate and 1.5 s silence refresh did not react to sub-1% local text and low-contrast changes.`);
  }
  if (localMisses.length || hybridMisses.length) {
    const motionResult = motionLocal ?? motionHybrid;
    const motionText = motionResult
      ? `even though they sent ${motionResult.sent} frames in that scene (${motionResult.sentOutsideEvents} outside labeled events)`
      : '';
    const uniqueMisses = new Map(
      [...localMisses, ...hybridMisses].map((failure) => [`${failure.sceneId}/${failure.eventId}`, failure]),
    );
    lines.push(`- **Local and hybrid** missed ${[...uniqueMisses.values()].map((failure) => `'${failure.sceneId}/${failure.eventId}'`).join(', ')} ${motionText}. The unrelated moving object consumed the rolling 20-frame budget before the labeled event; this is a real budget/backpressure failure, not a labeling error.`);
  }
  lines.push('- The hidden pause event is excluded from recall because the capture gap contains no input frame.');
  return lines.join('\n');
}

function missedByStrategy(report: BenchmarkReport, suite: 'tuning' | 'evaluation'): string {
  const failures = report.failureCases.filter((failure) => failure.suite === suite);
  const byStrategy = new Map<BenchmarkStrategyId, BenchmarkFailureCase[]>();
  for (const failure of failures) {
    const current = byStrategy.get(failure.strategy) ?? [];
    current.push(failure);
    byStrategy.set(failure.strategy, current);
  }
  if (!byStrategy.size) return 'No observable events were missed.';
  const lines: string[] = [];
  for (const [strategy, strategyFailures] of byStrategy) {
    const label = report.configuration.strategies.find((entry) => entry.id === strategy)?.label ?? strategy;
    lines.push(`- **${label}**: ${strategyFailures.map((failure) => `${failure.sceneId}/${failure.eventId} (${failure.eventKind})`).join(', ')}`);
  }
  return lines.join('\n');
}

function unobservableEvents(report: BenchmarkReport): string {
  const rows: string[] = [];
  for (const suite of ['tuning', 'evaluation'] as const) {
    for (const scene of report.suites[suite].scenes) {
      for (const event of scene.events) {
        const result = report.suites[suite].results.find(
          (entry) => entry.sceneId === scene.id && entry.unobservableEventIds.includes(event.id),
        );
        if (result) rows.push(`| ${suite} | ${scene.id} | ${event.id} | ${event.kind} | ${event.startMs}–${event.endMs} |`);
      }
    }
  }
  if (!rows.length) return 'None.';
  return [
    '| Suite | Scene | Event | Kind | Window |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function selectionTable(report: BenchmarkReport): string {
  const selected = report.selection.local;
  const lines = [
    '| Local threshold | Block | Local recall | Hybrid recall | Local sends | Hybrid sends | Local outside | Hybrid outside | Score | Selected |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |',
  ];
  for (const candidate of report.selection.candidates) {
    const isSelected = candidate.config.threshold === selected.threshold
      && candidate.config.blockWidth === selected.blockWidth
      && candidate.config.blockHeight === selected.blockHeight;
    lines.push(
      `| ${candidate.config.threshold}% | ${candidate.config.blockWidth}×${candidate.config.blockHeight} `
      + `| ${percent(candidate.local.recall)} | ${percent(candidate.hybrid.recall)} `
      + `| ${candidate.local.sent} | ${candidate.hybrid.sent} `
      + `| ${candidate.local.sentOutsideEvents} | ${candidate.hybrid.sentOutsideEvents} `
      + `| ${number(candidate.score, 3)} | ${isSelected ? 'yes' : ''} |`,
    );
  }
  return lines.join('\n');
}

export function formatReportMarkdown(report: BenchmarkReport): string {
  const { configuration, selection } = report;
  const tuning = report.suites.tuning;
  const evaluation = report.suites.evaluation;
  const selected = selection.local;
  return `# SemanticStream Phase 1B — Budget-Aware Event Evaluation

Generated by \`npm run benchmark\`. This file is a real replay result, not a hand-written example.

## Replay configuration

- Sample size: ${configuration.sampleWidth} × ${configuration.sampleHeight} RGBA
- Capture cadence: ${configuration.frameRate} fps, deterministic timestamps
- Budget: ${configuration.frameLimit} frames / ${configuration.budgetWindowMs / 1_000} s
- Minimum delivery interval: ${configuration.minimumIntervalMs} ms
- Maximum silence refresh: ${configuration.maximumSilenceMs} ms
- Global baseline threshold: ${configuration.globalThreshold}% mean RGB change
- Selected local detector: ${selected.threshold}% per ${selected.blockWidth}×${selected.blockHeight} block, at least ${selected.minChangedBlocks} changed block(s)
- Strategies: ${configuration.strategies.map((strategy) => strategy.label).join(' · ')}

## Parameter selection

${selection.rule}

${selectionTable(report)}

**Selected:** ${selected.threshold}% per ${selected.blockWidth}×${selected.blockHeight} block.

## Held-out evaluation suite

${evaluation.scenes.length} scenes, ${evaluation.scenes.reduce((total, scene) => total + scene.events.length, 0)} labeled events (${evaluation.aggregates[0]?.observableEvents ?? 0} observable outside capture gaps). The evaluation suite is not used for parameter selection.

${aggregateTable(evaluation.aggregates)}

### Per-scene evaluation

${sceneTable(evaluation)}

### Observable events missed

${missedByStrategy(report, 'evaluation')}

### Unobservable events

These events occur entirely inside a capture gap. No policy can recover them; they are excluded from recall.

${unobservableEvents(report)}

## Failure analysis

${failureAnalysis(report)}

## Tuning suite

Shown for transparency. This suite selected the local detector parameters.

${aggregateTable(tuning.aggregates)}

## How to read recall

Recall means **at least one delivered frame timestamp falls inside the event's labeled window**. It says nothing about whether a vision model or language model understood the event. Event labels and regions are used only after replay; they are never passed to a policy.

A send outside a labeled event is not automatically wrong: the event set is intentionally sparse and does not label every meaningful visual change. Treat it as a diagnostic, not a precision score.

## Notes

${report.notes.map((note) => `- ${note}`).join('\n')}
`;
}
