import type {
  EventFilter,
  EvidenceResolution,
  HistoryRange,
  ObjectEvent,
  ObjectRegion,
  ObjectStateSnapshot,
  TrackedObject,
  TrackFilter,
  TrackHistoryPoint,
} from './types';

/** Stable read interface for a future inference scheduler/phase 4I adapter. */
export interface ObjectStateReader {
  getTrackedObjects(filter?: TrackFilter): readonly TrackedObject[];
  getObjectById(trackId: string): TrackedObject | undefined;
  getObjectsInRegion(region: ObjectRegion): readonly TrackedObject[];
  getObjectHistory(trackId: string, timeRange?: HistoryRange): readonly TrackHistoryPoint[];
  getObjectEvents(filter?: EventFilter): readonly ObjectEvent[];
  getObjectEvidence(trackId: string, timestampMs: number): EvidenceResolution;
  snapshot(): ObjectStateSnapshot;
}

/** Local, page-scoped semantic event source. It is not a global event bus. */
export interface SemanticEventSource {
  subscribe(listener: (event: ObjectEvent) => void): () => void;
}

export interface EvidenceLookup {
  readonly sessionId: string;
  readonly trackId: string;
  readonly evidenceRef: string;
  readonly atMs: number;
}

/**
 * A resolver may bridge to a ContextBuffer when the producer and consumer share
 * the exact same session. Without one, evidence is explicitly unavailable.
 */
export interface EvidenceResolver {
  resolve(lookup: EvidenceLookup): EvidenceResolution;
}
