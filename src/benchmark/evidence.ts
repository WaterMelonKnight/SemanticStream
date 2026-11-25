import type { PixelRegion } from '../core/context-buffer';
import type { EventAnnotation, BenchmarkScene } from './types';

export interface EvidenceDelivery {
  readonly sequence: number;
  readonly capturedAtMs: number;
  readonly deliveredAtMs: number;
  readonly bytes: number;
  /** Full-frame delivery when absent. */
  readonly region?: PixelRegion;
}

export interface EvidenceTiming {
  readonly deadlineCoveredEvents: number;
  readonly retrievalTemporalEvents: number;
  readonly retrievalSpatialEvents: number;
  readonly meanFirstDeliveryLatencyMs: number | null;
}

export function intersection(a: PixelRegion, b: PixelRegion): PixelRegion | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

function inEvent(timestampMs: number, event: EventAnnotation): boolean {
  return timestampMs >= event.startMs && timestampMs < event.endMs;
}

export function evaluateEvidence(
  scene: BenchmarkScene,
  realtime: readonly EvidenceDelivery[],
  retrieval: readonly EvidenceDelivery[] = [],
  roi?: PixelRegion,
) {
  let observableEvents = 0;
  let capturedEvents = 0;
  let deadlineCoveredEvents = 0;
  let retrievalTemporalEvents = 0;
  let retrievalSpatialEvents = 0;
  let captureLatency = 0;
  let deliveryLatency = 0;
  const missedEventIds: string[] = [];
  const combined = [...realtime, ...retrieval];

  for (const event of scene.events) {
    const target = roi ? intersection(event.region, roi) : event.region;
    if (!target || !scene.frames.some((frame) => inEvent(frame.timestampMs, event))) continue;
    observableEvents += 1;
    const canShowEvent = (delivery: EvidenceDelivery): boolean => inEvent(delivery.capturedAtMs, event)
      && (!delivery.region || intersection(delivery.region, target) !== null);
    if (retrieval.some((delivery) => inEvent(delivery.capturedAtMs, event))) retrievalTemporalEvents += 1;
    if (retrieval.some(canShowEvent)) retrievalSpatialEvents += 1;
    const matches = combined.filter(canShowEvent);
    if (!matches.length) {
      missedEventIds.push(event.id);
      continue;
    }
    capturedEvents += 1;
    const firstDelivery = Math.min(...matches.map((delivery) => delivery.deliveredAtMs));
    const firstCapture = Math.min(...matches.map((delivery) => delivery.capturedAtMs));
    if (firstDelivery < event.endMs) deadlineCoveredEvents += 1;
    captureLatency += firstCapture - event.startMs;
    deliveryLatency += firstDelivery - event.startMs;
  }

  return {
    observableEvents,
    capturedEvents,
    missedEvents: missedEventIds.length,
    missedEventIds,
    recall: observableEvents ? capturedEvents / observableEvents : 0,
    meanFirstCaptureLatencyMs: capturedEvents ? captureLatency / capturedEvents : null,
    timing: {
      deadlineCoveredEvents, retrievalTemporalEvents, retrievalSpatialEvents,
      meanFirstDeliveryLatencyMs: capturedEvents ? deliveryLatency / capturedEvents : null,
    } satisfies EvidenceTiming,
  };
}

export function aggregateEvidenceTiming(
  results: readonly { readonly postCapturedEvents: number; readonly evidenceTiming: EvidenceTiming }[],
): EvidenceTiming {
  let captured = 0;
  let totalLatency = 0;
  let deadlineCoveredEvents = 0;
  let retrievalTemporalEvents = 0;
  let retrievalSpatialEvents = 0;
  for (const { postCapturedEvents, evidenceTiming } of results) {
    captured += postCapturedEvents;
    totalLatency += (evidenceTiming.meanFirstDeliveryLatencyMs ?? 0) * postCapturedEvents;
    deadlineCoveredEvents += evidenceTiming.deadlineCoveredEvents;
    retrievalTemporalEvents += evidenceTiming.retrievalTemporalEvents;
    retrievalSpatialEvents += evidenceTiming.retrievalSpatialEvents;
  }
  return {
    deadlineCoveredEvents, retrievalTemporalEvents, retrievalSpatialEvents,
    meanFirstDeliveryLatencyMs: captured ? totalLatency / captured : null,
  };
}

/** Independent audit ordered by expenditure time. A multi-frame response has one entry per delivered frame. */
export function countResourceViolations(
  deliveries: readonly EvidenceDelivery[], maxFrames: number, maxBytes: number, windowMs: number,
): number {
  const ordered = [...deliveries].sort((a, b) => a.deliveredAtMs - b.deliveredAtMs);
  let first = 0;
  let bytes = 0;
  let violations = 0;
  for (const [index, delivery] of ordered.entries()) {
    while (first < index && delivery.deliveredAtMs >= ordered[first].deliveredAtMs + windowMs) {
      bytes -= ordered[first++].bytes;
    }
    bytes += delivery.bytes;
    if (index - first + 1 > maxFrames || bytes > maxBytes) violations += 1;
  }
  return violations;
}
