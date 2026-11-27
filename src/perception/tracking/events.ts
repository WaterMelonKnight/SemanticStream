import type {
  EventCertainty,
  ObjectEvent,
  ObjectEventType,
  ObjectRegion,
  TrackingFrameResult,
  TrackedObject,
  NormalizedBox,
  TrackTransition,
} from './types';

export interface ObjectEventEngineConfig {
  readonly minMoveDistance: number;
  readonly stationaryAfterMs: number;
  readonly cooldownMs: number;
  readonly minConfidence: number;
  readonly region?: ObjectRegion;
  /** Retention for per-track event state after a track leaves the active set. */
  readonly stateTtlMs?: number;
  /** Hard cap for per-track event state, independent of the tracker. */
  readonly maxStateTracks?: number;
}

type ResolvedEventConfig = Omit<Required<ObjectEventEngineConfig>, 'region'> & { readonly region?: ObjectRegion };

const DEFAULTS: ResolvedEventConfig = {
  minMoveDistance: 0.03,
  stationaryAfterMs: 2_500,
  cooldownMs: 1_000,
  minConfidence: 0.35,
  stateTtlMs: 60_000,
  maxStateTracks: 256,
};

export interface EventEngineResult {
  readonly events: readonly ObjectEvent[];
  readonly suppressed: number;
}

/**
 * Converts tracker transitions plus stable image-space observations into
 * bounded semantic events. Event observedAtMs is the detection-completion time,
 * while movement/stationary calculations use matched observation state only.
 */
export class ObjectEventEngine {
  private readonly config: ResolvedEventConfig;
  private region?: ObjectRegion;
  private producedAt = () => 0;
  private sessionId = '';
  private serial = 0;
  private readonly emittedAt = new Map<string, number>();
  private readonly lastBox = new Map<string, NormalizedBox>();
  private readonly lastMovementAt = new Map<string, number>();
  private readonly lastStationaryAt = new Map<string, number>();
  private readonly insideRegion = new Map<string, boolean>();
  private readonly lastTouchedAt = new Map<string, number>();

  constructor(config: Partial<ObjectEventEngineConfig> = {}) {
    this.config = { ...DEFAULTS, ...config };
    this.region = config.region;
    for (const [key, value] of Object.entries({
      minMoveDistance: this.config.minMoveDistance,
      stationaryAfterMs: this.config.stationaryAfterMs,
      cooldownMs: this.config.cooldownMs,
      minConfidence: this.config.minConfidence,
      stateTtlMs: this.config.stateTtlMs,
    })) {
      if (!Number.isFinite(value) || value < 0) throw new RangeError(`${key} must be a non-negative finite number.`);
    }
    if (!Number.isSafeInteger(this.config.maxStateTracks) || this.config.maxStateTracks < 1) throw new RangeError('maxStateTracks must be a positive integer.');
  }

  reset(sessionId = ''): void {
    this.sessionId = sessionId;
    this.serial = 0;
    this.emittedAt.clear();
    this.lastBox.clear();
    this.lastMovementAt.clear();
    this.lastStationaryAt.clear();
    this.insideRegion.clear();
    this.lastTouchedAt.clear();
  }

  /** Number of distinct track IDs retained across all bounded event-state maps. */
  get stateEntries(): number {
    return this.lastTouchedAt.size;
  }

  setRegion(region?: ObjectRegion): void {
    this.region = region && { ...region };
    this.insideRegion.clear();
  }

