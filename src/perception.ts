import './perception.css';
import { meanRgbDifference } from './core/sampling';
import type { PixelSample } from './core/sampling';
import type { StreamFrame } from './core/stream';
import { CameraSource } from './visual/camera-source';
import { ProceduralSource } from './visual/source';
import type { VisualFrame } from './visual/source';
import { VideoSource, videoFileProblem } from './visual/video-source';
import type { VideoSourceStatus } from './visual/video-source';
import { drawLetterboxed, createSourceTransform, mapModelBoxToSource } from './perception/geometry';
import { LongTaskMonitor, PerceptionMetrics } from './perception/metrics';
import type { PerceptionStats } from './perception/types';
import { MediaPipeObjectDetectorProvider } from './perception/provider';
import type { ObjectDetectorProvider } from './perception/provider';
import { DetectionTrigger } from './perception/scheduler';
import { isCurrentDetectionResult } from './perception/session';
import { TelemetryHub } from './observability/telemetry';
import type { TelemetryEvent, TelemetrySource } from './observability/types';
import { ObjectTrackingSystem } from './perception/tracking/system';
import type { TrackingProcessingResult } from './perception/tracking/system';
import type { ObjectEvent, TrackedObject } from './perception/tracking/types';
import {
  DETECTOR_ID,
  EFFICIENTDET_MODEL_BYTES,
  EFFICIENTDET_MODEL_LABEL,
  EFFICIENTDET_MODEL_URL,
  EFFICIENTDET_MODEL_VERSION,
  MAX_OBSERVATIONS,
  MEDIAPIPE_RUNTIME_VERSION,
  MEDIAPIPE_WASM_VERSIONED_PATH,
  MODEL_INPUT_SIZE,
  PROBE_HEIGHT,
  PROBE_WIDTH,
} from './perception/types';
import type {
  BenchmarkPhase,
  DetectionMode,
  DetectionRequest,
  DetectionResponse,
  ModelState,
  ObjectObservation,
  SourceKind,
  TriggerConfig,
} from './perception/types';

const FEED_WIDTH = 720;
const FEED_HEIGHT = 405;
const BENCHMARK_DURATION_MS = 8_000;
const BENCHMARK_SETTLE_MS = 700;
const DETECTION_TIMEOUT_MS = 12_000;
const SCORE_THRESHOLD = 0.35;
const MAX_RESULTS = 20;

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error('Missing perception element: ' + id);
  return value as T;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!context) throw new Error('Canvas 2D is unavailable.');
  return context;
}

function wait(ms: number, aborted: () => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const started = performance.now();
    const tick = (): void => {
      if (aborted()) { resolve(false); return; }
      if (performance.now() - started >= ms) { resolve(true); return; }
      setTimeout(tick, Math.min(100, ms));
    };
    tick();
  });
}

function formatMs(value: number | null): string {
  return value === null ? '—' : value.toFixed(1) + ' ms';
}

function formatFps(value: number): string {
  return value.toFixed(2) + ' fps';
}

function formatPercent(value: number): string {
  return value.toFixed(0) + '%';
}

function supportsPerception(): boolean {
  return typeof Worker !== 'undefined'
    && typeof WebAssembly !== 'undefined'
    && typeof ImageData !== 'undefined';
}

const feed = element<HTMLCanvasElement>('feed');
const overlay = element<HTMLCanvasElement>('overlay');
const overlayContext = overlay.getContext('2d');
const media = element<HTMLVideoElement>('media');
const sourceStatus = element('source-status');
const feedStatus = element('feed-status');
const modelStatus = element('model-status');
const modelDetail = element('model-detail');
const enableModelButton = element<HTMLButtonElement>('enable-model');
const disableModelButton = element<HTMLButtonElement>('disable-model');
const loadProgress = element<HTMLProgressElement>('load-progress');
const cameraButton = element<HTMLButtonElement>('camera-start');
const cameraStopButton = element<HTMLButtonElement>('camera-stop');
const videoFile = element<HTMLInputElement>('video-file');
const videoPlayButton = element<HTMLButtonElement>('video-play');
const videoRestartButton = element<HTMLButtonElement>('video-restart');
const videoControls = element('video-controls');
const videoSeek = element<HTMLInputElement>('video-seek');
const videoTime = element('video-time');
const demoButton = element<HTMLButtonElement>('demo-start');
const modeSelect = element<HTMLSelectElement>('mode');
const targetFpsInput = element<HTMLInputElement>('target-fps');
const targetFpsValue = element<HTMLOutputElement>('target-fps-value');
const periodicInput = element<HTMLInputElement>('periodic-ms');
const periodicValue = element<HTMLOutputElement>('periodic-value');
const changeInput = element<HTMLInputElement>('change-threshold');
const changeValue = element<HTMLOutputElement>('change-value');
const fpsStat = element('stat-fps');
const batchStat = element('stat-batches');
const observationStat = element('stat-observations');
const p50Stat = element('stat-p50');
const p95Stat = element('stat-p95');
const dropStat = element('stat-drops');
const staleStat = element('stat-stale');
const longTaskStat = element('stat-longtasks');
const loadStat = element('stat-load');
const modelStat = element('stat-model');
const fps5sStat = element('stat-fps-5s');
const inputFps5sStat = element('stat-input-fps-5s');
const submittedStat = element('stat-submitted');
const queueLatencyStat = element('stat-queue-latency');
const triggerStat = element('stat-triggers');
const visibilityStat = element('stat-visibility');
const pageStateStat = element('stat-state');
const longTaskRateStat = element('stat-longtask-rate');
const trackingEnabledInput = element<HTMLInputElement>('tracking-enabled');
const trackingStatus = element('tracking-status');
const trackingActive = element('tracking-active');
const trackingTentative = element('tracking-tentative');
const trackingLost = element('tracking-lost');
const trackingExpired = element('tracking-expired');
const trackingEventCount = element('tracking-event-count');
const trackingMetrics = element('tracking-metrics');
const objectEvents = element('object-events');
const objectHistory = element('object-history');
const objectIndexJson = element('object-index-json');
const observationBody = element<HTMLTableSectionElement>('observations');
const detectionStatus = element('detection-status');
const telemetryStatus = element('perception-telemetry-status');
const telemetrySummary = element('perception-telemetry-summary');
const telemetryEvents = element('perception-telemetry-events');
const benchmarkRun = element<HTMLButtonElement>('benchmark-run');
const benchmarkCancel = element<HTMLButtonElement>('benchmark-cancel');
const benchmarkStatus = element('benchmark-status');
const benchmarkResults = element('benchmark-results');

