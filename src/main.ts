import './style.css';
import { SamplingSession, TIMELINE_CAPACITY } from './app/sampling-session';
import type { SamplingMode, SessionSnapshot, TimelineEntry } from './app/sampling-session';
import type { RetrievalResponse, RetrievalStats } from './core/active-retrieval';
import type { BufferedFrame } from './core/context-buffer';
import { SAMPLE_HEIGHT, SAMPLE_WIDTH } from './core/sample';
import type { AdaptiveStrategy } from './core/local-change';
import type { MetricsSnapshot } from './core/metrics';
import type { StreamFrame } from './core/stream';
import type { BenchmarkReport } from './benchmark/types';
import type { Phase2Report } from './benchmark/retrieval-types';
import type { TaskReport } from './benchmark/task-types';
import { DecisionEngine } from './decision/engine';
import { RuleBasedDecisionProvider } from './decision/rule-provider';
import type { DecisionResult, TaskDefinition } from './decision/types';
import { formatBytes, formatClock, formatRate } from './ui/format';
import { drawDecisionTimeline, timelineEntryIndexAt } from './ui/timeline-view';
import { ThumbnailReader } from './visual/canvas';
import { MockAgent } from './visual/mock-agent';
import type { FrameMetadata } from './visual/mock-agent';
import { ProceduralSource } from './visual/source';
import type { VisualFrame } from './visual/source';
import { VideoSource, videoFileProblem } from './visual/video-source';
import type { VideoResetReason, VideoSourceStatus } from './visual/video-source';

const DISPLAY_INTERVAL_MS = 100;
const REFRESH_INTERVAL_MS = 500;
const REGION_WIDTH = 24;
const REGION_HEIGHT = 16;

const TASK_PRESETS: Readonly<Record<string, TaskDefinition>> = {
  'read-status': {
    id: 'read-status', label: 'Read status text', category: 'text-reading', priority: 'high',
    roi: { x: 40, y: 20, width: 24, height: 14 },
  },
  'monitor-motion': {
    id: 'monitor-motion', label: 'Monitor motion', category: 'motion-monitoring', priority: 'normal',
    roi: { x: 8, y: 10, width: 80, height: 36 },
  },
  'inspect-panel': {
    id: 'inspect-panel', label: 'Inspect panel', category: 'general-inspection', priority: 'normal',
    roi: { x: 24, y: 18, width: 48, height: 24 },
  },
};

type SourceKind = 'demo' | 'video';

interface MetricsView {
  readonly row: HTMLElement;
  readonly inputs: HTMLElement;
  readonly sent: HTMLElement;
  readonly filtered: HTMLElement;
  readonly latency: HTMLElement;
  readonly inputRate: HTMLElement;
  readonly sentRate: HTMLElement;
  readonly policy: HTMLElement;
  readonly interval: HTMLElement;
  readonly budget: HTMLElement;
  readonly backpressure: HTMLElement;
}

function element<T extends HTMLElement>(id: string): T {
  const result = document.getElementById(id);
  if (!result) throw new Error('Missing page element: ' + id);
  return result as T;
}

function metricsView(mode: SamplingMode): MetricsView {
  return {
    row: element('metrics-' + mode),
    inputs: element(mode + '-inputs'),
    sent: element(mode + '-sent'),
    filtered: element(mode + '-filtered'),
    latency: element(mode + '-latency'),
    inputRate: element(mode + '-input-rate'),
    sentRate: element(mode + '-sent-rate'),
    policy: element(mode + '-policy'),
    interval: element(mode + '-interval'),
    budget: element(mode + '-budget'),
    backpressure: element(mode + '-backpressure'),
  };
}

function presentMetrics(view: MetricsView, snapshot: MetricsSnapshot, inputRate: number, sentRate: number): void {
  const hasInput = snapshot.inputs > 0;
  view.inputs.textContent = snapshot.inputs.toLocaleString('en');
  view.sent.textContent = snapshot.sent.toLocaleString('en');
  view.inputRate.textContent = hasInput ? formatRate(inputRate) + ' fps' : '—';
  view.sentRate.textContent = hasInput ? formatRate(sentRate) + ' fps' : '—';
  view.filtered.textContent = hasInput ? snapshot.filteredPercent.toFixed(1) + '%' : '—';
  view.latency.textContent = hasInput ? snapshot.meanProcessingMs.toFixed(2) + ' ms' : '—';
  view.policy.textContent = snapshot.reasons.policy.toLocaleString('en');
  view.interval.textContent = snapshot.reasons.interval.toLocaleString('en');
  view.budget.textContent = snapshot.reasons.budget.toLocaleString('en');
  view.backpressure.textContent = snapshot.reasons.backpressure.toLocaleString('en');
}

function positionText(frame: FrameMetadata): string {
  if (frame.mediaTimeMs !== null) return 'media ' + formatClock(frame.mediaTimeMs);
  return 'scene ' + (frame.elapsedMs / 1_000).toFixed(2) + ' s';
}

function presentFrame(sequence: HTMLElement, time: HTMLElement, frame?: FrameMetadata): void {
  sequence.textContent = frame ? 'Frame ' + String(frame.sequence).padStart(4, '0') : 'No frame yet';
  time.textContent = frame ? positionText(frame) : '—';
}

function presentVideoTime(time: HTMLElement, mediaMs: number | null, durationMs: number | null): void {
  time.textContent = formatClock(mediaMs) + ' / ' + formatClock(durationMs);
}

