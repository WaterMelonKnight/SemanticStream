import type { ObjectObservation } from '../perception/types';
import type { DetectionBatchStatus, ObjectEventType } from '../perception/tracking/types';
import { ObjectTrackingSystem } from '../perception/tracking/system';

export interface FixtureBox {
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width?: number;
  readonly height?: number;
  readonly score?: number;
}

export interface FixtureFrame {
  readonly atMs: number;
  readonly status?: DetectionBatchStatus;
  readonly session?: string;
  readonly detections: readonly FixtureBox[];
}

export interface TrackingFixture {
  readonly name: string;
  readonly description: string;
  readonly frames: readonly FixtureFrame[];
  readonly expectedEvents: readonly ObjectEventType[];
  readonly expectedSwitches?: number;
}

export interface FixtureResult {
  readonly name: string;
  readonly description: string;
  readonly rawDetections: number;
  readonly frames: number;
  readonly tracks: number;
  readonly expired: number;
  readonly idSwitches: number;
  readonly associationCorrect: number;
  readonly associationTotal: number;
  readonly events: readonly ObjectEventType[];
  readonly expectedEvents: readonly ObjectEventType[];
  readonly eventPrecision: number;
  readonly eventRecall: number;
  readonly duplicateEvents: number;
  readonly suppressedEvents: number;
  readonly activeMax: number;
  readonly indexEntries: number;
  readonly eventLogSize: number;
  readonly indexEvictions: number;
  readonly processingMs: number;
  readonly processingMaxMs: number;
  readonly firstEventLatencyMs: number | null;
}

const EVENT_ORDER: readonly ObjectEventType[] = [
  'OBJECT_APPEARED', 'OBJECT_MOVED', 'OBJECT_STATIONARY', 'OBJECT_TEMPORARILY_LOST',
  'OBJECT_REAPPEARED', 'OBJECT_EXPIRED', 'OBJECT_ENTERED_REGION', 'OBJECT_LEFT_REGION',
];

