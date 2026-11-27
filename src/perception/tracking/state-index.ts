import type { EvidenceResolver } from './contracts';
import {
  type EventFilter,
  type EvidenceResolution,
  type HistoryRange,
  type ObjectEvent,
  type ObjectEventType,
  type ObjectRegion,
  type ObjectStateSnapshot,
  type TrackedObject,
  type TrackFilter,
  type TrackHistoryPoint,
  type TrackingFrameResult,
} from './types';

export interface ObjectStateIndexConfig {
  readonly maxTracks: number;
  readonly maxHistoryPerTrack: number;
  readonly historyWindowMs: number;
  readonly maxEvents: number;
  readonly evidenceResolver?: EvidenceResolver;
}

const DEFAULTS: ObjectStateIndexConfig = {
  maxTracks: 100,
  maxHistoryPerTrack: 80,
  historyWindowMs: 60_000,
  maxEvents: 400,
};

/** Bounded, session-scoped index of tracks/history/events and evidence references. */
export class ObjectStateIndex {
  private readonly config: ObjectStateIndexConfig;
  private sessionId = '';
  private readonly tracks = new Map<string, TrackedObject>();
  private readonly histories = new Map<string, TrackHistoryPoint[]>();
  private readonly events: ObjectEvent[] = [];
  private indexEvictions = 0;
  private eventEvictions = 0;
  private eventSuppressed = 0;
  private activeEvictions = 0;

