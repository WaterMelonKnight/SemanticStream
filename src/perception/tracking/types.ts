import type { ObjectObservation } from '../types';

export const TRACKING_SCHEMA_VERSION = 1;

export type TrackingState = 'TENTATIVE' | 'CONFIRMED' | 'TEMPORARILY_LOST' | 'EXPIRED';
export type TrackTransitionType = 'appeared' | 'reappeared' | 'lost' | 'expired';
export type DetectionBatchStatus = 'ok' | 'skipped' | 'failed';
export type TrackingFrameStatus = DetectionBatchStatus | 'invalid-time' | 'invalid-frame' | 'invalid-observation' | 'wrong-session' | 'duplicate';
export type ObjectEventType =
  | 'OBJECT_APPEARED'
  | 'OBJECT_MOVED'
  | 'OBJECT_STATIONARY'
  | 'OBJECT_TEMPORARILY_LOST'
  | 'OBJECT_REAPPEARED'
  | 'OBJECT_EXPIRED'
  | 'OBJECT_ENTERED_REGION'
  | 'OBJECT_LEFT_REGION';

export type EventCertainty = 'observed' | 'inferred' | 'image-coordinate-only';

export interface NormalizedBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface NormalizedPoint {
  readonly x: number;
  readonly y: number;
}

export interface TrackVelocity {
  /** Normalized box-center units per second. */
  readonly xPerSecond: number;
  readonly yPerSecond: number;
}

export interface FrameEvidenceRef {
  readonly frameRef: string;
  readonly sessionId: string;
  readonly frameSequence: number;
  readonly capturedAtMs: number;
}

export interface TrackedObject {
  readonly trackId: string;
  readonly sessionId: string;
  readonly categoryId: number;
  readonly categoryName: string;
  readonly categoryKey: string;
  /** Normalized source-frame coordinates, never model-input coordinates. */
  readonly boundingBox: NormalizedBox;
  readonly confidence: number;
  readonly firstSeenAtMs: number;
  /** Actual frame capture time of the latest matched observation. */
  readonly lastSeenAtMs: number;
  /** Detection-completion time of the latest matched batch. */
  readonly lastObservationAtMs: number;
  /** Time the current tracking state was confirmed. */
  readonly stateChangedAtMs: number;
  /** Increments on state transitions, including transitions on the same clock tick. */
  readonly stateRevision: number;
  /** Capture/completion time of first confirmation, or null while tentative. */
  readonly confirmedAtMs: number | null;
  readonly observationCount: number;
  readonly missedObservations: number;
  readonly velocity?: TrackVelocity;
  readonly trackingState: TrackingState;
  readonly evidenceRef: string;
  readonly evidence: FrameEvidenceRef;
  /** True when more than one same-category detection was a plausible match. */
  readonly associationUncertain: boolean;
}

export interface TrackHistoryPoint {
  readonly atMs: number;
  readonly boundingBox: NormalizedBox;
  readonly confidence: number;
  readonly trackingState: TrackingState;
  readonly evidenceRef: string;
  readonly evidence: FrameEvidenceRef;
}

export interface ObjectEvent {
  readonly eventId: string;
  readonly eventType: ObjectEventType;
  readonly sessionId: string;
  readonly trackId: string;
  readonly categoryId: number;
  readonly categoryName: string;
  /** Completion of the batch which confirmed this event. */
  readonly observedAtMs: number;
  readonly producedAtMs: number;
  readonly stateChangedAtMs: number;
  /** Increments on state transitions, including transitions on the same clock tick. */
  readonly stateRevision: number;
  readonly previousState: TrackingState;
  readonly currentState: TrackingState;
  readonly confidence: number;
  /** True when the association, not the model score, was ambiguous. */
  readonly associationUncertain: boolean;
  readonly certainty: EventCertainty;
  readonly reason: string;
  readonly evidenceRef: string;
  readonly evidence: FrameEvidenceRef;
  readonly schemaVersion: number;
}

export interface ObjectRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DetectionBatch {
  readonly sessionId: string;
  /** Detection-completion time for this batch. */
  readonly observedAtMs: number;
  /** Actual frame capture time; defaults to observedAtMs for old callers. */
  readonly capturedAtMs?: number;
  /** Detection completion time; defaults to observedAtMs. */
  readonly completedAtMs?: number;
  readonly frameSequence: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly status: DetectionBatchStatus;
  /** Only a status:'ok' batch may be treated as evidence that an object is absent. */
  readonly detections: readonly ObjectObservation[];
}

