import './style.css';
import { BudgetController } from './core/budget';
import type { MetricsSnapshot } from './core/metrics';
import { AdaptiveSamplingPolicy, FixedSamplingPolicy } from './core/sampling';
import { Sampler } from './core/sampler';
import type { StreamFrame } from './core/stream';
import { ThumbnailReader } from './visual/canvas';
import { MockAgent } from './visual/mock-agent';
import type { FrameMetadata } from './visual/mock-agent';
import { ProceduralSource } from './visual/source';
import type { VisualFrame } from './visual/source';

const BUDGET_WINDOW_MS = 5_000;
const DELIVERY_TIMING = { minimumIntervalMs: 125, maximumSilenceMs: 1_500 };
const DISPLAY_INTERVAL_MS = 100;

type Mode = 'adaptive' | 'fixed';

function element<T extends HTMLElement>(id: string): T {
  const result = document.getElementById(id);
  if (!result) throw new Error('Missing page element: ' + id);
  return result as T;
}

function metricsView(mode: Mode) {
  return {
    row: element('metrics-' + mode),
    inputs: element(mode + '-inputs'),
    sent: element(mode + '-sent'),
    filtered: element(mode + '-filtered'),
    latency: element(mode + '-latency'),
  };
}

function presentMetrics(view: ReturnType<typeof metricsView>, snapshot: MetricsSnapshot): void {
  view.inputs.textContent = snapshot.inputs.toLocaleString('en');
  view.sent.textContent = snapshot.sent.toLocaleString('en');
  view.filtered.textContent = snapshot.inputs ? snapshot.filteredPercent.toFixed(1) + '%' : '—';
  view.latency.textContent = snapshot.inputs ? snapshot.meanProcessingMs.toFixed(2) + ' ms' : '—';
}

function presentFrame(sequence: HTMLElement, time: HTMLElement, frame?: FrameMetadata): void {
  sequence.textContent = frame ? 'Frame ' + String(frame.sequence).padStart(4, '0') : 'No frame yet';
  time.textContent = frame ? (frame.elapsedMs / 1_000).toFixed(2) + ' s' : '—';
}