const probeCanvas = document.createElement('canvas');
probeCanvas.width = PROBE_WIDTH;
probeCanvas.height = PROBE_HEIGHT;
const probeContext = context2d(probeCanvas);
const modelCanvas = document.createElement('canvas');
modelCanvas.width = MODEL_INPUT_SIZE;
modelCanvas.height = MODEL_INPUT_SIZE;
const modelContext = context2d(modelCanvas);
const transform = createSourceTransform(FEED_WIDTH, FEED_HEIGHT, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
const wasmUrl = new URL(MEDIAPIPE_WASM_VERSIONED_PATH, document.baseURI).href;

let provider: ObjectDetectorProvider | undefined;
let modelState: ModelState = supportsPerception() ? 'idle' : 'unsupported';
let modelBytes = 0;
let modelLoadMs: number | null = null;
let loadingStartedAt = 0;
let modelReady = false;
let sessionId = '';
let sessionVersion = 0;
let sourceKind: SourceKind | null = null;
let camera: CameraSource | undefined;
let video: VideoSource | undefined;
let demo: ProceduralSource | undefined;
let inFlight: { request: DetectionRequest; startedAt: number; timeout: number } | null = null;
let pending: { request: DetectionRequest; pixels: ArrayBuffer } | null = null;
let requestCounter = 0;
let observations: ObjectObservation[] = [];
let lastProbe: PixelSample | null = null;
let lastChangePercent = 0;
let lastStatusAt = 0;
let draggingSeek = false;
let lastStatsAt = 0;
let benchmarkRunning = false;
let benchmarkAbort = false;
let benchmarkPhases: BenchmarkPhase[] = [];
let foreground = !document.hidden;
let cameraStartVersion = 0;
let statsTimer: number | undefined;
let tracking: ObjectTrackingSystem | undefined;
let latestTracks: readonly TrackedObject[] = [];
let latestDetectionBatch: readonly ObjectObservation[] = [];
const trackIdByEvidence = new Map<string, string>();
let selectedTrackId = '';
let lastTrackingTelemetryAt = 0;
let lastTrackingRenderAt = 0;

const metrics = new PerceptionMetrics(performance.now(), foreground);
const telemetry = new TelemetryHub(320, 120);
let lastTelemetryAt = 0;
const longTasks = new LongTaskMonitor();
const trigger = new DetectionTrigger(readTriggerConfig());

function readTriggerConfig(): TriggerConfig {
  const target = targetFpsInput.valueAsNumber;
  const periodic = periodicInput.valueAsNumber;
  const threshold = changeInput.valueAsNumber;
  return {
    mode: modeSelect.value === 'adaptive' ? 'adaptive' : 'fixed',
    targetFps: Number.isFinite(target) ? target : 3,
    periodicMs: Number.isFinite(periodic) ? periodic : 1_500,
    changeThreshold: Number.isFinite(threshold) ? threshold : 3,
  };
}

function applyConfigLabels(): void {
  targetFpsValue.value = `${targetFpsInput.valueAsNumber} FPS`;
  periodicValue.value = `${periodicInput.valueAsNumber} ms`;
  changeValue.value = `${changeInput.valueAsNumber.toFixed(1)}%`;
  trigger.setConfig(readTriggerConfig());
}

function setStatus(text: string, state: 'idle' | 'ok' | 'warn' | 'error' = 'idle'): void {
  sourceStatus.textContent = text;
  sourceStatus.dataset.state = state;
}

function setDetectionStatus(text: string, state: 'idle' | 'ok' | 'warn' | 'error' = 'idle'): void {
  detectionStatus.textContent = text;
  detectionStatus.dataset.state = state;
}

function updateModelUi(): void {
  modelStatus.dataset.state = modelState;
  if (modelState === 'unsupported') {
    modelStatus.textContent = 'Unsupported browser';
    modelDetail.textContent = 'This experiment needs WebAssembly, a Worker, and Canvas ImageData. The source preview still works.';
    enableModelButton.disabled = true;
    disableModelButton.hidden = true;
    return;
  }
  if (modelState === 'loading') {
    modelStatus.textContent = 'Loading model…';
    enableModelButton.disabled = true;
    disableModelButton.hidden = true;
    return;
  }
  if (modelState === 'ready') {
    modelStatus.textContent = 'Detection enabled';
    const load = modelLoadMs === null ? '—' : `${modelLoadMs.toFixed(0)} ms`;
    modelDetail.textContent = `${EFFICIENTDET_MODEL_LABEL} · ${(modelBytes / 1_000_000).toFixed(2)} MB downloaded · load ${load} · MediaPipe ${MEDIAPIPE_RUNTIME_VERSION}`;
    enableModelButton.disabled = true;
    disableModelButton.hidden = false;
    return;
  }
  if (modelState === 'error') {
    modelStatus.textContent = 'Detection unavailable';
    modelDetail.textContent = 'Model load failed. The source and UI remain usable; retry with the button.';
    enableModelButton.textContent = 'Retry model';
    enableModelButton.disabled = false;
    disableModelButton.hidden = true;
    return;
  }
  modelStatus.textContent = 'Model not loaded';
  modelDetail.textContent = `Optional ${EFFICIENTDET_MODEL_LABEL} download (~${(EFFICIENTDET_MODEL_BYTES / 1_000_000).toFixed(2)} MB) plus MediaPipe Wasm. No media is uploaded.`;
  enableModelButton.textContent = 'Enable model';
  enableModelButton.disabled = false;
  disableModelButton.hidden = true;
}

function updateSourceButtons(): void {
  cameraButton.disabled = Boolean(camera) || benchmarkRunning;
  cameraStopButton.hidden = !camera;
  videoPlayButton.hidden = !video;
  videoRestartButton.hidden = !video;
  videoControls.hidden = !video;
  videoPlayButton.textContent = video?.isPlaying ? 'Pause video' : 'Play video';
  enableModelButton.disabled = modelState === 'loading' || modelState === 'ready' || modelState === 'unsupported';
  benchmarkRun.disabled = !modelReady || !sourceKind || benchmarkRunning;
  benchmarkCancel.disabled = !benchmarkRunning;
}

function invalidateSession(): void {
  if (sessionId) telemetry.event(systemClockNow(), 'perception', 'session_invalidated', telemetrySource(), { sessionId });
  sessionVersion += 1;
  sessionId = '';
  resetTracking();
  pending = null;
  observations = [];
  lastProbe = null;
  lastChangePercent = 0;
  trigger.reset();
  metrics.reset(performance.now());
  longTasks.reset();
  overlayContext?.clearRect(0, 0, overlay.width, overlay.height);
  renderObservations();
  renderStats(true);
}


function systemClockNow(): number { return performance.now(); }

function telemetrySource(): TelemetrySource {
  return modelReady ? 'real' : modelState === 'error' ? 'unavailable' : 'mock';
}

function renderPerceptionTelemetry(): void {
  const snap = telemetry.snapshot();
  const stats = metrics.snapshot(performance.now(), longTasks.count, longTasks.maxMs);
  telemetryStatus.textContent = modelReady ? 'Local model · real' : modelState === 'error' ? 'Local model · unavailable' : 'Local · model off';
  telemetryStatus.dataset.state = modelReady ? 'ok' : modelState === 'error' ? 'error' : 'idle';
  const summary = [
    'session · ' + (sessionId || 'none') + ' · source ' + (sourceKind ?? 'none') + ' · model ' + EFFICIENTDET_MODEL_LABEL,
    'detection · ' + stats.effectiveFps.toFixed(2) + ' fps cumulative · ' + stats.recentDetectionFps.toFixed(2) + ' fps 5s',
    'input · ' + stats.recentInputFps.toFixed(2) + ' fps 5s · submitted/completed ' + stats.submitted + '/' + stats.batches,
    'queue · P50 ' + formatMs(stats.queueLatency.p50Ms) + ' · P95 ' + formatMs(stats.queueLatency.p95Ms) + ' · triggers ' + formatTriggerCounts(stats.triggerReasons),
    'latency · P50 ' + formatMs(stats.latency.p50Ms) + ' · P95 ' + formatMs(stats.latency.p95Ms),
    'drops · ' + stats.droppedQueue + ' queue · ' + stats.droppedStale + ' stale · ' + stats.skippedNotReady + ' not ready',
    'visibility · foreground ' + formatDuration(stats.foregroundMs) + ' · background ' + formatDuration(stats.backgroundMs) + ' · ' + performanceState(stats),
    'page · long tasks ' + stats.longTasks + ' / ' + formatMs(stats.maxLongTaskMs) + ' · ' + stats.longTasksPerMinute.toFixed(1) + '/min · telemetry ' + snap.events.length + ' events / ' + snap.series.length + ' series',
  ];
  telemetrySummary.replaceChildren(...summary.map((text) => {
    const item = document.createElement('li'); item.textContent = text; return item;
  }));
  telemetryEvents.replaceChildren(...snap.events.slice(-10).reverse().map((event) => {
    const item = document.createElement('li'); item.textContent = formatTelemetryEvent(event); return item;
  }));
}

function formatTelemetryEvent(event: TelemetryEvent): string {
  return 't+' + (event.atMs / 1000).toFixed(2) + 's · ' + event.module + '/' + event.kind + ' · ' + event.name
    + (event.value === undefined ? '' : ' ' + event.value + (event.unit ? ' ' + event.unit : ''))
    + ' · ' + event.source + (event.sessionId ? ' · ' + event.sessionId : '');
}

function recordPerceptionGauges(now: number): void {
  if (now - lastTelemetryAt < 1000) return;
  lastTelemetryAt = now;
  const stats = metrics.snapshot(now, longTasks.count, longTasks.maxMs);
  const source = telemetrySource();
  const identity = sessionId ? { sessionId } : {};
  telemetry.gauge(now, 'perception', 'detection_fps', stats.effectiveFps, 'fps', source, identity);
  telemetry.gauge(now, 'perception', 'detection_fps_5s', stats.recentDetectionFps, 'fps', source, identity);
  telemetry.gauge(now, 'perception', 'input_fps_5s', stats.recentInputFps, 'fps', source, identity);
  telemetry.gauge(now, 'perception', 'submitted', stats.submitted, 'requests', source, identity);
  telemetry.gauge(now, 'perception', 'foreground_ms', stats.foregroundMs, 'ms', source, identity);
  telemetry.gauge(now, 'perception', 'background_ms', stats.backgroundMs, 'ms', source, identity);
  telemetry.gauge(now, 'perception', 'long_tasks_per_minute', stats.longTasksPerMinute, 'per_minute', source, identity);
  if (stats.queueLatency.p50Ms !== null) telemetry.histogram(now, 'perception', 'queue_p50_ms', stats.queueLatency.p50Ms, 'ms', source, identity);
  for (const [reason, count] of Object.entries(stats.triggerReasons)) {
    telemetry.gauge(now, 'perception', 'trigger_' + reason, count, 'count', source, identity);
  }
  telemetry.gauge(now, 'perception', 'batches', stats.batches, 'count', source, identity);
  telemetry.gauge(now, 'perception', 'observations', stats.observations, 'count', source, identity);
  if (stats.latency.p50Ms !== null) telemetry.histogram(now, 'perception', 'inference_p50_ms', stats.latency.p50Ms, 'ms', source, identity);
  if (stats.latency.p95Ms !== null) telemetry.histogram(now, 'perception', 'inference_p95_ms', stats.latency.p95Ms, 'ms', source, identity);
  telemetry.gauge(now, 'perception', 'queue_drops', stats.droppedQueue, 'count', source, identity);
  telemetry.gauge(now, 'perception', 'stale_results', stats.droppedStale, 'count', source, identity);
  telemetry.gauge(now, 'perception', 'long_tasks', stats.longTasks, 'count', source, identity);
}

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}