  process(result: TrackingFrameResult, now: () => number = () => result.completedAtMs): EventEngineResult {
    if (!result.processed) return { events: [], suppressed: 0 };
    if (result.sessionId !== this.sessionId) return { events: [], suppressed: 0 };
    const events: ObjectEvent[] = [];
    let suppressed = 0;
    const transitions = new Map<string, TrackTransition>();
    for (const transition of result.transitions) transitions.set(transition.track.trackId, transition);
    const batchAt = result.completedAtMs;
    this.producedAt = () => Math.max(batchAt, now());
    const activeIds = new Set(result.tracks.map((track) => track.trackId));

    const push = (event: ObjectEvent): void => {
      const key = event.trackId + ':' + event.eventType;
      const previous = this.emittedAt.get(key);
      const coalescible = event.eventType === 'OBJECT_MOVED' || event.eventType === 'OBJECT_STATIONARY';
      if (coalescible && previous !== undefined && event.observedAtMs - previous < this.config.cooldownMs) {
        suppressed += 1;
        return;
      }
      this.emittedAt.set(key, event.observedAtMs);
      events.push(event);
    };

    for (const track of result.tracks) {
      if (track.trackingState === 'EXPIRED') continue;
      this.lastTouchedAt.set(track.trackId, batchAt);
      const transition = transitions.get(track.trackId);
      if (transition) {
        if (transition.type === 'appeared' && track.confidence >= this.config.minConfidence) {
          push(this.event(track, 'OBJECT_APPEARED', track.confidence, 'inferred',
            track.associationUncertain ? 'ambiguous_association_confirmed' : 'confirmed_after_hits',
            'TENTATIVE', 'CONFIRMED', transition.atMs));
          if (!this.lastMovementAt.has(track.trackId)) this.lastMovementAt.set(track.trackId, batchAt);
        } else if (transition.type === 'reappeared' && (track.confirmedAtMs !== null && track.confidence >= this.config.minConfidence)) {
          this.lastStationaryAt.delete(track.trackId);
          this.lastMovementAt.set(track.trackId, batchAt);
          push(this.event(track, 'OBJECT_REAPPEARED', track.confidence, 'inferred',
            track.associationUncertain ? 'ambiguous_reappearance_match' : 'matched_after_temporary_loss',
            transition.previousState, 'CONFIRMED', transition.atMs));
        } else if (transition.type === 'lost' && (track.confirmedAtMs !== null && track.confidence >= this.config.minConfidence)) {
          this.insideRegion.delete(track.trackId);
          push(this.event(track, 'OBJECT_TEMPORARILY_LOST', track.confidence, 'inferred',
            'valid_empty_batch_gap', transition.previousState, 'TEMPORARILY_LOST', transition.atMs));
        } else if (transition.type === 'expired' && (track.confirmedAtMs !== null && track.confidence >= this.config.minConfidence)) {
          push(this.event(track, 'OBJECT_EXPIRED', track.confidence, 'inferred',
            'expiry_without_valid_match_not_physical_removal', transition.previousState, 'EXPIRED', transition.atMs));
        }
      }

      if (track.missedObservations > 0) {
        this.lastBox.delete(track.trackId);
        this.lastMovementAt.delete(track.trackId);
        this.lastStationaryAt.delete(track.trackId);
        continue;
      }
      if (track.trackingState === 'CONFIRMED' && track.confidence >= this.config.minConfidence) {
        const previous = this.lastBox.get(track.trackId);
        this.lastBox.set(track.trackId, track.boundingBox);
        const observedAtMs = track.lastObservationAtMs;
        if (previous) {
          const distance = centerDistance(previous, track.boundingBox);
          if (distance >= this.config.minMoveDistance) {
            this.lastMovementAt.set(track.trackId, observedAtMs);
            this.lastStationaryAt.delete(track.trackId);
            push(this.event(track, 'OBJECT_MOVED', track.confidence, 'image-coordinate-only',
              track.associationUncertain ? 'ambiguous_image_displacement' : 'image_displacement_threshold',
              'CONFIRMED', 'CONFIRMED', observedAtMs));
          } else {
            const movedAt = this.lastMovementAt.get(track.trackId) ?? track.confirmedAtMs ?? observedAtMs;
            if (observedAtMs - movedAt >= this.config.stationaryAfterMs
              && !this.lastStationaryAt.has(track.trackId)) {
              this.lastStationaryAt.set(track.trackId, observedAtMs);
              push(this.event(track, 'OBJECT_STATIONARY', track.confidence, 'inferred',
                'stable_image_position_hysteresis', 'CONFIRMED', 'CONFIRMED', observedAtMs));
            }
          }
        } else {
          this.lastMovementAt.set(track.trackId, observedAtMs);
        }

        if (this.region) {
          const inside = isCenterInside(track.boundingBox, this.region);
          const wasInside = this.insideRegion.get(track.trackId);
          this.insideRegion.set(track.trackId, inside);
          if (wasInside !== undefined && wasInside !== inside) {
            push(this.event(track, inside ? 'OBJECT_ENTERED_REGION' : 'OBJECT_LEFT_REGION', track.confidence,
              'image-coordinate-only', inside ? 'region_enter' : 'region_leave',
              'CONFIRMED', 'CONFIRMED', observedAtMs));
          }
        }
      }
    }

    // Expired tracks are not in result.tracks; consume their final transition once.
    for (const transition of result.transitions) {
      if (transition.type !== 'expired') continue;
      if (transition.track.confirmedAtMs === null || transition.track.confidence < this.config.minConfidence) continue;
      push(this.event(transition.track, 'OBJECT_EXPIRED', transition.track.confidence, 'inferred',
        'expiry_without_valid_match_not_physical_removal', transition.previousState, 'EXPIRED', transition.atMs));
    }

    // Expired track IDs cannot reappear; remove all per-track event state immediately.
    for (const transition of result.transitions) {
      if (transition.type === 'expired') this.forget(transition.track.trackId);
    }
    this.cleanup(activeIds, batchAt);
    return { events, suppressed };
  }

