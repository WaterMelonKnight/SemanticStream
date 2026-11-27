import type { EvidenceResolver, ObjectStateReader, SemanticEventSource } from './contracts';
import { ObjectEventEngine, type ObjectEventEngineConfig } from './events';
import { ObjectStateIndex, type ObjectStateIndexConfig } from './state-index';
import { ObjectTracker } from './tracker';
import {
  type DetectionBatch,
  type EventFilter,
  type EvidenceResolution,
  type HistoryRange,
  type ObjectEvent,
  type ObjectRegion,
  type ObjectStateSnapshot,
  type TrackedObject,
  type TrackFilter,
  type TrackHistoryPoint,
  type TrackingConfig,
  type TrackingFrameResult,
  type TrackingSystemSnapshot,
} from './types';

export interface ObjectTrackingSystemConfig {
  readonly tracker?: Partial<TrackingConfig>;
  readonly events?: Partial<ObjectEventEngineConfig>;
  readonly index?: Partial<ObjectStateIndexConfig>;
  readonly evidenceResolver?: EvidenceResolver;
  readonly clock?: () => number;
}

export interface TrackingProcessingResult {
  readonly frame: TrackingFrameResult;
  readonly events: readonly ObjectEvent[];
  readonly suppressedEvents: number;
  readonly trackingMs: number;
  readonly eventMs: number;
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

/** Page-scoped facade used by Perception Lab and the Phase 4I read contracts. */
export class ObjectTrackingSystem implements ObjectStateReader, SemanticEventSource {
  private readonly tracker: ObjectTracker;
  private readonly engine: ObjectEventEngine;
  private readonly index: ObjectStateIndex;
  private readonly listeners = new Set<(event: ObjectEvent) => void>();
  private readonly processingSamples: number[] = [];
  private readonly eventSamples: number[] = [];
  private inputBatches = 0;
  private inputDetections = 0;
  private receivedDetections = 0;
  private lowConfidenceDetections = 0;
  private outputEvents = 0;
  private listenerErrors = 0;
  private readonly now: () => number;
  private lastStatus = 'idle';
  private readonly MAX_LISTENERS = 32;

  constructor(sessionId: string, config: ObjectTrackingSystemConfig = {}) {
    this.now = config.clock ?? (() => performance.now());
    this.tracker = new ObjectTracker(config.tracker);
    this.engine = new ObjectEventEngine(config.events);
    this.index = new ObjectStateIndex(sessionId, {
      ...config.index,
      evidenceResolver: config.evidenceResolver ?? config.index?.evidenceResolver,
    });
    this.tracker.reset(sessionId);
    this.engine.reset(sessionId);
    this.index.reset(sessionId);
  }

  get sessionId(): string { return this.index.currentSessionId; }
  get activeTracks(): readonly TrackedObject[] { return this.index.getTrackedObjects(); }
  get events(): readonly ObjectEvent[] { return this.index.getObjectEvents(); }

  reset(sessionId: string): void {
    this.tracker.reset(sessionId);
    this.engine.reset(sessionId);
    this.index.reset(sessionId);
    this.processingSamples.length = 0;
    this.eventSamples.length = 0;
    this.inputBatches = 0;
    this.inputDetections = 0;
    this.receivedDetections = 0;
    this.lowConfidenceDetections = 0;
    this.outputEvents = 0;
    this.lastStatus = 'idle';
    this.listenerErrors = 0;
  }

  process(batch: DetectionBatch): TrackingProcessingResult {
    const trackingStart = this.now();
    const frame = this.tracker.update(batch);
    const trackingMs = this.now() - trackingStart;
    const eventStart = this.now();
    const eventResult = this.engine.process(frame, this.now);
    const eventMs = this.now() - eventStart;
    this.index.ingest(frame, eventResult.events, eventResult.suppressed);
    this.inputBatches += frame.processed ? 1 : 0;
    this.inputDetections += frame.detectionsProcessed;
    this.receivedDetections += frame.receivedDetections;
    this.lowConfidenceDetections += frame.lowConfidenceDetections;
    this.outputEvents += eventResult.events.length;
    this.lastStatus = frame.invalidReason ? `${frame.status}: ${frame.invalidReason}` : frame.status;
    if (frame.processed) {
      this.processingSamples.push(trackingMs);
      if (this.processingSamples.length > 200) this.processingSamples.shift();
      this.eventSamples.push(eventMs);
      if (this.eventSamples.length > 200) this.eventSamples.shift();
    }
    for (const event of eventResult.events) {
      for (const listener of [...this.listeners]) {
        if (event.sessionId !== this.sessionId) break;
        try { listener(event); } catch { this.listenerErrors += 1; }
      }
    }
    return { frame, events: eventResult.events, suppressedEvents: eventResult.suppressed, trackingMs, eventMs };
  }

  setRegion(region?: ObjectRegion): void { this.engine.setRegion(region); }

  subscribe(listener: (event: ObjectEvent) => void): () => void {
    if (this.listeners.size >= this.MAX_LISTENERS) throw new RangeError('Too many semantic event listeners.');
    this.listeners.add(listener);
    let active = true;
    return () => { if (active) { active = false; this.listeners.delete(listener); } };
  }

  getTrackedObjects(filter: TrackFilter = {}): readonly TrackedObject[] { return this.index.getTrackedObjects(filter); }
  getObjectById(trackId: string): TrackedObject | undefined { return this.index.getObjectById(trackId); }
  getObjectsInRegion(region: ObjectRegion): readonly TrackedObject[] { return this.index.getObjectsInRegion(region); }
  getObjectHistory(trackId: string, timeRange?: HistoryRange): readonly TrackHistoryPoint[] {
    return this.index.getObjectHistory(trackId, timeRange);
  }
  getObjectEvents(filter: EventFilter = {}): readonly ObjectEvent[] { return this.index.getObjectEvents(filter); }
  getObjectEvidence(trackId: string, timestampMs: number, sessionId = this.sessionId): EvidenceResolution {
    return this.index.getObjectEvidence(trackId, timestampMs, sessionId);
  }
  snapshot(): ObjectStateSnapshot { return this.index.snapshot(); }

  diagnostics(): TrackingSystemSnapshot {
    const state = this.index.snapshot();
    return {
      ...state,
      processingP50Ms: percentile(this.processingSamples, 0.5),
      processingP95Ms: percentile(this.processingSamples, 0.95),
      eventP50Ms: percentile(this.eventSamples, 0.5),
      eventP95Ms: percentile(this.eventSamples, 0.95),
      associationFailures: this.tracker.trackerStats.associationFailures,
      inputBatches: this.inputBatches,
      inputDetections: this.inputDetections,
      receivedDetections: this.receivedDetections,
      lowConfidenceDetections: this.lowConfidenceDetections,
      outputEvents: this.outputEvents,
      lastStatus: this.lastStatus,
      historyEntries: this.index.historyEntries,
      trackerTracks: this.tracker.activeTracks.length,
      eventStateEntries: this.engine.stateEntries,
      activeEvictions: this.index.activeEvictionCount,
      listenerCount: this.listeners.size,
      listenerErrors: this.listenerErrors,
    };
  }
}
