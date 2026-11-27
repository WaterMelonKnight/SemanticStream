import './agent-lab.css';
import { AgentSession } from './agent/session';
import type { AgentTask } from './agent/policy';
import type { AgentProvider } from './agent/provider';
import type { BufferedFrame } from './core/context-buffer';
import { GatewayStreamingProvider } from './inference/gateway-provider';
import { ScriptedStreamingProvider } from './inference/scripted-provider';
import { systemClock } from './inference/types';
import { BudgetPoller } from './observability/budget-poller';
import { costView, formatUsd } from './observability/cost';
import { summarizeRuntime } from './observability/summary';
import { createSourceTransform, drawLetterboxed } from './perception/geometry';
import { MediaPipeObjectDetectorProvider } from './perception/provider';
import { DETECTOR_ID, EFFICIENTDET_MODEL_URL, EFFICIENTDET_MODEL_VERSION, MEDIAPIPE_WASM_VERSIONED_PATH, MODEL_INPUT_SIZE } from './perception/types';
import type { ObjectEvent } from './perception/tracking/types';
import { CameraSource } from './visual/camera-source';
import { context2d, ThumbnailReader } from './visual/canvas';
import { MonitorSource } from './visual/monitor-source';
import { ProceduralSource } from './visual/source';
import type { VisualFrame } from './visual/source';
import { VideoSource, videoFileProblem } from './visual/video-source';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
const feed = el<HTMLCanvasElement>('feed');
const overlay = context2d(el<HTMLCanvasElement>('overlay'));
const media = el<HTMLVideoElement>('media');
const evidence = context2d(el<HTMLCanvasElement>('evidence'));
const thumbnail = new ThumbnailReader();
const modelCanvas = document.createElement('canvas');
modelCanvas.width = modelCanvas.height = MODEL_INPUT_SIZE;
const modelContext = context2d(modelCanvas, { alpha: false, willReadFrequently: true });
const transform = createSourceTransform(feed.width, feed.height, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
const baseLimits = { slots: 2, queue: 4, transport: { windowMs: 5_000, maxFrames: 16, maxBytes: 96_000 } };
const mock: AgentProvider = {
  adapter: new ScriptedStreamingProvider(systemClock, (task) => ({
    firstTokenMs: task.priority >= 20 ? 220 : 420, intervalMs: 540, finishAfterMs: 140,
    chunks: [
      task.event.label + '. ',
      'I used the recorded event and the latest tracked state. ',
      'Image evidence stays on this device.',
    ],
  })),
  capabilities: {
    modelId: 'scripted-text', executionLocation: 'mock', supportsText: true, supportsVision: false,
    supportsStreaming: true, supportsCancellation: true, maxConcurrency: 2, usageReporting: 'simulated', readiness: 'ready',
  },
  source: 'mock', deadlineMs: 5_000, limits: { ...baseLimits, totalTokens: 16_000, tokensPerTask: 128 },
};
const agent = new AgentSession<VisualFrame>({
  runtimeInstanceId: 'agent-' + crypto.randomUUID(), clock: systemClock, provider: mock,
  frames: {
    sample: (frame) => thumbnail.read(frame.canvas),
    metadata: (frame) => ({ mediaTimeMs: frame.mediaTimeMs, phase: frame.phase }),
    detection: (frame) => {
      drawLetterboxed(modelContext, frame.canvas, transform);
      return { transform, pixels: modelContext.getImageData(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE).data.buffer };
    },
  },
});
let monitor: MonitorSource | undefined;
let video: VideoSource | undefined;
let generation = 0;
let gatewayGeneration = 0;
let lastQuestion = '';
let poller: BudgetPoller | undefined;
let refresh: number | undefined;
let budgetTimer: number | undefined;
const providerAddress = () => gatewaySupported ? 'Supported Gateway address · ' + location.origin
  : 'Gateway is available from its local Node page at 127.0.0.1. External addresses are disabled.';
const gatewaySupported = location.hostname === '127.0.0.1' && location.protocol === 'http:';

function clearEvidence(): void {
  evidence.clearRect(0, 0, 96, 54);
  el('history').textContent = '';
  el('evidence-state').textContent = 'Select a frame or event to inspect local evidence.';
}

function replaceSource(): number {
  const version = ++generation;
  monitor = undefined;
  video = undefined;
  el('monitor-actions').hidden = true;
  el('play').hidden = true;
  clearEvidence();
  return version;
}

function stopInput(message: string): void {
  replaceSource();
  agent.suspend();
  context2d(feed).clearRect(0, 0, feed.width, feed.height);
  el('source-state').textContent = message;
}

function scene(systemMonitor: boolean): void {
  const version = replaceSource();
  const source = systemMonitor ? new MonitorSource(feed) : new ProceduralSource(feed);
  if (source instanceof MonitorSource) monitor = source;
  el('monitor-actions').hidden = !systemMonitor;
  el('source-state').textContent = systemMonitor ? 'Synthetic system monitor' : 'Procedural test scene';
  void agent.useSource(source, 'demo').catch(() => {
    if (version === generation) stopInput('Scene could not start');
  });
}

async function camera(): Promise<void> {
  const version = replaceSource();
  el('source-state').textContent = 'Waiting for camera permission…';
  const source = new CameraSource(media, feed, (message) => {
    if (version === generation) stopInput(message);
  });
  try {
    await agent.useSource({ start: (listener) => source.start(listener), stop: () => source.dispose() }, 'camera');
    if (version === generation) el('source-state').textContent = 'Camera running · local';
  } catch (error) {
    if (version === generation) stopInput(error instanceof DOMException && error.name === 'NotAllowedError'
      ? 'Camera permission denied' : 'Camera unavailable in this browser');
  }
}

function localVideo(file: File): void {
  const problem = videoFileProblem(media, file);
  if (problem) { el('source-state').textContent = problem; return; }
  const version = replaceSource();
  const source = new VideoSource(media, feed, { callbacks: {
    onSessionReset: () => { if (version === generation) { clearEvidence(); agent.resetSource(); } },
    onStatus: ({ message }) => { if (version === generation) el('source-state').textContent = message; },
    onError: (message) => { if (version === generation) stopInput(message); },
  } });
  video = source;
  el('play').hidden = false;
  void agent.useSource(source, 'video').catch(() => {
    if (version === generation) stopInput('Video could not start');
  });
  source.load(file);
}

function list(id: string, lines: readonly string[]): void {
  const element = el(id);
  const next = lines.join('\n');
  if (element.dataset.text === next) return;
  element.dataset.text = next;
  element.replaceChildren(...lines.map((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  }));
}

function showEvidence(result: { status: string; frame: BufferedFrame | null }, event?: ObjectEvent): void {
  evidence.clearRect(0, 0, 96, 54);
  const { frame, status } = result;
  if (frame) {
    const image = evidence.createImageData(frame.width, frame.height);
    image.data.set(frame.pixels);
    evidence.putImageData(image, 0, 0);
  }
  el('evidence-state').textContent = status + (frame ? ' · #' + frame.sequence + ' captured at ' + frame.timestampMs.toFixed(1) + ' ms' : '');
  el('history').textContent = event ? agent.state.getObjectHistory(event.trackId, { fromMs: 0, toMs: event.producedAtMs })
    .slice(-8).map((point) => point.trackingState + ' · known at ' + point.atMs.toFixed(0) + ' ms · capture '
      + point.evidence.capturedAtMs.toFixed(0) + ' ms').join('\n') : '';
}

let lastEventKey = '';
function render(): void {
  const { source, objects, detector, provider, runtime, visual, evidence: cache, cost, task, status, taskRevision,
    measurements, captureCount, decisions } = agent.snapshot();
  el('task-state').textContent = status + ' · rev ' + taskRevision;
  el('pause').textContent = status === 'paused' ? 'Resume task' : 'Pause task';
  el<HTMLButtonElement>('pause').disabled = status === 'terminated';
  el('detector-status').textContent = ({
    off: 'Detector off · model downloads only after opt-in',
    loading: 'Loading EfficientDet-Lite0…',
    ready: 'Detector ready · local EfficientDet-Lite0',
    error: 'Detector unavailable · retry to load again',
  })[detector];
  el('detect').textContent = detector === 'ready' || detector === 'loading' ? 'Disable detector' : 'Enable object detector';
  list('tracks', objects.tracks.slice(-15).reverse().map((track) => track.trackId + ' · ' + track.categoryName + ' · '
    + track.trackingState + (track.associationUncertain ? ' · uncertain link' : '')));
  overlay.clearRect(0, 0, feed.width, feed.height);
  if (task.type === 'region') {
    const b = task.region;
    overlay.strokeStyle = '#ffcb6b';
    overlay.lineWidth = 3;
    overlay.strokeRect(b.x * feed.width, b.y * feed.height, b.width * feed.width, b.height * feed.height);
  }
  overlay.font = '14px system-ui';
  for (const track of objects.tracks) {
    if (track.trackingState !== 'CONFIRMED' && track.trackingState !== 'TENTATIVE') continue;
    const b = track.boundingBox;
    const x = b.x * feed.width;
    const y = b.y * feed.height;
    overlay.strokeStyle = overlay.fillStyle = track.associationUncertain ? '#ffcb6b' : '#7af7d4';
    overlay.lineWidth = 2;
    overlay.strokeRect(x, y, b.width * feed.width, b.height * feed.height);
    overlay.fillText(track.categoryName + ' · ' + track.trackId.split(':').at(-1), x, Math.max(15, y - 5));
  }
  const recent = decisions.slice(-18).reverse();
  const eventKey = recent.map((item) => item.id).join(' ');
  if (lastEventKey !== eventKey) {
    lastEventKey = eventKey;
    el('events').replaceChildren(...recent.map((row) => {
      const item = document.createElement('li');
      item.textContent = row.label + ' · ' + row.action + ' · ' + row.reason
        + (row.taskId ? ' · task #' + row.taskId : '') + ' · consumed ' + row.consumedAtMs.toFixed(0) + ' ms';
      const event = row.event;
      if (event) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Inspect event evidence';
        button.onclick = () => showEvidence(agent.retrieveEvent(event), event);
        item.append(document.createElement('br'), button);
      }
      return item;
    }));
  }
  const answers = runtime.outputs.slice().reverse();
  const answerKey = JSON.stringify(answers);
  if (el('answers').dataset.text !== answerKey) {
    el('answers').dataset.text = answerKey;
    el('answers').replaceChildren(...answers.map((answer) => {
      const item = document.createElement('li');
      item.dataset.state = answer.state;
      item.textContent = '#' + answer.taskId + ' · ' + answer.state + ' · ' + answer.text;
      return item;
    }));
  }
  list('queue', [
    runtime.attempts.length + '/' + runtime.slots + ' slots held · ' + runtime.queued.length + ' queued',
    ...runtime.attempts.map((task) => '#' + task.id + ' · context v' + task.context + ' · '
      + (task.quarantined ? 'quarantined' : task.outcome ? 'draining' : 'running')),
    ...runtime.queued.map((task) => '#' + task.id + ' · context v' + task.context + ' · queued'),
  ]);
  el('provider-state').textContent = provider.modelId + ' · ' + source;
  list('capabilities', [
    provider.executionLocation + ' · ' + provider.readiness + ' · ' + provider.maxConcurrency + ' logical slots',
    'Text streaming · cancellation requests supported · ' + provider.usageReporting + ' usage',
    'Image evidence stays local · browser-local LLM integration reserved for Phase 4I-L',
  ]);
  list('budget', [
    cost ? 'Gateway estimate · ' + formatUsd(cost.settledNanoUsd) + ' settled · ' + formatUsd(cost.reservedNanoUsd)
      + ' reserved · ' + formatUsd(cost.provisionalNanoUsd) + ' provisional' : 'Gateway cost unavailable',
    ...(cost ? [formatUsd(cost.availableNanoUsd) + ' available · ' + cost.accepted + '/' + cost.requestLimit + ' requests'
      + (cost.admission.reasons.length ? ' · ' + cost.admission.reasons.join(', ') : '')] : []),
    (source === 'mock' ? 'Mock tokens' : 'Reported gateway tokens') + ' · ' + runtime.budget.settledTokens
      + ' settled · ' + runtime.budget.unknownUsageCount + ' unknown receipts',
    captureCount + ' captured · ' + (visual?.rates.input.toFixed(1) ?? '—') + ' input FPS · '
      + (cache?.buffer.frameCount ?? 0) + ' buffered · ' + (cache?.retrieval.budget.total.usedFrames ?? 0) + ' visual transfers / 5 s',
  ]);
  const summary = summarizeRuntime(measurements);
  const fmt = (value: number | null | undefined) => value == null ? '—' : value.toFixed(1) + ' ms';
  const tracking = objects;
  const telemetry = agent.telemetry.snapshot();
  const telemetryP95 = (name: string) => {
    const points = telemetry.series.find((series) => series.name === name && series.sessionId === objects.sessionId)?.points;
    const ordered = points?.map((point) => point.value).sort((a, b) => a - b) ?? [];
    return ordered[Math.ceil(ordered.length * 0.95) - 1];
  };
  list('measurements', [
    'Perception P95 ' + fmt(telemetryP95('inference_ms'))
      + ' · tracking P95 ' + fmt(tracking.processingP95Ms) + ' · event processing P95 ' + fmt(tracking.eventP95Ms),
    'Admission P95 ' + fmt(telemetryP95('event_to_admission_ms')) + ' · queue wait P95 ' + fmt(telemetryP95('queue_wait_ms'))
      + ' · ' + decisions.filter((item) => !item.taskId).length + ' recent policy suppressions',
    measuresLine(measurements, 'firstTextDelayMs', 'First text') + ' · ' + measuresLine(measurements, 'firstEffectiveDelayMs', 'Effective response'),
    measurements.filter((item) => item.unanswered).length + '/' + measurements.length + ' unanswered · '
      + measurements.reduce((sum, item) => sum + item.stale, 0) + ' stale partials suppressed',
    'Failures ' + summary.failed + '/' + summary.tasks + ' · rejected ' + summary.rejected + '/' + summary.tasks
      + ' · expired ' + summary.expired + '/' + summary.tasks + ' · invalidated ' + summary.invalidated,
    'Reported usage · ' + summary.inputTokens + ' input / ' + summary.outputTokens + ' output · ' + summary.unknownUsage + ' unknown',
    ...measurements.slice(-5).reverse().map((item) => '#' + item.id + ' · ' + item.outcome + (item.reason ? ' · ' + item.reason : '')),
  ]);
}