  private forget(trackId: string): void {
    this.emittedAt.delete(trackId + ':OBJECT_APPEARED');
    this.emittedAt.delete(trackId + ':OBJECT_REAPPEARED');
    this.emittedAt.delete(trackId + ':OBJECT_TEMPORARILY_LOST');
    this.emittedAt.delete(trackId + ':OBJECT_EXPIRED');
    this.emittedAt.delete(trackId + ':OBJECT_MOVED');
    this.emittedAt.delete(trackId + ':OBJECT_STATIONARY');
    this.emittedAt.delete(trackId + ':OBJECT_ENTERED_REGION');
    this.emittedAt.delete(trackId + ':OBJECT_LEFT_REGION');
    this.lastBox.delete(trackId);
    this.lastMovementAt.delete(trackId);
    this.lastStationaryAt.delete(trackId);
    this.insideRegion.delete(trackId);
    this.lastTouchedAt.delete(trackId);
  }

  private cleanup(activeIds: Set<string>, now: number): void {
    for (const [trackId, touchedAt] of [...this.lastTouchedAt]) {
      if (!activeIds.has(trackId) && now - touchedAt > this.config.stateTtlMs) this.forget(trackId);
    }
    if (this.lastTouchedAt.size <= this.config.maxStateTracks) return;
    const removable = [...this.lastTouchedAt.entries()]
      .filter(([trackId]) => !activeIds.has(trackId))
      .sort((left, right) => left[1] - right[1]);
    for (const [trackId] of removable) {
      if (this.lastTouchedAt.size <= this.config.maxStateTracks) break;
      this.forget(trackId);
    }
    while (this.lastTouchedAt.size > this.config.maxStateTracks) {
      const oldest = [...this.lastTouchedAt.entries()].sort((a, b) => a[1] - b[1])[0];
      if (!oldest) break;
      this.forget(oldest[0]);
    }
  }

  private event(
    track: TrackedObject,
    eventType: ObjectEventType,
    confidence: number,
    certainty: EventCertainty,
    reason: string,
    previousState: ObjectEvent['previousState'],
    currentState: ObjectEvent['currentState'],
    atMs: number,
  ): ObjectEvent {
    return {
      eventId: `${track.sessionId}:e${++this.serial}`,
      eventType,
      sessionId: track.sessionId,
      trackId: track.trackId,
      categoryId: track.categoryId,
      categoryName: track.categoryName,
      observedAtMs: atMs,
      producedAtMs: this.producedAt(),
      stateChangedAtMs: track.stateChangedAtMs,
      previousState,
      currentState,
      confidence,
      associationUncertain: track.associationUncertain,
      certainty,
      reason,
      evidenceRef: track.evidenceRef,
      evidence: track.evidence,
      schemaVersion: 1,
    };
  }
}

function centerDistance(left: NormalizedBox, right: NormalizedBox): number {
  return Math.hypot(
    (left.x + left.width / 2) - (right.x + right.width / 2),
    (left.y + left.height / 2) - (right.y + right.height / 2),
  );
}

function isCenterInside(box: NormalizedBox, region: ObjectRegion): boolean {
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  return x >= region.x && x <= region.x + region.width && y >= region.y && y <= region.y + region.height;
}