function trackingEnabled(): boolean {
  return trackingEnabledInput.checked;
}

function resetTracking(): void {
  tracking = undefined;
  latestTracks = [];
  selectedTrackId = '';
  lastTrackingTelemetryAt = 0;
  lastTrackingRenderAt = 0;
  trackIdByEvidence.clear();
  renderObjectTracking();
}

function startTracking(): void {
  if (!trackingEnabled() || !sessionId) {
    resetTracking();
    return;
  }
  tracking = new ObjectTrackingSystem(sessionId);
  latestTracks = [];
  selectedTrackId = '';
  lastTrackingTelemetryAt = 0;
  lastTrackingRenderAt = 0;
  trackIdByEvidence.clear();
  renderObjectTracking();
}

function trackForObservation(observation: ObjectObservation): TrackedObject | undefined {
  return latestTracks.find((track) => track.evidenceRef === observation.evidence.frameRef
    && track.categoryId === observation.categoryId)
    ?? (trackIdByEvidence.has(observation.evidence.frameRef)
      ? tracking?.getObjectById(trackIdByEvidence.get(observation.evidence.frameRef) ?? '')
      : undefined);
}

function formatTrackEvent(event: ObjectEvent): string {
  return `t+${(event.observedAtMs / 1_000).toFixed(2)}s · ${event.eventType} · ${event.trackId}`
    + ` · ${event.categoryName} · ${event.reason} · ${event.certainty}`;
}