function runDemo(): void {
  const sourceCanvas = element<HTMLCanvasElement>('source-canvas');
  const adaptiveCanvas = element<HTMLCanvasElement>('agent-adaptive');
  const fixedCanvas = element<HTMLCanvasElement>('agent-fixed');
  const videoElement = element<HTMLVideoElement>('video-element');
  const adaptiveRadio = element<HTMLInputElement>('mode-adaptive');
  const fixedRadio = element<HTMLInputElement>('mode-fixed');
  const threshold = element<HTMLInputElement>('threshold');
  const thresholdValue = element<HTMLOutputElement>('threshold-value');
  const budget = element<HTMLInputElement>('budget');
  const budgetValue = element<HTMLOutputElement>('budget-value');
  const adaptiveStrategySelect = element<HTMLSelectElement>('adaptive-strategy');
  const localThreshold = element<HTMLInputElement>('local-threshold');
  const localThresholdValue = element<HTMLOutputElement>('local-threshold-value');
  const blockSize = element<HTMLSelectElement>('block-size');
  const sourcePhase = element('source-phase');
  const sourceSequence = element('source-sequence');
  const sourceTime = element('source-time');
  const sourceTimestamp = element('source-timestamp');
  const agentMode = element('agent-mode');
  const agentSequence = element('agent-sequence');
  const agentTime = element('agent-time');
  const agentPhase = element('agent-phase');
  const metrics = { adaptive: metricsView('adaptive'), fixed: metricsView('fixed') };
  const restartLabel = element('restart-label');
  const restartButton = element<HTMLButtonElement>('restart');
  const videoControls = element('video-controls');
  const videoFile = element<HTMLInputElement>('video-file');
  const chooseVideo = element<HTMLButtonElement>('choose-video');
  const useDemo = element<HTMLButtonElement>('use-demo');
  const sourceStatus = element('source-status');
  const videoError = element('video-error');
  const videoPlay = element<HTMLButtonElement>('video-play');
  const videoRestart = element<HTMLButtonElement>('video-restart');
  const videoSeek = element<HTMLInputElement>('video-seek');
  const videoCapture = element('video-capture');
  const videoTime = element('video-time');
  const timelineCanvas = element<HTMLCanvasElement>('timeline-canvas');
  const timelineCount = element('timeline-count');
  const sentDelta = element('sent-delta');
  const benchmarkStatus = element('benchmark-status');
  const benchmarkBody = element<HTMLTableSectionElement>('benchmark-body');
  const benchmarkNote = element('benchmark-note');
  const benchmarkFailureNote = element('benchmark-failures');
  const retrievalStatus = element('retrieval-status');
  const historyRange = element('history-range');
  const cacheUsage = element('cache-usage');
  const cacheEvictions = element('cache-evictions');
  const retrievalBudget = element('retrieval-budget');
  const retrievedCanvas = element<HTMLCanvasElement>('retrieved-canvas');
  const retrievedMeta = element('retrieved-meta');
  const regionCanvas = element<HTMLCanvasElement>('region-canvas');
  const regionMeta = element('region-meta');
  const retrievalLogBody = element<HTMLTableSectionElement>('retrieval-log');
  const phase2BenchmarkStatus = element('phase2-benchmark-status');
  const phase2BenchmarkBody = element<HTMLTableSectionElement>('phase2-benchmark-body');
  const phase2BenchmarkNote = element('phase2-benchmark-note');
  const taskSelect = element<HTMLSelectElement>('task-select');
  const roiX = element<HTMLInputElement>('roi-x');
  const roiY = element<HTMLInputElement>('roi-y');
  const roiW = element<HTMLInputElement>('roi-w');
  const roiH = element<HTMLInputElement>('roi-h');
  const taskStatus = element('task-status');
  const taskRoiSummary = element('task-roi-summary');
  const taskRealtimeBudget = element('task-realtime-budget');
  const taskRetrievalBudget = element('task-retrieval-budget');
  const taskDecisionLatency = element('task-decision-latency');
  const taskDecisionLog = element<HTMLTableSectionElement>('task-decision-log');
  const phase3BenchmarkStatus = element('phase3-benchmark-status');
  const phase3BenchmarkBody = element<HTMLTableSectionElement>('phase3-benchmark-body');
  const phase3BenchmarkNote = element('phase3-benchmark-note');

  videoElement.muted = true;
  videoElement.playsInline = true;

  let mode: SamplingMode = fixedRadio.checked ? 'fixed' : 'adaptive';
  let sourceKind: SourceKind = 'demo';
  let proceduralSource: ProceduralSource | undefined;
  let videoSource: VideoSource | undefined;
  let lastDisplayAt = -Infinity;
  let draggingSeek = false;
  let lastVideoStatus: VideoSourceStatus | undefined;
  let videoWasPlaying = false;
  let refreshTimer: number | undefined;
  let sessionCounter = 0;
  let lastRetrievedFrame: BufferedFrame | null = null;
  let lastRenderedRequestCount = -1;
  let displayedTimeline: readonly TimelineEntry[] = [];
  let liveTask = TASK_PRESETS['read-status'];
  const thumbnail = new ThumbnailReader();
  const liveDecisionEngine = new DecisionEngine(new RuleBasedDecisionProvider(), new RuleBasedDecisionProvider());

  function currentAdaptiveStrategy(): AdaptiveStrategy {
    const value = adaptiveStrategySelect.value;
    return value === 'local' || value === 'hybrid' || value === 'task' ? value : 'global';
  }

  function adaptiveStrategyLabel(strategy: AdaptiveStrategy): string {
    return strategy === 'global' ? 'Global'
      : strategy === 'local' ? 'Local'
        : strategy === 'hybrid' ? 'Hybrid' : 'Task-aware';
  }

  function taskAwareMode(): boolean {
    return currentAdaptiveStrategy() === 'task';
  }

  function createAgents() {
    return { adaptive: new MockAgent(adaptiveCanvas), fixed: new MockAgent(fixedCanvas) };
  }

  function createSession(): SamplingSession<VisualFrame> {
    return new SamplingSession(`live-${++sessionCounter}`, agents, {
      threshold: threshold.valueAsNumber,
      budget: budget.valueAsNumber,
      adaptiveStrategy: currentAdaptiveStrategy(),
      localThreshold: localThreshold.valueAsNumber,
      blockWidth: Number(blockSize.value),
      blockHeight: Number(blockSize.value),
      task: liveTask,
    }, liveDecisionEngine, presentTaskDecision);
  }

  let agents = createAgents();
  let session = createSession();

  function presentSentDelta(snapshot: SessionSnapshot): void {
    const { adaptive, fixed } = snapshot;
    if (!adaptive.inputs) {
      sentDelta.textContent = 'Waiting for input frames.';
      return;
    }
    const inputs = adaptive.inputs.toLocaleString('en');
    if (adaptive.sent === fixed.sent) {
      sentDelta.textContent = `Both strategies delivered ${adaptive.sent.toLocaleString('en')} frames from the same ${inputs} input frames.`;
      return;
    }
    const adaptiveMore = adaptive.sent > fixed.sent;
    const more = adaptiveMore ? 'Adaptive' : 'Fixed';
    const less = adaptiveMore ? 'fixed' : 'adaptive';
    const difference = Math.abs(adaptive.sent - fixed.sent).toLocaleString('en');
    sentDelta.textContent = `${more} delivered ${difference} more frames than ${less} from the same ${inputs} input frames.`;
  }

  function presentSnapshot(target = session): void {
    const snapshot = target.snapshot();
    presentMetrics(metrics.adaptive, snapshot.adaptive, snapshot.rates.input, snapshot.rates.adaptiveSent);
    presentMetrics(metrics.fixed, snapshot.fixed, snapshot.rates.input, snapshot.rates.fixedSent);
    presentSentDelta(snapshot);
    displayedTimeline = target.timeline.toArray();
    drawDecisionTimeline(timelineCanvas, displayedTimeline);
    timelineCount.textContent = `${target.timeline.size} / ${TIMELINE_CAPACITY} latest input frames kept`;
    presentRetrieval();
  }

  function setRetrievalStatus(message: string, state: 'ok' | 'error' | 'idle' = 'idle'): void {
    retrievalStatus.textContent = message;
    retrievalStatus.dataset.state = state;
  }

  function clearCanvas(canvas: HTMLCanvasElement): void {
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
  }

  function drawPixels(canvas: HTMLCanvasElement, pixels: Uint8ClampedArray, width: number, height: number): void {
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  }

  function rangeText(range: { startMs: number; endMs: number } | null): string {
    return range ? `${formatClock(range.startMs)}–${formatClock(range.endMs)}` : 'no retained range';
  }

  function clearRetrievalView(message = 'New session · buffer recording'): void {
    lastRetrievedFrame = null;
    lastRenderedRequestCount = -1;
    clearCanvas(retrievedCanvas);
    clearCanvas(regionCanvas);
    retrievedMeta.textContent = 'Click a recent timeline column to request a buffered frame.';
    regionMeta.textContent = 'Click the retrieved frame to crop a 24×16 pixel region.';
    setRetrievalStatus(message, 'idle');
  }

  function clampTaskRoi(): void {
    let x = Math.max(0, Math.min(SAMPLE_WIDTH - 1, Math.round(roiX.valueAsNumber) || 0));
    let y = Math.max(0, Math.min(SAMPLE_HEIGHT - 1, Math.round(roiY.valueAsNumber) || 0));
    let width = Math.max(1, Math.min(SAMPLE_WIDTH - x, Math.round(roiW.valueAsNumber) || 1));
    let height = Math.max(1, Math.min(SAMPLE_HEIGHT - y, Math.round(roiH.valueAsNumber) || 1));
    x = Math.max(0, x);
    y = Math.max(0, y);
    width = Math.max(1, Math.min(SAMPLE_WIDTH - x, width));
    height = Math.max(1, Math.min(SAMPLE_HEIGHT - y, height));
    roiX.value = String(x);
    roiY.value = String(y);
    roiW.value = String(width);
    roiH.value = String(height);
    liveTask = {
      ...liveTask,
      id: 'custom',
      label: 'Custom ROI',
      category: 'general-inspection',
      priority: 'normal',
      roi: { x, y, width, height },
    };
    taskSelect.value = 'custom';
    taskRoiSummary.textContent = `${liveTask.label} · ${x},${y} ${width}×${height}`;
    session.setTask(liveTask);
    resetTaskPreview();
  }

  function selectTaskPreset(id: string): void {
    if (id === 'custom') {
      taskRoiSummary.textContent = `${liveTask.label} · ${roiX.value},${roiY.value} ${roiW.value}×${roiH.value}`;
      return;
    }
    const preset = TASK_PRESETS[id];
    if (!preset) return;
    liveTask = { ...preset, roi: preset.roi ? { ...preset.roi } : null };
    if (liveTask.roi) {
      roiX.value = String(liveTask.roi.x);
      roiY.value = String(liveTask.roi.y);
      roiW.value = String(liveTask.roi.width);
      roiH.value = String(liveTask.roi.height);
      taskRoiSummary.textContent = `${liveTask.label} · ${liveTask.roi.x},${liveTask.roi.y} ${liveTask.roi.width}×${liveTask.roi.height}`;
    }
    session.setTask(liveTask);
    resetTaskPreview();
  }

  function resetTaskPreview(): void {
    taskDecisionLatency.textContent = '—';
    taskStatus.textContent = taskAwareMode() ? 'Live gate · waiting' : 'Advisory preview';
    taskStatus.dataset.state = 'idle';
    taskDecisionLog.replaceChildren();
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.textContent = 'Waiting for input frames.';
    row.append(cell);
    taskDecisionLog.append(row);
  }

  function presentTaskBudget(stats: RetrievalStats): void {
    const realtimeRemaining = Math.max(0, stats.budget.realtime.maxFrames - stats.budget.realtime.usedFrames);
    const retrievalRemaining = Math.max(0, stats.budget.retrieval.maxFrames - stats.budget.retrieval.usedFrames);
    taskRealtimeBudget.textContent = `${realtimeRemaining}/${stats.budget.realtime.maxFrames} frames`;
    taskRetrievalBudget.textContent = `${retrievalRemaining}/${stats.budget.retrieval.maxFrames} frames`;
  }

  function presentTaskDecision(decision: DecisionResult): void {
    taskDecisionLatency.textContent = decision.latencyMs.toFixed(3) + ' ms';
    taskStatus.textContent = decision.degraded
      ? 'Fallback used'
      : (taskAwareMode() ? 'Live gate · ' : 'Advisory preview · ') + decision.providerId;
    taskStatus.dataset.state = decision.degraded ? 'error' : 'ok';
    const row = document.createElement('tr');
    row.dataset.degraded = String(decision.degraded);
    const cells = [
      new Date().toLocaleTimeString(),
      decision.action,
      decision.scoreKind,
      decision.latencyMs.toFixed(3) + ' ms',
      decision.degraded ? 'yes' : 'no',
      decision.reason,
    ];
    for (const value of cells) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    taskDecisionLog.prepend(row);
    while (taskDecisionLog.children.length > 8) taskDecisionLog.lastElementChild?.remove();
  }

  function presentRetrieval(): void {
    const { buffer: bufferStats, retrieval: retrievalStats } = session.evidence();
    historyRange.textContent = bufferStats.oldestTimestampMs === null
      ? 'No cached frames'
      : `${formatClock(bufferStats.oldestTimestampMs)}–${formatClock(bufferStats.latestTimestampMs)}`;
    cacheUsage.textContent = `${formatBytes(bufferStats.byteCount)} / ${bufferStats.frameCount} frames`;
    cacheEvictions.textContent = `${bufferStats.evictionCount} (age ${bufferStats.evictedByReason.age}, frames ${bufferStats.evictedByReason.frames}, bytes ${bufferStats.evictedByReason.bytes})`;
    retrievalBudget.textContent = `${retrievalStats.budget.retrieval.usedFrames}/${retrievalStats.budget.retrieval.maxFrames} ret · `
      + `${retrievalStats.budget.total.usedFrames}/${retrievalStats.budget.total.maxFrames} total`;
    renderRetrievalLog(retrievalStats);
    presentTaskBudget(retrievalStats);
  }

  function renderRetrievalLog(stats: RetrievalStats): void {
    if (stats.requests === lastRenderedRequestCount) return;
    lastRenderedRequestCount = stats.requests;
    retrievalLogBody.replaceChildren();
    if (!stats.log.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 6;
      cell.textContent = 'No retrieval requests yet.';
      row.append(cell);
      retrievalLogBody.append(row);
      return;
    }
    const methods: Record<string, string> = {
      getLatestFrame: 'latest',
      getFrameBySequence: 'sequence',
      getFrameAtTimestamp: 'timestamp',
      getFramesBetween: 'range',
      getRegion: 'region',
    };
    for (const entry of [...stats.log].slice(-8).reverse()) {
      const row = document.createElement('tr');
      row.dataset.status = entry.status;
      row.title = entry.message;
      const cells = [
        entry.requestId.replace('retrieval-', '#'),
        methods[entry.method] ?? entry.method,
        entry.status,
        String(entry.frameCount),
        formatBytes(entry.bytes),
        entry.latencyMs.toFixed(2) + ' ms',
      ];
      for (const value of cells) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      retrievalLogBody.append(row);
    }
  }

  function applyFrameResponse(response: RetrievalResponse, entry: TimelineEntry): void {
    if (response.status === 'available' && 'frame' in response && response.frame) {
      lastRetrievedFrame = response.frame;
      drawPixels(retrievedCanvas, response.frame.pixels, response.frame.width, response.frame.height);
      const sent = entry.adaptive === 'sent' || entry.fixed === 'sent';
      retrievedMeta.textContent = `Frame #${String(response.frame.sequence).padStart(4, '0')} · `
        + `${response.frame.mediaTimeMs === null ? 't+' + (response.frame.timestampMs / 1_000).toFixed(2) + ' s' : 'media ' + formatClock(response.frame.mediaTimeMs)} · `
        + `${formatBytes(response.bytes)} · ${sent ? 'already sent' : 'not sent by either sampler'}`;
      clearCanvas(regionCanvas);
      regionMeta.textContent = 'Click the retrieved frame to crop a 24×16 pixel region.';
      setRetrievalStatus(`Retrieved frame #${response.frame.sequence}`, 'ok');
      return;
    }
    lastRetrievedFrame = null;
    clearCanvas(retrievedCanvas);
    retrievedMeta.textContent = `${response.status}: ${response.message} · available ${rangeText(response.availableRange)}`;
    clearCanvas(regionCanvas);
    regionMeta.textContent = 'No source frame for a crop.';
    setRetrievalStatus(`${response.status} · available ${rangeText(response.availableRange)}`, 'error');
  }

  function handleTimelineClick(event: MouseEvent): void {
    const index = timelineEntryIndexAt(timelineCanvas, event.clientX);
    if (index === null) return;
    const entry = displayedTimeline[index];
    if (!entry) return;
    const response = session.retrieveFrame(entry.sequence);
    applyFrameResponse(response, entry);
    presentRetrieval();
  }

  function handleRetrievedClick(event: MouseEvent): void {
    if (!lastRetrievedFrame) {
      setRetrievalStatus('Request a frame from the timeline first.', 'error');
      return;
    }
    const frame = lastRetrievedFrame;
    const rect = retrievedCanvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const pixelX = Math.floor(((event.clientX - rect.left) / rect.width) * frame.width);
    const pixelY = Math.floor(((event.clientY - rect.top) / rect.height) * frame.height);
    const width = Math.min(REGION_WIDTH, frame.width);
    const height = Math.min(REGION_HEIGHT, frame.height);
    const x = Math.max(0, Math.min(frame.width - width, pixelX - Math.floor(width / 2)));
    const y = Math.max(0, Math.min(frame.height - height, pixelY - Math.floor(height / 2)));
    const response = session.retrieveRegion(frame.sequence, { x, y, width, height });
    if (response.status === 'available' && response.image) {
      drawPixels(regionCanvas, response.image.pixels, response.image.width, response.image.height);
      regionMeta.textContent = `x ${x}, y ${y} · ${response.image.width}×${response.image.height} · ${formatBytes(response.bytes)} · ${response.latencyMs.toFixed(2)} ms`;
      setRetrievalStatus(`Region crop from frame #${frame.sequence}`, 'ok');
    } else {
      clearCanvas(regionCanvas);
      regionMeta.textContent = `${response.status}: ${response.message}`;
      setRetrievalStatus(`Region request failed · ${response.status}`, 'error');
    }
    presentRetrieval();
  }

  function presentAgentFrame(): void {
    const frame = agents[mode].latest();
    presentFrame(agentSequence, agentTime, frame);
    agentPhase.textContent = frame?.phase ?? '—';
  }

  function updateAgentView(): void {
    const adaptive = mode === 'adaptive';
    adaptiveCanvas.hidden = !adaptive;
    fixedCanvas.hidden = adaptive;
    agentMode.textContent = adaptive ? 'Adaptive · ' + adaptiveStrategyLabel(currentAdaptiveStrategy()) : 'Fixed';
    metrics.adaptive.row.dataset.active = String(adaptive);
    metrics.fixed.row.dataset.active = String(!adaptive);
    presentAgentFrame();
  }

  function resetSession(): void {
    session.dispose();
    agents = createAgents();
    session = createSession();
    lastDisplayAt = -Infinity;
    resetTaskPreview();
    clearRetrievalView();
    updateAgentView();
    presentSnapshot(session);
  }

  function setSourceModeUi(): void {
    const videoMode = sourceKind === 'video';
    videoControls.hidden = !videoMode;
    useDemo.hidden = !videoMode;
    restartLabel.textContent = videoMode ? 'Restart video' : 'Restart demo';
    if (!videoMode) {
      sourceStatus.textContent = 'Built-in procedural demo · processed locally';
      sourceStatus.dataset.state = 'demo';
      videoCapture.textContent = '—';
    }
  }

  function applyVideoStatus(status: VideoSourceStatus): void {
    lastVideoStatus = status;
    if (sourceStatus.textContent !== status.message) sourceStatus.textContent = status.message;
    sourceStatus.dataset.state = status.state;
    videoCapture.textContent = status.captureMode === 'requestVideoFrameCallback'
      ? 'Frame callback'
      : 'Animation fallback';

    const duration = status.durationMs;
    const media = status.mediaTimeMs ?? 0;
    const hasDuration = duration !== null && duration > 0;
    videoSeek.disabled = !hasDuration || status.state === 'loading' || status.state === 'error';
    videoSeek.max = hasDuration ? String(duration / 1_000) : '0';
    if (!draggingSeek) {
      videoSeek.value = String(media / 1_000);
      presentVideoTime(videoTime, media, duration);
    }
    videoPlay.disabled = status.state === 'idle' || status.state === 'loading' || status.state === 'error';
    videoPlay.textContent = status.state === 'playing' ? 'Pause' : status.state === 'ended' ? 'Replay' : 'Play';
    videoPlay.setAttribute('aria-label', status.state === 'playing' ? 'Pause video' : 'Play video');
    videoRestart.disabled = status.fileName === null || status.state === 'loading' || status.state === 'error';
    if (status.state === 'error') showVideoError(status.message);
  }

  function showVideoError(message: string): void {
    videoError.textContent = message;
    videoError.hidden = false;
  }

  function hideVideoError(): void {
    videoError.textContent = '';
    videoError.hidden = true;
  }

  function handleVideoReset(reason: VideoResetReason): void {
    resetSession();
    sourcePhase.textContent = 'Video';
    sourceSequence.textContent = reason === 'seek'
      ? 'Seeking video'
      : reason === 'restart' ? 'Restarting video' : 'Loading video';
    sourceTime.textContent = '—';
    sourceTimestamp.textContent = '—';
  }

  function openVideo(file: File): void {
    hideVideoError();
    if (sourceKind !== 'video') {
      proceduralSource?.stop();
      proceduralSource = undefined;
      sourceKind = 'video';
      sourcePhase.textContent = 'Video';
      sourceSequence.textContent = 'Loading video';
      sourceTime.textContent = '—';
      sourceTimestamp.textContent = '—';
      setSourceModeUi();
      if (!videoSource) {
        videoSource = new VideoSource(videoElement, sourceCanvas, {
          callbacks: {
            onStatus: applyVideoStatus,
            onSessionReset: handleVideoReset,
            onError: showVideoError,
          },
        });
        videoSource.start(onFrame);
      }
    }
    sourceStatus.textContent = 'Preparing local video…';
    sourceStatus.dataset.state = 'loading';
    videoSource?.load(file);
  }

  function restartDemo(): void {
    hideVideoError();
    proceduralSource?.stop();
    proceduralSource = new ProceduralSource(sourceCanvas);
    resetSession();
    sourcePhase.textContent = 'Waiting';
    presentFrame(sourceSequence, sourceTime);
    sourceTimestamp.textContent = '—';
    proceduralSource.start(onFrame);
  }

  function returnToDemo(): void {
    if (sourceKind === 'demo') return;
    videoSource?.dispose();
    videoSource = undefined;
    sourceKind = 'demo';
    hideVideoError();
    setSourceModeUi();
    restartLabel.textContent = 'Restart demo';
    resetSession();
    sourcePhase.textContent = 'Waiting';
    presentFrame(sourceSequence, sourceTime);
    sourceTimestamp.textContent = '—';
    proceduralSource = new ProceduralSource(sourceCanvas);
    proceduralSource.start(onFrame);
  }

  function restartCurrent(): void {
    if (sourceKind === 'video') {
      videoSource?.restart();
      return;
    }
    restartDemo();
  }

  function onFrame(frame: StreamFrame<VisualFrame>): void {
    const { payload } = frame;
    const { decisions, decision } = session.process(frame, thumbnail.read(payload.canvas), {
      mediaTimeMs: payload.mediaTimeMs, phase: payload.phase,
    });
    void decision.catch((error: unknown) => console.error('Could not evaluate task observation.', error));
    if (sourcePhase.textContent !== payload.phase) sourcePhase.textContent = payload.phase;
    const metadata: FrameMetadata = {
      sequence: frame.sequence,
      timestampMs: frame.timestampMs,
      elapsedMs: payload.elapsedMs,
      mediaTimeMs: payload.mediaTimeMs,
      sessionElapsedMs: payload.sessionElapsedMs,
      phase: payload.phase,
    };
    presentFrame(sourceSequence, sourceTime, metadata);
    sourceTimestamp.textContent = 't+' + (frame.timestampMs / 1_000).toFixed(2) + ' s';
    if (decisions[mode] === 'sent') {
      presentAgentFrame();
    }

    if (frame.timestampMs - lastDisplayAt >= DISPLAY_INTERVAL_MS) {
      lastDisplayAt = frame.timestampMs;
      presentSnapshot(session);
    }
  }

  function applyThreshold(): void {
    session.setThreshold(threshold.valueAsNumber);
    thresholdValue.value = threshold.valueAsNumber.toFixed(1) + '%';
    threshold.setAttribute('aria-valuetext', thresholdValue.value);
  }

  function applyBudget(): void {
    session.setBudget(budget.valueAsNumber);
    const frames = budget.value + (budget.valueAsNumber === 1 ? ' frame' : ' frames');
    budgetValue.value = frames + ' / 5 s';
    budget.setAttribute('aria-valuetext', frames + ' per 5 seconds');
  }

  function applyLocalThreshold(): void {
    session.setLocalThreshold(localThreshold.valueAsNumber);
    localThresholdValue.value = localThreshold.valueAsNumber.toFixed(1) + '%';
    localThreshold.setAttribute('aria-valuetext', localThresholdValue.value);
  }

  function applyBlockSize(): void {
    const size = Number(blockSize.value);
    session.setBlockSize(size, size);
  }

  function syncStrategyControls(): void {
    const strategy = currentAdaptiveStrategy();
    threshold.disabled = strategy === 'local' || strategy === 'task';
    localThreshold.disabled = strategy === 'global' || strategy === 'task';
    blockSize.disabled = strategy === 'global' || strategy === 'task';
    if (taskStatus.dataset.state !== 'error') {
      taskStatus.textContent = taskAwareMode() ? 'Live gate · waiting' : 'Advisory preview';
      taskStatus.dataset.state = 'idle';
    }
  }

  for (const radio of [adaptiveRadio, fixedRadio]) {
    radio.addEventListener('change', () => {
      mode = fixedRadio.checked ? 'fixed' : 'adaptive';
      updateAgentView();
    });
  }

  threshold.addEventListener('input', applyThreshold);
  budget.addEventListener('input', applyBudget);
  localThreshold.addEventListener('input', applyLocalThreshold);
  blockSize.addEventListener('change', applyBlockSize);
  adaptiveStrategySelect.addEventListener('change', () => {
    session.setAdaptiveStrategy(currentAdaptiveStrategy());
    resetTaskPreview();
    syncStrategyControls();
    updateAgentView();
  });
  restartButton.addEventListener('click', restartCurrent);
  useDemo.addEventListener('click', returnToDemo);

  timelineCanvas.addEventListener('click', handleTimelineClick);
  retrievedCanvas.addEventListener('click', handleRetrievedClick);

  chooseVideo.addEventListener('click', () => videoFile.click());

  videoFile.addEventListener('change', () => {
    const file = videoFile.files?.[0];
    videoFile.value = '';
    if (!file) return;
    const problem = videoFileProblem(videoElement, file);
    if (problem) {
      showVideoError(problem);
      return;
    }
    openVideo(file);
  });

  videoPlay.addEventListener('click', () => {
    if (!videoSource) return;
    if (videoSource.currentState === 'playing') videoSource.pause();
    else void videoSource.play();
  });

  videoRestart.addEventListener('click', () => videoSource?.restart());

  videoSeek.addEventListener('input', () => {
    draggingSeek = true;
    const media = Number(videoSeek.value) * 1_000;
    presentVideoTime(videoTime, media, lastVideoStatus?.durationMs ?? null);
  });

  videoSeek.addEventListener('change', () => {
    draggingSeek = false;
    if (!videoSource) return;
    videoSource.seekTo(Number(videoSeek.value));
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (sourceKind === 'video') videoSource?.resumeCapture();
    else proceduralSource?.start(onFrame);
  });

  window.addEventListener('pagehide', (event) => {
    proceduralSource?.stop();
    if (videoSource) {
      videoWasPlaying = videoSource.isPlaying;
      videoSource.stop();
      if (!event.persisted) videoSource.dispose();
    }
    if (event.persisted) session.invalidateDecisions();
    else {
      session.dispose();
      if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
    }
  });

  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    if (sourceKind === 'video') {
      videoSource?.start(onFrame);
      if (videoWasPlaying) void videoSource?.play();
    } else {
      proceduralSource?.start(onFrame);
    }
  });

  function renderBenchmark(report: BenchmarkReport): void {
    const evaluation = report.suites.evaluation;
    const byStrategy = new Map(evaluation.aggregates.map((aggregate) => [aggregate.strategy, aggregate]));
    benchmarkBody.replaceChildren();
    for (const strategy of report.configuration.strategies) {
      const aggregate = byStrategy.get(strategy.id);
      if (!aggregate) continue;
      const row = document.createElement('tr');
      row.dataset.strategy = strategy.id;
      const labels = ['Strategy', 'Sent', 'Recall', 'Missed', 'First capture', 'Mean processing', 'Budget violations'];
      const values = [
        strategy.label,
        aggregate.sent.toLocaleString('en'),
        `${(100 * aggregate.recall).toFixed(1)}% (${aggregate.capturedEvents}/${aggregate.observableEvents})`,
        aggregate.missedEvents.toLocaleString('en'),
        aggregate.meanFirstCaptureLatencyMs === null ? '—' : aggregate.meanFirstCaptureLatencyMs.toFixed(1) + ' ms',
        aggregate.meanProcessingMs.toFixed(3) + ' ms',
        aggregate.budgetViolations.toLocaleString('en'),
      ];
      values.forEach((value, index) => {
        const cell = index === 0 ? document.createElement('th') : document.createElement('td');
        if (index === 0 && cell instanceof HTMLTableCellElement) cell.scope = 'row';
        cell.dataset.label = labels[index];
        cell.textContent = value;
        row.append(cell);
      });
      benchmarkBody.append(row);
    }

    benchmarkStatus.textContent = `${evaluation.scenes.length} held-out scenes · ${report.configuration.frameLimit} frames / 5 s`;
    benchmarkNote.textContent = `Selected on the tuning suite: local ${report.selection.local.threshold}% / `
      + `${report.selection.local.blockWidth}×${report.selection.local.blockHeight} block. `
      + 'Recall is frame capture inside a labeled window, not model understanding.';
    const missedByStrategy = new Map<string, number>();
    for (const failure of report.failureCases) {
      if (failure.suite !== 'evaluation') continue;
      missedByStrategy.set(failure.strategy, (missedByStrategy.get(failure.strategy) ?? 0) + 1);
    }
    const missedText = report.configuration.strategies
      .map((strategy) => `${strategy.label}: ${missedByStrategy.get(strategy.id) ?? 0}`)
      .join(' · ');
    const unobservable = evaluation.aggregates[0]?.unobservableEvents ?? 0;
    benchmarkFailureNote.textContent = `Held-out observable misses — ${missedText}. `
      + `${unobservable} labeled event${unobservable === 1 ? '' : 's'} fell inside capture gaps and are excluded from recall. `
      + 'Full failure cases are in benchmarks/results/latest.md.';
  }

  async function loadBenchmark(): Promise<void> {
    try {
      const response = await fetch(import.meta.env.BASE_URL + 'benchmark/latest.json', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`Benchmark request returned ${response.status}.`);
      renderBenchmark(await response.json() as BenchmarkReport);
    } catch (error) {
      benchmarkStatus.textContent = 'Unavailable';
      benchmarkBody.replaceChildren();
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 7;
      cell.textContent = 'Benchmark results are not available. Run npm run benchmark.';
      row.append(cell);
      benchmarkBody.append(row);
      benchmarkNote.textContent = 'The live sampler still works; benchmark data is a generated static artifact.';
      console.error('Could not load benchmark results.', error);
    }
  }

  function renderPhase2Benchmark(report: Phase2Report): void {
    const evaluation = report.suites.evaluation;
    const byStrategy = new Map(evaluation.aggregates.map((aggregate) => [aggregate.strategy, aggregate]));
    phase2BenchmarkBody.replaceChildren();
    for (const strategy of report.configuration.strategies) {
      const aggregate = byStrategy.get(strategy.id);
      if (!aggregate) continue;
      const row = document.createElement('tr');
      if (aggregate.oracle) row.dataset.strategy = 'oracle';
      const labels = ['Strategy', 'Realtime recall', 'Post-retrieval', 'Retrieval frames', 'Total sent', 'Cache peak', 'Violations (rt/ret/total)'];
      const values = [
        strategy.label,
        `${(100 * aggregate.realtimeRecall).toFixed(1)}% (${aggregate.realtimeCapturedEvents}/${aggregate.observableEvents})`,
        `${(100 * aggregate.postRetrievalRecall).toFixed(1)}% (${aggregate.postCapturedEvents}/${aggregate.observableEvents})`,
        `${aggregate.retrievalFrames} · ${formatBytes(aggregate.retrievalBytes)}`,
        `${aggregate.totalSent} · ${formatBytes(aggregate.totalBytes)}`,
        `${formatBytes(aggregate.peakCacheBytes)} / ${aggregate.peakCacheFrames} frames`,
        `${aggregate.realtimeBudgetViolations}/${aggregate.retrievalBudgetViolations}/${aggregate.totalBudgetViolations}`,
      ];
      values.forEach((value, index) => {
        const cell = index === 0 ? document.createElement('th') : document.createElement('td');
        if (index === 0 && cell instanceof HTMLTableCellElement) cell.scope = 'row';
        cell.dataset.label = labels[index];
        cell.textContent = value;
        row.append(cell);
      });
      phase2BenchmarkBody.append(row);
    }
    phase2BenchmarkStatus.textContent = `${evaluation.scenes.length} held-out scenes · corrected replay · cue ${report.cueSelection.intervalMs} ms`;
    phase2BenchmarkNote.textContent = `C uses real-time budget-denial cues only. The oracle row uses event labels, is an upper bound, not autonomous discovery, and bypasses the production retrieval budget. `
      + `Cache peak and evictions are measured over the same replay.`;
  }

  async function loadPhase2Benchmark(): Promise<void> {
    try {
      const response = await fetch(import.meta.env.BASE_URL + 'benchmark/phase2-corrected.json', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`Phase 2 benchmark request returned ${response.status}.`);
      renderPhase2Benchmark(await response.json() as Phase2Report);
    } catch (error) {
      phase2BenchmarkStatus.textContent = 'Unavailable';
      phase2BenchmarkBody.replaceChildren();
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 7;
      cell.textContent = 'Phase 2 benchmark results are not available. Run npm run benchmark.';
      row.append(cell);
      phase2BenchmarkBody.append(row);
      phase2BenchmarkNote.textContent = 'The live retrieval demo still works; benchmark data is a generated static artifact.';
      console.error('Could not load Phase 2 benchmark results.', error);
    }
  }

  function renderPhase3Benchmark(report: TaskReport): void {
    const evaluation = report.suites.evaluation;
    phase3BenchmarkBody.replaceChildren();
    for (const aggregate of evaluation.aggregates) {
      const row = document.createElement('tr');
      const labels = ['Strategy', 'Realtime', 'Post-retrieval', 'ROI realtime', 'ROI post', 'Retrieval', 'Total sent', 'Cache peak', 'Violations', 'Decision / fallback'];
      const values = [
        aggregate.strategyLabel,
        `${(100 * aggregate.realtimeRecall).toFixed(1)}% (${aggregate.realtimeCapturedEvents}/${aggregate.observableEvents})`,
        `${(100 * aggregate.postRetrievalRecall).toFixed(1)}% (${aggregate.postCapturedEvents}/${aggregate.observableEvents})`,
        `${(100 * aggregate.roiRealtimeRecall).toFixed(1)}% (${aggregate.roiRealtimeCapturedEvents}/${aggregate.roiObservableEvents})`,
        `${(100 * aggregate.roiPostRetrievalRecall).toFixed(1)}% (${aggregate.roiPostCapturedEvents}/${aggregate.roiObservableEvents})`,
        `${aggregate.retrievalFrames} · ${formatBytes(aggregate.retrievalBytes)}`,
        `${aggregate.totalSent} · ${formatBytes(aggregate.totalBytes)}`,
        `${formatBytes(aggregate.peakCacheBytes)} / ${aggregate.peakCacheFrames} frames`,
        `${aggregate.realtimeBudgetViolations}/${aggregate.retrievalBudgetViolations}/${aggregate.totalBudgetViolations}`,
        aggregate.decisionLatencyMeanMs === null
          ? '—'
          : `${aggregate.decisionLatencyMeanMs.toFixed(3)} ms · ${aggregate.decisionFallbacks} fallback`,
      ];
      values.forEach((value, index) => {
        const cell = index === 0 ? document.createElement('th') : document.createElement('td');
        if (index === 0 && cell instanceof HTMLTableCellElement) cell.scope = 'row';
        cell.dataset.label = labels[index];
        cell.textContent = value;
        row.append(cell);
      });
      phase3BenchmarkBody.append(row);
    }
    phase3BenchmarkStatus.textContent = `${evaluation.scenes.length} held-out scenes · corrected replay · task ROI predeclared`;
    phase3BenchmarkNote.textContent = 'Task ROI is authored per scene and is not generated from evaluator labels. D uses heuristic rule scores, not calibrated probabilities. '
      + 'The result is a comparison, not a promise that the task-aware policy wins.';
  }

  async function loadPhase3Benchmark(): Promise<void> {
    try {
      const response = await fetch(import.meta.env.BASE_URL + 'benchmark/phase3a-corrected.json', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`Phase 3 benchmark request returned ${response.status}.`);
      renderPhase3Benchmark(await response.json() as TaskReport);
    } catch (error) {
      phase3BenchmarkStatus.textContent = 'Unavailable';
      phase3BenchmarkBody.replaceChildren();
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 10;
      cell.textContent = 'Phase 3A benchmark results are not available. Run npm run benchmark.';
      row.append(cell);
      phase3BenchmarkBody.append(row);
      phase3BenchmarkNote.textContent = 'The live decision preview still works; benchmark data is a generated static artifact.';
      console.error('Could not load Phase 3A benchmark results.', error);
    }
  }

  taskSelect.addEventListener('change', () => selectTaskPreset(taskSelect.value));
  for (const input of [roiX, roiY, roiW, roiH]) {
    input.addEventListener('change', clampTaskRoi);
  }

  applyThreshold();
  applyBudget();
  applyLocalThreshold();
  applyBlockSize();
  syncStrategyControls();
  selectTaskPreset('read-status');
  updateAgentView();
  setSourceModeUi();
  presentSnapshot(session);
  proceduralSource = new ProceduralSource(sourceCanvas);
  proceduralSource.start(onFrame);

  refreshTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible') presentSnapshot(session);
  }, REFRESH_INTERVAL_MS);

  void loadBenchmark();
  void loadPhase2Benchmark();
  void loadPhase3Benchmark();
}

try {
  runDemo();
} catch (error) {
  const status = element('stream-status');
  status.textContent = 'Stream unavailable';
  status.dataset.error = 'true';
  throw error;
}