export const TRACKING_FIXTURES: readonly TrackingFixture[] = [
  {
    name: 'moving-object',
    description: 'One person-like box moves steadily; labels are synthetic.',
    expectedEvents: ['OBJECT_APPEARED', 'OBJECT_MOVED'],
    expectedSwitches: 0,
    frames: Array.from({ length: 10 }, (_, index) => ({
      atMs: index * 250,
      detections: [{ label: 'A', x: 10 + index * 5, y: 20 }],
    })),
  },
  {
    name: 'stationary-jitter',
    description: 'A static box has one-pixel jitter; it should not create repeated movement.',
    expectedEvents: ['OBJECT_APPEARED', 'OBJECT_STATIONARY'],
    expectedSwitches: 0,
    frames: Array.from({ length: 14 }, (_, index) => ({
      atMs: index * 250,
      detections: [{ label: 'A', x: index % 2 === 0 ? 30 : 31, y: 20 }],
    })),
  },
  {
    name: 'crossing-same-category',
    description: 'Two same-category objects approach and overlap; identity is ambiguous without appearance/ReID.',
    expectedEvents: ['OBJECT_APPEARED', 'OBJECT_MOVED'],
    frames: [
      { atMs: 0, detections: [{ label: 'A', x: 5, y: 20 }, { label: 'B', x: 75, y: 20 }] },
      { atMs: 250, detections: [{ label: 'A', x: 25, y: 20 }, { label: 'B', x: 55, y: 20 }] },
      { atMs: 500, detections: [{ label: 'A', x: 42, y: 20 }, { label: 'B', x: 42, y: 60 }] },
      { atMs: 750, detections: [{ label: 'A', x: 55, y: 20 }, { label: 'B', x: 25, y: 60 }] },
      { atMs: 1_000, detections: [{ label: 'A', x: 75, y: 20 }, { label: 'B', x: 5, y: 60 }] },
    ],
  },
  {
    name: 'short-occlusion',
    description: 'A confirmed object disappears for two valid empty batches and returns.',
    expectedEvents: ['OBJECT_APPEARED', 'OBJECT_TEMPORARILY_LOST', 'OBJECT_REAPPEARED'],
    frames: [
      { atMs: 0, detections: [{ label: 'A', x: 20, y: 20 }] },
      { atMs: 250, detections: [{ label: 'A', x: 20, y: 20 }] },
      { atMs: 900, detections: [] },
      { atMs: 1_200, detections: [] },
      { atMs: 1_500, detections: [{ label: 'A', x: 20, y: 20 }] },
    ],
  },
  {
    name: 'expiry-gap',
    description: 'No valid detections for longer than the expiry window.',
    expectedEvents: ['OBJECT_APPEARED', 'OBJECT_TEMPORARILY_LOST', 'OBJECT_EXPIRED'],
    frames: [
      { atMs: 0, detections: [{ label: 'A', x: 20, y: 20 }] },
      { atMs: 250, detections: [{ label: 'A', x: 20, y: 20 }] },
      { atMs: 3_000, detections: [] },
      { atMs: 6_000, detections: [] },
      { atMs: 12_500, detections: [] },
    ],
  },
  {
    name: 'low-confidence',
    description: 'Only low-confidence detections; no stable object event should be asserted.',
    expectedEvents: [],
    frames: Array.from({ length: 6 }, (_, index) => ({
      atMs: index * 250,
      detections: [{ label: 'A', x: 20, y: 20, score: 0.2 }],
    })),
  },
  {
    name: 'irregular-intervals',
    description: 'Detection timing varies from 250 ms to 2.5 s.',
    expectedEvents: ['OBJECT_APPEARED', 'OBJECT_TEMPORARILY_LOST', 'OBJECT_REAPPEARED'],
    frames: [
      { atMs: 0, detections: [{ label: 'A', x: 20, y: 20 }] },
      { atMs: 500, detections: [{ label: 'A', x: 21, y: 20 }] },
      { atMs: 1_500, detections: [{ label: 'A', x: 22, y: 20 }] },
      { atMs: 2_600, detections: [] },
      { atMs: 3_000, detections: [{ label: 'A', x: 22, y: 20 }] },
      { atMs: 5_500, detections: [{ label: 'A', x: 23, y: 20 }] },
    ],
  },
  {
    name: 'skipped-vs-empty',
    description: 'Skipped detection must not age a track; a valid empty batch can.',
    expectedEvents: ['OBJECT_APPEARED', 'OBJECT_TEMPORARILY_LOST'],
    frames: [
      { atMs: 0, detections: [{ label: 'A', x: 20, y: 20 }] },
      { atMs: 250, detections: [{ label: 'A', x: 20, y: 20 }] },
      { atMs: 2_000, status: 'skipped', detections: [] },
      { atMs: 2_200, detections: [] },
    ],
  },
  {
    name: 'session-switch',
    description: 'A second session starts; old track IDs must not be reused.',
    expectedEvents: ['OBJECT_APPEARED'],
    frames: [
      { atMs: 0, detections: [{ label: 'A', x: 20, y: 20 }] },
      { atMs: 250, detections: [{ label: 'A', x: 20, y: 20 }] },
      { atMs: 300, session: 'second', detections: [{ label: 'B', x: 70, y: 20 }] },
      { atMs: 550, session: 'second', detections: [{ label: 'B', x: 70, y: 20 }] },
    ],
  },
  {
    name: 'camera-pan-ambiguity',
    description: 'All boxes shift together; movement is image-coordinate only, not physical motion.',
    expectedEvents: ['OBJECT_APPEARED', 'OBJECT_MOVED'],
    frames: Array.from({ length: 8 }, (_, index) => ({
      atMs: index * 300,
      detections: [{ label: 'A', x: 20 + index * 4, y: 20 + index * 2 }],
    })),
  },
];

let serial = 0;
function observation(session: string, frame: FixtureFrame, box: FixtureBox): ObjectObservation {
  const id = ++serial;
  return {
    sessionId: session,
    frameSequence: id,
    capturedAtMs: frame.atMs,
    submittedAtMs: frame.atMs,
    completedAtMs: frame.atMs,
    detectorId: 'synthetic-fixture',
    modelVersion: 'fixture-v1',
    categoryId: 1,
    categoryName: 'person',
    score: box.score ?? 0.9,
    box: { x: box.x, y: box.y, width: box.width ?? 20, height: box.height ?? 20 },
    evidence: {
      sourceKind: 'demo',
      frameSequence: id,
      capturedAtMs: frame.atMs,
      frameRef: `${session}:${box.label}:${frame.atMs}`,
      input: { width: 100, height: 100, scale: 1, offsetX: 0, offsetY: 0 },
    },
  };
}

