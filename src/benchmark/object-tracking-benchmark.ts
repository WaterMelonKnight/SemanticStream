import type { ObjectObservation } from '../perception/types';
import type { DetectionBatchStatus, ObjectEvent, ObjectEventType } from '../perception/tracking/types';
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

export interface ExpectedEventInstance {
  readonly label: string;
  readonly eventType: ObjectEventType;
  readonly fromMs: number;
  readonly toMs: number;
  readonly session?: string;
}

export interface TrackingFixture {
  readonly name: string;
  readonly description: string;
  readonly frames: readonly FixtureFrame[];
  /** Event types for the approximate type-set metric only. */
  readonly expectedEvents: readonly ObjectEventType[];
  readonly expectedEventInstances?: readonly ExpectedEventInstance[];
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
  readonly unmatchedDetections: number;
  readonly reappearanceIdSwitches: number;
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
  readonly eventInstanceMeasured: boolean;
  readonly eventInstancePrecision: number | null;
  readonly eventInstanceRecall: number | null;
  readonly eventFalsePositives: number;
  readonly eventFalseNegatives: number;
  readonly duplicateInstances: number;
  readonly meanEventLatencyMs: number | null;
  readonly configLabel: string;
  readonly sessions: readonly string[];
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
    expectedEventInstances: [
      { label: 'A', eventType: 'OBJECT_APPEARED', fromMs: 200, toMs: 500 },
      { label: 'A', eventType: 'OBJECT_MOVED', fromMs: 450, toMs: 700 },
      { label: 'A', eventType: 'OBJECT_MOVED', fromMs: 900, toMs: 1_200 },
      { label: 'A', eventType: 'OBJECT_MOVED', fromMs: 1_400, toMs: 1_700 },
      { label: 'A', eventType: 'OBJECT_MOVED', fromMs: 1_900, toMs: 2_300 },
    ],
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
    expectedEventInstances: [
      { label: 'A', eventType: 'OBJECT_APPEARED', fromMs: 200, toMs: 500 },
      { label: 'A', eventType: 'OBJECT_STATIONARY', fromMs: 1_000, toMs: 4_000 },
    ],
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
    // Instance-level identity is intentionally NOT measured: crossing labels are ambiguous.
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
    expectedEventInstances: [
      { label: 'A', eventType: 'OBJECT_APPEARED', fromMs: 200, toMs: 500 },
      { label: 'A', eventType: 'OBJECT_TEMPORARILY_LOST', fromMs: 700, toMs: 1_300 },
      { label: 'A', eventType: 'OBJECT_REAPPEARED', fromMs: 1_300, toMs: 1_900 },
    ],
    frames: [
      { atMs: 0, detections: [{ label: 'A', x: 20, y: 20 }] },
      { atMs: 250, detections: [{ label: 'A', x: 20, y: 20 }] },
      { atMs: 900, detections: [] },
      { atMs: 1_200, detections: [] },
      { atMs: 1_500, detections: [{ label: 'A', x: 20, y: 20 }] },
    ],
  },
  {
    name: 'occlusion-id-switch',
    description: 'Two same-category objects swap positions after an occlusion; this measures reappearance ID switches, not identity correctness.',
    expectedEvents: ['OBJECT_APPEARED', 'OBJECT_TEMPORARILY_LOST', 'OBJECT_REAPPEARED'],
    frames: [
      { atMs: 0, detections: [{ label: 'A', x: 20, y: 20 }, { label: 'B', x: 70, y: 20 }] },
      { atMs: 250, detections: [{ label: 'A', x: 22, y: 20 }, { label: 'B', x: 68, y: 20 }] },
      { atMs: 900, detections: [] },
      { atMs: 1_200, detections: [] },
      { atMs: 1_500, detections: [{ label: 'A', x: 68, y: 20 }, { label: 'B', x: 22, y: 20 }] },
    ],
  },
  {
    name: 'expiry-gap',
    description: 'No valid detections for longer than the expiry window.',
    expectedEvents: ['OBJECT_APPEARED', 'OBJECT_TEMPORARILY_LOST', 'OBJECT_EXPIRED'],
    expectedEventInstances: [
      { label: 'A', eventType: 'OBJECT_APPEARED', fromMs: 200, toMs: 500 },
      { label: 'A', eventType: 'OBJECT_TEMPORARILY_LOST', fromMs: 2_800, toMs: 6_500 },
      { label: 'A', eventType: 'OBJECT_EXPIRED', fromMs: 10_000, toMs: 13_500 },
    ],
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
    expectedEventInstances: [],
    frames: Array.from({ length: 6 }, (_, index) => ({
      atMs: index * 250,
      detections: [{ label: 'A', x: 20, y: 20, score: 0.2 }],
    })),
  },
  {
    name: 'irregular-intervals',
    description: 'Detection timing varies from 250 ms to 2.5 s.',
    expectedEvents: ['OBJECT_APPEARED', 'OBJECT_TEMPORARILY_LOST', 'OBJECT_REAPPEARED'],
    expectedEventInstances: [
      { label: 'A', eventType: 'OBJECT_APPEARED', fromMs: 200, toMs: 500 },
      { label: 'A', eventType: 'OBJECT_TEMPORARILY_LOST', fromMs: 700, toMs: 1_300 },
      { label: 'A', eventType: 'OBJECT_REAPPEARED', fromMs: 1_300, toMs: 1_900 },
    ],
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
    expectedEventInstances: [
      { label: 'A', eventType: 'OBJECT_APPEARED', fromMs: 200, toMs: 500 },
      { label: 'A', eventType: 'OBJECT_TEMPORARILY_LOST', fromMs: 2_000, toMs: 3_000 },
    ],
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
    expectedEventInstances: [
      { label: 'A', eventType: 'OBJECT_APPEARED', fromMs: 200, toMs: 500 },
      { label: 'B', eventType: 'OBJECT_APPEARED', fromMs: 500, toMs: 900, session: 'second' },
    ],
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
    // Instance-level physical events are NOT_MEASURED without camera-motion compensation.
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

export interface TrackingBenchmarkOptions {
  readonly defaultConfig?: boolean;
}

function eventLabel(event: ObjectEvent, labelsByTrack: Map<string, Map<string, number>>): string {
  const counts = labelsByTrack.get(event.trackId);
  if (!counts?.size) return 'UNKNOWN';
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

export function runTrackingBenchmark(
  fixtures: readonly TrackingFixture[] = TRACKING_FIXTURES,
  options: TrackingBenchmarkOptions = {},
): FixtureResult[] {
  return fixtures.map((fixture) => {
    const session0 = fixture.name;
    const system = options.defaultConfig
      ? new ObjectTrackingSystem(session0)
      : new ObjectTrackingSystem(session0, {
        tracker: { confirmHits: 2, lostAfterMs: 600, expireAfterMs: 10_000, maxAssociationGapMs: 3_200, minConfidence: 0.3, maxCenterDistance: 0.4 },
        events: { minMoveDistance: 0.03, stationaryAfterMs: 1_200, cooldownMs: 500 },
        index: { maxTracks: 20, maxHistoryPerTrack: 10, maxEvents: 30, historyWindowMs: 60_000 },
      });
    const labelsByTrack = new Map<string, Map<string, number>>();
    const switches = new Map<string, number>();
    const lastTrackByLabel = new Map<string, string>();
    let presentPrevious = new Set<string>();
    let associationCorrect = 0;
    let associationTotal = 0;
    let rawDetections = 0;
    let activeMax = 0;
    let processingMs = 0;
    let processingMaxMs = 0;
    let suppressedEvents = 0;
    let reappearanceIdSwitches = 0;
    const allEvents: ObjectEvent[] = [];
    let firstEventLatencyMs: number | null = null;
    let currentSession = session0;
    let frameSequence = 0;
    const sessions = new Set<string>([session0]);

    for (const frame of fixture.frames) {
      const session = frame.session ?? session0;
      sessions.add(session);
      if (session !== currentSession) {
        system.reset(session);
        currentSession = session;
        presentPrevious = new Set();
      }
      const detections = frame.detections.map((box) => observation(session, frame, box));
      rawDetections += detections.length;
      associationTotal += detections.length;
      const result = system.process({
        sessionId: session,
        observedAtMs: frame.atMs,
        capturedAtMs: frame.atMs,
        completedAtMs: frame.atMs,
        frameSequence: ++frameSequence,
        frameWidth: 100,
        frameHeight: 100,
        status: frame.status ?? 'ok',
        detections,
      });
      processingMs += result.trackingMs;
      processingMaxMs = Math.max(processingMaxMs, result.trackingMs);
      activeMax = Math.max(activeMax, result.frame.tracks.length);
      for (const track of result.frame.tracks) {
        const label = track.evidenceRef.split(':')[1];
        const counts = labelsByTrack.get(track.trackId) ?? new Map<string, number>();
        counts.set(label, (counts.get(label) ?? 0) + 1);
        labelsByTrack.set(track.trackId, counts);
      }
      for (const event of result.events) {
        allEvents.push(event);
        if (firstEventLatencyMs === null) firstEventLatencyMs = event.observedAtMs - fixture.frames[0].atMs;
      }
      suppressedEvents += result.suppressedEvents;

      const current = new Set<string>();
      for (const box of frame.detections) {
        current.add(box.label);
        const track = result.frame.tracks.find((item) => item.evidenceRef.startsWith(`${session}:${box.label}:`));
        if (!track) continue;
        const majority = [...(labelsByTrack.get(track.trackId)?.entries() ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0];
        if (majority === box.label) associationCorrect += 1;
        const previousTrack = lastTrackByLabel.get(box.label);
        if (previousTrack && previousTrack !== track.trackId) {
          switches.set(box.label, (switches.get(box.label) ?? 0) + 1);
          if (!presentPrevious.has(box.label)) reappearanceIdSwitches += 1;
        }
        lastTrackByLabel.set(box.label, track.trackId);
      }
      presentPrevious = current;
    }

    const snapshot = system.snapshot();
    const expectedTypes = [...new Set(fixture.expectedEvents)];
    const actualTypes = new Set(allEvents.map((event) => event.eventType));
    let typeTruePositive = 0;
    for (const type of EVENT_ORDER) {
      if (actualTypes.has(type) && expectedTypes.includes(type)) typeTruePositive += 1;
    }
    const typePrecision = actualTypes.size ? typeTruePositive / actualTypes.size : expectedTypes.length ? 0 : 1;
    const typeRecall = expectedTypes.length ? typeTruePositive / expectedTypes.length : 1;

    const expectedInstances = (fixture.expectedEventInstances ?? []).map((event) => ({
      ...event,
      session: event.session ?? session0,
    }));
    const instanceMeasured = fixture.expectedEventInstances !== undefined;
    const matchedExpected = new Set<number>();
    const matchedActual = new Set<number>();
    const latencies: number[] = [];
    if (instanceMeasured) {
      for (let expectedIndex = 0; expectedIndex < expectedInstances.length; expectedIndex += 1) {
        const expected = expectedInstances[expectedIndex];
        let bestIndex = -1;
        let bestTime = Infinity;
        for (let actualIndex = 0; actualIndex < allEvents.length; actualIndex += 1) {
          if (matchedActual.has(actualIndex)) continue;
          const actualEvent = allEvents[actualIndex];
          if (actualEvent.sessionId !== expected.session || actualEvent.eventType !== expected.eventType) continue;
          if (eventLabel(actualEvent, labelsByTrack) !== expected.label) continue;
          if (actualEvent.observedAtMs < expected.fromMs || actualEvent.observedAtMs > expected.toMs) continue;
          if (actualEvent.observedAtMs < bestTime) { bestTime = actualEvent.observedAtMs; bestIndex = actualIndex; }
        }
        if (bestIndex >= 0) {
          matchedExpected.add(expectedIndex);
          matchedActual.add(bestIndex);
          latencies.push(allEvents[bestIndex].observedAtMs - expected.fromMs);
        }
      }
    }
    let eventFalsePositives = 0;
    let eventFalseNegatives = 0;
    if (instanceMeasured) {
      eventFalsePositives = allEvents.reduce((count, _event, index) => count + (matchedActual.has(index) ? 0 : 1), 0);
      eventFalseNegatives = expectedInstances.reduce((count, _event, index) => count + (matchedExpected.has(index) ? 0 : 1), 0);
    }
    const duplicateInstances = countDuplicateInstances(allEvents);
    const eventInstancePrecision = instanceMeasured
      ? (matchedActual.size + eventFalsePositives > 0 ? matchedActual.size / (matchedActual.size + eventFalsePositives) : expectedInstances.length ? 0 : 1)
      : null;
    const eventInstanceRecall = instanceMeasured
      ? (matchedExpected.size + eventFalseNegatives > 0 ? matchedExpected.size / (matchedExpected.size + eventFalseNegatives) : 1)
      : null;

    return {
      name: fixture.name,
      description: fixture.description,
      rawDetections,
      frames: fixture.frames.length,
      tracks: system.activeTracks.length,
      expired: snapshot.expiredCount,
      idSwitches: [...switches.values()].reduce((sum, value) => sum + value, 0),
      reappearanceIdSwitches,
      associationCorrect,
      associationTotal,
      unmatchedDetections: associationTotal - associationCorrect,
      events: [...actualTypes],
      expectedEvents: expectedTypes,
      eventPrecision: typePrecision,
      eventRecall: typeRecall,
      duplicateEvents: duplicateInstances,
      suppressedEvents,
      activeMax,
      indexEntries: snapshot.indexEntries,
      eventLogSize: snapshot.eventLogSize,
      indexEvictions: snapshot.indexEvictions,
      processingMs,
      processingMaxMs,
      firstEventLatencyMs,
      eventInstanceMeasured: instanceMeasured,
      eventInstancePrecision,
      eventInstanceRecall,
      eventFalsePositives,
      eventFalseNegatives,
      duplicateInstances,
      meanEventLatencyMs: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null,
      configLabel: options.defaultConfig ? 'production-default' : 'fixture-tuned',
      sessions: [...sessions],
    };
  });
}

function countDuplicateInstances(events: readonly ObjectEvent[]): number {
  let duplicates = 0;
  for (let index = 0; index < events.length; index += 1) {
    const current = events[index];
    if (events.slice(0, index).some((previous) => previous.sessionId === current.sessionId
      && previous.trackId === current.trackId
      && previous.eventType === current.eventType
      && current.observedAtMs - previous.observedAtMs < 500)) duplicates += 1;
  }
  return duplicates;
}

export function trackingReport(results: readonly FixtureResult[], title = 'Phase 4P.2 · Synthetic object tracking benchmark'): string {
  const measured = results.filter((result) => result.eventInstanceMeasured);
  const instancePrecision = measured.length
    ? measured.reduce((sum, result) => sum + (result.eventInstancePrecision ?? 0), 0) / measured.length
    : null;
  const instanceRecall = measured.length
    ? measured.reduce((sum, result) => sum + (result.eventInstanceRecall ?? 0), 0) / measured.length
    : null;
  const lines = [
    `# ${title}`,
    '',
    '> Synthetic ObjectObservation fixtures only. These numbers are not real detector accuracy. Moving-camera events are image-coordinate changes without camera-motion compensation.',
    '',
    '**Metric scope:** type precision/recall is only the set of event types present. Instance precision/recall matches each expected event by session, synthetic identity, event type and a time window; it is marked NOT_MEASURED where identity is deliberately ambiguous.',
    '',
    `**Instance macro precision:** ${instancePrecision === null ? 'NOT_MEASURED' : instancePrecision.toFixed(3)} · **recall:** ${instanceRecall === null ? 'NOT_MEASURED' : instanceRecall.toFixed(3)}`,
    '',
    '| Fixture | Config | Sessions | Raw det. | Assoc. correct / denominator | ID switches | Reappear switches | Type P/R | Instance P/R | FP/FN | Dup. | Mean latency ms | Index entries | Processing ms |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |',
    ...results.map((result) => `| ${result.name} | ${result.configLabel} | ${result.sessions.join(',')} | ${result.rawDetections} | ${result.associationCorrect}/${result.associationTotal} | ${result.idSwitches} | ${result.reappearanceIdSwitches} | ${result.eventPrecision.toFixed(3)}/${result.eventRecall.toFixed(3)} | ${result.eventInstanceMeasured ? `${(result.eventInstancePrecision ?? 0).toFixed(3)}/${(result.eventInstanceRecall ?? 0).toFixed(3)}` : 'NOT_MEASURED'} | ${result.eventInstanceMeasured ? `${result.eventFalsePositives}/${result.eventFalseNegatives}` : '—'} | ${result.duplicateInstances} | ${result.meanEventLatencyMs === null ? '—' : result.meanEventLatencyMs.toFixed(0)} | ${result.indexEntries} | ${result.processingMs.toFixed(3)} |`),
    '',
    'Association denominator includes every synthetic detection, including unmatched and low-confidence detections. Crossing and camera-pan identity/event instances are NOT_MEASURED, not silently treated as zero. The separate production-default run uses no fixture-tuned thresholds.',
  ];
  return lines.join('\n');
}
