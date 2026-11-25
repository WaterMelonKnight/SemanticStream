import './runtime-lab.css';
import { SamplingSession } from './app/sampling-session';
import { SAMPLE_HEIGHT, SAMPLE_WIDTH } from './core/sample';
import type { StreamFrame } from './core/stream';
import { DecisionEngine } from './decision/engine';
import { RuleBasedDecisionProvider } from './decision/rule-provider';
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
let video: VideoSource | undefined;
let pendingScenario: { label: string; critical: boolean } | undefined;
let lastFilterAt = -Infinity;
let latestDecision = 'Awaiting visual decision';
let refresh: number | undefined;

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
const runtime = new InferenceScheduler(provider, systemClock, {
  slots: 2, queue: 4, tokensPerTask: 128, totalTokens: 12_800,
  transport: { windowMs: 5_000, maxFrames: 16, maxBytes: 1_300_000 },
}, 'context-aware');

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
    const evidence: Evidence = {
      source: monitor ? 'monitor' : camera ? 'camera' : video ? 'video' : 'procedural',
      sequence, capturedAtMs: timestampMs, mediaType: 'application/x-rgba-base64',
      data: btoa(String.fromCharCode(...sample)),
    };
    const request: InferenceRequest = known?.critical
      ? { channel: 'observation', priority: 10, ttlMs: 4_000, supersede: true }
      : { channel: 'observation', priority: 1, ttlMs: 5_000, dedupeKey: known ? 'monitor-change' : 'pixel-candidate' };
    event(known ? 'scenario' : 'pixels', known?.label ?? 'Frame #' + sequence,
      'Selected by ' + adaptiveSelection + ' · latest proposal: ' + latestDecision, request, evidence, timestampMs);
  } else if (timestampMs - lastFilterAt >= 500) {
    lastFilterAt = timestampMs;
    event('pixels', 'Frame #' + sequence, 'Visual filter: ' + decisions.adaptive + ' · latest proposal: ' + latestDecision,
      undefined, undefined, timestampMs);
  }
  element('capture-status').textContent = phase + ' · frame #' + sequence;
}

function resetSampling(): void {
  session?.dispose();
  pendingScenario = undefined;
  latestDecision = 'Awaiting visual decision';
  lastFilterAt = -Infinity;
  runtime.newSession(
    mode.value === 'serial' || mode.value === 'fifo' ? 'fifo' : 'context-aware',
    mode.value === 'serial' || mode.value === 'aware-serial' ? 1 : 2,
  );
  agent.clearRect(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  historical.clearRect(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  element('agent-status').textContent = 'Awaiting dispatch';
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
    (decision) => { latestDecision = decision.action + ' · ' + decision.reason; },
    systemClock.now,
  );
}

function stopSource(): void {
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
    if (camera === source) status.textContent = 'Camera running · video stays in this browser';
  } catch (error) {
    if (camera !== source) return;
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
  event('scenario', label, 'Known monitor event · awaiting selected evidence');
}

function list(id: string, lines: readonly string[]): void {
  element(id).replaceChildren(...lines.map((line) => {
    const item = document.createElement('li');
    item.textContent = line;
    return item;
  }));
}

function taskLabel(task: TaskSummary): string {
  return '#' + task.id + ' · s' + task.session + '/i' + task.interaction + '/ctx' + task.context
    + ' · ' + (task.evidence.length ? 'frames ' + task.evidence.join(', ') : 'text only');
}

function render(): void {
  const { slots, attempts, queued, records, outputs, budget, peakSlots, peakQueue } = runtime.snapshot();
  const visibleSlots = Math.max(slots, ...attempts.map((attempt) => attempt.slot ?? 0));
  const capacity = Array.from({ length: visibleSlots }, (_, index) => {
    const item = document.createElement('span');
    const slot = index + 1;
    const attempt = attempts.find((candidate) => candidate.slot === slot);
    const state = attempt ? '#' + attempt.id + (attempt.outcome ? ' draining' : ' running')
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
    'Simulated tokens · ' + budget.settledTokens + ' settled + ' + budget.reservedTokens
      + ' reserved + ' + budget.provisionalTokens + ' provisional / ' + budget.tokenLimit,
    ...(visual ? ['Visual transfer · ' + visual.retrieval.budget.total.usedFrames + '/'
      + visual.retrieval.budget.total.maxFrames + ' frames · ' + visual.retrieval.budget.total.usedBytes.toLocaleString()
      + '/' + visual.retrieval.budget.total.maxBytes.toLocaleString() + ' bytes / 5 s (sampling + retrieval)'] : []),
  ]);
  const buffer = visual?.buffer;
  element('cache').textContent = buffer
    ? buffer.frameCount + ' retained frames · ' + Math.round(buffer.byteCount / 1024) + ' KiB · latest #'
      + (buffer.lastCapturedSequence ?? '—') + ' · ' + buffer.evictionCount + ' evictions'
    : 'No active visual source';
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
    channel: 'response', priority: 20, ttlMs: 5_000, supersede: true,
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

window.addEventListener('pagehide', () => {
  window.clearInterval(refresh);
  stopSource();
  session?.dispose();
  session = undefined;
  runtime.newSession();
});
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  useScene();
  refresh = window.setInterval(render, 200);
});

useScene();
refresh = window.setInterval(render, 200);
render();
