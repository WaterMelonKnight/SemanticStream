export const MEDIAPIPE_RUNTIME_VERSION = '1.2.3';
/** Self-hosted by scripts/prepare-mediapipe-wasm.mjs; kept here for documentation. */
export const MEDIAPIPE_WASM_PATH = 'mediapipe/wasm';
export const MEDIAPIPE_WASM_VERSIONED_PATH = `${MEDIAPIPE_WASM_PATH}/${MEDIAPIPE_RUNTIME_VERSION}`;
export const EFFICIENTDET_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite';
export const EFFICIENTDET_MODEL_BYTES = 4_602_795;
export const EFFICIENTDET_MODEL_LABEL = 'EfficientDet-Lite0 int8';
export const EFFICIENTDET_MODEL_VERSION = 'efficientdet_lite0/int8/1';
export const DETECTOR_ID = 'mediapipe-efficientdet-lite0-int8';
export const MODEL_INPUT_SIZE = 320;
export const PROBE_WIDTH = 64;
export const PROBE_HEIGHT = 36;
export const MAX_OBSERVATIONS = 60;

export type DetectionMode = 'fixed' | 'adaptive';
export type SourceKind = 'camera' | 'video' | 'demo';
export type ModelState = 'idle' | 'loading' | 'ready' | 'error' | 'unsupported';

export interface SourceTransform {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly modelWidth: number;
  readonly modelHeight: number;
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export interface ModelBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ObjectObservation {
  readonly sessionId: string;
  readonly frameSequence: number;
  readonly capturedAtMs: number;
  readonly submittedAtMs: number;
  readonly completedAtMs: number;
  readonly detectorId: string;
  readonly modelVersion: string;
  readonly categoryId: number;
  readonly categoryName: string;
  readonly score: number;
  /** Source-canvas pixels, not model-input pixels. */
  readonly box: ModelBox;
  readonly evidence: {
    readonly sourceKind: SourceKind;
    readonly frameSequence: number;
    readonly capturedAtMs: number;
    readonly frameRef: string;
    readonly input: {
      readonly width: number;
      readonly height: number;
      readonly scale: number;
      readonly offsetX: number;
      readonly offsetY: number;
    };
  };
}

export interface WorkerDetection {
  readonly categoryId: number;
  readonly categoryName: string;
  readonly score: number;
  readonly box: ModelBox;
}

export interface DetectionRequest {
  readonly requestId: number;
  readonly sessionId: string;
  readonly frameSequence: number;
  readonly capturedAtMs: number;
  readonly submittedAtMs: number;
  readonly width: number;
  readonly height: number;
  readonly transform: SourceTransform;
  readonly sourceKind: SourceKind;
}

export interface DetectionResponse {
  readonly type: 'detections';
  readonly requestId: number;
  readonly sessionId: string;
  readonly frameSequence: number;
  readonly inferenceMs: number;
  readonly detections: readonly WorkerDetection[];
}

export interface WorkerLoadMessage {
  readonly type: 'load';
  readonly wasmUrl: string;
  readonly modelUrl: string;
  readonly scoreThreshold: number;
  readonly maxResults: number;
}

export interface WorkerDetectMessage {
  readonly type: 'detect';
  readonly request: DetectionRequest;
  readonly pixels: ArrayBuffer;
}

export interface WorkerUnloadMessage {
  readonly type: 'unload';
}

export type ToDetectorWorker = WorkerLoadMessage | WorkerDetectMessage | WorkerUnloadMessage;

export type FromDetectorWorker =
  | { readonly type: 'loading'; readonly message: string }
  | { readonly type: 'download'; readonly loadedBytes: number; readonly totalBytes: number }
  | { readonly type: 'ready'; readonly loadMs: number; readonly modelBytes: number }
  | { readonly type: 'unloaded' }
  | { readonly type: 'error'; readonly phase: 'load' | 'detect' | 'unload'; readonly message: string }
  | DetectionResponse;

export type TriggerReason = TriggerDecision['reason'];

export interface TriggerReasonCounts {
  fixed: number;
  change: number;
  periodic: number;
  interval: number;
  'below-threshold': number;
}

export interface LatencyStats {
  readonly count: number;
  readonly meanMs: number | null;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
}

export interface PerceptionStats {
  readonly batches: number;
  readonly submitted: number;
  readonly observations: number;
  readonly droppedQueue: number;
  readonly droppedStale: number;
  readonly skippedNotReady: number;
  readonly effectiveFps: number;
  readonly recentDetectionFps: number;
  readonly recentInputFps: number;
  readonly triggerReasons: TriggerReasonCounts;
  readonly foregroundMs: number;
  readonly backgroundMs: number;
  readonly visible: boolean;
  readonly latency: LatencyStats;
  readonly queueLatency: LatencyStats;
  readonly longTasks: number;
  readonly maxLongTaskMs: number | null;
  readonly longTasksPerMinute: number;
  readonly elapsedMs: number;
}

export interface BenchmarkPhase {
  readonly mode: DetectionMode;
  readonly targetFps: number;
  readonly periodicMs: number;
  readonly changeThreshold: number;
  readonly stats: PerceptionStats;
}

export interface TriggerConfig {
  readonly mode: DetectionMode;
  readonly targetFps: number;
  readonly periodicMs: number;
  readonly changeThreshold: number;
}

export interface TriggerDecision {
  readonly submit: boolean;
  readonly reason: 'fixed' | 'change' | 'periodic' | 'interval' | 'below-threshold';
  readonly intervalMs: number;
}

export interface DetectionTriggerState {
  readonly lastSubmittedAtMs: number | null;
  readonly lastSubmittedChange: number | null;
}