export interface TrackTransition {
  readonly type: TrackTransitionType;
  readonly track: TrackedObject;
  readonly previousState: TrackingState;
  readonly atMs: number;
  readonly reason: string;
}

export interface TrackingFrameResult {
  readonly sessionId: string;
  readonly observedAtMs: number;
  readonly capturedAtMs: number;
  readonly completedAtMs: number;
  readonly processed: boolean;
  readonly status: TrackingFrameStatus;
  readonly invalidReason?: string;
  readonly tracks: readonly TrackedObject[];
  readonly expired: readonly TrackedObject[];
  readonly transitions: readonly TrackTransition[];
  readonly receivedDetections: number;
  readonly detectionsProcessed: number;
  readonly lowConfidenceDetections: number;
  readonly associationFailures: number;
}

export interface TrackingConfig {
  readonly minConfidence: number;
  readonly minIou: number;
  readonly maxCenterDistance: number;
  readonly maxAssociationGapMs: number;
  readonly lostAfterMs: number;
  readonly expireAfterMs: number;
  readonly confirmHits: number;
  readonly enableVelocity: boolean;
  readonly maxTracks: number;
  readonly ambiguityMargin: number;
}

export interface TrackerStats {
  inputBatches: number;
  skippedBatches: number;
  failedBatches: number;
  detections: number;
  lowConfidenceDetections: number;
  associationFailures: number;
  createdTracks: number;
  expiredTracks: number;
  ambiguousMatches: number;
}

export interface TrackFilter {
  readonly state?: TrackingState;
  readonly categoryName?: string;
  readonly minConfidence?: number;
}

export interface EventFilter {
  readonly eventType?: ObjectEventType;
  readonly trackId?: string;
  readonly fromMs?: number;
  readonly toMs?: number;
}

export interface HistoryRange {
  readonly fromMs: number;
  readonly toMs: number;
}

export type EvidenceStatus = 'available' | 'unavailable' | 'expired' | 'evicted' | 'wrong-session' | 'budget-denied';

export interface EvidenceResolution {
  readonly status: EvidenceStatus;
  readonly sessionId: string;
  readonly trackId: string;
  readonly requestedAtMs: number;
  readonly evidenceRef?: string;
  readonly capturedAtMs?: number;
  readonly frameSequence?: number;
  readonly message: string;
}

export interface ObjectStateSnapshot {
  readonly sessionId: string;
  readonly tracks: readonly TrackedObject[];
  readonly events: readonly ObjectEvent[];
  readonly activeCount: number;
  readonly tentativeCount: number;
  readonly lostCount: number;
  readonly expiredCount: number;
  readonly indexEntries: number;
  readonly indexEvictions: number;
  readonly eventLogSize: number;
  readonly eventSuppressed: number;
  readonly eventCounts: Readonly<Record<ObjectEventType, number>>;
}

export interface TrackingSystemSnapshot extends ObjectStateSnapshot {
  readonly processingP50Ms: number | null;
  readonly processingP95Ms: number | null;
  readonly eventP50Ms: number | null;
  readonly eventP95Ms: number | null;
  readonly associationFailures: number;
  readonly inputBatches: number;
  readonly inputDetections: number;
  readonly receivedDetections: number;
  readonly lowConfidenceDetections: number;
  readonly outputEvents: number;
  readonly lastStatus: string;
  readonly historyEntries: number;
  readonly trackerTracks: number;
  readonly eventStateEntries: number;
  readonly activeEvictions: number;
  readonly listenerCount: number;
  readonly listenerErrors: number;
}

export const TRACKING_DEFAULTS: TrackingConfig = {
  minConfidence: 0.35,
  minIou: 0.1,
  maxCenterDistance: 0.22,
  maxAssociationGapMs: 3_200,
  lostAfterMs: 2_800,
  expireAfterMs: 10_000,
  confirmHits: 2,
  enableVelocity: true,
  maxTracks: 100,
  ambiguityMargin: 0.06,
};