function measuresLine(rows: ReturnType<typeof agent.snapshot>['measurements'], key: 'firstTextDelayMs' | 'firstEffectiveDelayMs', name: string): string {
  const sorted = rows.flatMap((row) => row[key] === undefined ? [] : [row[key]]).sort((a, b) => a - b);
  return name + ' P95 ' + (sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(1) + ' ms' : '—');
}

function configureTask(): void {
  const kind = el<HTMLSelectElement>('template').value as AgentTask['type'];
  el('object-fields').hidden = kind !== 'object' && kind !== 'region';
  el('track-field').hidden = kind !== 'object';
  el('move-field').hidden = kind !== 'object';
  el('region-fields').hidden = kind !== 'region';
}
el('template').onchange = configureTask;
el<HTMLFormElement>('task').onsubmit = (event) => {
  event.preventDefault();
  const kind = el<HTMLSelectElement>('template').value as AgentTask['type'];
  const category = el<HTMLInputElement>('category').value;
  const percent = (name: string) => el<HTMLInputElement>('roi-' + name).valueAsNumber / 100;
  try {
    if (kind === 'object') agent.setTask({ type: kind, category, trackId: el<HTMLInputElement>('track').value,
      movement: el<HTMLInputElement>('movement').checked });
    else if (kind === 'region') agent.setTask({ type: kind, category,
      region: { x: percent('x'), y: percent('y'), width: percent('w'), height: percent('h') } });
    else agent.setTask({ type: kind });
    el('task-error').textContent = '';
  } catch { el('task-error').textContent = 'Choose a valid region inside the image.'; }
};
el('pause').onclick = () => agent.setTaskStatus(agent.snapshot().status === 'paused' ? 'active' : 'paused');
el('end-task').onclick = () => agent.setTaskStatus('terminated');
el('summary').onclick = () => agent.summarize();
el('monitor').onclick = () => scene(true);
el('procedural').onclick = () => scene(false);
el('stop-source').onclick = () => stopInput('Input stopped');
el('camera').onclick = () => void camera();
el('play').onclick = () => { if (video?.isPlaying) video.pause(); else void video?.play(); };
el<HTMLInputElement>('video-file').onchange = (event) => {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) localVideo(file);
};
el('normal').onclick = () => { monitor?.trigger(false); agent.monitor(false); };
el('critical').onclick = () => { monitor?.trigger(true); agent.monitor(true); };
el('latest').onclick = () => showEvidence(agent.retrieveLatest());
el<HTMLFormElement>('historical-time').onsubmit = (event) => {
  event.preventDefault();
  showEvidence(agent.retrieveAt(el<HTMLInputElement>('at').valueAsNumber));
};
el<HTMLFormElement>('ask').onsubmit = (event) => {
  event.preventDefault();
  const input = el<HTMLInputElement>('question');
  lastQuestion = input.value.trim();
  if (!lastQuestion) return;
  agent.ask(lastQuestion);
  input.value = '';
  el<HTMLButtonElement>('retry').disabled = false;
};
el('retry').onclick = () => agent.ask(lastQuestion);
el('interrupt').onclick = () => agent.interrupt();
el('detect').onclick = async () => {
  const status = agent.snapshot().detector;
  if (status === 'loading' || status === 'ready') { agent.disableDetector(); return; }
  const adapter = new MediaPipeObjectDetectorProvider(DETECTOR_ID, EFFICIENTDET_MODEL_VERSION);
  await agent.enableDetector(adapter, {
    id: DETECTOR_ID, version: EFFICIENTDET_MODEL_VERSION,
    wasmUrl: new URL(MEDIAPIPE_WASM_VERSIONED_PATH, document.baseURI).href,
    modelUrl: EFFICIENTDET_MODEL_URL, scoreThreshold: 0.35, maxResults: 20,
  });
};