function renderObjectTracking(): void {
  const enabled = trackingEnabled();
  const diagnostic = tracking?.diagnostics();
  if (!enabled) {
    trackingStatus.textContent = 'Disabled';
    trackingStatus.dataset.state = 'idle';
    trackingActive.textContent = '0';
    trackingTentative.textContent = '0';
    trackingLost.textContent = '0';
    trackingExpired.textContent = '0';
    trackingEventCount.textContent = '0';
    trackingMetrics.replaceChildren();
    objectEvents.replaceChildren();
    objectHistory.replaceChildren();
    objectIndexJson.textContent = '{}';
    return;
  }
  if (!tracking) {
    trackingStatus.textContent = sessionId ? 'Idle · no detection yet' : 'Idle · no session';
    trackingStatus.dataset.state = 'idle';
    trackingActive.textContent = '0';
    trackingTentative.textContent = '0';
    trackingLost.textContent = '0';
    trackingExpired.textContent = '0';
    trackingEventCount.textContent = '0';
    trackingMetrics.replaceChildren();
    objectEvents.replaceChildren();
    objectHistory.replaceChildren();
    objectIndexJson.textContent = '{}';
    return;
  }
  const snapshot = tracking.snapshot();
  trackingStatus.textContent = sessionId ? `Session · ${sessionId}` : 'Idle';
  trackingStatus.dataset.state = snapshot.activeCount > 0 ? 'ok' : 'idle';
  trackingActive.textContent = String(snapshot.activeCount);
  trackingTentative.textContent = String(snapshot.tentativeCount);
  trackingLost.textContent = String(snapshot.lostCount);
  trackingExpired.textContent = String(snapshot.expiredCount);
  trackingEventCount.textContent = String(snapshot.eventLogSize);
  const metrics = [
    `processing · P50 ${formatMs(diagnostic?.processingP50Ms ?? null)} · P95 ${formatMs(diagnostic?.processingP95Ms ?? null)}`,
    `events · P50 ${formatMs(diagnostic?.eventP50Ms ?? null)} · P95 ${formatMs(diagnostic?.eventP95Ms ?? null)}`,
    `index · ${snapshot.indexEntries} entries · ${snapshot.indexEvictions} evictions · ${diagnostic?.associationFailures ?? 0} association failures`,
    `event log · ${snapshot.eventLogSize}/${snapshot.eventLogSize + snapshot.eventSuppressed} shown · ${snapshot.eventSuppressed} suppressed`,
    `input · ${diagnostic?.inputBatches ?? 0} batches · ${diagnostic?.inputDetections ?? 0} detections · ${diagnostic?.outputEvents ?? 0} events`,
    `counts · ${Object.entries(snapshot.eventCounts).filter(([, count]) => count > 0).map(([type, count]) => `${type} ${count}`).join(' · ') || '—'}`,
  ];
  trackingMetrics.replaceChildren(...metrics.map((text) => {
    const item = document.createElement('li'); item.textContent = text; return item;
  }));
  const recent = snapshot.events.slice(-12).reverse();
  objectEvents.replaceChildren(...(recent.length ? recent.map((event) => {
    const item = document.createElement('li'); item.textContent = formatTrackEvent(event); return item;
  }) : [listItem('No semantic events yet.')]));

  if (!selectedTrackId) {
    objectHistory.replaceChildren(listItem('Select a track row to inspect its bounded history and evidence status.'));
  } else {
    const track = tracking.getObjectById(selectedTrackId);
    if (!track) {
      selectedTrackId = '';
      objectHistory.replaceChildren(listItem('Selected track is no longer in the bounded index.'));
    } else {
      const history = tracking.getObjectHistory(track.trackId).slice(-12).reverse();
      const evidence = tracking.getObjectEvidence(track.trackId, track.lastObservationAtMs);
      const rows = [
        `selected · ${track.trackId} · ${track.categoryName} · ${track.trackingState} · confidence ${track.confidence.toFixed(3)}`,
        `first/last · ${formatDuration(track.firstSeenAtMs)} / ${formatDuration(track.lastSeenAtMs)} · observations ${track.observationCount}`,
        `evidence · ${evidence.status} · ${evidence.message}`,
        ...history.map((point) => `history · ${formatDuration(point.atMs)} · ${point.trackingState}`
          + ` · ${point.boundingBox.x.toFixed(3)},${point.boundingBox.y.toFixed(3)}`
          + ` · confidence ${point.confidence.toFixed(3)}`),
      ];
      objectHistory.replaceChildren(...rows.map((text) => listItem(text)));
    }
  }
  if (objectIndexJson.closest('details')?.open) {
    objectIndexJson.textContent = JSON.stringify(snapshot, null, 2);
  }
}

function listItem(text: string): HTMLLIElement {
  const item = document.createElement('li');
  item.textContent = text;
  return item;
}

function recordTrackingTelemetry(result: TrackingProcessingResult): void {
  if (!tracking) return;
  const now = systemClockNow();
  const identity = sessionId ? { sessionId } : {};
  telemetry.histogram(now, 'tracking', 'processing_ms', result.trackingMs, 'ms', 'real', identity);
  telemetry.histogram(now, 'events', 'processing_ms', result.eventMs, 'ms', 'real', identity);
  for (const event of result.events) {
    telemetry.counter(now, 'events', 'event_' + event.eventType, 1, 'real', identity);
  }
  if (now - lastTrackingTelemetryAt < 1_000) return;
  lastTrackingTelemetryAt = now;
  const diagnostic = tracking.diagnostics();
  const snapshot = tracking.snapshot();
  telemetry.gauge(now, 'tracking', 'active_tracks', snapshot.activeCount, 'tracks', 'real', identity);
  telemetry.gauge(now, 'tracking', 'tentative_tracks', snapshot.tentativeCount, 'tracks', 'real', identity);
  telemetry.gauge(now, 'tracking', 'lost_tracks', snapshot.lostCount, 'tracks', 'real', identity);
  telemetry.gauge(now, 'tracking', 'expired_tracks', snapshot.expiredCount, 'tracks', 'real', identity);
  telemetry.gauge(now, 'tracking', 'index_entries', snapshot.indexEntries, 'objects', 'real', identity);
  telemetry.gauge(now, 'tracking', 'index_evictions', snapshot.indexEvictions, 'evictions', 'real', identity);
  telemetry.gauge(now, 'tracking', 'association_failures', diagnostic.associationFailures, 'failures', 'real', identity);
  telemetry.gauge(now, 'tracking', 'input_batches', diagnostic.inputBatches, 'batches', 'real', identity);
  telemetry.gauge(now, 'tracking', 'input_detections', diagnostic.inputDetections, 'detections', 'real', identity);
  telemetry.gauge(now, 'tracking', 'output_events', diagnostic.outputEvents, 'events', 'real', identity);
  telemetry.gauge(now, 'tracking', 'event_suppressed', snapshot.eventSuppressed, 'events', 'real', identity);
  telemetry.gauge(now, 'tracking', 'event_log_size', snapshot.eventLogSize, 'events', 'real', identity);
  if (diagnostic.processingP50Ms !== null) telemetry.gauge(now, 'tracking', 'processing_p50_ms', diagnostic.processingP50Ms, 'ms', 'real', identity);
  if (diagnostic.processingP95Ms !== null) telemetry.gauge(now, 'tracking', 'processing_p95_ms', diagnostic.processingP95Ms, 'ms', 'real', identity);
  if (diagnostic.eventP50Ms !== null) telemetry.gauge(now, 'events', 'processing_p50_ms', diagnostic.eventP50Ms, 'ms', 'real', identity);
  if (diagnostic.eventP95Ms !== null) telemetry.gauge(now, 'events', 'processing_p95_ms', diagnostic.eventP95Ms, 'ms', 'real', identity);
  for (const [type, count] of Object.entries(snapshot.eventCounts)) {
    telemetry.gauge(now, 'events', 'count_' + type, count, 'events', 'real', identity);
  }
}

function beginSession(kind: SourceKind): void {
  sessionVersion += 1;
  sessionId = `perception-${kind}-${sessionVersion}`;
  startTracking();
  pending = null;
  observations = [];
  lastProbe = null;
  lastChangePercent = 0;
  trigger.reset();
  metrics.reset(performance.now());
  longTasks.reset();
  overlayContext?.clearRect(0, 0, overlay.width, overlay.height);
  renderObservations();
  renderStats(true);
}