export function runTrackingBenchmark(fixtures: readonly TrackingFixture[] = TRACKING_FIXTURES): FixtureResult[] {
  return fixtures.map((fixture) => {
    const session0 = fixture.name;
    const system = new ObjectTrackingSystem(session0, {
      tracker: { confirmHits: 2, lostAfterMs: 600, expireAfterMs: 10_000, maxAssociationGapMs: 3_200, minConfidence: 0.3, maxCenterDistance: 0.4 },
      events: { minMoveDistance: 0.03, stationaryAfterMs: 1_200, cooldownMs: 500 },
      index: { maxTracks: 20, maxHistoryPerTrack: 10, maxEvents: 30, historyWindowMs: 60_000 },
    });
    const labelsByTrack = new Map<string, Map<string, number>>();
    const switches = new Map<string, number>();
    let associationCorrect = 0;
    let associationTotal = 0;
    let rawDetections = 0;
    let activeMax = 0;
    let processingMs = 0;
    let processingMaxMs = 0;
    let suppressedEvents = 0;
    const allEvents: ObjectEventType[] = [];
    let firstEventLatencyMs: number | null = null;
    let lastLabelTrack = new Map<string, string>();

    for (const frame of fixture.frames) {
      const session = frame.session === 'second' ? 'second' : session0;
      const detections = frame.detections.map((box) => observation(session, frame, box));
      rawDetections += detections.length;
      const result = system.process({
        sessionId: session,
        observedAtMs: frame.atMs,
        frameSequence: frame.atMs,
        frameWidth: 100,
        frameHeight: 100,
        status: frame.status ?? 'ok',
        detections,
      });
      processingMs += result.trackingMs;
      processingMaxMs = Math.max(processingMaxMs, result.trackingMs);
      activeMax = Math.max(activeMax, result.frame.tracks.length);
      for (const event of result.events) {
        allEvents.push(event.eventType);
        if (firstEventLatencyMs === null) firstEventLatencyMs = event.observedAtMs - fixture.frames[0].atMs;
      }
      suppressedEvents += result.suppressedEvents;
      for (const track of result.frame.tracks) {
        const label = track.evidenceRef.split(':')[1];
        const counts = labelsByTrack.get(track.trackId) ?? new Map<string, number>();
        counts.set(label, (counts.get(label) ?? 0) + 1);
        labelsByTrack.set(track.trackId, counts);
      }
      const current = new Map<string, string>();
      for (const box of frame.detections) {
        const track = result.frame.tracks.find((item) => item.evidenceRef.startsWith(`${session}:${box.label}:`));
        if (!track) continue;
        current.set(box.label, track.trackId);
        associationTotal += 1;
        const majority = [...(labelsByTrack.get(track.trackId)?.entries() ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0];
        if (majority === box.label) associationCorrect += 1;
        if (lastLabelTrack.get(box.label) && lastLabelTrack.get(box.label) !== track.trackId) {
          switches.set(box.label, (switches.get(box.label) ?? 0) + 1);
        }
      }
      lastLabelTrack = current;
    }

    const snapshot = system.snapshot();
    const expected = [...fixture.expectedEvents];
    const actualTypes = new Set(allEvents);
    const expectedTypes = new Set(expected);
    let truePositive = 0;
    for (const type of EVENT_ORDER) {
      if (actualTypes.has(type) && expectedTypes.has(type)) truePositive += 1;
    }
    const duplicateEvents = suppressedEvents;
    return {
      name: fixture.name,
      description: fixture.description,
      rawDetections,
      frames: fixture.frames.length,
      tracks: system.activeTracks.length,
      expired: snapshot.expiredCount,
      idSwitches: [...switches.values()].reduce((sum, value) => sum + value, 0),
      associationCorrect,
      associationTotal,
      events: allEvents,
      expectedEvents: expected,
      eventPrecision: actualTypes.size ? truePositive / actualTypes.size : expectedTypes.size ? 0 : 1,
      eventRecall: expectedTypes.size ? truePositive / expectedTypes.size : 1,
      duplicateEvents,
      suppressedEvents,
      activeMax,
      indexEntries: snapshot.indexEntries,
      eventLogSize: snapshot.eventLogSize,
      indexEvictions: snapshot.indexEvictions,
      processingMs,
      processingMaxMs,
      firstEventLatencyMs,
    };
  });
}

export function trackingReport(results: readonly FixtureResult[]): string {
  const lines = [
    '# Phase 4P.2 · Synthetic object tracking benchmark',
    '',
    '> Synthetic ObjectObservation fixtures only. These numbers are not real detector accuracy, and the moving-camera case is image-coordinate change without camera-motion compensation.',
    '',
    '| Fixture | Frames | Raw det. | ID switches | Assoc. correct | Events (actual / expected) | Type precision | Type recall | First event ms | Suppressed ev. | Index entries | Processing ms |',
    '| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...results.map((result) => `| ${result.name} | ${result.frames} | ${result.rawDetections} | ${result.idSwitches} | ${result.associationCorrect}/${result.associationTotal} | ${result.events.length}/${result.expectedEvents.length} | ${result.eventPrecision.toFixed(3)} | ${result.eventRecall.toFixed(3)} | ${result.firstEventLatencyMs === null ? '—' : result.firstEventLatencyMs.toFixed(0)} | ${result.suppressedEvents} | ${result.indexEntries} | ${result.processingMs.toFixed(3)} |`),
    '',
    'Association correctness is evaluated only for synthetic labels. Crossing and camera-pan fixtures are deliberately ambiguous; they are not a claim of long-term identity recognition.',
  ];
  return lines.join('\n');
}
