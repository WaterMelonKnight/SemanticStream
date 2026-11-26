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
import { MediaPipeObjectDetectorProvider } from './perception/provider';
import type { ObjectDetectorProvider } from './perception/provider';
import { DetectionTrigger } from './perception/scheduler';
import {
  DETECTOR_ID,
  EFFICIENTDET_MODEL_BYTES,
  EFFICIENTDET_MODEL_LABEL,
  EFFICIENTDET_MODEL_URL,
  EFFICIENTDET_MODEL_VERSION,
  MAX_OBSERVATIONS,
  MEDIAPIPE_RUNTIME_VERSION,
  MEDIAPIPE_WASM_PATH,
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
const observationBody = element<HTMLTableSectionElement>('observations');
const detectionStatus = element('detection-status');
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
const wasmUrl = new URL(MEDIAPIPE_WASM_PATH, document.baseURI).href;

let provider: ObjectDetectorProvider | undefined;
let modelState: ModelState = supportsPerception() ? 'idle' : 'unsupported';
let modelBytes = 0;
let modelLoadMs: number | null = null;
let modelError = '';
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

const metrics = new PerceptionMetrics(performance.now());
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
    modelDetail.textContent = `Model load failed: ${modelError}. The source and UI remain usable; retry with the button.`;
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
  sessionVersion += 1;
  sessionId = '';
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

function beginSession(kind: SourceKind): void {
  sessionVersion += 1;
  sessionId = `perception-${kind}-${sessionVersion}`;
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
  inFlight = {
    request,
    startedAt: performance.now(),
    timeout: window.setTimeout(() => {
      if (!inFlight) return;
      setDetectionStatus('Detection timed out; disabling the worker.', 'error');
      modelState = 'error';
      modelError = 'Worker inference timed out.';
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
  if (inFlight) {
    window.clearTimeout(inFlight.timeout);
    inFlight = null;
  }
  if (!request || result.requestId !== request.requestId || result.sessionId !== sessionId) {
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
  metrics.recordBatch(result.inferenceMs, batch.length, completedAtMs);
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

function handleDetectionError(error: Error): void {
  if (!modelReady) return;
  if (inFlight) {
    window.clearTimeout(inFlight.timeout);
    inFlight = null;
  }
  pending = null;
  modelState = 'error';
  modelError = error.message;
  modelReady = false;
  provider?.dispose();
  provider = undefined;
  updateModelUi();
  updateSourceButtons();
  setDetectionStatus('Detection stopped after a worker error. The source preview is still live.', 'error');
}

function drawObservations(items: readonly ObjectObservation[]): void {
  if (!overlayContext) return;
  overlayContext.clearRect(0, 0, overlay.width, overlay.height);
  for (const observation of items) {
    const { box } = observation;
    if (box.width < 1 || box.height < 1) continue;
    overlayContext.strokeStyle = '#7ee787';
    overlayContext.lineWidth = 2;
    overlayContext.strokeRect(box.x, box.y, box.width, box.height);
    const label = `${observation.categoryName} ${formatPercent(observation.score * 100)}`;
    overlayContext.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
    const width = overlayContext.measureText(label).width + 8;
    overlayContext.fillStyle = 'rgba(10, 14, 22, 0.86)';
    overlayContext.fillRect(box.x, Math.max(0, box.y - 18), width, 16);
    overlayContext.fillStyle = '#b7ffcb';
    overlayContext.fillText(label, box.x + 4, Math.max(11, box.y - 6));
  }
}

function renderObservations(): void {
  observationBody.replaceChildren();
  if (!observations.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.textContent = modelReady ? 'No observations yet.' : 'Enable the model to start structured observations.';
    row.append(cell);
    observationBody.append(row);
    return;
  }
  for (const observation of observations) {
    const row = document.createElement('tr');
    const values = [
      `#${String(observation.frameSequence).padStart(4, '0')}`,
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
    observationBody.append(row);
  }
}

function renderStats(force = false): void {
  const now = performance.now();
  if (!force && now - lastStatsAt < 250) return;
  lastStatsAt = now;
  const stats = metrics.snapshot(now, longTasks.count, longTasks.maxMs);
  fpsStat.textContent = formatFps(stats.effectiveFps);
  batchStat.textContent = String(stats.batches);
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
}

function updateFrameStatus(frame: StreamFrame<VisualFrame>): void {
  const now = performance.now();
  if (now - lastStatusAt < 200) return;
  lastStatusAt = now;
  const phase = frame.payload.phase;
  feedStatus.textContent = `${phase} · frame #${frame.sequence} · ${lastChangePercent.toFixed(1)}% change probe`;
}

function onFrame(frame: StreamFrame<VisualFrame>): void {
  if (!sessionId) return;
  const probe = readProbe();
  lastChangePercent = lastProbe ? meanRgbDifference(lastProbe, probe) : 100;
  lastProbe = probe;
  updateFrameStatus(frame);
  if (!modelReady) {
    if (modelState === 'loading') metrics.recordNotReady();
    return;
  }
  const decision = trigger.shouldSubmit(frame.timestampMs, lastChangePercent);
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
  modelError = '';
  modelState = 'loading';
  loadingStartedAt = performance.now();
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
    loadProgress.hidden = true;
    updateModelUi();
    updateSourceButtons();
    setDetectionStatus('Model ready. Start a source or wait for the current one.', 'ok');
    renderObservations();
  } catch (error) {
    modelState = 'error';
    modelError = error instanceof Error ? error.message : String(error);
    modelReady = false;
    provider?.dispose();
    provider = undefined;
    loadProgress.hidden = true;
    updateModelUi();
    updateSourceButtons();
    setDetectionStatus('Model load failed; detection is disabled. The source still works.', 'error');
  }
}

function disableModel(): void {
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
    if (camera !== source) return;
    setStatus('Camera running · frames stay in this browser', 'ok');
    updateSourceButtons();
  }).catch((error: unknown) => {
    if (camera !== source) return;
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
benchmarkRun.addEventListener('click', () => void runBenchmark());
benchmarkCancel.addEventListener('click', () => { benchmarkAbort = true; });

applyConfigLabels();
updateModelUi();
updateSourceButtons();
renderObservations();
renderStats(true);
setStatus('Choose a source. Detection is off until you enable the model.', 'idle');
setDetectionStatus('Detection off by default.', 'idle');
const statsTimer = setInterval(() => renderStats(), 500);

window.addEventListener('pagehide', (event) => {
  if (event.persisted) return;
  benchmarkAbort = true;
  provider?.dispose();
  provider = undefined;
  stopSources();
  window.clearInterval(statsTimer);
  longTasks.dispose();
});

window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  updateSourceButtons();
});