function stopSources(): void {
  cameraStartVersion += 1;
  camera?.dispose();
  camera = undefined;
  video?.dispose();
  video = undefined;
  demo?.stop();
  demo = undefined;
  sourceKind = null;
  invalidateSession();
  overlayContext?.clearRect(0, 0, overlay.width, overlay.height);
  updateSourceButtons();
}

function clearLateWork(): void {
  if (inFlight) window.clearTimeout(inFlight.timeout);
  pending = null;
  inFlight = null;
}

function readProbe(): PixelSample {
  probeContext.drawImage(feed, 0, 0, PROBE_WIDTH, PROBE_HEIGHT);
  return probeContext.getImageData(0, 0, PROBE_WIDTH, PROBE_HEIGHT).data;
}

function prepareDetection(frame: StreamFrame<VisualFrame>): { request: DetectionRequest; pixels: ArrayBuffer } {
  const requestId = ++requestCounter;
  const submittedAtMs = performance.now();
  drawLetterboxed(modelContext, feed, transform);
  const image = modelContext.getImageData(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
  const request: DetectionRequest = {
    requestId,
    sessionId,
    frameSequence: frame.sequence,
    capturedAtMs: frame.timestampMs,
    submittedAtMs,
    width: MODEL_INPUT_SIZE,
    height: MODEL_INPUT_SIZE,
    transform,
    sourceKind: sourceKind ?? 'demo',
  };
  return { request, pixels: image.data.buffer };
}

function submitDetection(request: DetectionRequest, pixels: ArrayBuffer): void {
  if (!provider || !modelReady) return;
  if (inFlight) {
    if (pending) metrics.recordQueueDrop();
    pending = { request, pixels };
    return;
  }
  metrics.recordSubmitted();
  inFlight = {
    request,
    startedAt: performance.now(),
    timeout: window.setTimeout(() => {
      if (!inFlight) return;
      setDetectionStatus('Detection timed out; disabling the worker.', 'error');
      modelState = 'error';
      modelReady = false;
      provider?.dispose();
      provider = undefined;
      clearLateWork();
      updateModelUi();
      updateSourceButtons();
    }, DETECTION_TIMEOUT_MS),
  };
  void provider.detect(request, pixels).then(handleDetection).catch(handleDetectionError);
}

function handleDetection(result: DetectionResponse): void {
  const request = inFlight?.request;
  const startedAtMs = inFlight?.startedAt;
  if (inFlight) {
    window.clearTimeout(inFlight.timeout);
    inFlight = null;
  }
  if (!request || !isCurrentDetectionResult(result, request, sessionId)) {
    metrics.recordStale();
    const next = pending;
    pending = null;
    if (next) submitDetection(next.request, next.pixels);
    return;
  }
  const completedAtMs = performance.now();
  const batch: ObjectObservation[] = result.detections.map((detection) => ({
    sessionId,
    frameSequence: result.frameSequence,
    capturedAtMs: request.capturedAtMs,
    submittedAtMs: request.submittedAtMs,
    completedAtMs,
    detectorId: DETECTOR_ID,
    modelVersion: EFFICIENTDET_MODEL_VERSION,
    categoryId: detection.categoryId,
    categoryName: detection.categoryName,
    score: detection.score,
    box: mapModelBoxToSource(detection.box, transform),
    evidence: {
      sourceKind: sourceKind ?? 'demo',
      frameSequence: result.frameSequence,
      capturedAtMs: request.capturedAtMs,
      frameRef: `${sessionId}:${result.frameSequence}`,
      input: {
        width: MODEL_INPUT_SIZE,
        height: MODEL_INPUT_SIZE,
        scale: transform.scale,
        offsetX: transform.offsetX,
        offsetY: transform.offsetY,
      },
    },
  }));
  observations = [...batch, ...observations].slice(0, MAX_OBSERVATIONS);
  metrics.recordBatch(result.inferenceMs, batch.length, completedAtMs, startedAtMs === undefined ? 0 : startedAtMs - request.submittedAtMs);
  telemetry.histogram(completedAtMs, 'perception', 'inference_ms', result.inferenceMs, 'ms', 'real', { sessionId });
  telemetry.counter(completedAtMs, 'perception', 'detection_batch', 1, 'real', { sessionId });
  if (batch.length) telemetry.counter(completedAtMs, 'perception', 'observations', batch.length, 'real', { sessionId });
  latestDetectionBatch = batch;
  if (trackingEnabled() && tracking) {
    try {
      const trackingResult = tracking.process({
        sessionId,
        observedAtMs: completedAtMs,
        frameSequence: result.frameSequence,
        frameWidth: FEED_WIDTH,
        frameHeight: FEED_HEIGHT,
        status: 'ok',
        detections: batch,
      });
      latestTracks = trackingResult.frame.tracks;
      for (const track of [...trackingResult.frame.tracks, ...trackingResult.frame.expired]) {
        trackIdByEvidence.set(track.evidenceRef, track.trackId);
      }
      while (trackIdByEvidence.size > 300) {
        const oldest = trackIdByEvidence.keys().next().value;
        if (oldest === undefined) break;
        trackIdByEvidence.delete(oldest);
      }
      recordTrackingTelemetry(trackingResult);
      const now = systemClockNow();
      if (trackingResult.events.length > 0 || now - lastTrackingRenderAt >= 250) {
        lastTrackingRenderAt = now;
        renderObjectTracking();
      }
    } catch {
      trackingStatus.textContent = 'Tracking unavailable';
      trackingStatus.dataset.state = 'error';
    }
  } else {
    latestTracks = [];
  }
  drawObservations(batch);
  renderObservations();
  renderStats();
  setDetectionStatus(
    batch.length ? `Frame ${result.frameSequence} · ${batch.length} object${batch.length === 1 ? '' : 's'}` : `Frame ${result.frameSequence} · no objects above ${SCORE_THRESHOLD}`,
    batch.length ? 'ok' : 'idle',
  );
  const next = pending;
  pending = null;
  if (next) submitDetection(next.request, next.pixels);
}

function handleDetectionError(): void {
  if (!modelReady) return;
  telemetry.event(systemClockNow(), 'perception', 'worker_failed', 'unavailable', { sessionId }, { code: 'worker_failed' }, true);
  if (inFlight) {
    window.clearTimeout(inFlight.timeout);
    inFlight = null;
  }
  pending = null;
  modelState = 'error';
  modelReady = false;
  provider?.dispose();
  provider = undefined;
  updateModelUi();
  updateSourceButtons();
  setDetectionStatus('Detection stopped after a worker error. The source preview is still live.', 'error');
}

function selectTrack(trackId: string): void {
  selectedTrackId = trackId;
  renderObjectTracking();
  drawObservations(latestDetectionBatch);
}

function drawTrackTrail(): void {
  if (!overlayContext || !tracking || !selectedTrackId) return;
  const history = tracking.getObjectHistory(selectedTrackId).slice(-24);
  if (history.length < 2) return;
  overlayContext.beginPath();
  for (let index = 0; index < history.length; index += 1) {
    const point = history[index].boundingBox;
    const x = (point.x + point.width / 2) * feed.width;
    const y = (point.y + point.height / 2) * feed.height;
    if (index === 0) overlayContext.moveTo(x, y); else overlayContext.lineTo(x, y);
  }
  overlayContext.strokeStyle = 'rgba(126, 231, 135, 0.7)';
  overlayContext.lineWidth = 2;
  overlayContext.stroke();
}

function drawObservations(items: readonly ObjectObservation[]): void {
  if (!overlayContext) return;
  overlayContext.clearRect(0, 0, overlay.width, overlay.height);
  for (const observation of items) {
    const { box } = observation;
    if (box.width < 1 || box.height < 1) continue;
    const track = trackForObservation(observation);
    overlayContext.strokeStyle = track?.trackingState === 'TENTATIVE' ? '#f6c85f' : '#7ee787';
    overlayContext.lineWidth = 2;
    overlayContext.strokeRect(box.x, box.y, box.width, box.height);
    const trackLabel = track ? track.trackId : 'untracked';
    const label = `${observation.categoryName} ${formatPercent(observation.score * 100)} · ${trackLabel}`;
    overlayContext.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
    const width = overlayContext.measureText(label).width + 8;
    overlayContext.fillStyle = 'rgba(10, 14, 22, 0.86)';
    overlayContext.fillRect(box.x, Math.max(0, box.y - 18), width, 16);
    overlayContext.fillStyle = '#b7ffcb';
    overlayContext.fillText(label, box.x + 4, Math.max(11, box.y - 6));
  }
  drawTrackTrail();
}

function renderObservations(): void {
  observationBody.replaceChildren();
  if (!observations.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 8;
    cell.textContent = modelReady ? 'No observations yet.' : 'Enable the model to start structured observations.';
    row.append(cell);
    observationBody.append(row);
    return;
  }
  for (const observation of observations) {
    const row = document.createElement('tr');
    const track = trackForObservation(observation);
    const values = [
      `#${String(observation.frameSequence).padStart(4, '0')}`,
      track?.trackId ?? '—',
      track?.trackingState ?? '—',
      observation.categoryName,
      observation.score.toFixed(3),
      `${Math.round(observation.box.x)},${Math.round(observation.box.y)} ${Math.round(observation.box.width)}×${Math.round(observation.box.height)}`,
      observation.evidence.sourceKind,
      observation.evidence.frameRef,
    ];
    for (const value of values) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    if (track) {
      row.classList.add('track-row');
      row.tabIndex = 0;
      row.addEventListener('click', () => selectTrack(track.trackId));
    }
    observationBody.append(row);
  }
}


function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

function formatTriggerCounts(counts: PerceptionStats['triggerReasons']): string {
  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  return entries.length ? entries.map(([reason, count]) => `${reason} ${count}`).join(' · ') : '—';
}

function performanceState(stats: PerceptionStats): string {
  if (!stats.visible) return 'background · camera released';
  if (stats.recentInputFps < 0.5) return 'foreground · no input';
  if ((stats.queueLatency.p95Ms ?? 0) > 50) return 'foreground · queue-limited';
  const target = readTriggerConfig().targetFps;
  if (stats.recentDetectionFps < target * 0.75) return 'foreground · trigger-limited';
  return 'foreground · active';
}

function renderStats(force = false): void {
  const now = performance.now();
  if (!force && now - lastStatsAt < 250) return;
  lastStatsAt = now;
  const stats = metrics.snapshot(now, longTasks.count, longTasks.maxMs);
  fpsStat.textContent = formatFps(stats.effectiveFps);
  fps5sStat.textContent = formatFps(stats.recentDetectionFps);
  inputFps5sStat.textContent = formatFps(stats.recentInputFps);
  batchStat.textContent = String(stats.batches);
  submittedStat.textContent = `${stats.submitted} / ${stats.batches}`;
  queueLatencyStat.textContent = `${formatMs(stats.queueLatency.p50Ms)} / ${formatMs(stats.queueLatency.p95Ms)}`;
  triggerStat.textContent = formatTriggerCounts(stats.triggerReasons);
  visibilityStat.textContent = `FG ${formatDuration(stats.foregroundMs)} / BG ${formatDuration(stats.backgroundMs)}`;
  pageStateStat.textContent = performanceState(stats);
  longTaskRateStat.textContent = longTasks.supported ? `${stats.longTasksPerMinute.toFixed(1)}/min` : 'unavailable';
  observationStat.textContent = String(stats.observations);
  p50Stat.textContent = formatMs(stats.latency.p50Ms);
  p95Stat.textContent = formatMs(stats.latency.p95Ms);
  dropStat.textContent = `${stats.droppedQueue} queued / ${stats.skippedNotReady} not ready`;
  staleStat.textContent = String(stats.droppedStale);
  longTaskStat.textContent = longTasks.supported
    ? `${stats.longTasks} / ${formatMs(stats.maxLongTaskMs)}`
    : 'unavailable';
  loadStat.textContent = modelLoadMs === null ? '—' : `${modelLoadMs.toFixed(0)} ms`;
  modelStat.textContent = modelReady ? EFFICIENTDET_MODEL_LABEL : 'off';
  recordPerceptionGauges(now);
  renderPerceptionTelemetry();
}

function updateFrameStatus(frame: StreamFrame<VisualFrame>): void {
  const now = performance.now();
  if (now - lastStatusAt < 200) return;
  lastStatusAt = now;
  const phase = frame.payload.phase;
  feedStatus.textContent = `${phase} · frame #${frame.sequence} · ${lastChangePercent.toFixed(1)}% change probe`;
}

function onFrame(frame: StreamFrame<VisualFrame>): void {
  if (!sessionId || !foreground) return;
  metrics.recordInput(frame.timestampMs);
  const probe = readProbe();
  lastChangePercent = lastProbe ? meanRgbDifference(lastProbe, probe) : 100;
  lastProbe = probe;
  updateFrameStatus(frame);
  if (!modelReady) {
    if (modelState === 'loading') metrics.recordNotReady();
    return;
  }
  const decision = trigger.shouldSubmit(frame.timestampMs, lastChangePercent);
  metrics.recordTrigger(decision.reason);
  if (!decision.submit) return;
  trigger.markSubmitted(frame.timestampMs, lastChangePercent);
  const request = prepareDetection(frame);
  submitDetection(request.request, request.pixels);
}

async function enableModel(): Promise<void> {
  if (modelState === 'loading' || modelState === 'ready') return;
  if (!supportsPerception()) {
    modelState = 'unsupported';
    updateModelUi();
    return;
  }
  modelState = 'loading';
  loadingStartedAt = performance.now();
  telemetry.event(systemClockNow(), 'model', 'load_started', 'real', { sessionId }, { model: EFFICIENTDET_MODEL_VERSION });
  loadProgress.hidden = false;
  loadProgress.value = 0;
  loadProgress.max = EFFICIENTDET_MODEL_BYTES;
  updateModelUi();
  updateSourceButtons();
  provider = new MediaPipeObjectDetectorProvider(DETECTOR_ID, EFFICIENTDET_MODEL_VERSION);
  try {
    const result = await provider.load({
      id: DETECTOR_ID,
      version: EFFICIENTDET_MODEL_VERSION,
      wasmUrl,
      modelUrl: EFFICIENTDET_MODEL_URL,
      scoreThreshold: SCORE_THRESHOLD,
      maxResults: MAX_RESULTS,
    }, {
      onStatus: (message) => { modelDetail.textContent = message; },
      onDownload: (loadedBytes, totalBytes) => {
        loadProgress.value = loadedBytes;
        loadProgress.max = totalBytes || EFFICIENTDET_MODEL_BYTES;
        modelDetail.textContent = `Downloading model · ${(loadedBytes / 1_000_000).toFixed(2)} MB`;
      },
    });
    modelBytes = result.modelBytes;
    modelLoadMs = performance.now() - loadingStartedAt;
    modelReady = true;
    modelState = 'ready';
    telemetry.event(systemClockNow(), 'model', 'load_ready', 'real', { sessionId }, { model: EFFICIENTDET_MODEL_VERSION });
    telemetry.histogram(systemClockNow(), 'model', 'load_ms', modelLoadMs, 'ms', 'real', { sessionId });
    loadProgress.hidden = true;
    updateModelUi();
    updateSourceButtons();
    setDetectionStatus('Model ready. Start a source or wait for the current one.', 'ok');
    renderObservations();
  } catch (error) {
    modelState = 'error';
    modelReady = false;
    telemetry.event(systemClockNow(), 'model', 'load_failed', 'unavailable', { sessionId }, { code: 'model_load_failed' }, true);
    provider?.dispose();
    provider = undefined;
    loadProgress.hidden = true;
    updateModelUi();
    updateSourceButtons();
    setDetectionStatus('Model load failed; detection is disabled. The source still works.', 'error');
  }
}

function disableModel(): void {
  telemetry.event(systemClockNow(), 'model', 'unloaded', 'unavailable', { sessionId });
  provider?.dispose();
  provider = undefined;
  modelReady = false;
  modelState = supportsPerception() ? 'idle' : 'unsupported';
  modelLoadMs = null;
  modelBytes = 0;
  clearLateWork();
  overlayContext?.clearRect(0, 0, overlay.width, overlay.height);
  loadProgress.hidden = true;
  updateModelUi();
  updateSourceButtons();
  setDetectionStatus('Detection is off. The source preview is unaffected.', 'idle');
  renderObservations();
}

function startCamera(): void {
  if (benchmarkRunning) return;
  stopSources();
  const startVersion = ++cameraStartVersion;
  sourceKind = 'camera';
  beginSession('camera');
  const source = new CameraSource(media, feed, (message) => {
    if (camera !== source) return;
    camera = undefined;
    sourceKind = null;
    invalidateSession();
    sourceStatus.textContent = message;
    setDetectionStatus('Camera stopped.', 'warn');
    updateSourceButtons();
  });
  camera = source;
  setStatus('Waiting for camera permission…', 'idle');
  updateSourceButtons();
  void source.start(onFrame).then(() => {
    if (camera !== source || startVersion !== cameraStartVersion || document.hidden) {
      source.dispose();
      return;
    }
    setStatus('Camera running · frames stay in this browser', 'ok');
    updateSourceButtons();
  }).catch((error: unknown) => {
    if (camera !== source || startVersion !== cameraStartVersion) return;
    source.dispose();
    camera = undefined;
    sourceKind = null;
    invalidateSession();
    setStatus(error instanceof Error ? error.message : 'Camera could not start.', 'error');
    updateSourceButtons();
  });
}

function startVideo(file: File): void {
  if (benchmarkRunning) return;
  const problem = videoFileProblem(media, file);
  if (problem) {
    setStatus(problem, 'error');
    return;
  }
  stopSources();
  sourceKind = 'video';
  const source = new VideoSource(media, feed, {
    callbacks: {
      onStatus: (status) => presentVideoStatus(status),
      onSessionReset: () => { if (sourceKind === 'video') beginSession('video'); },
      onError: (message) => setStatus(message, 'error'),
    },
  });
  video = source;
  beginSession('video');
  source.start(onFrame);
  source.load(file);
  setStatus('Loading local video…', 'idle');
  updateSourceButtons();
}

function presentVideoStatus(status: VideoSourceStatus): void {
  if (sourceKind !== 'video') return;
  const detail = status.message || status.state;
  setStatus(`${detail}${status.durationMs === null ? '' : ' · ' + (status.durationMs / 1_000).toFixed(1) + ' s'}`, status.state === 'error' ? 'error' : 'ok');
  if (status.durationMs !== null && status.durationMs > 0) {
    videoSeek.max = String(Math.max(1, Math.round(status.durationMs / 100)));
    if (!draggingSeek && status.mediaTimeMs !== null) videoSeek.value = String(Math.round(status.mediaTimeMs / 100));
    videoTime.textContent = `${status.mediaTimeMs === null ? '0:00.0' : formatClock(status.mediaTimeMs)} / ${formatClock(status.durationMs)}`;
  } else {
    videoTime.textContent = '—';
  }
  updateSourceButtons();
}

function formatClock(ms: number): string {
  const total = Math.max(0, ms);
  const minutes = Math.floor(total / 60_000);
  const seconds = (total % 60_000) / 1_000;
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}

function startDemo(): void {
  if (benchmarkRunning) return;
  stopSources();
  sourceKind = 'demo';
  beginSession('demo');
  const source = new ProceduralSource(feed);
  demo = source;
  source.start(onFrame);
  setStatus('Procedural scene · local synthetic input', 'ok');
  updateSourceButtons();
}

function stopCamera(): void {
  if (!camera) return;
  cameraStartVersion += 1;
  camera.dispose();
  camera = undefined;
  sourceKind = null;
  invalidateSession();
  setStatus('Camera stopped.', 'idle');
  setDetectionStatus('Detection idle.', 'idle');
  updateSourceButtons();
}

async function runBenchmark(): Promise<void> {
  if (!modelReady || !sourceKind || benchmarkRunning) return;
  benchmarkRunning = true;
  benchmarkAbort = false;
  benchmarkPhases = [];
  benchmarkStatus.textContent = 'Running fixed and adaptive phases sequentially…';
  updateSourceButtons();
  try {
    const modes: readonly DetectionMode[] = ['fixed', 'adaptive'];
    for (const phaseMode of modes) {
      if (benchmarkAbort) break;
      if (video) {
        video.restart();
        const settled = await wait(BENCHMARK_SETTLE_MS, () => benchmarkAbort);
        if (!settled) break;
      }
      modeSelect.value = phaseMode;
      applyConfigLabels();
      beginSession(sourceKind);
      benchmarkStatus.textContent = `${phaseMode} phase · ${BENCHMARK_DURATION_MS / 1_000}s`;
      const completed = await wait(BENCHMARK_DURATION_MS, () => benchmarkAbort);
      const stats = metrics.snapshot(performance.now(), longTasks.count, longTasks.maxMs);
      benchmarkPhases.push({
        mode: phaseMode,
        targetFps: targetFpsInput.valueAsNumber,
        periodicMs: periodicInput.valueAsNumber,
        changeThreshold: changeInput.valueAsNumber,
        stats,
      });
      if (!completed) break;
    }
    renderBenchmark();
    benchmarkStatus.textContent = benchmarkAbort
      ? 'Benchmark stopped. Partial results are shown.'
      : 'Benchmark complete. These are throughput/latency results, not accuracy.';
  } finally {
    benchmarkRunning = false;
    benchmarkAbort = false;
    updateSourceButtons();
  }
}

function renderBenchmark(): void {
  benchmarkResults.replaceChildren();
  if (!benchmarkPhases.length) {
    benchmarkResults.textContent = 'No completed phases.';
    return;
  }
  const table = document.createElement('table');
  table.className = 'benchmark-table';
  const header = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const text of ['Mode', 'Target FPS', 'Detection batches', 'Effective FPS', 'P50', 'P95', 'Queue drops', 'Stale', 'Long tasks / max', 'Elapsed']) {
    const cell = document.createElement('th');
    cell.textContent = text;
    headerRow.append(cell);
  }
  header.append(headerRow);
  table.append(header);
  const body = document.createElement('tbody');
  for (const phase of benchmarkPhases) {
    const row = document.createElement('tr');
    const values = [
      phase.mode,
      String(phase.targetFps),
      String(phase.stats.batches),
      formatFps(phase.stats.effectiveFps),
      formatMs(phase.stats.latency.p50Ms),
      formatMs(phase.stats.latency.p95Ms),
      String(phase.stats.droppedQueue),
      String(phase.stats.droppedStale),
      `${phase.stats.longTasks} / ${formatMs(phase.stats.maxLongTaskMs)}`,
      `${(phase.stats.elapsedMs / 1_000).toFixed(1)} s`,
    ];
    for (const value of values) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    body.append(row);
  }
  table.append(body);
  benchmarkResults.append(table);
  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = 'No labeled data is available, so no detection accuracy or event recall is reported. Camera/demo phases are sequential, not the same clip.';
  benchmarkResults.append(note);
}

