import { describe, expect, it } from 'vitest';
import type { ObjectObservation } from '../types';
import { ObjectTrackingSystem } from './system';
import type { DetectionBatch } from './types';

let sequence = 0;
function detection(
  sessionId: string,
  x: number,
  y: number,
  options: { categoryId?: number; score?: number; width?: number; height?: number; at?: number } = {},
): ObjectObservation {
  const frame = ++sequence;
  const at = options.at ?? frame * 100;
  return {
    sessionId,
    frameSequence: frame,
    capturedAtMs: at,
    submittedAtMs: at,
    completedAtMs: at,
    detectorId: 'fixture',
    modelVersion: '1',
    categoryId: options.categoryId ?? 1,
    categoryName: 'person',
    score: options.score ?? 0.9,
    box: { x, y, width: options.width ?? 20, height: options.height ?? 20 },
    evidence: {
      sourceKind: 'demo',
      frameSequence: frame,
      capturedAtMs: at,
      frameRef: sessionId + ':' + frame,
      input: { width: 100, height: 100, scale: 1, offsetX: 0, offsetY: 0 },
    },
  };
}

function batch(sessionId: string, at: number, detections: readonly ObjectObservation[], status: DetectionBatch['status'] = 'ok'): DetectionBatch {
  return { sessionId, observedAtMs: at, frameSequence: at, frameWidth: 100, frameHeight: 100, status, detections };
}

const config = {
  tracker: { confirmHits: 2, lostAfterMs: 600, expireAfterMs: 2_000, maxAssociationGapMs: 1_500, minConfidence: 0.3, maxCenterDistance: 0.3, minIou: 0.05 },
  events: { minMoveDistance: 0.03, stationaryAfterMs: 1_000, cooldownMs: 0 },
};

describe('object tracking system', () => {
  it('keeps a stable track for a moving object and emits appeared/moved', () => {
    const system = new ObjectTrackingSystem('s', config);
    const a = detection('s', 10, 10, { at: 0 });
    const b = detection('s', 12, 10, { at: 100 });
    const first = system.process(batch('s', 0, [a]));
    expect(first.frame.tracks[0].trackingState).toBe('TENTATIVE');
    const second = system.process(batch('s', 100, [b]));
    expect(second.frame.tracks).toHaveLength(1);
    expect(second.frame.tracks[0].trackingState).toBe('CONFIRMED');
    expect(second.events.map((event) => event.eventType)).toContain('OBJECT_APPEARED');
    const moved = system.process(batch('s', 500, [detection('s', 40, 10, { at: 500 })]));
    expect(moved.frame.tracks[0].trackId).toBe(second.frame.tracks[0].trackId);
    expect(moved.events.map((event) => event.eventType)).toContain('OBJECT_MOVED');
    expect(moved.events.find((event) => event.eventType === 'OBJECT_MOVED')?.certainty).toBe('image-coordinate-only');
  });

  it('does not merge two same-category objects that cross', () => {
    const system = new ObjectTrackingSystem('s', { ...config, tracker: { ...config.tracker, maxCenterDistance: 0.5 } });
    system.process(batch('s', 0, [detection('s', 5, 10, { at: 0 }), detection('s', 75, 10, { at: 0 })]));
    system.process(batch('s', 100, [detection('s', 25, 10, { at: 100 }), detection('s', 55, 10, { at: 100 })]));
    const cross = system.process(batch('s', 200, [detection('s', 45, 10, { at: 200 }), detection('s', 45, 30, { at: 200 })]));
    expect(cross.frame.tracks.length).toBe(2);
    expect(new Set(cross.frame.tracks.map((track) => track.trackId)).size).toBe(2);
  });

  it('distinguishes a valid empty batch from skipped/failed detection', () => {
    const system = new ObjectTrackingSystem('s', config);
    system.process(batch('s', 0, [detection('s', 10, 10, { at: 0 })]));
    system.process(batch('s', 100, [detection('s', 10, 10, { at: 100 })]));
    const skipped = system.process(batch('s', 5_000, [], 'skipped'));
    expect(skipped.frame.processed).toBe(false);
    expect(skipped.frame.tracks[0]?.trackingState).toBe('CONFIRMED');
    const empty = system.process(batch('s', 5_000, [], 'ok'));
    expect(empty.frame.tracks).toHaveLength(0);
    expect(empty.frame.expired[0].trackingState).toBe('EXPIRED');
    expect(empty.events.map((event) => event.eventType)).toContain('OBJECT_EXPIRED');
  });

  it('temporarily loses then reappears for a valid occlusion gap', () => {
    const system = new ObjectTrackingSystem('s', config);
    system.process(batch('s', 0, [detection('s', 10, 10, { at: 0 })]));
    system.process(batch('s', 100, [detection('s', 10, 10, { at: 100 })]));
    const lost = system.process(batch('s', 800, []));
    expect(lost.events.map((event) => event.eventType)).toContain('OBJECT_TEMPORARILY_LOST');
    const reappeared = system.process(batch('s', 1_100, [detection('s', 12, 10, { at: 1_100 })]));
    expect(reappeared.events.map((event) => event.eventType)).toContain('OBJECT_REAPPEARED');
    expect(reappeared.frame.tracks[0].trackingState).toBe('CONFIRMED');
  });

  it('ignores low-confidence detections and isolates sessions', () => {
    const system = new ObjectTrackingSystem('a', config);
    const low = system.process(batch('a', 0, [detection('a', 10, 10, { score: 0.1 })]));
    expect(low.frame.tracks).toHaveLength(0);
    system.process(batch('a', 100, [detection('a', 10, 10, { at: 100 })]));
    const other = system.process(batch('b', 200, [detection('b', 40, 40, { at: 200 })]));
    expect(other.frame.sessionId).toBe('b');
    expect(other.frame.tracks).toHaveLength(1);
    expect(other.frame.tracks[0].sessionId).toBe('b');
  });

  it('bounds index entries/history/events and reports evidence unavailable without resolver', () => {
    const system = new ObjectTrackingSystem('s', {
      ...config,
      index: { maxTracks: 2, maxHistoryPerTrack: 3, maxEvents: 2, historyWindowMs: 10_000 },
    });
    for (let index = 0; index < 8; index += 1) {
      system.process(batch('s', index * 100, [detection('s', index * 8, 10, { categoryId: index, at: index * 100 })]));
    }
    const state = system.snapshot();
    expect(state.indexEntries).toBeLessThanOrEqual(2);
    expect(state.eventLogSize).toBeLessThanOrEqual(2);
    const trackId = state.tracks[0]?.trackId;
    if (trackId) {
      expect(system.getObjectHistory(trackId).length).toBeLessThanOrEqual(3);
      const evidence = system.getObjectEvidence(trackId, 500);
      expect(evidence.status).toBe('unavailable');
      expect(evidence.message).toContain('no image cache');
    }
  });

  it('suppresses repeated stationary events with cooldown/hysteresis', () => {
    const system = new ObjectTrackingSystem('s', {
      ...config,
      events: { minMoveDistance: 0.5, stationaryAfterMs: 500, cooldownMs: 200 },
    });
    system.process(batch('s', 0, [detection('s', 10, 10, { at: 0 })]));
    system.process(batch('s', 100, [detection('s', 10, 10, { at: 100 })]));
    let stationary = 0;
    for (let index = 2; index < 12; index += 1) {
      const result = system.process(batch('s', index * 200, [detection('s', 10, 10, { at: index * 200 })]));
      stationary += result.events.filter((event) => event.eventType === 'OBJECT_STATIONARY').length;
    }
    expect(stationary).toBe(1);
  });
});