  constructor(sessionId: string, config: Partial<ObjectStateIndexConfig> = {}) {
    this.sessionId = sessionId;
    this.config = { ...DEFAULTS, ...config };
    for (const [key, value] of Object.entries({
      maxTracks: this.config.maxTracks,
      maxHistoryPerTrack: this.config.maxHistoryPerTrack,
      historyWindowMs: this.config.historyWindowMs,
      maxEvents: this.config.maxEvents,
    })) {
      if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${key} must be a non-negative safe integer.`);
    }
    if (this.config.maxTracks < 1 || this.config.maxHistoryPerTrack < 1 || this.config.maxEvents < 1) throw new RangeError('State-index capacities must be positive.');
  }

  get currentSessionId(): string { return this.sessionId; }
  get size(): number { return this.tracks.size; }
  get evidenceResolver(): EvidenceResolver | undefined { return this.config.evidenceResolver; }
  get historyEntries(): number { return this.histories.size; }
  get activeEvictionCount(): number { return this.activeEvictions; }

  reset(sessionId: string): void {
    this.sessionId = sessionId;
    this.tracks.clear();
    this.histories.clear();
    this.events.length = 0;
    this.indexEvictions = 0;
    this.eventEvictions = 0;
    this.eventSuppressed = 0;
    this.activeEvictions = 0;
  }

  ingest(result: TrackingFrameResult, events: readonly ObjectEvent[], suppressed = 0): void {
    if (!result.processed) return;
    // Session switching is an explicit system reset; never let late data reset the index.
    if (result.sessionId !== this.sessionId) return;
    for (const track of [...result.tracks, ...result.expired]) this.upsert(track);
    this.addEvents(events);
    this.eventSuppressed += suppressed;
  }

  private upsert(track: TrackedObject): void {
    const existing = this.tracks.get(track.trackId);
    if (existing?.trackingState === 'EXPIRED') return; // do not re-ingest/replay expired tracks
    if (!existing && this.tracks.size >= this.config.maxTracks) {
      const evict = this.evictionCandidate();
      if (evict) {
        this.tracks.delete(evict.trackId);
        this.histories.delete(evict.trackId); // keep track and history ownership in sync
        this.indexEvictions += 1;
        if (evict.trackingState !== 'EXPIRED') this.activeEvictions += 1;
      }
    }
    this.tracks.set(track.trackId, track);
    const history = this.histories.get(track.trackId) ?? [];
    const previous = history[history.length - 1];
    const stateChanged = track.trackingState !== existing?.trackingState;
    const atMs = stateChanged ? track.stateChangedAtMs : track.lastSeenAtMs;
    if (!previous || atMs > previous.atMs || (atMs === previous.atMs && track.trackingState !== previous.trackingState)) {
      history.push({
        atMs,
        boundingBox: track.boundingBox,
        confidence: track.confidence,
        trackingState: track.trackingState,
        evidenceRef: track.evidenceRef,
      });
    }
    const cutoff = Math.max(track.lastSeenAtMs, track.stateChangedAtMs) - this.config.historyWindowMs;
    while (history.length && history[0].atMs < cutoff) history.shift();
    while (history.length > this.config.maxHistoryPerTrack) history.shift();
    this.histories.set(track.trackId, history);
  }

  /** Prefer expired, then lost/tentative, and evict confirmed active objects last. */
  private evictionCandidate(): TrackedObject | undefined {
    const rank = (track: TrackedObject): number => {
      if (track.trackingState === 'EXPIRED') return 0;
      if (track.trackingState === 'TEMPORARILY_LOST') return 1;
      if (track.trackingState === 'TENTATIVE') return 2;
      return 3;
    };
    return [...this.tracks.values()].sort((left, right) => rank(left) - rank(right)
      || left.lastSeenAtMs - right.lastSeenAtMs
      || left.trackId.localeCompare(right.trackId))[0];
  }

  private addEvents(events: readonly ObjectEvent[]): void {
    for (const event of events) {
      if (event.sessionId !== this.sessionId) continue;
      const duplicate = this.events.some((existing) => existing.eventId === event.eventId);
      if (duplicate) {
        this.eventSuppressed += 1;
        continue;
      }
      this.events.push(event);
      if (this.events.length > this.config.maxEvents) {
        this.events.shift();
        this.eventEvictions += 1;
      }
    }
  }

  getTrackedObjects(filter: TrackFilter = {}): readonly TrackedObject[] {
    return [...this.tracks.values()].filter((track) => {
      if (filter.state && track.trackingState !== filter.state) return false;
      if (filter.categoryName && track.categoryName !== filter.categoryName) return false;
      if (filter.minConfidence !== undefined && track.confidence < filter.minConfidence) return false;
      return true;
    });
  }

  getObjectById(trackId: string): TrackedObject | undefined {
    return this.tracks.get(trackId);
  }

  getObjectsInRegion(region: ObjectRegion): readonly TrackedObject[] {
    return [...this.tracks.values()].filter((track) => {
      if (track.trackingState === 'EXPIRED') return false;
      const box = track.boundingBox;
      return box.x < region.x + region.width && box.x + box.width > region.x
        && box.y < region.y + region.height && box.y + box.height > region.y;
    });
  }

  getObjectHistory(trackId: string, timeRange?: HistoryRange): readonly TrackHistoryPoint[] {
    const history = this.histories.get(trackId) ?? [];
    if (!timeRange) return [...history];
    return history.filter((point) => point.atMs >= timeRange.fromMs && point.atMs <= timeRange.toMs);
  }

  getObjectEvents(filter: EventFilter = {}): readonly ObjectEvent[] {
    return this.events.filter((event) => {
      if (filter.eventType && event.eventType !== filter.eventType) return false;
      if (filter.trackId && event.trackId !== filter.trackId) return false;
      if (filter.fromMs !== undefined && event.observedAtMs < filter.fromMs) return false;
      if (filter.toMs !== undefined && event.observedAtMs > filter.toMs) return false;
      return true;
    });
  }

  getObjectEvidence(trackId: string, timestampMs: number, sessionId = this.sessionId): EvidenceResolution {
    if (sessionId !== this.sessionId) {
      return { status: 'wrong-session', sessionId: this.sessionId, trackId, requestedAtMs: timestampMs,
        message: 'The requested session does not own this object index.' };
    }
    const track = this.tracks.get(trackId);
    const history = this.histories.get(trackId) ?? [];
    const point = [...history].reverse().find((item) => item.atMs <= timestampMs);
    if (!track || !point) {
      return { status: 'unavailable', sessionId: this.sessionId, trackId, requestedAtMs: timestampMs,
        message: 'No structured observation exists at or before the requested time.' };
    }
    if (track.trackingState === 'EXPIRED') {
      return { status: 'expired', sessionId: this.sessionId, trackId, requestedAtMs: timestampMs,
        evidenceRef: point.evidenceRef, capturedAtMs: point.atMs,
        message: 'The object state is expired; this is not a physical-removal or image-availability claim.' };
    }
    if (!this.config.evidenceResolver) {
      return { status: 'unavailable', sessionId: this.sessionId, trackId, requestedAtMs: timestampMs,
        evidenceRef: point.evidenceRef, capturedAtMs: point.atMs,
        message: 'Evidence is unavailable: no image cache is attached to this perception session.' };
    }
    return this.config.evidenceResolver.resolve({ sessionId: this.sessionId, trackId, evidenceRef: point.evidenceRef, atMs: point.atMs });
  }

  snapshot(): ObjectStateSnapshot {
    const values = [...this.tracks.values()];
    const counts = emptyEventCounts();
    for (const event of this.events) counts[event.eventType] += 1;
    return {
      sessionId: this.sessionId,
      tracks: values,
      events: [...this.events],
      activeCount: values.filter((track) => track.trackingState !== 'EXPIRED').length,
      tentativeCount: values.filter((track) => track.trackingState === 'TENTATIVE').length,
      lostCount: values.filter((track) => track.trackingState === 'TEMPORARILY_LOST').length,
      expiredCount: values.filter((track) => track.trackingState === 'EXPIRED').length,
      indexEntries: values.length,
      indexEvictions: this.indexEvictions,
      eventLogSize: this.events.length,
      eventSuppressed: this.eventSuppressed,
      eventCounts: counts,
    };
  }
}

function emptyEventCounts(): Record<ObjectEventType, number> {
  return {
    OBJECT_APPEARED: 0, OBJECT_MOVED: 0, OBJECT_STATIONARY: 0,
    OBJECT_TEMPORARILY_LOST: 0, OBJECT_REAPPEARED: 0, OBJECT_EXPIRED: 0,
    OBJECT_ENTERED_REGION: 0, OBJECT_LEFT_REGION: 0,
  };
}