function updateSettings(): void {
  applyConfigLabels();
  trigger.setConfig(readTriggerConfig());
}

cameraButton.addEventListener('click', startCamera);
cameraStopButton.addEventListener('click', stopCamera);
demoButton.addEventListener('click', startDemo);
videoFile.addEventListener('change', () => {
  const file = videoFile.files?.[0];
  if (file) startVideo(file);
});
videoPlayButton.addEventListener('click', () => {
  if (!video) return;
  if (video.isPlaying) video.pause();
  else void video.play();
});
videoRestartButton.addEventListener('click', () => video?.restart());
videoSeek.addEventListener('input', () => { draggingSeek = true; });
videoSeek.addEventListener('change', () => {
  draggingSeek = false;
  if (video) video.seekTo(videoSeek.valueAsNumber / 10);
});
videoSeek.addEventListener('pointerup', () => { draggingSeek = false; });
enableModelButton.addEventListener('click', () => void enableModel());
disableModelButton.addEventListener('click', disableModel);
modeSelect.addEventListener('change', updateSettings);
targetFpsInput.addEventListener('input', updateSettings);
periodicInput.addEventListener('input', updateSettings);
changeInput.addEventListener('input', updateSettings);
element('perception-telemetry-json').addEventListener('click', () => download('perception-telemetry.json', telemetry.exportJson(), 'application/json'));
element('perception-telemetry-csv').addEventListener('click', () => download('perception-telemetry.csv', telemetry.exportCsv(), 'text/csv'));
element('perception-telemetry-clear').addEventListener('click', () => { telemetry.clear(); renderPerceptionTelemetry(); });
trackingEnabledInput.addEventListener('change', () => {
  if (trackingEnabled()) startTracking(); else resetTracking();
  drawObservations(latestDetectionBatch);
});
element('object-index-export').addEventListener('click', () => {
  if (!tracking) return;
  download('perception-object-index.json', JSON.stringify(tracking.snapshot(), null, 2), 'application/json');
});
element('object-index-clear').addEventListener('click', () => {
  selectedTrackId = '';
  renderObjectTracking();
  drawObservations(latestDetectionBatch);
});
benchmarkRun.addEventListener('click', () => void runBenchmark());
benchmarkCancel.addEventListener('click', () => { benchmarkAbort = true; });


