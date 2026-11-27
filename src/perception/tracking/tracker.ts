import type { ObjectObservation } from '../types';
import {
  TRACKING_DEFAULTS,
  type DetectionBatch,
  type NormalizedBox,
  type TrackTransition,
  type TrackedObject,
  type TrackingConfig,
  type TrackingFrameResult,
  type TrackingFrameStatus,
  type TrackVelocity,
  type TrackerStats,
} from './types';

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
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

function withVelocity(previous: TrackedObject, box: NormalizedBox, capturedAtMs: number): TrackVelocity | undefined {
  if (capturedAtMs <= previous.lastSeenAtMs) return previous.velocity;
  const oldCenter = boxCenter(previous.boundingBox);
  const newCenter = boxCenter(box);
  const seconds = (capturedAtMs - previous.lastSeenAtMs) / 1_000;
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

function validateBatch(batch: DetectionBatch, config: TrackingConfig): string | null {
  if (!batch.sessionId) return 'sessionId must be non-empty.';
  if (!finite(batch.frameWidth) || batch.frameWidth <= 0 || !finite(batch.frameHeight) || batch.frameHeight <= 0) return 'Frame dimensions must be positive finite numbers.';
  if (!finite(batch.frameSequence) || batch.frameSequence < 0) return 'frameSequence must be a non-negative finite number.';
  if (!finite(batch.observedAtMs)) return 'observedAtMs must be finite.';
  const captured = batch.capturedAtMs ?? batch.observedAtMs;
  const completed = batch.completedAtMs ?? batch.observedAtMs;
  if (!finite(captured) || !finite(completed) || captured < 0) return 'Capture/completion times must be finite and non-negative.';
  if (completed < captured) return 'Detection completion cannot precede capture.';
  if (batch.status !== 'ok') return null;
  for (const observation of batch.detections) {
    if (observation.sessionId !== batch.sessionId) return 'Observation session does not match its batch.';
    if (!finite(observation.capturedAtMs) || !finite(observation.submittedAtMs) || !finite(observation.completedAtMs)) return 'Observation timestamps must be finite.';
    if (observation.capturedAtMs < 0 || observation.submittedAtMs < observation.capturedAtMs || observation.completedAtMs < observation.submittedAtMs) return 'Observation timestamps are out of order.';
    if (observation.capturedAtMs > captured + 1) return 'Observation capture is newer than its batch capture.';
    if (!finite(observation.score) || observation.score < 0 || observation.score > 1) return 'Observation confidence must be finite within [0,1].';
    // Category ids are opaque provider values; MediaPipe may use an unknown/negative index.
    if (!finite(observation.categoryId) || !Number.isSafeInteger(observation.categoryId)) return 'categoryId must be a safe integer.';
    if (!observation.categoryName || typeof observation.categoryName !== 'string') return 'categoryName must be non-empty.';
    if (!finite(observation.box.x) || !finite(observation.box.y) || !finite(observation.box.width) || !finite(observation.box.height)) return 'Bounding box must be finite.';
    if (observation.box.width <= 0 || observation.box.height <= 0) return 'Bounding box dimensions must be positive.';
    if (!finite(observation.frameSequence) || observation.frameSequence < 0) return 'Observation frameSequence must be non-negative.';
    if (!observation.evidence || typeof observation.evidence.frameRef !== 'string' || !observation.evidence.frameRef) return 'Evidence frameRef must be non-empty.';
  }
  if (batch.detections.length > config.maxTracks * 4) return 'Detection batch exceeds the bounded tracking capacity.';
  return null;
}

function validateConfig(config: TrackingConfig): void {
  const numbers = ['minConfidence', 'minIou', 'maxCenterDistance', 'maxAssociationGapMs', 'lostAfterMs', 'expireAfterMs', 'confirmHits', 'maxTracks', 'ambiguityMargin'];
  for (const key of numbers) {
    const value = config[key as keyof TrackingConfig];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new RangeError(`${key} must be a non-negative finite number.`);
  }
  if (config.minConfidence > 1 || config.minIou > 1 || config.ambiguityMargin > 1) throw new RangeError('Normalized thresholds must be <= 1.');
  if (config.maxCenterDistance > 1) throw new RangeError('maxCenterDistance must be <= 1.');
  if (config.confirmHits < 1 || !Number.isSafeInteger(config.confirmHits)) throw new RangeError('confirmHits must be a positive integer.');
  if (config.maxTracks < 1 || !Number.isSafeInteger(config.maxTracks)) throw new RangeError('maxTracks must be a positive integer.');
  if (config.lostAfterMs > config.expireAfterMs) throw new RangeError('lostAfterMs must not exceed expireAfterMs.');
  if (config.maxAssociationGapMs > config.expireAfterMs) throw new RangeError('maxAssociationGapMs must not exceed expireAfterMs.');
}

/**
 * Deterministic tracking-by-detection. A skipped/failed batch never ages a
 * track; only a valid (`ok`) detection batch can imply absence. Session changes
 * require an explicit reset; old-session batches are rejected.
 */
export class ObjectTracker {
  private config: TrackingConfig;
  private sessionId = '';
  private readonly tracks = new Map<string, TrackedObject>();
  private nextTrackSerial = 0;
  private lastFrameSequence: number | null = null;
  private lastCapturedAtMs: number | null = null;
  private lastCompletedAtMs: number | null = null;
  private stats: TrackerStats = emptyStats();

  constructor(config: Partial<TrackingConfig> = {}) {
    this.config = { ...TRACKING_DEFAULTS, ...config };
    validateConfig(this.config);
  }

  get currentSessionId(): string { return this.sessionId; }
  get activeTracks(): readonly TrackedObject[] { return [...this.tracks.values()]; }
  get trackerStats(): TrackerStats { return { ...this.stats }; }

  reset(sessionId = ''): void {
    this.sessionId = sessionId;
    this.tracks.clear();
    this.nextTrackSerial = 0;
    this.lastFrameSequence = null;
    this.lastCapturedAtMs = null;
    this.lastCompletedAtMs = null;
    this.stats = emptyStats();
  }

  update(batch: DetectionBatch): TrackingFrameResult {
    if (this.sessionId && batch.sessionId !== this.sessionId) {
      return this.result(batch, false, 'wrong-session');
    }
    if (!this.sessionId && batch.sessionId) this.sessionId = batch.sessionId;
    const validationError = validateBatch(batch, this.config);
    if (validationError) return this.result(batch, false, 'invalid-observation', [], 0, 0, [], 0, validationError);
    const capturedAtMs = batch.capturedAtMs ?? batch.observedAtMs;
    const completedAtMs = batch.completedAtMs ?? batch.observedAtMs;
    if (this.lastFrameSequence !== null && batch.frameSequence <= this.lastFrameSequence) {
      return this.result(batch, false, 'duplicate');
    }
    if (this.lastCapturedAtMs !== null && capturedAtMs <= this.lastCapturedAtMs) {
      return this.result(batch, false, 'duplicate');
    }
    if (this.lastCompletedAtMs !== null && completedAtMs < this.lastCompletedAtMs) {
      return this.result(batch, false, 'invalid-time');
    }
    this.lastFrameSequence = batch.frameSequence;
    this.lastCapturedAtMs = capturedAtMs;
    this.lastCompletedAtMs = completedAtMs;
    if (batch.status !== 'ok') {
      this.stats.inputBatches += 1;
      if (batch.status === 'skipped') this.stats.skippedBatches += 1;
      else this.stats.failedBatches += 1;
      return this.result(batch, false, batch.status);
    }

    this.stats.inputBatches += 1;
    const detections = batch.detections.map((observation) => ({
      observation,
      box: normalizeBox(observation, batch.frameWidth, batch.frameHeight),
    }));
    this.stats.detections += detections.length;
    const lowConfidence = detections.filter((item) => item.observation.score < this.config.minConfidence);
    this.stats.lowConfidenceDetections += lowConfidence.length;
    const accepted = detections.filter((item) => item.observation.score >= this.config.minConfidence);

    const transitions: TrackTransition[] = [];
    const newlyExpired: TrackedObject[] = [];
    const matchedTracks = new Set<string>();
    const matchedDetections = new Set<number>();
    const candidates: Array<{ track: TrackedObject; detectionIndex: number; cost: number }> = [];

    for (const track of this.tracks.values()) {
      if (track.trackingState === 'EXPIRED') continue;
      const elapsed = capturedAtMs - track.lastSeenAtMs;
      if (elapsed > this.config.maxAssociationGapMs) continue;
      const predicted = predictedBox(track, elapsed, this.config.enableVelocity);
      for (let index = 0; index < accepted.length; index += 1) {
        const detection = accepted[index];
        if (detection.observation.categoryId !== track.categoryId) continue;
        const overlap = iou(predicted, detection.box);
        const distance = centerDistance(predicted, detection.box);
        if (overlap < this.config.minIou && distance > this.config.maxCenterDistance) continue;
        const cost = (1 - overlap) * 0.7 + distance * 0.5 + (1 - detection.observation.score) * 0.1;
        candidates.push({ track, detectionIndex: index, cost });
      }
    }

    candidates.sort((left, right) => left.cost - right.cost
      || left.track.trackId.localeCompare(right.track.trackId)
      || left.detectionIndex - right.detectionIndex);
    for (const candidate of candidates) {
      if (matchedTracks.has(candidate.track.trackId) || matchedDetections.has(candidate.detectionIndex)) continue;
      const sameTrack = candidates.filter((other) => other.track.trackId === candidate.track.trackId
        && !matchedDetections.has(other.detectionIndex));
      const ambiguous = sameTrack.length > 1 && sameTrack[1].cost - sameTrack[0].cost <= this.config.ambiguityMargin;
      if (ambiguous) this.stats.ambiguousMatches += 1;
      matchedTracks.add(candidate.track.trackId);
      matchedDetections.add(candidate.detectionIndex);
      const detection = accepted[candidate.detectionIndex];
      const previous = candidate.track;
      const state: TrackedObject['trackingState'] = previous.trackingState === 'TEMPORARILY_LOST'
        ? 'CONFIRMED'
        : previous.trackingState === 'TENTATIVE' && previous.observationCount + 1 >= this.config.confirmHits
          ? 'CONFIRMED' : previous.trackingState;
      const changed = state !== previous.trackingState;
      const confirmedAtMs = state === 'CONFIRMED'
        ? (previous.confirmedAtMs ?? completedAtMs)
        : previous.confirmedAtMs;
      const updated: TrackedObject = {
        ...previous,
        boundingBox: detection.box,
        confidence: detection.observation.score,
        lastSeenAtMs: capturedAtMs,
        lastObservationAtMs: completedAtMs,
        stateChangedAtMs: changed ? completedAtMs : previous.stateChangedAtMs,
        confirmedAtMs,
        observationCount: previous.observationCount + 1,
        missedObservations: 0,
        velocity: withVelocity(previous, detection.box, capturedAtMs),
        trackingState: state,
        evidenceRef: detection.observation.evidence.frameRef,
        associationUncertain: ambiguous,
      };
      this.tracks.set(updated.trackId, updated);
      if (previous.trackingState === 'TEMPORARILY_LOST') {
        if (previous.confirmedAtMs !== null) {
          transitions.push({ type: 'reappeared', track: updated, previousState: previous.trackingState, atMs: completedAtMs, reason: 'matched_after_temporary_loss' });
        } else {
          transitions.push({ type: 'appeared', track: updated, previousState: 'TENTATIVE', atMs: completedAtMs, reason: 'confirmed_after_hits' });
        }
      } else if (previous.trackingState === 'TENTATIVE' && state === 'CONFIRMED') {
        transitions.push({ type: 'appeared', track: updated, previousState: previous.trackingState, atMs: completedAtMs, reason: 'confirmed_after_hits' });
      }
    }

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
        firstSeenAtMs: capturedAtMs,
        lastSeenAtMs: capturedAtMs,
        lastObservationAtMs: completedAtMs,
        stateChangedAtMs: completedAtMs,
        confirmedAtMs: state === 'CONFIRMED' ? completedAtMs : null,
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
        transitions.push({ type: 'appeared', track, previousState: 'TENTATIVE', atMs: completedAtMs, reason: 'confirmed_on_first_hit' });
      }
    }

    // Only a valid batch can age tracks. Gaps use capture time; transition time uses completion time.
    for (const track of [...this.tracks.values()]) {
      if (matchedTracks.has(track.trackId)) continue;
      const gap = capturedAtMs - track.lastSeenAtMs;
      if (gap > this.config.expireAfterMs) {
        const expired: TrackedObject = {
          ...track,
          trackingState: 'EXPIRED',
          stateChangedAtMs: completedAtMs,
          missedObservations: track.missedObservations + 1,
        };
        this.tracks.delete(track.trackId);
        newlyExpired.push(expired);
        this.stats.expiredTracks += 1;
        transitions.push({ type: 'expired', track: expired, previousState: track.trackingState, atMs: completedAtMs, reason: 'expiry_gap' });
      } else if (gap > this.config.lostAfterMs && track.trackingState !== 'TEMPORARILY_LOST') {
        const lost: TrackedObject = {
          ...track,
          trackingState: 'TEMPORARILY_LOST',
          stateChangedAtMs: completedAtMs,
          missedObservations: track.missedObservations + 1,
        };
        this.tracks.set(track.trackId, lost);
        transitions.push({ type: 'lost', track: lost, previousState: track.trackingState, atMs: completedAtMs, reason: 'valid_empty_gap' });
      } else {
        this.tracks.set(track.trackId, { ...track, missedObservations: track.missedObservations + 1 });
      }
    }

    if (accepted.length > 0) {
      this.stats.associationFailures += [...this.tracks.values()].filter((track) => !matchedTracks.has(track.trackId)).length;
    }
    return this.result(batch, true, 'ok', transitions, accepted.length, lowConfidence.length, newlyExpired, detections.length);
  }

  private result(
    batch: DetectionBatch,
    processed: boolean,
    status: TrackingFrameStatus,
    transitions: TrackTransition[] = [],
    detectionsProcessed = 0,
    lowConfidenceDetections = 0,
    newlyExpired: TrackedObject[] = [],
    receivedDetections = 0,
    invalidReason?: string,
  ): TrackingFrameResult {
    const capturedAtMs = batch.capturedAtMs ?? batch.observedAtMs;
    const completedAtMs = batch.completedAtMs ?? batch.observedAtMs;
    return {
      sessionId: this.sessionId,
      observedAtMs: completedAtMs,
      capturedAtMs,
      completedAtMs,
      processed,
      status,
      invalidReason,
      tracks: [...this.tracks.values()],
      expired: newlyExpired,
      transitions,
      receivedDetections,
      detectionsProcessed,
      lowConfidenceDetections,
      associationFailures: this.stats.associationFailures,
    };
  }
}
