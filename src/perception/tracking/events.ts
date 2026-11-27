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
}

const DEFAULTS: ObjectEventEngineConfig = {
  minMoveDistance: 0.03,
  stationaryAfterMs: 2_500,
  cooldownMs: 1_000,
  minConfidence: 0.35,
};

export interface EventEngineResult {
  readonly events: readonly ObjectEvent[];
  readonly suppressed: number;
}

/**
 * Converts tracker transitions plus stable image-space observations into
 * bounded semantic events. It deliberately does not claim physical motion:
 * there is no camera-motion compensation in this phase.
 */
export class ObjectEventEngine {
  private readonly config: ObjectEventEngineConfig;
  private sessionId = '';
  private serial = 0;
  private readonly emittedAt = new Map<string, number>();
  private readonly lastBox = new Map<string, NormalizedBox>();
  private readonly lastMovementAt = new Map<string, number>();
  private readonly lastStationaryAt = new Map<string, number>();
  private readonly insideRegion = new Map<string, boolean>();
  private readonly confirmedTracks = new Set<string>();

  constructor(config: Partial<ObjectEventEngineConfig> = {}) {
    this.config = { ...DEFAULTS, ...config };
  }

  reset(sessionId = ''): void {
    this.sessionId = sessionId;
    this.serial = 0;
    this.emittedAt.clear();
    this.lastBox.clear();
    this.lastMovementAt.clear();
    this.lastStationaryAt.clear();
    this.insideRegion.clear();
    this.confirmedTracks.clear();
  }

  process(result: TrackingFrameResult): EventEngineResult {
    if (!result.processed) return { events: [], suppressed: 0 };
    if (result.sessionId !== this.sessionId) this.reset(result.sessionId);
    const events: ObjectEvent[] = [];
    let suppressed = 0;
    const transitions = new Map<string, TrackTransition>();
    for (const transition of result.transitions) transitions.set(transition.track.trackId, transition);

    const push = (event: ObjectEvent): void => {
      const key = event.trackId + ':' + event.eventType;
      const previous = this.emittedAt.get(key);
      if (previous !== undefined && event.observedAtMs - previous < this.config.cooldownMs) {
        suppressed += 1;
        return;
      }
      this.emittedAt.set(key, event.observedAtMs);
      events.push(event);
    };

    for (const track of result.tracks) {
      if (track.trackingState === 'EXPIRED') continue;
      const transition = transitions.get(track.trackId);
      if (transition) {
        if (transition.type === 'appeared' && track.confidence >= this.config.minConfidence) {
          this.confirmedTracks.add(track.trackId);
          push(this.event(track, 'OBJECT_APPEARED', track.confidence, 'inferred',
            track.associationUncertain ? 'ambiguous_association_confirmed' : 'confirmed_after_hits', 'TENTATIVE', 'CONFIRMED', track.lastSeenAtMs));
          if (!this.lastMovementAt.has(track.trackId)) this.lastMovementAt.set(track.trackId, track.lastSeenAtMs);
        } else if (transition.type === 'reappeared') {
          this.confirmedTracks.add(track.trackId);
          this.lastStationaryAt.delete(track.trackId);
          push(this.event(track, 'OBJECT_REAPPEARED', track.confidence, 'inferred',
            track.associationUncertain ? 'ambiguous_reappearance_match' : 'matched_after_temporary_loss', 'TEMPORARILY_LOST', 'CONFIRMED', track.lastSeenAtMs));
        } else if (transition.type === 'lost' && this.confirmedTracks.has(track.trackId)) {
          push(this.event(track, 'OBJECT_TEMPORARILY_LOST', track.confidence, 'inferred',
            'valid_empty_batch_gap', 'CONFIRMED', 'TEMPORARILY_LOST', track.lastSeenAtMs));
        } else if (transition.type === 'expired' && this.confirmedTracks.has(track.trackId)) {
          push(this.event(track, 'OBJECT_EXPIRED', track.confidence, 'inferred',
            'expiry_without_valid_match_not_physical_removal', 'TEMPORARILY_LOST', 'EXPIRED', track.lastSeenAtMs));
        }
      }

      if (track.trackingState === 'CONFIRMED' && track.confidence >= this.config.minConfidence) {
        const previous = this.lastBox.get(track.trackId);
        this.lastBox.set(track.trackId, track.boundingBox);
        if (previous) {
          const distance = centerDistance(previous, track.boundingBox);
          if (distance >= this.config.minMoveDistance) {
            this.lastMovementAt.set(track.trackId, track.lastSeenAtMs);
            this.lastStationaryAt.delete(track.trackId);
            push(this.event(track, 'OBJECT_MOVED', track.confidence, 'image-coordinate-only',
              track.associationUncertain ? 'ambiguous_image_displacement' : 'image_displacement_threshold',
              'CONFIRMED', 'CONFIRMED', track.lastSeenAtMs));
          } else {
            const movedAt = this.lastMovementAt.get(track.trackId) ?? track.firstSeenAtMs;
            if (track.lastSeenAtMs - movedAt >= this.config.stationaryAfterMs
              && !this.lastStationaryAt.has(track.trackId)) {
              this.lastStationaryAt.set(track.trackId, track.lastSeenAtMs);
              push(this.event(track, 'OBJECT_STATIONARY', track.confidence, 'inferred',
                'stable_image_position_hysteresis', 'CONFIRMED', 'CONFIRMED', track.lastSeenAtMs));
            }
          }
        } else {
          this.lastMovementAt.set(track.trackId, track.lastSeenAtMs);
        }

        if (this.config.region) {
          const inside = isCenterInside(track.boundingBox, this.config.region);
          const wasInside = this.insideRegion.get(track.trackId);
          this.insideRegion.set(track.trackId, inside);
          if (wasInside !== undefined && wasInside !== inside) {
            push(this.event(track, inside ? 'OBJECT_ENTERED_REGION' : 'OBJECT_LEFT_REGION', track.confidence,
              'image-coordinate-only', inside ? 'region_enter' : 'region_leave',
              'CONFIRMED', 'CONFIRMED', track.lastSeenAtMs));
          }
        }
      }
    }

    // Lost/expired tracks are not in result.tracks after expiry; transitions carry them.
    for (const transition of result.transitions) {
      if (transition.type !== 'lost' && transition.type !== 'expired') continue;
      if (result.tracks.some((track) => track.trackId === transition.track.trackId)) continue;
      if (transition.type === 'lost' && this.confirmedTracks.has(transition.track.trackId)) {
        push(this.event(transition.track, 'OBJECT_TEMPORARILY_LOST', transition.track.confidence, 'inferred',
          'valid_empty_batch_gap', transition.previousState, 'TEMPORARILY_LOST', transition.atMs));
      } else if (transition.type === 'expired' && this.confirmedTracks.has(transition.track.trackId)) {
        push(this.event(transition.track, 'OBJECT_EXPIRED', transition.track.confidence, 'inferred',
          'expiry_without_valid_match_not_physical_removal', transition.previousState, 'EXPIRED', transition.atMs));
      }
    }

    return { events, suppressed };
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
      previousState,
      currentState,
      confidence,
      certainty,
      reason,
      evidenceRef: track.evidenceRef,
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
