import './runtime-lab.css';
import { SamplingSession } from './app/sampling-session';
import { SAMPLE_HEIGHT, SAMPLE_WIDTH } from './core/sample';
import type { StreamFrame } from './core/stream';
import { DecisionEngine } from './decision/engine';
import { RuleBasedDecisionProvider } from './decision/rule-provider';
import { GatewayStreamingProvider } from './inference/gateway-provider';
import { BudgetPoller } from './observability/budget-poller';
import { costView, formatUsd, formatUtilization } from './observability/cost';
import type { CostView } from './observability/cost';
import { summarizeRuntime } from './observability/summary';
import { diagnosticCode } from './observability/diagnostics';
import { isCurrentRuntimeSession, runtimeSessionId } from './observability/session';
import { CostGeneration } from './observability/cost-generation';
import { TelemetryHub } from './observability/telemetry';
import type { TelemetryEvent, TelemetrySource } from './observability/types';
import { InferenceScheduler } from './inference/scheduler';
import type { TaskSummary } from './inference/scheduler';
import { ScriptedStreamingProvider } from './inference/scripted-provider';
import { systemClock } from './inference/types';
import type { Evidence, InferenceRequest, StreamEvent } from './inference/types';
import { CameraSource } from './visual/camera-source';
import { context2d, ThumbnailReader } from './visual/canvas';
import { MonitorSource } from './visual/monitor-source';
import { ProceduralSource } from './visual/source';
import type { VisualFrame } from './visual/source';
import { VideoSource, videoFileProblem } from './visual/video-source';

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const feed = element<HTMLCanvasElement>('feed');
const agent = context2d(element<HTMLCanvasElement>('agent'));
const historical = context2d(element<HTMLCanvasElement>('historical'));
const media = element<HTMLVideoElement>('media');
const status = element('source-status');
const mode = element<HTMLSelectElement>('mode');
const behavior = element<HTMLSelectElement>('behavior');
const thumbnail = new ThumbnailReader();
const rules = new RuleBasedDecisionProvider();
const decisionEngine = new DecisionEngine(rules, rules);
const birth = systemClock.now();
let session: SamplingSession<VisualFrame> | undefined;
let sourceVersion = 0;
let monitor: MonitorSource | undefined;
let procedural: ProceduralSource | undefined;
let camera: CameraSource | undefined;
let cameraStartVersion = 0;
let video: VideoSource | undefined;
let pendingScenario: { label: string; critical: boolean } | undefined;
let lastFilterAt = -Infinity;
let latestDecision = 'Awaiting visual decision';
let refresh: number | undefined;
const telemetry = new TelemetryHub(500, 180);
const costFields = {
  state: element('cost-state'), total: element('cost-total'), settled: element('cost-settled'),
  reserved: element('cost-reserved'), provisional: element('cost-provisional'), available: element('cost-available'),
  utilization: element('cost-utilization'), accepted: element('cost-accepted'), quarantined: element('cost-quarantined'),
  frozen: element('cost-frozen'), detail: element('cost-detail'),
};
const telemetryState = element('telemetry-state');
let cost: CostView | null = null;
let costAt: number | null = null;
let costError = '';
const costGeneration = new CostGeneration();
let budgetPoller: BudgetPoller | undefined;
let costTimer: number | undefined;
let lastTelemetryAt = 0;
const seenOutcomes = new Set<string>();
let gateway: GatewayStreamingProvider | undefined;
let lastMonitorEvent: string | undefined;
let gatewayConnectGeneration = 0;

function showPixels(context: CanvasRenderingContext2D, pixels: Uint8ClampedArray, width: number, height: number): void {
  const image = context.createImageData(width, height);
  image.data.set(pixels);
  context.putImageData(image, 0, 0);
}

