import './style.css';
import { SamplingSession, TIMELINE_CAPACITY } from './app/sampling-session';
import type { SamplingMode, SessionSnapshot } from './app/sampling-session';
import type { AdaptiveStrategy } from './core/local-change';
import type { MetricsSnapshot } from './core/metrics';
import type { StreamFrame } from './core/stream';
import type { BenchmarkReport } from './benchmark/types';
import { formatClock, formatRate } from './ui/format';
import { drawDecisionTimeline } from './ui/timeline-view';
import type { FrameMetadata } from './visual/mock-agent';
import { ProceduralSource } from './visual/source';
import type { VisualFrame } from './visual/source';
import { VideoSource, videoFileProblem } from './visual/video-source';
import type { VideoResetReason, VideoSourceStatus } from './visual/video-source';

const DISPLAY_INTERVAL_MS = 100;
const REFRESH_INTERVAL_MS = 500;

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

  function currentAdaptiveStrategy(): AdaptiveStrategy {
    const value = adaptiveStrategySelect.value;
    return value === 'local' || value === 'hybrid' ? value : 'global';
  }

  function adaptiveStrategyLabel(strategy: AdaptiveStrategy): string {
    return strategy === 'global' ? 'Global' : strategy === 'local' ? 'Local' : 'Hybrid';
  }

  function createSession(): SamplingSession {
    return new SamplingSession(adaptiveCanvas, fixedCanvas, {
      threshold: threshold.valueAsNumber,
      budget: budget.valueAsNumber,
      adaptiveStrategy: currentAdaptiveStrategy(),
      localThreshold: localThreshold.valueAsNumber,
      blockWidth: Number(blockSize.value),
      blockHeight: Number(blockSize.value),
    });
  }

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

  function presentSnapshot(target: SamplingSession = session): void {
    const snapshot = target.snapshot();
    presentMetrics(metrics.adaptive, snapshot.adaptive, snapshot.rates.input, snapshot.rates.adaptiveSent);
    presentMetrics(metrics.fixed, snapshot.fixed, snapshot.rates.input, snapshot.rates.fixedSent);
    presentSentDelta(snapshot);
    drawDecisionTimeline(timelineCanvas, target.timeline.toArray());
    timelineCount.textContent = `${target.timeline.size} / ${TIMELINE_CAPACITY} latest input frames kept`;
  }

  function presentAgentFrame(): void {
    const frame = session.latest(mode);
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
    session = createSession();
    lastDisplayAt = -Infinity;
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
    const decisions = session.process(frame);
    const { payload } = frame;
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
    if (decisions[mode] === 'sent') presentAgentFrame();

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
    threshold.disabled = strategy === 'local';
    localThreshold.disabled = strategy === 'global';
    blockSize.disabled = strategy === 'global';
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
    syncStrategyControls();
    updateAgentView();
  });
  restartButton.addEventListener('click', restartCurrent);
  useDemo.addEventListener('click', returnToDemo);

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
    if (!event.persisted && refreshTimer !== undefined) window.clearInterval(refreshTimer);
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

  applyThreshold();
  applyBudget();
  applyLocalThreshold();
  applyBlockSize();
  syncStrategyControls();
  updateAgentView();
  setSourceModeUi();
  presentSnapshot(session);
  proceduralSource = new ProceduralSource(sourceCanvas);
  proceduralSource.start(onFrame);

  refreshTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible') presentSnapshot(session);
  }, REFRESH_INTERVAL_MS);

  void loadBenchmark();
}

try {
  runDemo();
} catch (error) {
  const status = element('stream-status');
  status.textContent = 'Stream unavailable';
  status.dataset.error = 'true';
  throw error;
}