async function poll(): Promise<void> {
  const active = poller;
  if (!active || document.hidden) return;
  const result = await active.poll();
  if (active !== poller || document.hidden || result.status === 'skipped') return;
  try { agent.setGatewayCost(result.status === 'updated' ? costView(result.budget) : undefined); }
  catch { agent.setGatewayCost(undefined); }
}

const modelMode = el<HTMLSelectElement>('model-mode');
modelMode.options[1].disabled = !gatewaySupported;
modelMode.onchange = () => { el('auth-wrap').hidden = modelMode.value !== 'gateway'; };
el('gateway-address').textContent = providerAddress();

function disconnect(): void {
  gatewayGeneration += 1;
  poller = undefined;
  agent.setProvider(mock);
  modelMode.value = 'mock';
  el('auth-wrap').hidden = true;
  el('disconnect').hidden = true;
  el('gateway-address').textContent = providerAddress();
  el<HTMLInputElement>('access').value = '';
  el<HTMLButtonElement>('connect').disabled = false;
  clearEvidence();
}

el('disconnect').onclick = disconnect;
el<HTMLFormElement>('gateway-form').onsubmit = async (event) => {
  event.preventDefault();
  if (modelMode.value === 'mock') { disconnect(); return; }
  if (!gatewaySupported || document.hidden) return;
  const field = el<HTMLInputElement>('access');
  const token = field.value.trim();
  field.value = '';
  if (!token) return;
  const version = ++gatewayGeneration;
  const connect = el<HTMLButtonElement>('connect');
  connect.disabled = true;
  el('gateway-address').textContent = 'Connecting to ' + location.origin;
  try {
    const adapter = await GatewayStreamingProvider.connect(token);
    if (version !== gatewayGeneration || document.hidden) return;
    const caps = adapter.capabilities;
    const binding: AgentProvider = {
      adapter, source: 'real', deadlineMs: caps.timeoutMs,
      capabilities: { modelId: caps.model, executionLocation: 'gateway', supportsText: true, supportsVision: false,
        supportsStreaming: true, supportsCancellation: true, maxConcurrency: caps.slots,
        usageReporting: 'reported-or-unknown', readiness: 'ready' },
      limits: { ...baseLimits, slots: caps.slots, tokensPerTask: caps.outputLimit, inputTokensPerTask: caps.inputReserve,
        totalTokens: (caps.inputReserve + caps.outputLimit) * 100 },
    };
    try {
      agent.setProvider(binding);
    } catch (error) {
      el('gateway-address').textContent = error instanceof Error ? error.message : 'Gateway switch could not be applied';
      return;
    }
    poller = new BudgetPoller(() => adapter.budget(), systemClock.now);
    await poll();
    if (version !== gatewayGeneration) return;
    el('gateway-address').textContent = 'Connected · ' + location.origin + ' · text requests may incur charges';
    el('disconnect').hidden = false;
    clearEvidence();
  } catch {
    if (version === gatewayGeneration) el('gateway-address').textContent = 'Gateway unavailable or access token rejected';
  } finally { if (version === gatewayGeneration) connect.disabled = false; }
};
el('telemetry').onclick = () => {
  const url = URL.createObjectURL(new Blob([agent.telemetry.exportJson()], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'semanticstream-agent-telemetry.json';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

function stopTimers(): void { window.clearInterval(refresh); window.clearInterval(budgetTimer); }
function startTimers(): void {
  stopTimers();
  refresh = window.setInterval(render, 250);
  budgetTimer = window.setInterval(() => void poll(), 4_000);
  render();
}
function background(): void {
  stopTimers();
  disconnect();
  stopInput('Input paused in background. Choose a source to resume.');
  lastQuestion = '';
  el<HTMLInputElement>('question').value = '';
  el<HTMLButtonElement>('retry').disabled = true;
}
document.addEventListener('visibilitychange', () => { if (document.hidden) background(); else startTimers(); });
window.addEventListener('pagehide', background);
window.addEventListener('pageshow', (event) => { if (event.persisted && !document.hidden) startTimers(); });

configureTask();
if (!document.hidden) { scene(true); startTimers(); }