const provider = new ScriptedStreamingProvider(systemClock, (task) => {
  const received = task.context.evidence.at(-1);
  if (received) showPixels(agent, Uint8ClampedArray.from(atob(received.data), (byte) => byte.charCodeAt(0)),
    SAMPLE_WIDTH, SAMPLE_HEIGHT);
  else agent.clearRect(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  element('agent-status').textContent = 'Task #' + task.id + ' · ' + (received ? 'frame #' + received.sequence : 'text only');
  const opening = task.event.source === 'pixels'
    ? 'Pixel sampler selected a candidate. '
    : task.event.source === 'user' ? 'User asked: “' + task.event.label + '”. ' : task.event.label + '. ';
  return {
    firstTokenMs: behavior.value === 'slow' ? 6_000 : 260,
    intervalMs: task.priority >= 10 ? 450 : 700,
    chunks: [
      opening,
      'Context v' + task.contextVersion + ' contains ' + task.context.evidence.length + ' visual sample(s). ',
      task.event.source === 'scenario' && task.priority >= 10
        ? 'Scripted action: check replica connectivity.' : 'Scripted review finished.',
    ],
    finishAfterMs: behavior.value === 'ignore' ? 800 : 150,
    ignoreCancel: behavior.value === 'ignore',
    unknownUsage: behavior.value === 'ignore',
    fail: behavior.value === 'error',
  };
});
const mockRuntime = new InferenceScheduler(provider, systemClock, {
  slots: 2, queue: 4, tokensPerTask: 128, totalTokens: 12_800,
  transport: { windowMs: 5_000, maxFrames: 16, maxBytes: 1_300_000 },
}, 'context-aware');
let runtime = mockRuntime;

function event(source: StreamEvent['source'], label: string, reason: string,
  request?: InferenceRequest, evidence?: Evidence, capturedAtMs = systemClock.now()): void {
  runtime.ingest({ source, capturedAtMs, label, reason }, request, evidence);
}

function processFrame(frame: StreamFrame<VisualFrame>): void {
  if (!session) return;
  const { canvas, mediaTimeMs, phase } = frame.payload;
  const sample = thumbnail.read(canvas);
  const { decisions, adaptiveSelection } = session.process(frame, sample, { mediaTimeMs, phase });
  const { sequence, timestampMs } = frame;
  const known = pendingScenario;
  if (decisions.adaptive === 'sent') {
    pendingScenario = undefined;
    const evidence: Evidence | undefined = gateway ? undefined : {
      source: monitor ? 'monitor' : camera ? 'camera' : video ? 'video' : 'procedural',
      sequence, capturedAtMs: timestampMs, mediaType: 'application/x-rgba-base64',
      data: btoa(String.fromCharCode(...sample)),
    };
    if (gateway) {
      showPixels(agent, sample, SAMPLE_WIDTH, SAMPLE_HEIGHT);
      element('agent-status').textContent = 'Local frame #' + sequence + ' · real model receives text only';
    }
    const request: InferenceRequest = known?.critical
      ? { channel: 'observation', priority: 10, ttlMs: 4_000, supersede: true }
      : { channel: 'observation', priority: 1, ttlMs: 5_000, dedupeKey: known ? 'monitor-change' : 'pixel-candidate' };
    event(known ? 'scenario' : 'pixels', known?.label ?? 'Frame #' + sequence,
      'Selected by ' + adaptiveSelection + ' · latest proposal: ' + latestDecision,
      gateway ? undefined : request, evidence, timestampMs);
  } else if (timestampMs - lastFilterAt >= 500) {
    lastFilterAt = timestampMs;
    event('pixels', 'Frame #' + sequence, 'Visual filter: ' + decisions.adaptive + ' · latest proposal: ' + latestDecision,
      undefined, undefined, timestampMs);
  }
  element('capture-status').textContent = phase + ' · frame #' + sequence;
}

function resetSampling(): void {
  lastTelemetryAt = 0;
  session?.dispose();
  pendingScenario = undefined;
  lastMonitorEvent = undefined;
  latestDecision = 'Awaiting visual decision';
  lastFilterAt = -Infinity;
  runtime.newSession(
    mode.value === 'serial' || mode.value === 'fifo' ? 'fifo' : 'context-aware',
    mode.value === 'serial' || mode.value === 'aware-serial' ? 1 : (gateway?.capabilities.slots ?? 2),
  );
  agent.clearRect(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  historical.clearRect(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  element('agent-status').textContent = gateway ? 'Real provider receives text only' : 'Awaiting dispatch';
  element('history-status').textContent = '';
  element<HTMLInputElement>('sequence').value = '';
  session = new SamplingSession(
    'lab-' + ++sourceVersion,
    { adaptive: { accept: () => true }, fixed: { accept: () => true } },
    {
      threshold: 2.5, budget: 20, adaptiveStrategy: 'task', localThreshold: 4,
      blockWidth: 8, blockHeight: 8,
      task: { id: 'monitor', label: 'Visual monitoring', category: 'motion-monitoring', priority: 'normal', roi: null },
    },
    decisionEngine,
    (decision) => {
      latestDecision = decision.action + ' · ' + decision.reason;
      telemetry.event(decision.observedAtMs, 'decision', 'decision', telemetrySource(), {
        sessionId: decision.sessionId,
      }, { action: decision.action, degraded: decision.degraded });
    },
    systemClock.now,
  );
}

function stopSource(): void {
  cameraStartVersion += 1;
  monitor?.stop();
  monitor = undefined;
  procedural?.stop();
  procedural = undefined;
  camera?.dispose();
  camera = undefined;
  video?.dispose();
  video = undefined;
  const context = context2d(feed);
  context.clearRect(0, 0, feed.width, feed.height);
  element('capture-status').textContent = '';
  sourceControls();
}

function sourceControls(): void {
  element<HTMLButtonElement>('normal').disabled = !monitor;
  element<HTMLButtonElement>('critical').disabled = !monitor;
  element<HTMLButtonElement>('camera').disabled = Boolean(camera);
  element('stop-camera').hidden = !camera;
  element('video-playback').hidden = !video;
}

function useScene(original = false): void {
  stopSource();
  resetSampling();
  if (original) {
    procedural = new ProceduralSource(feed);
    procedural.start(processFrame);
    status.textContent = 'Procedural scene · local pixel candidates';
  } else {
    monitor = new MonitorSource(feed);
    monitor.start(processFrame);
    status.textContent = 'System monitor · local synthetic scene';
  }
  sourceControls();
}

async function useCamera(): Promise<void> {
  stopSource();
  const startVersion = ++cameraStartVersion;
  resetSampling();
  const source = new CameraSource(media, feed, (message) => {
    useScene();
    status.textContent = message + ' Showing the local system monitor.';
  });
  camera = source;
  sourceControls();
  status.textContent = 'Waiting for camera permission…';
  try {
    await source.start(processFrame);
    if (camera !== source || startVersion !== cameraStartVersion || document.hidden) {
      source.dispose();
      return;
    }
    status.textContent = 'Camera running · video stays in this browser';
  } catch (error) {
    if (camera !== source || startVersion !== cameraStartVersion) return;
    const message = error instanceof DOMException && error.name === 'NotAllowedError'
      ? 'Camera permission denied.' : error instanceof Error ? error.message : 'Camera could not start.';
    useScene();
    status.textContent = message + ' Showing the local system monitor.';
  }
}

function trigger(critical: boolean): void {
  if (!monitor) return;
  const label = critical ? 'Critical anomaly: DB replica offline' : 'Ordinary change: request load updated';
  if (pendingScenario) event('scenario', pendingScenario.label, 'Scene changed again before visual selection');
  monitor.trigger(critical);
  pendingScenario = { label, critical };
  lastMonitorEvent = label;
  if (gateway) {
    event('scenario', label, 'Known synthetic event metadata · user-triggered model request', {
      channel: 'observation', priority: critical ? 10 : 1, ttlMs: gateway.capabilities.timeoutMs,
      supersede: critical, dedupeKey: critical ? undefined : 'monitor-change',
    });
  } else {
    event('scenario', label, 'Known monitor event · awaiting selected evidence');
  }
}

function list(id: string, lines: readonly string[]): void {
  element(id).replaceChildren(...lines.map((line) => {
    const item = document.createElement('li');
    item.textContent = line;
    return item;
  }));
}


function telemetrySource(): TelemetrySource {
  return gateway ? 'real' : 'mock';
}

function telemetrySession(): string {
  return 'lab-' + sourceVersion;
}

function setCostField(element: HTMLElement, value: string, risk = false): void {
  element.textContent = value;
  element.dataset.risk = String(risk);
}

function renderCost(): void {
  if (!gateway) {
    cost = null;
    costAt = null;
    costError = '';
    costFields.state.textContent = 'Unavailable';
    costFields.state.dataset.state = 'idle';
    for (const field of [costFields.total, costFields.settled, costFields.reserved, costFields.provisional,
      costFields.available, costFields.utilization, costFields.accepted, costFields.quarantined, costFields.frozen]) {
      setCostField(field, '—');
    }
    costFields.detail.textContent = 'Cost is unavailable while the Mock provider is active. No unknown real cost is represented as zero.';
    return;
  }
  if (!cost) {
    costFields.state.textContent = 'Fetching';
    costFields.state.dataset.state = 'warn';
    for (const field of [costFields.total, costFields.settled, costFields.reserved, costFields.provisional,
      costFields.available, costFields.utilization, costFields.accepted, costFields.quarantined, costFields.frozen]) {
      setCostField(field, '—');
    }
    costFields.detail.textContent = costError
      ? 'Gateway cost is unavailable. Inference is not blocked by this dashboard query.'
      : 'Fetching configured gateway ledger…';
    return;
  }
  const stale = Boolean(costError);
  costFields.state.textContent = stale ? 'Stale / unavailable' : 'Configured estimate';
  costFields.state.dataset.state = stale ? 'warn' : 'ok';
  setCostField(costFields.total, formatUsd(cost.totalNanoUsd));
  setCostField(costFields.settled, formatUsd(cost.settledNanoUsd));
  setCostField(costFields.reserved, formatUsd(cost.reservedNanoUsd));
  setCostField(costFields.provisional, formatUsd(cost.provisionalNanoUsd));
  setCostField(costFields.available, formatUsd(cost.availableNanoUsd), cost.availableNanoUsd === 0);
  setCostField(costFields.utilization, formatUtilization(cost.utilization), cost.utilization >= 0.8);
  setCostField(costFields.accepted, cost.accepted + ' / ' + cost.requestLimit);
  setCostField(costFields.quarantined, String(cost.quarantined), cost.quarantined > 0);
  const admission = cost.admission;
  const admissionText = admission.canAdmit ? 'open'
    : admission.reasons.map((reason) => reason === 'ledger_frozen' ? 'ledger frozen'
      : reason === 'cost_exhausted' ? 'cost exhausted'
        : reason === 'request_limit' ? 'request limit' : 'slots full').join(' · ');
  setCostField(costFields.frozen, admissionText, !admission.canAdmit);
  const updated = costAt === null ? 'unknown time' : new Date(costAt).toLocaleTimeString();
  costFields.detail.textContent = (stale ? 'Last refresh failed. Showing the last known ledger. ' : '')
    + 'Updated ' + updated + '. This is a configured-price estimate from the gateway ledger, not a vendor invoice.';
  if (!admission.canAdmit) costFields.detail.textContent += ' Admission is blocked: ' + admissionText + '.';
}

async function refreshCost(): Promise<void> {
  if (!gateway || !budgetPoller) {
    renderCost();
    return;
  }
  const generation = costGeneration.current();
  const result = await budgetPoller.poll();
  if (!costGeneration.isCurrent(generation)) return;
  if (result.status === 'updated') {
    try {
      cost = costView(result.budget);
      costAt = result.atMs;
      costError = '';
      telemetry.event(systemClock.now(), 'cost', 'budget_updated', 'real', { sessionId: telemetrySession() }, {
        frozen: cost.frozen, quarantined: cost.quarantined,
      });
      telemetry.gauge(systemClock.now(), 'cost', 'settled_nano_usd', cost.settledNanoUsd, 'nanoUSD', 'real', { sessionId: telemetrySession() });
      telemetry.gauge(systemClock.now(), 'cost', 'available_nano_usd', cost.availableNanoUsd, 'nanoUSD', 'real', { sessionId: telemetrySession() });
      telemetry.gauge(systemClock.now(), 'cost', 'utilization', cost.utilization, 'ratio', 'real', { sessionId: telemetrySession() });
    } catch (error) {
      costError = error instanceof Error ? error.message : 'Invalid ledger payload';
      telemetry.event(systemClock.now(), 'cost', 'budget_invalid', 'unavailable', { sessionId: telemetrySession() });
    }
  } else if (result.status === 'error') {
    costError = result.message;
    telemetry.event(systemClock.now(), 'cost', 'budget_poll_failed', 'unavailable', { sessionId: telemetrySession() });
  }
  renderCost();
  renderObservability();
}

function rememberOutcome(key: string): boolean {
  if (seenOutcomes.has(key)) return false;
  seenOutcomes.add(key);
  if (seenOutcomes.size > 300) seenOutcomes.delete(seenOutcomes.values().next().value!);
  return true;
}

function renderObservability(): void {
  const now = systemClock.now();
  const snapshot = runtime.snapshot();
  const visual = session?.snapshot();
  const evidence = session?.evidence();
  const measurements = runtime.requestMeasurements(snapshot.sessionVersion);
  const summary = summarizeRuntime(measurements);
  const source = telemetrySource();
  const identity = { sessionId: telemetrySession() };
  if (now - lastTelemetryAt >= 1_000 || lastTelemetryAt === 0) {
    lastTelemetryAt = now;
    const fps = visual?.rates;
    if (fps) {
      telemetry.gauge(now, 'runtime', 'input_fps', fps.input, 'fps', source, identity);
      telemetry.gauge(now, 'runtime', 'adaptive_sent_fps', fps.adaptiveSent, 'fps', source, identity);
      telemetry.gauge(now, 'runtime', 'fixed_sent_fps', fps.fixedSent, 'fps', source, identity);
    }
    telemetry.gauge(now, 'scheduler', 'queue_depth', snapshot.queued.length, 'tasks', source, identity);
    telemetry.gauge(now, 'scheduler', 'slots', snapshot.slots, 'slots', source, identity);
    telemetry.gauge(now, 'scheduler', 'settled_tokens', snapshot.budget.settledTokens, 'tokens', source, identity);
    telemetry.gauge(now, 'scheduler', 'unknown_usage', snapshot.budget.unknownUsageCount, 'receipts', source, identity);
    if (evidence) {
      telemetry.gauge(now, 'context', 'cache_bytes', evidence.buffer.byteCount, 'bytes', source, identity);
      telemetry.gauge(now, 'context', 'cache_frames', evidence.buffer.frameCount, 'frames', source, identity);
      telemetry.gauge(now, 'context', 'transfer_frames', evidence.retrieval.budget.total.usedFrames, 'frames', source, identity);
      telemetry.gauge(now, 'context', 'transfer_bytes', evidence.retrieval.budget.total.usedBytes, 'bytes', source, identity);
    }
    for (const record of snapshot.records) {
      if (!record.task || !isCurrentRuntimeSession(record.task.session, snapshot.sessionVersion)) continue;
      const taskSessionId = runtimeSessionId(record.task.session);
      if (record.kind === 'end' && record.outcome) {
        const key = record.task.session + ':' + record.task.id + ':' + record.outcome;
        if (!rememberOutcome(key)) continue;
        telemetry.event(record.atMs, 'scheduler', 'task_' + record.outcome, source, {
          sessionId: taskSessionId,
          taskId: record.task.id,
          requestId: record.task.requestId,
        }, { code: diagnosticCode(record.reason ?? record.outcome) }, true);
      } else if (record.kind === 'upstream') {
        const key = record.task.session + ':' + record.task.id + ':upstream';
        if (!rememberOutcome(key)) continue;
        telemetry.event(record.atMs, 'model', 'terminal', source, {
          sessionId: taskSessionId,
          taskId: record.task.id,
          requestId: record.task.requestId,
          providerRequestId: record.providerRequestId,
        }, { code: record.usageUnknown ? 'usage_unknown' : 'terminal' }, true);
      }
    }
  }
  const sourceLabel = gateway ? 'real gateway · configured estimate' : 'mock provider · local simulation';
  telemetryState.textContent = gateway ? 'Real · configured estimate' : 'Mock · local';
  telemetryState.dataset.state = gateway ? 'ok' : 'idle';
  const lines = [
    'source · ' + sourceLabel + ' · visual ' + (session ? telemetrySession() : 'not attached') + ' · perception is a separate runtime',
    visual
      ? 'visual · input ' + visual.rates.input.toFixed(2) + ' fps · adaptive ' + visual.rates.adaptiveSent.toFixed(2) + ' fps · fixed ' + visual.rates.fixedSent.toFixed(2) + ' fps'
      : 'visual · not attached',
    evidence
      ? 'context · cache ' + evidence.buffer.frameCount + ' frames / ' + evidence.buffer.byteCount.toLocaleString() + ' bytes · transfer '
        + evidence.retrieval.budget.total.usedFrames + ' frames / ' + evidence.retrieval.budget.total.usedBytes.toLocaleString() + ' bytes / 5 s'
      : 'context · no active cache',
    'scheduler · queue ' + snapshot.queued.length + ' · ' + snapshot.slots + ' slot(s) · peak ' + snapshot.peakQueue + ' queued / ' + snapshot.peakSlots + ' slots',
    'tasks · ' + summary.completed + ' completed · ' + summary.failed + ' failed · ' + summary.cancelled + ' cancelled · '
      + summary.expired + ' expired · ' + summary.invalidated + ' invalidated · ' + summary.rejected + ' rejected · ' + summary.pending + ' pending · ' + summary.unanswered + ' unanswered',
    'latency · first text P50/P95 ' + msOrDash(summary.firstText.p50Ms) + ' / ' + msOrDash(summary.firstText.p95Ms)
      + ' · event→effective ' + msOrDash(summary.effectiveOutput.p50Ms) + ' / ' + msOrDash(summary.effectiveOutput.p95Ms)
      + ' · upstream ' + msOrDash(summary.upstream.p50Ms) + ' / ' + msOrDash(summary.upstream.p95Ms),
    'tokens · ' + summary.knownUsage + ' known (' + summary.inputTokens + ' in / ' + summary.outputTokens + ' out) · ' + summary.unknownUsage + ' unknown · ' + summary.staleOutputs + ' stale blocked · ' + summary.blockedOutputs + ' total blocked',
    'reasons · ' + (() => {
      const counts = new Map<string, number>();
      for (const [reason, count] of Object.entries(summary.reasons)) {
        const code = diagnosticCode(reason);
        counts.set(code, (counts.get(code) ?? 0) + count);
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([code, count]) => code + ' ×' + count).join(' · ') || '—';
    })(),
    cost
      ? 'cost · ' + formatUsd(cost.settledNanoUsd) + ' settled · ' + formatUsd(cost.reservedNanoUsd) + ' reserved · '
        + formatUsd(cost.provisionalNanoUsd) + ' provisional · ' + formatUsd(cost.availableNanoUsd) + ' available · '
        + formatUtilization(cost.utilization) + ' · ' + (cost.admission.canAdmit ? 'admission open' : 'admission blocked') + (costError ? ' · stale' : '')
      : 'cost · unavailable (Mock or not yet fetched); unknown is not zero',
  ];
  list('telemetry-summary', lines);
  const telemetrySnapshot = telemetry.snapshot();
  list('telemetry-events', telemetrySnapshot.events.slice(-12).reverse().map((event) => formatTelemetryEvent(event)));
  list('telemetry-series', telemetrySnapshot.series.slice(-8).map((series) => {
    const point = series.points.at(-1);
    return series.name + ' · ' + (point ? point.value : '—') + (series.unit ? ' ' + series.unit : '')
      + ' · ' + series.points.length + ' points · ' + series.source;
  }));
}

function msOrDash(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : Math.max(0, Math.round(value)) + ' ms';
}

function formatTelemetryEvent(event: TelemetryEvent): string {
  return '+' + Math.round(event.atMs - birth) + ' ms · ' + event.module + '/' + event.kind + ' · ' + event.name
    + (event.value === undefined ? '' : ' ' + event.value + (event.unit ? ' ' + event.unit : ''))
    + ' · ' + event.source + (event.taskId === undefined ? '' : ' · task ' + event.taskId);
}

function downloadTelemetry(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function taskLabel(task: TaskSummary): string {
  return '#' + task.id + ' · s' + task.session + '/i' + task.interaction + '/ctx' + task.context
    + ' · ' + (task.evidence.length ? 'frames ' + task.evidence.join(', ') : 'text only');
}

function render(): void {
  const { slots, attempts, queued, records, outputs, budget, peakSlots, peakQueue, sessionVersion } = runtime.snapshot();
  const visibleSlots = Math.max(slots, ...attempts.map((attempt) => attempt.slot ?? 0));
  const capacity = Array.from({ length: visibleSlots }, (_, index) => {
    const item = document.createElement('span');
    const slot = index + 1;
    const attempt = attempts.find((candidate) => candidate.slot === slot);
    const state = attempt ? '#' + attempt.id + (attempt.quarantined ? ' quarantined' : attempt.outcome ? ' draining' : ' running')
      : slot > slots ? 'disabled' : 'free';
    item.textContent = 'Slot ' + slot + ' · ' + state;
    return item;
  });
  element('capacity').replaceChildren(...capacity);
  list('tasks', [
    'Queue ' + queued.length + '/4 · peaks: ' + peakSlots + ' in flight / ' + peakQueue + ' queued',
    ...attempts.map((task) => taskLabel(task) + ' · ' + (task.outcome ?? 'running')),
    ...queued.map((task) => taskLabel(task) + ' · queued'),
    ...records.filter(({ kind }) => kind === 'end').slice(-7).reverse()
      .map(({ task, outcome, reason }) => taskLabel(task!) + ' · ' + outcome + ' · ' + reason),
  ]);
  list('events', records.slice(-30).reverse().map(({ atMs, event, kind, reason, task }) =>
    '+' + Math.round(atMs - birth) + ' ms · ' + kind + ' · '
    + (event ? '[' + event.source + '] ' + event.label + ' · ' : task ? '#' + task.id + ' · ' : '') + reason));
  const outputList = element('outputs');
  outputList.replaceChildren(...outputs.slice().reverse().map((output) => {
    const item = document.createElement('li');
    const label = document.createElement('strong');
    item.dataset.state = output.state;
    label.textContent = '#' + output.taskId + ' · ' + output.channel + ' · ' + output.state;
    item.append(label, output.text);
    return item;
  }));
  const visual = session?.evidence();
  list('budget', [
    'Rolling dispatch · ' + budget.rolling.frames + '/' + budget.rollingLimits.maxFrames + ' requests · '
      + budget.rolling.bytes.toLocaleString() + '/' + budget.rollingLimits.maxBytes.toLocaleString() + ' bytes / 5 s',
    (gateway ? 'Client token exposure' : 'Simulated tokens') + ' · ' + budget.settledTokens + ' settled + ' + budget.reservedTokens
      + ' held + ' + budget.provisionalTokens + ' provisional / ' + budget.tokenLimit
      + (budget.reservationOverrun ? ' · admissions frozen after overrun' : ''),
    ...(gateway ? ['Reported tokens · ' + budget.settledInputTokens + ' input / ' + budget.settledOutputTokens
      + ' output · ' + budget.unknownUsageCount + ' terminal receipts without usage · '
      + budget.quarantinedSlots + ' quarantined slot(s)'] : []),
    ...(visual ? ['Visual transfer · ' + visual.retrieval.budget.total.usedFrames + '/'
      + visual.retrieval.budget.total.maxFrames + ' frames · ' + visual.retrieval.budget.total.usedBytes.toLocaleString()
      + '/' + visual.retrieval.budget.total.maxBytes.toLocaleString() + ' bytes / 5 s (sampling + retrieval)'] : []),
  ]);
  const metrics = runtime.requestMeasurements(sessionVersion);
  element('metric-scope').textContent = (gateway
    ? 'Gateway timings · first streamed text is the observable first-token proxy'
    : 'Scripted simulation · timings from the browser clock') + ' · '
    + metrics.filter((task) => task.unanswered).length + '/' + metrics.length + ' recent tasks ended without effective output';
  const ms = (value?: number) => value === undefined ? '—' : Math.max(0, Math.round(value)) + ' ms';
  list('request-metrics', metrics.slice(-12).reverse().map((task) => '#' + task.id + ' · ' + task.outcome
    + (task.requestId ? ' · request ' + task.requestId : '')
    + (task.providerRequestId ? ' · upstream ' + task.providerRequestId : '')
    + ' · start +' + (task.startedAtMs === undefined ? '—' : ms(task.startedAtMs - birth))
    + ' · gateway dispatch +' + (task.gatewayDispatchAtMs === undefined ? '—' : ms(task.gatewayDispatchAtMs - birth))
    + ' · first text ' + ms(task.firstTextDelayMs) + ' / upstream ' + ms(task.upstreamFirstTextMs)
    + ' · event → effective ' + ms(task.firstEffectiveDelayMs)
    + ' · output stop ' + ms(task.outputStopMs) + ' · stop → terminal ' + ms(task.waitForTerminalAfterStopMs)
    + ' · upstream ' + ms(task.upstreamElapsedMs)
    + ' · tokens ' + (task.usage === 'reported' ? task.inputTokens + ' in / ' + task.outputTokens + ' out' : task.usage)
    + ' · ' + task.stale + ' stale blocked / ' + task.blocked + ' total blocked' + (task.unanswered ? ' · unanswered' : '')));
  const buffer = visual?.buffer;
  element('cache').textContent = buffer
    ? buffer.frameCount + ' retained frames · ' + Math.round(buffer.byteCount / 1024) + ' KiB · latest #'
      + (buffer.lastCapturedSequence ?? '—') + ' · ' + buffer.evictionCount + ' evictions'
    : 'No active visual source';
  renderCost();
  renderObservability();
}

element('normal').onclick = () => trigger(false);
element('critical').onclick = () => trigger(true);
element('monitor').onclick = () => useScene();
element('procedural').onclick = () => useScene(true);
element('camera').onclick = () => void useCamera();
element('stop-camera').onclick = () => useScene();
mode.onchange = resetSampling;
element('video-playback').onclick = () => {
  if (video?.isPlaying) video.pause();
  else void video?.play();
};
element<HTMLInputElement>('video-file').onchange = (e) => {
  const input = e.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const problem = videoFileProblem(media, file);
  if (problem) {
    status.textContent = problem;
    return;
  }
  stopSource();
  resetSampling();
  video = new VideoSource(media, feed, {
    callbacks: {
      onSessionReset: resetSampling,
      onStatus: (state) => { status.textContent = state.message; },
      onError: (message) => { status.textContent = message; },
    },
  });
  video.start(processFrame);
  video.load(file);
  sourceControls();
};

element<HTMLFormElement>('turn').onsubmit = (e) => {
  e.preventDefault();
  const input = element<HTMLInputElement>('prompt');
  const text = input.value.trim();
  if (!text) return;
  event('user', text, 'User turn · supersede previous response', {
    channel: 'response', priority: 20, ttlMs: gateway?.capabilities.timeoutMs ?? 5_000, supersede: true,
    textContext: gateway && lastMonitorEvent ? 'Most recent local synthetic monitor event: ' + lastMonitorEvent : undefined,
  });
  input.value = '';
};
element('interrupt').onclick = () => {
  event('user', 'Interrupt', 'Stop visible output and request upstream cancellation');
  runtime.interrupt();
};
element<HTMLFormElement>('history').onsubmit = (e) => {
  e.preventDefault();
  const sequence = element<HTMLInputElement>('sequence').valueAsNumber;
  if (!session || !Number.isSafeInteger(sequence) || sequence < 1) return;
  const result = session.retrieveFrame(sequence);
  historical.clearRect(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  if (result.frame) showPixels(historical, result.frame.pixels, result.frame.width, result.frame.height);
  element('history-status').textContent = 'Frame #' + sequence + ' · ' + result.status + ' · ' + result.message;
};

function updateSlotOptions(slots: number): void {
  for (const option of mode.options) {
    if (option.value === 'fifo' || option.value === 'aware') option.disabled = slots < 2;
  }
  if (slots === 1 && (mode.value === 'fifo' || mode.value === 'aware')) {
    mode.value = mode.value === 'fifo' ? 'serial' : 'aware-serial';
  }
}

function useMock(): void {
  gatewayConnectGeneration += 1;
  runtime.newSession();
  gateway = undefined;
  costGeneration.next();
  budgetPoller = undefined;
  cost = null;
  costAt = null;
  costError = '';
  telemetry.event(systemClock.now(), 'model', 'gateway_disabled', 'mock', { sessionId: telemetrySession() });
  runtime = mockRuntime;
  updateSlotOptions(2);
  element('provider-status').textContent = 'Mock provider · local simulation';
  element('output-title').textContent = 'Mock LLM output';
  behavior.disabled = false;
  element('use-mock').hidden = true;
  element<HTMLInputElement>('gateway-token').disabled = false;
  element<HTMLButtonElement>('enable-gateway').disabled = false;
  resetSampling();
}

element('use-mock').onclick = useMock;
element<HTMLFormElement>('gateway-controls').onsubmit = async (e) => {
  e.preventDefault();
  if (gateway) return;
  const field = element<HTMLInputElement>('gateway-token');
  const enable = element<HTMLButtonElement>('enable-gateway');
  const token = field.value.trim();
  if (!token) return;
  field.value = '';
  enable.disabled = true;
  const generation = ++gatewayConnectGeneration;
  try {
    const adapter = await GatewayStreamingProvider.connect(token);
    if (generation !== gatewayConnectGeneration) return;
    gateway = adapter;
    costGeneration.next();
    budgetPoller = new BudgetPoller(() => adapter.budget());
    cost = null;
    costAt = null;
    costError = '';
    const caps = adapter.capabilities;
    telemetry.event(systemClock.now(), 'model', 'gateway_connected', 'real', { sessionId: telemetrySession() }, { model: caps.model, profile: caps.profile });
    void refreshCost();
    updateSlotOptions(caps.slots);
    runtime.newSession();
    runtime = new InferenceScheduler(adapter, systemClock, {
      slots: caps.slots, queue: 4,
      tokensPerTask: caps.outputLimit, inputTokensPerTask: caps.inputReserve,
      totalTokens: (caps.inputReserve + caps.outputLimit) * 100,
      transport: { windowMs: 5_000, maxFrames: 16, maxBytes: 384_000 },
    }, 'context-aware');
    element('provider-status').textContent = 'Real gateway · ' + caps.model
      + ' · submitted text and triggered monitor events can incur charges';
    element('output-title').textContent = 'Streaming model output · ' + caps.model;
    element('use-mock').hidden = false;
    field.disabled = true;
    behavior.disabled = true;
    resetSampling();
  } catch {
    if (generation !== gatewayConnectGeneration) return;
    enable.disabled = false;
    element('provider-status').textContent = 'Could not enable the real gateway. Check the local server and access token.';
  }
};

function startCostPolling(): void {
  if (costTimer !== undefined) window.clearInterval(costTimer);
  costTimer = window.setInterval(() => {
    if (gateway && document.visibilityState === 'visible') void refreshCost();
  }, 4_000);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (camera) {
      stopSource();
      status.textContent = 'Camera paused while hidden. Tap Start camera to resume.';
    } else if (video) {
      video.pause();
      status.textContent = 'Video paused while hidden. Tap Play video to resume.';
    } else if (monitor || procedural) {
      stopSource();
      status.textContent = 'Visual source paused while hidden. Tap System monitor or Start camera to resume.';
    }
    sourceControls();
    return;
  }
  sourceControls();
  if (!camera && !monitor && !video) status.textContent = 'Camera stopped while away. Tap Start camera to resume.';
});

window.addEventListener('pagehide', () => {
  gatewayConnectGeneration += 1;
  costGeneration.next();
  window.clearInterval(refresh);
  refresh = undefined;
  if (costTimer !== undefined) window.clearInterval(costTimer);
  costTimer = undefined;
  budgetPoller = undefined;
  stopSource();
  session?.dispose();
  session = undefined;
  runtime.newSession();
});
window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  window.clearInterval(refresh);
  if (!gateway) element<HTMLButtonElement>('enable-gateway').disabled = false;
  useScene();
  refresh = window.setInterval(render, 200);
  if (gateway) {
    costGeneration.next();
    budgetPoller = new BudgetPoller(() => gateway!.budget());
    void refreshCost();
  }
  startCostPolling();
});

element('cost-refresh').onclick = () => void refreshCost();
element('telemetry-json').onclick = () => downloadTelemetry('semanticstream-telemetry.json', telemetry.exportJson(), 'application/json');
element('telemetry-csv').onclick = () => downloadTelemetry('semanticstream-telemetry.csv', telemetry.exportCsv(), 'text/csv');
element('telemetry-clear').onclick = () => {
  telemetry.clear();
  seenOutcomes.clear();
  lastTelemetryAt = 0;
  renderObservability();
};
startCostPolling();

useScene();
refresh = window.setInterval(render, 200);
render();
