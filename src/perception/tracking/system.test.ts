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

function batch(
  sessionId: string, at: number, detections: readonly ObjectObservation[], status: DetectionBatch['status'] = 'ok',
  frameSequence = at, completedAtMs?: number,
): DetectionBatch {
  return { sessionId, observedAtMs: at, frameSequence, completedAtMs, frameWidth: 100, frameHeight: 100, status,
    detections: detections.map((item) => ({
      ...item, frameSequence, completedAtMs: completedAtMs ?? item.completedAtMs,
      evidence: { ...item.evidence, frameSequence },
    })),
  };
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
    const empty = system.process(batch('s', 5_001, []));
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
    const wrong = system.process(batch('b', 200, [detection('b', 40, 40, { at: 200 })]));
    expect(wrong.frame.status).toBe('wrong-session');
    expect(wrong.frame.sessionId).toBe('a');
    system.reset('b');
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
      const evidence = system.getObjectEvidence(trackId, 700);
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

describe('Phase 4P.2 review invariants', () => {
  it('uses completion time for lost/expired events and preserves previous state', () => {
    const system = new ObjectTrackingSystem('time', {
      tracker: { confirmHits: 1, lostAfterMs: 500, expireAfterMs: 1_000, maxAssociationGapMs: 1_000, minConfidence: 0.3 },
      events: { stationaryAfterMs: 10_000, cooldownMs: 0 },
    });
    const first = { ...detection('time', 10, 10, { at: 100 }), completedAtMs: 500 };
    system.process({ ...batch('time', 100, [first]), capturedAtMs: 100, completedAtMs: 500 });
    const lost = system.process({ ...batch('time', 1_000, []), capturedAtMs: 1_000, completedAtMs: 1_200 });
    const lostEvent = lost.events.find((event) => event.eventType === 'OBJECT_TEMPORARILY_LOST');
    expect(lostEvent?.observedAtMs).toBe(1_200);
    expect(lostEvent?.previousState).toBe('CONFIRMED');
    const expired = system.process({ ...batch('time', 2_000, []), capturedAtMs: 2_000, completedAtMs: 2_300 });
    const expiredEvent = expired.events.find((event) => event.eventType === 'OBJECT_EXPIRED');
    expect(expiredEvent?.observedAtMs).toBe(2_300);
    expect(expiredEvent?.previousState).toBe('TEMPORARILY_LOST');
  });

  it('does not emit reappeared for a never-confirmed tentative track', () => {
    const system = new ObjectTrackingSystem('tentative', {
      tracker: { confirmHits: 2, lostAfterMs: 100, expireAfterMs: 1_000, maxAssociationGapMs: 500, minConfidence: 0.3 },
      events: { stationaryAfterMs: 10_000, cooldownMs: 0 },
    });
    system.process(batch('tentative', 0, [detection('tentative', 10, 10, { at: 0 })]));
    const lost = system.process(batch('tentative', 200, []));
    expect(lost.frame.tracks[0]?.trackingState).toBe('TEMPORARILY_LOST');
    const again = system.process(batch('tentative', 300, [detection('tentative', 11, 10, { at: 300 })]));
    expect(again.events.map((event) => event.eventType)).toContain('OBJECT_APPEARED');
    expect(again.events.map((event) => event.eventType)).not.toContain('OBJECT_REAPPEARED');
  });

  it('rejects duplicate/out-of-order/wrong-session/invalid batches without aging', () => {
    const system = new ObjectTrackingSystem('s', config);
    system.process(batch('s', 0, [detection('s', 10, 10, { at: 0 })]));
    system.process(batch('s', 100, [detection('s', 10, 10, { at: 100 })]));
    const duplicate = system.process(batch('s', 100, [detection('s', 10, 10, { at: 100 })]));
    expect(duplicate.frame.status).toBe('duplicate');
    expect(duplicate.frame.tracks[0]?.observationCount).toBe(2);
    const wrong = system.process(batch('other', 200, [detection('other', 10, 10, { at: 200 })]));
    expect(wrong.frame.status).toBe('wrong-session');
    expect(system.snapshot().sessionId).toBe('s');
    const invalid = system.process(batch('s', 200, [detection('s', 10, 10, { at: 200, score: Number.NaN })], 'ok', 3));
    expect(invalid.frame.status).toBe('invalid-observation');
    expect(invalid.frame.tracks[0]?.observationCount).toBe(2);
    const invalidTime = system.process(batch('s', 300, [], 'ok', 4, 50));
    expect(invalidTime.frame.status).toBe('invalid-observation');
    expect(invalidTime.frame.tracks[0]?.trackingState).toBe('CONFIRMED');
  });

  it('never returns future evidence and distinguishes expired/wrong-session evidence', () => {
    const resolver = { resolve: (lookup: { sessionId: string; trackId: string; atMs: number; evidenceRef: string }) => ({
      status: 'available' as const, sessionId: lookup.sessionId, trackId: lookup.trackId,
      requestedAtMs: lookup.atMs, evidenceRef: lookup.evidenceRef, capturedAtMs: lookup.atMs, message: 'attached',
    }) };
    const system = new ObjectTrackingSystem('s', {
      ...config,
      tracker: { ...config.tracker, confirmHits: 1, lostAfterMs: 100, expireAfterMs: 300, maxAssociationGapMs: 300 },
      index: { evidenceResolver: resolver },
    });
    system.process(batch('s', 0, [detection('s', 10, 10, { at: 0 })]));
    const trackId = system.getTrackedObjects()[0].trackId;
    expect(system.getObjectEvidence(trackId, -1).status).toBe('unavailable');
    expect(system.getObjectEvidence(trackId, 0, 'wrong').status).toBe('wrong-session');
    system.process(batch('s', 500, [], 'ok', 2));
    expect(system.getObjectEvidence(trackId, 0).status).toBe('available');
  });

  it('keeps all internal tracking state bounded across 10000 unique-track cycles', () => {
    const system = new ObjectTrackingSystem('churn', {
      tracker: { confirmHits: 1, minConfidence: 0.3, lostAfterMs: 100, expireAfterMs: 200, maxAssociationGapMs: 200, maxTracks: 8 },
      events: { stationaryAfterMs: 10_000, cooldownMs: 0, maxStateTracks: 16, stateTtlMs: 50 },
      index: { maxTracks: 8, maxHistoryPerTrack: 4, maxEvents: 20, historyWindowMs: 1000 },
    });
    for (let index = 0; index < 10_000; index += 1) {
      const at = index * 300;
      system.process(batch('churn', at, [detection('churn', 10, 10, { categoryId: index, at })]));
      system.process(batch('churn', at + 250, []));
    }
    const diagnostics = system.diagnostics();
    expect(diagnostics.trackerTracks).toBeLessThanOrEqual(8);
    expect(diagnostics.indexEntries).toBeLessThanOrEqual(8);
    expect(diagnostics.historyEntries).toBeLessThanOrEqual(8);
    expect(diagnostics.eventLogSize).toBeLessThanOrEqual(20);
    expect(diagnostics.eventStateEntries).toBeLessThanOrEqual(16);
    expect(diagnostics.listenerCount).toBe(0);
  });

  it('runs with the default production configuration', () => {
    const system = new ObjectTrackingSystem('defaults');
    for (let index = 0; index < 8; index += 1) {
      const at = index * 500;
      system.process(batch('defaults', at, [detection('defaults', 10 + index, 10, { at })], 'ok', index));
    }
    const diag = system.diagnostics();
    expect(diag.inputBatches).toBe(8);
    expect(diag.activeCount).toBe(1);
    expect(diag.processingP50Ms).not.toBeNull();
  });
});

  it('rejects a completed batch whose completion time goes backwards', () => {
    const system = new ObjectTrackingSystem('ordered', { tracker: { confirmHits: 1, maxAssociationGapMs: 5_000, expireAfterMs: 5_000, lostAfterMs: 1_000 } });
    system.process(batch('ordered', 100, [detection('ordered', 10, 10, { at: 100 })], 'ok', 1, 1_000));
    const late = system.process(batch('ordered', 200, [], 'ok', 2, 300));
    expect(late.frame.status).toBe('invalid-time');
    expect(late.frame.tracks[0]?.trackingState).toBe('CONFIRMED');
  });

describe('bounded ownership and subscriptions', () => {
  it('caps listeners and makes unsubscribe idempotent', () => {
    const system = new ObjectTrackingSystem('listeners');
    const unsubs = Array.from({ length: 32 }, () => system.subscribe(() => undefined));
    expect(() => system.subscribe(() => undefined)).toThrow(RangeError);
    expect(system.diagnostics().listenerCount).toBe(32);
    unsubs[0]();
    unsubs[0]();
    expect(system.diagnostics().listenerCount).toBe(31);
  });

  it('evicts state-index entries with their histories and prefers expired entries', () => {
    const system = new ObjectTrackingSystem('evict', {
      tracker: { confirmHits: 1, maxTracks: 4, lostAfterMs: 100, expireAfterMs: 200, maxAssociationGapMs: 200 },
      index: { maxTracks: 2, maxHistoryPerTrack: 3, maxEvents: 10, historyWindowMs: 1_000 },
    });
    // One confirmed track, then expire it.
    system.process(batch('evict', 0, [detection('evict', 10, 10, { categoryId: 1, at: 0 })], 'ok', 1));
    system.process(batch('evict', 500, [], 'ok', 2));
    expect(system.snapshot().expiredCount).toBe(1);
    // Two new active tracks force the expired one out before active entries.
    system.process(batch('evict', 600, [detection('evict', 30, 10, { categoryId: 2, at: 600 })], 'ok', 3));
    system.process(batch('evict', 700, [detection('evict', 50, 10, { categoryId: 3, at: 700 })], 'ok', 4));
    const state = system.snapshot();
    expect(state.indexEntries).toBeLessThanOrEqual(2);
    expect(state.expiredCount).toBe(0);
    expect(system.diagnostics().historyEntries).toBeLessThanOrEqual(2);
    expect(system.diagnostics().activeEvictions).toBe(0);
  });
});

  it('evicts active entries only after expired/lost candidates and cleans their history', () => {
    const system = new ObjectTrackingSystem('active-evict', {
      tracker: { confirmHits: 1, maxTracks: 3, lostAfterMs: 100, expireAfterMs: 200, maxAssociationGapMs: 200 },
      index: { maxTracks: 1, maxHistoryPerTrack: 2, maxEvents: 5, historyWindowMs: 1_000 },
    });
    system.process(batch('active-evict', 0, [detection('active-evict', 10, 10, { categoryId: 1, at: 0 })], 'ok', 1));
    system.process(batch('active-evict', 100, [detection('active-evict', 40, 10, { categoryId: 2, at: 100 })], 'ok', 2));
    const state = system.snapshot();
    expect(state.indexEntries).toBeLessThanOrEqual(1);
    expect(system.diagnostics().historyEntries).toBeLessThanOrEqual(1);
    expect(system.diagnostics().activeEvictions).toBe(1);
  });

  it('rejects invalid observation session/box/confidence without changing state', () => {
    const system = new ObjectTrackingSystem('invalid', { tracker: { confirmHits: 1 } });
    system.process(batch('invalid', 0, [detection('invalid', 10, 10, { at: 0 })], 'ok', 1));
    const base = detection('invalid', 10, 10, { at: 100 });
    for (const candidate of [
      { ...base, sessionId: 'other' },
      { ...base, score: Number.NaN },
      { ...base, score: 1.1 },
      { ...base, box: { x: Number.NaN, y: 10, width: 10, height: 10 } },
      { ...base, box: { x: 10, y: 10, width: 0, height: 10 } },
    ]) {
      const result = system.process(batch('invalid', 100, [candidate], 'ok', 2));
      expect(result.frame.status).toBe('invalid-observation');
      expect(system.getTrackedObjects()).toHaveLength(1);
    }
  });

describe('time-window configuration invariants', () => {
  it('rejects impossible lost/expire/association windows', () => {
    expect(() => new ObjectTrackingSystem('bad', { tracker: { lostAfterMs: 200, expireAfterMs: 100 } })).toThrow(RangeError);
    expect(() => new ObjectTrackingSystem('bad', { tracker: { maxAssociationGapMs: 2_000, expireAfterMs: 1_000 } })).toThrow(RangeError);
  });
});

describe('expiry from a confirmed state', () => {
  it('preserves CONFIRMED as previousState when expiry happens without an intermediate lost batch', () => {
    const system = new ObjectTrackingSystem('direct-expiry', {
      tracker: { confirmHits: 1, lostAfterMs: 500, expireAfterMs: 1_000, maxAssociationGapMs: 1_000, minConfidence: 0.3 },
      events: { stationaryAfterMs: 10_000, cooldownMs: 0 },
    });
    system.process(batch('direct-expiry', 0, [detection('direct-expiry', 10, 10, { at: 0 })], 'ok', 1, 100));
    const result = system.process(batch('direct-expiry', 2_000, [], 'ok', 2, 2_100));
    const expired = result.events.find((event) => event.eventType === 'OBJECT_EXPIRED');
    expect(expired?.previousState).toBe('CONFIRMED');
    expect(expired?.observedAtMs).toBe(2_100);
  });
});

describe('provider category ids', () => {
  it('accepts opaque safe-integer category ids including unknown -1', () => {
    const system = new ObjectTrackingSystem('opaque', { tracker: { confirmHits: 1 } });
    system.process(batch('opaque', 0, [detection('opaque', 10, 10, { categoryId: -1, at: 0 })], 'ok', 1));
    expect(system.getTrackedObjects()[0]?.categoryId).toBe(-1);
  });
});

describe('integrated identity and causal evidence', () => {
  it('uses normalized names and model namespaces when category IDs are unknown', () => {
    const system = new ObjectTrackingSystem('s', { tracker: { confirmHits: 1 } });
    const input = (at: number, categoryName: string, modelVersion = '1') => batch('s', at, [{
      ...detection('s', 10, 10, { at, categoryId: -1 }), categoryName, modelVersion,
    }]);
    system.process(input(100, ' Dog '));
    system.process(input(300, 'ＤＯＧ'));
    system.process(input(600, 'person'));
    system.process(input(900, 'dog', '2'));
    expect(system.getTrackedObjects().map((track) => track.observationCount)).toEqual([2, 1, 1]);
  });

  it('rejects mismatched frame identity or capture time even if the boxes are usable', () => {
    const system = new ObjectTrackingSystem('s');
    const good = batch('s', 200, [detection('s', 10, 10, { at: 200 })]);
    const observation = good.detections[0];
    for (const mismatch of [
      { ...observation, frameSequence: 199 },
      { ...observation, capturedAtMs: 199 },
      { ...observation, evidence: { ...observation.evidence, capturedAtMs: 201 } },
      { ...observation, sessionId: 'other' },
    ]) expect(system.process({ ...good, detections: [mismatch] }).frame.status).toBe('invalid-observation');
    expect(system.process(good).frame.status).toBe('ok');
  });

  it('does not extend stationary evidence over a missed observation and isolates listeners', () => {
    const system = new ObjectTrackingSystem('s', {
      tracker: { confirmHits: 1, lostAfterMs: 1_500 },
      events: { stationaryAfterMs: 400 },
    });
    let received = 0;
    system.subscribe(() => { throw new Error('listener unavailable'); });
    system.subscribe(() => { received += 1; });
    system.process(batch('s', 0, [detection('s', 10, 10, { at: 0 })]));
    expect(system.process(batch('s', 500, [])).events).toHaveLength(0);
    const resume = system.process(batch('s', 600, [detection('s', 10, 10, { at: 600 })]));
    expect(resume.events).toHaveLength(0);
    expect(received).toBe(1);
    expect(system.diagnostics().listenerErrors).toBe(1);
  });

  it('keeps capture, confirmation, production and historical lookup times distinct', () => {
    const system = new ObjectTrackingSystem('s', { tracker: { confirmHits: 1 }, clock: () => 450 });
    const established = system.process(batch('s', 100, [detection('s', 10, 10, { at: 100 })], 'ok', 1, 300));
    const event = established.events[0];
    expect(event).toMatchObject({ observedAtMs: 300, stateChangedAtMs: 300, producedAtMs: 450,
      evidence: { capturedAtMs: 100, frameSequence: 1 } });
    expect(system.getObjectEvidence(event.trackId, 250)).toMatchObject({ status: 'unavailable' });
    expect(system.getObjectEvidence(event.trackId, 400)).toMatchObject({
      status: 'unavailable', capturedAtMs: 100, requestedAtMs: 400,
    });
    expect(system.getObjectHistory(event.trackId)[0]).toMatchObject({ atMs: 300, evidence: { capturedAtMs: 100 } });
  });
});