function startStatsTimer(): void {
  if (statsTimer !== undefined) window.clearInterval(statsTimer);
  statsTimer = window.setInterval(() => renderStats(), 500);
}

function handleVisibilityChange(): void {
  const visible = !document.hidden;
  foreground = visible;
  metrics.setVisible(visible, performance.now());
  telemetry.event(performance.now(), 'perception', visible ? 'foreground' : 'background', telemetrySource(),
    sessionId ? { sessionId } : {});
  if (visible) {
    updateSourceButtons();
    if (!sourceKind) setStatus('Camera paused while the page was hidden. Tap Start camera to resume.', 'warn');
    return;
  }
  clearLateWork();
  cameraStartVersion += 1;
  if (camera) {
    camera.dispose();
    camera = undefined;
    sourceKind = null;
    setStatus('Camera paused while the page was hidden. Tap Start camera to resume.', 'warn');
  } else if (video) {
    video.pause();
    setStatus('Video paused while the page was hidden. Tap Play video to resume.', 'warn');
  } else if (demo) {
    demo.stop();
    demo = undefined;
    sourceKind = null;
    setStatus('Procedural scene paused while the page was hidden. Choose a source to resume.', 'idle');
  }
  setDetectionStatus('Detection paused while the page is hidden.', 'idle');
  updateSourceButtons();
}

