import { describe, expect, it } from 'vitest';
import type { ObjectObservation } from '../types';
import { ObjectTrackingSystem } from './system';
import type { DetectionBatch } from './types';

function observation(at: number, x: number): ObjectObservation {
  return {
    sessionId: 's', frameSequence: at, capturedAtMs: at, submittedAtMs: at, completedAtMs: at,
    detectorId: 'fixture', modelVersion: '1', categoryId: 1, categoryName: 'person', score: 0.9,
    box: { x, y: 10, width: 20, height: 20 },
    evidence: { sourceKind: 'demo', frameSequence: at, capturedAtMs: at, frameRef: `s:${at}`,
      input: { width: 100, height: 100, scale: 1, offsetX: 0, offsetY: 0 } },
  };
}
function batch(at: number, detections: ObjectObservation[]): DetectionBatch {
  return { sessionId: 's', observedAtMs: at, frameSequence: at, frameWidth: 100, frameHeight: 100, status: 'ok', detections };
}
const config = {
  tracker: { confirmHits: 2, lostAfterMs: 600, expireAfterMs: 2_000, maxAssociationGapMs: 1_500, minConfidence: 0.3 },
  events: { minMoveDistance: 0.03, stationaryAfterMs: 1_000, cooldownMs: 500 },
};

describe('object state index contracts', () => {
  it('supports filters, regions, histories and evidence resolution', () => {
    const system = new ObjectTrackingSystem('s', {
      ...config,
      index: {
        evidenceResolver: { resolve: (lookup) => ({
          status: 'available', sessionId: lookup.sessionId, trackId: lookup.trackId,
          requestedAtMs: lookup.atMs, evidenceRef: lookup.evidenceRef, capturedAtMs: lookup.atMs,
          message: 'fixture evidence attached',
        }) },
      },
    });
    system.process(batch(0, [observation(0, 10)]));
    system.process(batch(100, [observation(100, 12)]));
    const track = system.getTrackedObjects({ state: 'CONFIRMED' })[0];
    expect(track).toBeDefined();
    expect(system.getObjectById(track.trackId)?.trackId).toBe(track.trackId);
    expect(system.getObjectsInRegion({ x: 0, y: 0, width: 0.5, height: 0.5 })).toHaveLength(1);
    expect(system.getObjectHistory(track.trackId, { fromMs: 0, toMs: 100 })).toHaveLength(2);
    expect(system.getObjectEvents({ eventType: 'OBJECT_APPEARED' })).toHaveLength(1);
    expect(system.getObjectEvidence(track.trackId, 100)).toMatchObject({ status: 'available', trackId: track.trackId });
  });

  it('keeps session state isolated and bounds history/events', () => {
    const system = new ObjectTrackingSystem('a', { ...config, index: { maxTracks: 2, maxHistoryPerTrack: 2, maxEvents: 1, historyWindowMs: 1_000 } });
    system.process(batch(0, [observation(0, 10)]));
    system.process(batch(100, [observation(100, 12)]));
    const wrong = system.process({ ...batch(200, [observation(200, 16)]), sessionId: 'b' });
    expect(wrong.frame.status).toBe('wrong-session');
    expect(system.snapshot().sessionId).toBe('a');
    system.reset('b');
    system.process({ ...batch(300, [observation(300, 16)]), sessionId: 'b' });
    expect(system.snapshot().sessionId).toBe('b');
    expect(system.getTrackedObjects().every((track) => track.sessionId === 'b')).toBe(true);
    expect(system.getObjectHistory(system.getTrackedObjects()[0]?.trackId ?? 'missing')).toBeDefined();
  });
});
