import type { ObjectObservation } from '../types';
import {
  TRACKING_DEFAULTS,
  type DetectionBatch,
  type NormalizedBox,
  type TrackTransition,
  type TrackedObject,
  type TrackingConfig,
  type TrackingFrameResult,
  type TrackVelocity,
  type TrackerStats,
} from './types';

type UnknownObservation = never;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function normalizeBox(observation: ObjectObservation, frameWidth: number, frameHeight: number): NormalizedBox {
  if (!(frameWidth > 0) || !(frameHeight > 0)) throw new RangeError('Tracking frame dimensions must be positive.');
  const x = clamp01(observation.box.x / frameWidth);
  const y = clamp01(observation.box.y / frameHeight);
  return {
    x,
    y,
    width: clamp01(observation.box.width / frameWidth),
    height: clamp01(observation.box.height / frameHeight),
  };
}

export function boxCenter(box: NormalizedBox): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export function iou(left: NormalizedBox, right: NormalizedBox): number {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = left.width * left.height + right.width * right.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function centerDistance(left: NormalizedBox, right: NormalizedBox): number {
  const a = boxCenter(left);
  const b = boxCenter(right);
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function predictedBox(track: TrackedObject, elapsedMs: number, enableVelocity: boolean): NormalizedBox {
  if (!enableVelocity || !track.velocity || elapsedMs <= 0) return track.boundingBox;
  const seconds = Math.min(1, elapsedMs / 1_000);
  const x = clamp01(track.boundingBox.x + track.velocity.xPerSecond * seconds);
  const y = clamp01(track.boundingBox.y + track.velocity.yPerSecond * seconds);
  return { ...track.boundingBox, x, y };
}

function withVelocity(previous: TrackedObject, box: NormalizedBox, atMs: number): TrackVelocity | undefined {
  if (atMs <= previous.lastObservationAtMs) return previous.velocity;
  const oldCenter = boxCenter(previous.boundingBox);
  const newCenter = boxCenter(box);
  const seconds = (atMs - previous.lastObservationAtMs) / 1_000;
  if (seconds <= 0) return previous.velocity;
  return { xPerSecond: (newCenter.x - oldCenter.x) / seconds, yPerSecond: (newCenter.y - oldCenter.y) / seconds };
}

function emptyStats(): TrackerStats {
  return {
    inputBatches: 0, skippedBatches: 0, failedBatches: 0, detections: 0,
    lowConfidenceDetections: 0, associationFailures: 0, createdTracks: 0,
    expiredTracks: 0, ambiguousMatches: 0,
  };
}

/**
 * Deterministic tracking-by-detection. It is intentionally independent of DOM,
 * model providers and page code. A skipped/failed batch never ages or removes a
 * track; only a valid (`ok`) detection batch can imply absence.
 */
export class ObjectTracker {
  private config: TrackingConfig;
  private sessionId = '';
  private readonly tracks = new Map<string, TrackedObject>();
  private readonly expired: TrackedObject[] = [];
  private nextTrackSerial = 0;
  private lastBatchAtMs: number | null = null;
  private stats: TrackerStats = emptyStats();

  constructor(config: Partial<TrackingConfig> = {}) {
    this.config = { ...TRACKING_DEFAULTS, ...config };
  }

  get currentSessionId(): string {
    return this.sessionId;
  }

  get activeTracks(): readonly TrackedObject[] {
    return [...this.tracks.values()];
  }

  get trackerStats(): TrackerStats {
    return { ...this.stats };
  }

  reset(sessionId = ''): void {
    this.sessionId = sessionId;
    this.tracks.clear();
    this.expired.length = 0;
    this.nextTrackSerial = 0;
    this.lastBatchAtMs = null;
    this.stats = emptyStats();
  }

  update(batch: DetectionBatch): TrackingFrameResult {
    if (!(batch.frameWidth > 0) || !(batch.frameHeight > 0)) {
      return this.result(batch, false, 'invalid-frame', [], 0, 0);
    }
    if (this.sessionId !== batch.sessionId) this.reset(batch.sessionId);
    if (this.lastBatchAtMs !== null && batch.observedAtMs < this.lastBatchAtMs) {
      return this.result(batch, false, 'invalid-time', [], 0, 0);
    }
    if (batch.status !== 'ok') {
      this.stats.inputBatches += 1;
      if (batch.status === 'skipped') this.stats.skippedBatches += 1;
      else this.stats.failedBatches += 1;
      return this.result(batch, false, batch.status);
    }
    this.stats.inputBatches += 1;
    this.lastBatchAtMs = batch.observedAtMs;

    const detections = batch.detections.map((observation) => ({
      observation,
      box: normalizeBox(observation, batch.frameWidth, batch.frameHeight),
    }));
    this.stats.detections += detections.length;
    const lowConfidence = detections.filter((item) => item.observation.score < this.config.minConfidence);
    this.stats.lowConfidenceDetections += lowConfidence.length;
    const accepted = detections.filter((item) => item.observation.score >= this.config.minConfidence);

    const transitions: TrackTransition[] = [];
    const matchedTracks = new Set<string>();
    const matchedDetections = new Set<number>();
    const candidates: Array<{ track: TrackedObject; detectionIndex: number; cost: number; ambiguous: boolean }> = [];

    for (const track of this.tracks.values()) {
      if (track.trackingState === 'EXPIRED') continue;
      const elapsed = batch.observedAtMs - track.lastObservationAtMs;
      if (elapsed > this.config.maxAssociationGapMs) continue;
      const predicted = predictedBox(track, elapsed, this.config.enableVelocity);
      for (let index = 0; index < accepted.length; index += 1) {
        const detection = accepted[index];
        if (detection.observation.categoryId !== track.categoryId) continue;
        const overlap = iou(predicted, detection.box);
        const distance = centerDistance(predicted, detection.box);
        if (overlap < this.config.minIou && distance > this.config.maxCenterDistance) continue;
        const cost = (1 - overlap) * 0.7 + distance * 0.5 + (1 - detection.observation.score) * 0.1;
        candidates.push({ track, detectionIndex: index, cost, ambiguous: false });
      }
    }

    candidates.sort((left, right) => left.cost - right.cost
      || left.track.trackId.localeCompare(right.track.trackId)
      || left.detectionIndex - right.detectionIndex);
    for (const candidate of candidates) {
      if (matchedTracks.has(candidate.track.trackId) || matchedDetections.has(candidate.detectionIndex)) continue;
      const sameTrack = candidates.filter((other) => other.track.trackId === candidate.track.trackId
        && !matchedDetections.has(other.detectionIndex));
      const ambiguous = sameTrack.length > 1
        && sameTrack[1].cost - sameTrack[0].cost <= this.config.ambiguityMargin;
      if (ambiguous) this.stats.ambiguousMatches += 1;
      matchedTracks.add(candidate.track.trackId);
      matchedDetections.add(candidate.detectionIndex);
      const detection = accepted[candidate.detectionIndex];
      const previous = candidate.track;
      const matchedBox = detection.box;
      const state: TrackedObject['trackingState'] = previous.trackingState === 'TEMPORARILY_LOST'
        ? 'CONFIRMED'
        : previous.trackingState === 'TENTATIVE' && previous.observationCount + 1 >= this.config.confirmHits
          ? 'CONFIRMED' : previous.trackingState;
      const updated: TrackedObject = {
        ...previous,
        boundingBox: matchedBox,
        confidence: detection.observation.score,
        lastSeenAtMs: batch.observedAtMs,
        lastObservationAtMs: batch.observedAtMs,
        observationCount: previous.observationCount + 1,
        missedObservations: 0,
        velocity: withVelocity(previous, matchedBox, batch.observedAtMs),
        trackingState: state,
        evidenceRef: detection.observation.evidence.frameRef,
        associationUncertain: ambiguous,
      };
      this.tracks.set(updated.trackId, updated);
      if (previous.trackingState === 'TEMPORARILY_LOST') {
        transitions.push({ type: 'reappeared', track: updated, previousState: previous.trackingState, atMs: batch.observedAtMs, reason: 'matched_after_temporary_loss' });
      } else if (previous.trackingState === 'TENTATIVE' && state === 'CONFIRMED') {
        transitions.push({ type: 'appeared', track: updated, previousState: previous.trackingState, atMs: batch.observedAtMs, reason: 'confirmed_after_hits' });
      }
    }

    // Create tracks only for valid detections that could not be matched.
    for (let index = 0; index < accepted.length; index += 1) {
      if (matchedDetections.has(index)) continue;
      if (this.tracks.size >= this.config.maxTracks) {
        this.stats.associationFailures += 1;
        continue;
      }
      const detection = accepted[index];
      const trackId = `${this.sessionId}:o${++this.nextTrackSerial}`;
      const state: TrackedObject['trackingState'] = this.config.confirmHits <= 1 ? 'CONFIRMED' : 'TENTATIVE';
      const track: TrackedObject = {
        trackId,
        sessionId: this.sessionId,
        categoryId: detection.observation.categoryId,
        categoryName: detection.observation.categoryName,
        boundingBox: detection.box,
        confidence: detection.observation.score,
        firstSeenAtMs: batch.observedAtMs,
        lastSeenAtMs: batch.observedAtMs,
        lastObservationAtMs: batch.observedAtMs,
        observationCount: 1,
        missedObservations: 0,
        trackingState: state,
        evidenceRef: detection.observation.evidence.frameRef,
        associationUncertain: false,
      };
      this.tracks.set(trackId, track);
      matchedTracks.add(trackId);
      this.stats.createdTracks += 1;
      if (state === 'CONFIRMED') {
        transitions.push({ type: 'appeared', track, previousState: 'TENTATIVE', atMs: batch.observedAtMs, reason: 'confirmed_on_first_hit' });
      }
    }

    // Only a valid batch can age unmatched tracks.
    for (const track of [...this.tracks.values()]) {
      if (matchedTracks.has(track.trackId)) continue;
      const gap = batch.observedAtMs - track.lastObservationAtMs;
      if (gap > this.config.expireAfterMs) {
        const expired: TrackedObject = { ...track, trackingState: 'EXPIRED', missedObservations: track.missedObservations + 1 };
        this.tracks.delete(track.trackId);
        this.expired.push(expired);
        if (this.expired.length > this.config.maxTracks) this.expired.shift();
        this.stats.expiredTracks += 1;
        transitions.push({ type: 'expired', track: expired, previousState: track.trackingState, atMs: batch.observedAtMs, reason: 'expiry_gap' });
      } else if (gap > this.config.lostAfterMs && track.trackingState !== 'TEMPORARILY_LOST') {
        const lost: TrackedObject = {
          ...track, trackingState: 'TEMPORARILY_LOST',
          missedObservations: track.missedObservations + 1,
        };
        this.tracks.set(track.trackId, lost);
        transitions.push({ type: 'lost', track: lost, previousState: track.trackingState, atMs: batch.observedAtMs, reason: 'valid_empty_gap' });
      } else {
        this.tracks.set(track.trackId, { ...track, missedObservations: track.missedObservations + 1 });
      }
    }

    if (accepted.length > 0) {
      this.stats.associationFailures += [...this.tracks.values()].filter((track) => !matchedTracks.has(track.trackId)).length;
    }
    return this.result(batch, true, 'ok', transitions, accepted.length, lowConfidence.length);
  }

  private result(
    batch: DetectionBatch,
    processed: boolean,
    status: TrackingFrameResult['status'],
    transitions: TrackTransition[] = [],
    detectionsProcessed = 0,
    lowConfidenceDetections = 0,
  ): TrackingFrameResult {
    return {
      sessionId: this.sessionId,
      observedAtMs: batch.observedAtMs,
      processed,
      status,
      tracks: [...this.tracks.values()],
      expired: [...this.expired],
      transitions,
      detectionsProcessed,
      lowConfidenceDetections,
      associationFailures: this.stats.associationFailures,
    };
  }
}

export type { UnknownObservation };
