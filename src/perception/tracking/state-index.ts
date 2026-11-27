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

  constructor(sessionId: string, config: Partial<ObjectStateIndexConfig> = {}) {
    this.sessionId = sessionId;
    this.config = { ...DEFAULTS, ...config };
  }

  get currentSessionId(): string { return this.sessionId; }
  get size(): number { return this.tracks.size; }
  get evidenceResolver(): EvidenceResolver | undefined { return this.config.evidenceResolver; }

  reset(sessionId: string): void {
    this.sessionId = sessionId;
    this.tracks.clear();
    this.histories.clear();
    this.events.length = 0;
    this.indexEvictions = 0;
    this.eventEvictions = 0;
    this.eventSuppressed = 0;
  }

  ingest(result: TrackingFrameResult, events: readonly ObjectEvent[], suppressed = 0): void {
    if (!result.processed) return;
    if (result.sessionId !== this.sessionId) this.reset(result.sessionId);
    const all = [...result.tracks, ...result.expired];
    for (const track of all) this.upsert(track, result.observedAtMs);
    this.addEvents(events);
    this.eventSuppressed += suppressed;
  }

  private upsert(track: TrackedObject, atMs: number): void {
    if (!this.tracks.has(track.trackId) && this.tracks.size >= this.config.maxTracks) {
      const oldest = [...this.tracks.values()].sort((left, right) => left.lastSeenAtMs - right.lastSeenAtMs)[0];
      if (oldest) this.tracks.delete(oldest.trackId);
      this.indexEvictions += 1;
    }
    this.tracks.set(track.trackId, track);
    const history = this.histories.get(track.trackId) ?? [];
    const previous = history[history.length - 1];
    if (!previous || previous.atMs !== atMs || previous.trackingState !== track.trackingState) {
      history.push({
        atMs,
        boundingBox: track.boundingBox,
        confidence: track.confidence,
        trackingState: track.trackingState,
        evidenceRef: track.evidenceRef,
      });
    }
    const cutoff = atMs - this.config.historyWindowMs;
    while (history.length && history[0].atMs < cutoff) history.shift();
    while (history.length > this.config.maxHistoryPerTrack) history.shift();
    this.histories.set(track.trackId, history);
  }

  private addEvents(events: readonly ObjectEvent[]): void {
    for (const event of events) {
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

  getObjectEvidence(trackId: string, timestampMs: number): EvidenceResolution {
    const track = this.tracks.get(trackId);
    const history = this.histories.get(trackId) ?? [];
    const point = [...history].reverse().find((item) => item.atMs <= timestampMs) ?? history[0];
    if (!track || !point) {
      return {
        status: 'unavailable', sessionId: this.sessionId, trackId, requestedAtMs: timestampMs,
        message: 'No structured observation exists for this track and time.',
      };
    }
    if (!this.config.evidenceResolver) {
      return {
        status: 'unavailable', sessionId: this.sessionId, trackId, requestedAtMs: timestampMs,
        evidenceRef: point.evidenceRef,
        message: 'Evidence is unavailable: no image cache is attached to this perception session.',
      };
    }
    return this.config.evidenceResolver.resolve({
      sessionId: this.sessionId, trackId, evidenceRef: point.evidenceRef, atMs: point.atMs,
    });
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
