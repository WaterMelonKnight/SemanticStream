import type { EvidenceTiming } from './evidence';

interface EvidenceResult {
  readonly evidenceTiming: EvidenceTiming;
  readonly retrievalAvailable: number;
}

export const evidenceCsvColumns = [
  'deadline_covered_events', 'retrieval_temporal_events', 'retrieval_spatial_events',
  'mean_first_delivery_latency_ms', 'available_retrieval_requests',
];

export function evidenceCsvValues(result: EvidenceResult): Array<string | number | null> {
  const timing = result.evidenceTiming;
  return [
    timing.deadlineCoveredEvents, timing.retrievalTemporalEvents, timing.retrievalSpatialEvents,
    timing.meanFirstDeliveryLatencyMs?.toFixed(3) ?? null, result.retrievalAvailable,
  ];
}

export function evidenceTimingTable(
  results: readonly (EvidenceResult & {
    readonly strategyLabel: string;
    readonly observableEvents: number;
    readonly retrievalRequests: number;
  })[],
): string {
  return [
    '| Strategy | Before event end | Events with retrieved captures | Events with overlapping retrieved pixels | First evidence delivery | Available requests |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...results.map(({ strategyLabel, evidenceTiming: t, observableEvents, retrievalAvailable, retrievalRequests }) =>
      `| ${strategyLabel} | ${t.deadlineCoveredEvents}/${observableEvents} | ${t.retrievalTemporalEvents} `
      + `| ${t.retrievalSpatialEvents} | ${t.meanFirstDeliveryLatencyMs?.toFixed(1) ?? '—'} ms `
      + `| ${retrievalAvailable}/${retrievalRequests} |`),
  ].join('\n');
}