function runDemo(): void {
  const sourceCanvas = element<HTMLCanvasElement>('source-canvas');
  const adaptiveCanvas = element<HTMLCanvasElement>('agent-adaptive');
  const fixedCanvas = element<HTMLCanvasElement>('agent-fixed');
  const adaptiveRadio = element<HTMLInputElement>('mode-adaptive');
  const fixedRadio = element<HTMLInputElement>('mode-fixed');
  const threshold = element<HTMLInputElement>('threshold');
  const thresholdValue = element<HTMLOutputElement>('threshold-value');
  const budget = element<HTMLInputElement>('budget');
  const budgetValue = element<HTMLOutputElement>('budget-value');
  const sourcePhase = element('source-phase');
  const sourceSequence = element('source-sequence');
  const sourceTime = element('source-time');
  const agentMode = element('agent-mode');
  const agentSequence = element('agent-sequence');
  const agentTime = element('agent-time');
  const agentPhase = element('agent-phase');
  const metrics = { adaptive: metricsView('adaptive'), fixed: metricsView('fixed') };
  const thumbnail = new ThumbnailReader();

  function createSession() {
    const source = new ProceduralSource(sourceCanvas);
    const adaptive = new MockAgent(adaptiveCanvas);
    const fixed = new MockAgent(fixedCanvas);
    const adaptivePolicy = new AdaptiveSamplingPolicy(threshold.valueAsNumber);
    const adaptiveBudget = new BudgetController(BUDGET_WINDOW_MS, budget.valueAsNumber);
    const fixedBudget = new BudgetController(BUDGET_WINDOW_MS, budget.valueAsNumber);
    return {
      source,
      adaptivePolicy,
      adaptiveBudget,
      fixedBudget,
      agents: { adaptive, fixed },
      samplers: {
        adaptive: new Sampler(adaptivePolicy, adaptiveBudget, DELIVERY_TIMING, adaptive),
        fixed: new Sampler(new FixedSamplingPolicy(250), fixedBudget, DELIVERY_TIMING, fixed),
      },
    };
  }

  let mode: Mode = fixedRadio.checked ? 'fixed' : 'adaptive';
  let session = createSession();
  let lastDisplayAt = -Infinity;

  function presentAgentFrame(): void {
    const frame = session.agents[mode].latest();
    presentFrame(agentSequence, agentTime, frame);
    agentPhase.textContent = frame?.phase ?? '—';
  }

  function updateAgentView(): void {
    const adaptive = mode === 'adaptive';
    adaptiveCanvas.hidden = !adaptive;
    fixedCanvas.hidden = adaptive;
    agentMode.textContent = adaptive ? 'Adaptive' : 'Fixed';
    metrics.adaptive.row.dataset.active = String(adaptive);
    metrics.fixed.row.dataset.active = String(!adaptive);
    presentAgentFrame();
  }

  function onFrame(frame: StreamFrame<VisualFrame>): void {
    const pixels = thumbnail.read(frame.payload.canvas);
    const preparationMs = performance.now() - frame.timestampMs;
    const adaptiveDecision = session.samplers.adaptive.process(frame, pixels, preparationMs);
    const fixedDecision = session.samplers.fixed.process(frame, pixels, preparationMs);

    const { elapsedMs, phase } = frame.payload;
    if (sourcePhase.textContent !== phase) sourcePhase.textContent = phase;
    presentFrame(sourceSequence, sourceTime, { sequence: frame.sequence, elapsedMs, phase });
    if ((mode === 'adaptive' ? adaptiveDecision : fixedDecision) === 'sent') presentAgentFrame();

    if (frame.timestampMs - lastDisplayAt >= DISPLAY_INTERVAL_MS) {
      lastDisplayAt = frame.timestampMs;
      presentMetrics(metrics.adaptive, session.samplers.adaptive.snapshot());
      presentMetrics(metrics.fixed, session.samplers.fixed.snapshot());
    }
  }

  for (const radio of [adaptiveRadio, fixedRadio]) {
    radio.addEventListener('change', () => {
      mode = fixedRadio.checked ? 'fixed' : 'adaptive';
      updateAgentView();
    });
  }

  function applyThreshold(): void {
    session.adaptivePolicy.setThreshold(threshold.valueAsNumber);
    thresholdValue.value = threshold.valueAsNumber.toFixed(1) + '%';
    threshold.setAttribute('aria-valuetext', thresholdValue.value);
  }

  function applyBudget(): void {
    session.adaptiveBudget.setLimit(budget.valueAsNumber);
    session.fixedBudget.setLimit(budget.valueAsNumber);
    const frames = budget.value + (budget.valueAsNumber === 1 ? ' frame' : ' frames');
    budgetValue.value = frames + ' / 5 s';
    budget.setAttribute('aria-valuetext', frames + ' per 5 seconds');
  }

  threshold.addEventListener('input', applyThreshold);
  budget.addEventListener('input', applyBudget);

  element<HTMLButtonElement>('restart').addEventListener('click', () => {
    session.source.stop();
    session = createSession();
    lastDisplayAt = -Infinity;
    sourcePhase.textContent = 'Waiting';
    presentFrame(sourceSequence, sourceTime);
    updateAgentView();
    presentMetrics(metrics.adaptive, session.samplers.adaptive.snapshot());
    presentMetrics(metrics.fixed, session.samplers.fixed.snapshot());
    session.source.start(onFrame);
  });

  window.addEventListener('pagehide', () => session.source.stop());
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) session.source.start(onFrame);
  });

  applyThreshold();
  applyBudget();
  updateAgentView();
  session.source.start(onFrame);
}

try {
  runDemo();
} catch (error) {
  const status = element('stream-status');
  status.textContent = 'Stream unavailable';
  status.dataset.error = 'true';
  throw error;
}
