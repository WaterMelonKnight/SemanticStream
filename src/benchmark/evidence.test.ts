import { describe, expect, it } from 'vitest';
import { countResourceViolations, evaluateEvidence } from './evidence';
import type { EvidenceDelivery } from './evidence';
import type { BenchmarkScene } from './types';

const region = { x: 1, y: 1, width: 2, height: 2 };
const scene: BenchmarkScene = {
  id: 'historical-evidence', suite: 'evaluation', description: 'One captured event.',
  frames: [{ sequence: 1, timestampMs: 20, sample: new Uint8ClampedArray(16) }],
  events: [{ id: 'event', kind: 'brief', startMs: 10, endMs: 40, region, description: 'A brief event.' }],
};

function delivery(capturedAtMs: number, deliveredAtMs: number): EvidenceDelivery {
  return { sequence: 1, capturedAtMs, deliveredAtMs, bytes: 16 };
}

describe('replay evidence time', () => {
  it('audits historical evidence in the rolling window in which it was delivered', () => {
    const history = delivery(20, 4_999);
    const next = delivery(5_025, 5_025);
    expect(countResourceViolations([next, history], 1, 16, 5_000)).toBe(1);
    expect(countResourceViolations([history, delivery(5_025, 9_999)], 1, 16, 5_000)).toBe(0);
  });

  it('separates captured evidence, delivery latency, deadline, and crop footprint', () => {
    const historical = delivery(20, 44);
    const outside = { ...historical, region: { ...region, x: 3 } };
    const unavailable = evaluateEvidence(scene, [], [outside]);
    expect(unavailable).toMatchObject({
      capturedEvents: 0, timing: { retrievalTemporalEvents: 1, retrievalSpatialEvents: 0 },
    });
    expect(evaluateEvidence(scene, [], [historical])).toMatchObject({
      capturedEvents: 1,
      meanFirstCaptureLatencyMs: 10,
      timing: { deadlineCoveredEvents: 0, meanFirstDeliveryLatencyMs: 34, retrievalSpatialEvents: 1 },
    });
    expect(evaluateEvidence(scene, [delivery(20, 40)]).timing.deadlineCoveredEvents).toBe(0);
    expect(evaluateEvidence(scene, [delivery(20, 39)]).timing.deadlineCoveredEvents).toBe(1);
  });
});