function handlePageHide(event: PageTransitionEvent): void {
  benchmarkAbort = true;
  foreground = false;
  metrics.setVisible(false, performance.now());
  cameraStartVersion += 1;
  clearLateWork();
  stopSources();
  if (statsTimer !== undefined) window.clearInterval(statsTimer);
  statsTimer = undefined;
  provider?.dispose();
  provider = undefined;
  modelReady = false;
  modelState = supportsPerception() ? 'idle' : 'unsupported';
  modelLoadMs = null;
  modelBytes = 0;
  updateModelUi();
  if (!event.persisted) longTasks.dispose();
}

function handlePageShow(event: PageTransitionEvent): void {
  if (!event.persisted) return;
  foreground = !document.hidden;
  metrics.setVisible(foreground, performance.now());
  startStatsTimer();
  updateModelUi();
  updateSourceButtons();
  if (!sourceKind) setStatus('Camera stopped while away. Tap Start camera to resume.', 'warn');
}

startStatsTimer();
document.addEventListener('visibilitychange', handleVisibilityChange);
window.addEventListener('pagehide', handlePageHide);
window.addEventListener('pageshow', handlePageShow);
applyConfigLabels();
updateModelUi();
updateSourceButtons();
renderObservations();
renderStats(true);
setStatus('Choose a source. Detection is off until you enable the model.', 'idle');
setDetectionStatus('Detection off by default.', 'idle');
