import { AgentSession } from '../agent/session';
import { allEligiblePolicy, rulePolicy } from '../agent/policy';
import type { AgentProvider } from '../agent/provider';
import { SAMPLE_WIDTH, SAMPLE_HEIGHT } from '../core/sample';
import type { FrameListener } from '../core/stream';
import { ScriptedStreamingProvider } from '../inference/scripted-provider';
import type { InferenceProvider } from '../inference/types';
import type { DetectorModelSpec, ObjectDetectorProvider } from '../perception/provider';
import type { DetectionRequest, SourceTransform, WorkerDetection } from '../perception/types';
import { ReplayClock } from './runtime-clock';

const transform: SourceTransform = {
  sourceWidth: 100, sourceHeight: 100, modelWidth: 100, modelHeight: 100, scale: 1, offsetX: 0, offsetY: 0,
};
const spec: DetectorModelSpec = { id: 'fixture', version: '1', modelUrl: '', wasmUrl: '', scoreThreshold: 0.35, maxResults: 20 };
const limits = {
  slots: 2, queue: 3, tokensPerTask: 32, totalTokens: 512, terminalGraceMs: 500,
  transport: { windowMs: 5_000, maxFrames: 8, maxBytes: 6_000 },
};

export const modes = ['all-eligible-fifo', 'task-aware-fifo', 'semanticstream'] as const;
type Mode = (typeof modes)[number];

function item(categoryName: string, x = 10, score = 0.9): WorkerDetection {
  return { categoryName, categoryId: -1, score, box: { x, y: 10, width: 20, height: 20 } };
}

interface FixtureFrame { readonly key: number; readonly signal: number }

class FixtureSource {
  listener?: FrameListener<FixtureFrame>;
  sequence = 0;
  start(listener: FrameListener<FixtureFrame>): void { this.listener = listener; }
  stop(): void { this.listener = undefined; }
}

async function setup(mode: Mode, tokenBudget = limits.totalTokens) {
  const clock = new ReplayClock();
  const assistant = new ScriptedStreamingProvider(clock, (task) => ({
    firstTokenMs: task.priority >= 20 ? 25 : 190,
    intervalMs: 210, chunks: ['Acknowledged. ', 'Structured evidence reviewed.'],
    finishAfterMs: 100, ignoreCancel: true, latePartialMs: 20,
  }));
  const provider: InferenceProvider = {
    start(task, signal, callbacks) {
      if (task.event.label.includes('unconfirmed')) clock.after(90, () => callbacks.unconfirmed?.('Fixture transport disappeared'));
      else assistant.start(task, signal, callbacks);
    },
  };
  const binding: AgentProvider = {
    adapter: provider, source: 'fixture', deadlineMs: 3_500,
    limits: { ...limits, totalTokens: tokenBudget },
    capabilities: {
      modelId: 'scripted-fixture', executionLocation: 'mock', supportsText: true, supportsVision: false,
      supportsStreaming: true, supportsCancellation: true, maxConcurrency: 2, usageReporting: 'simulated', readiness: 'ready',
    },
  };
  const frames = new Map<number, readonly WorkerDetection[]>();
  let key = 0;
  const detector: ObjectDetectorProvider = {
    id: 'fixture', version: '1',
    async load() { return { loadMs: 0, modelBytes: 0 }; },
    detect(request: DetectionRequest, pixels: ArrayBuffer) {
      const frame = frames.get(new Uint32Array(pixels)[0]) ?? [];
      return new Promise((resolve) => clock.after(15, () => resolve({
        type: 'detections', requestId: request.requestId, sessionId: request.sessionId, frameSequence: request.frameSequence,
        inferenceMs: 15, detections: frame,
      })));
    },
    dispose() {},
  };
  const agent = new AgentSession<FixtureFrame>({
    runtimeInstanceId: 'fixture-agent', clock, provider: binding,
    policy: mode === 'all-eligible-fifo' ? allEligiblePolicy : rulePolicy,
    scheduling: mode === 'semanticstream' ? 'context-aware' : 'fifo',
    tracking: {
      tracker: { enableVelocity: false, confirmHits: 2, lostAfterMs: 550, maxAssociationGapMs: 1_900, expireAfterMs: 2_500 },
      events: { stationaryAfterMs: 550, minMoveDistance: 0.02, cooldownMs: 900 },
    },
    frames: {
      sample: ({ signal }) => new Uint8ClampedArray(SAMPLE_WIDTH * SAMPLE_HEIGHT * 4).fill(signal),
      detection: ({ key: frameKey }) => ({ pixels: Uint32Array.of(frameKey).buffer, transform }),
    },
  });
  let stream = new FixtureSource();
  await agent.useSource(stream, 'demo');
  await agent.enableDetector(detector, spec, 'fixture');
  const advance = async (at: number) => {
    clock.advance(at);
    await Promise.resolve();
  };
  return {
    agent, clock, advance,
    async frame(at: number, detections: readonly WorkerDetection[], signal?: number) {
      await advance(at);
      key += 1;
      frames.set(key, detections);
      stream.listener?.({ sequence: ++stream.sequence, timestampMs: at,
        payload: { key, signal: signal ?? (key % 2 ? 240 : 20) } });
      await advance(at + 16);
      frames.delete(key);
    },
    async newSource() {
      stream = new FixtureSource();
      await agent.useSource(stream, 'demo');
    },
  };
}

type Harness = Awaited<ReturnType<typeof setup>>;

const scenarios: readonly {
  name: string; expected: readonly string[]; cap?: number;
  run(h: Harness): Promise<Record<string, string | number | boolean> | void>;
}[] = [
  {
    name: 'static and unrelated detections', expected: [],
    async run({ agent, frame }) {
      agent.setTask({ type: 'object', category: 'person', movement: false });
      await frame(0, [item('chair')], 30);
      await frame(1_500, [item('chair')], 30);
      await frame(3_000, [item('chair')], 30);
    },
  },
  {
    name: 'appearance, loss and reappearance',
    expected: ['OBJECT_APPEARED · person', 'OBJECT_TEMPORARILY_LOST · person', 'OBJECT_REAPPEARED · person'],
    async run({ agent, frame }) {
      agent.setTask({ type: 'object', category: 'person', movement: false });
      await frame(0, [item('person')]);
      await frame(300, [item('person')]);
      await frame(1_100, []);
      await frame(1_400, [item('person')]);
    },
  },
  {
    name: 'uncertain association and duplicate event', expected: ['OBJECT_APPEARED · person'],
    async run({ agent, frame }) {
      agent.setTask({ type: 'object', category: 'person', movement: true });
      await frame(0, [item('person')]);
      await frame(300, [item('person')]);
      await frame(600, [item('person', 14), item('person', 6)]);
      const moved = agent.state.getObjectEvents({ eventType: 'OBJECT_MOVED' })[0];
      if (moved) agent.acceptSemanticEvent(moved);
      const row = agent.snapshot().decisions.find((item) => item.event?.eventType === 'OBJECT_MOVED');
      return { uncertain: moved?.associationUncertain ?? false, policy: row?.action ?? 'missing',
        copies: agent.snapshot().decisions.filter((item) => item.id === moved?.eventId).length };
    },
  },
  {
    name: 'critical takeover and task revision',
    expected: ['Synthetic monitor alert: database replica offline', 'Summarize current tracked objects and recent events.'],
    async run({ agent, advance }) {
      agent.monitor(false);
      await advance(50);
      agent.monitor(true);
      await advance(750);
      agent.monitor(false);
      agent.setTask({ type: 'summary' });
      agent.summarize();
    },
  },
  {
    name: 'background suspend, evicted evidence and late previous session',
    expected: ['OBJECT_APPEARED · person'],
    async run({ agent, clock, frame, newSource, advance }) {
      agent.setTask({ type: 'object', category: 'person', movement: false });
      await frame(0, [item('person')]);
      await frame(300, [item('person')]);
      const old = agent.state.getObjectEvents()[0];
      await advance(530);
      agent.suspend();
      agent.acceptSemanticEvent(old);
      const wrong = agent.retrieveEvent(old).status;
      await newSource();
      await frame(900, []);
      return { oldEvidence: wrong, backgroundAt: clock.now(), lateDecisions: agent.snapshot().decisions.filter((row) => row.id === old.eventId).length };
    },
  },
  {
    name: 'rolling evidence eviction and historical time', expected: ['OBJECT_APPEARED · person'],
    async run({ agent, frame }) {
      agent.setTask({ type: 'object', category: 'person', movement: false });
      await frame(0, [item('person')]);
      await frame(300, [item('person')]);
      const event = agent.state.getObjectEvents()[0];
      const before = agent.retrieveAt(290);
      await frame(3_600, []);
      return { asOfSequence: before.frame?.sequence ?? -1, asOfCapture: before.frame?.timestampMs ?? -1,
        eventEvidence: agent.retrieveEvent(event).status };
    },
  },
  {
    name: 'insufficient token reservation', expected: ['Summarize current tracked objects and recent events.'], cap: 1,
    async run({ agent }) { agent.summarize(); },
  },
  {
    name: 'saturated queue and urgent user request',
    expected: ['OBJECT_APPEARED · person', 'Summarize current tracked objects and recent events.'],
    async run({ agent, frame, advance }) {
      agent.setTask({ type: 'object', category: 'person', movement: false });
      const batch = Array.from({ length: 7 }, (_, index) => item('person', index * 12));
      await frame(0, batch);
      await frame(300, batch);
      await advance(340);
      agent.summarize();
    },
  },
  {
    name: 'unconfirmed upstream fills physical slots', expected: ['Can you continue?'],
    async run({ agent, advance }) {
      agent.ask('unconfirmed first');
      await advance(35);
      agent.ask('unconfirmed second');
      await advance(150);
      agent.ask('Can you continue?');
    },
  },
];

function percentile(values: number[], quantile: number): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * quantile) - 1] ?? null;
}

interface CaseResult {
  scene: string; expected: number; successes: number; falsePositives: number; misses: number; unanswered: number;
  suppressed: number; starts: number; bytes: number; mockTokens: number; held: number; staleBlocked: number; violations: number;
  effectiveDelaysMs: number[]; observations?: Record<string, string | number | boolean> | void;
  cases: { label: string; policy: string; reason: string; outcome: string }[];
}

async function replay(mode: Mode) {
  const results: CaseResult[] = [];
  for (const scene of scenarios) {
    const harness = await setup(mode, scene.cap);
    const observations = await scene.run(harness);
    await harness.advance(harness.clock.now() + 10_000);
    const { runtime, decisions, measurements } = harness.agent.snapshot();
    const expected = new Set(scene.expected);
    const responses = decisions.flatMap((row) => {
      const result = measurements.find((task) => task.id === row.taskId);
      return result?.firstEffectiveDelayMs === undefined ? [] : [{
        label: row.label, delay: result.firstEffectiveDelayMs + row.consumedAtMs - row.producedAtMs,
      }];
    });
    const valid = new Set(responses.filter((row) => expected.has(row.label)).map((row) => row.label));
    const starts = runtime.records.filter((record) => record.kind === 'start' && record.task);
    const violations = starts.reduce((sum, row) => {
      const rolling = starts.filter((start) => start.atMs > row.atMs - limits.transport.windowMs && start.atMs <= row.atMs);
      return sum + Number(rolling.length > limits.transport.maxFrames
        || rolling.reduce((bytes, start) => bytes + start.task!.contextBytes, 0) > limits.transport.maxBytes);
    }, Number(runtime.peakSlots > limits.slots) + Number(runtime.budget.reservationOverrun)
      + Number(runtime.budget.settledTokens + runtime.budget.reservedTokens + runtime.budget.provisionalTokens > (scene.cap ?? limits.totalTokens)));
    results.push({
      scene: scene.name, expected: expected.size, successes: valid.size, falsePositives: responses.filter((row) => !expected.has(row.label)).length,
      misses: expected.size - valid.size, unanswered: measurements.filter((task) => task.unanswered).length,
      suppressed: decisions.filter((row) => !row.taskId).length, starts: starts.length,
      bytes: runtime.budget.sentBytes, mockTokens: runtime.budget.settledTokens, held: runtime.attempts.length,
      staleBlocked: measurements.reduce((sum, item) => sum + item.stale, 0), violations,
      effectiveDelaysMs: responses.map((row) => row.delay), observations,
      cases: decisions.map((row) => ({
        label: row.label, policy: row.action, reason: row.reason,
        outcome: measurements.find((task) => task.id === row.taskId)?.outcome ?? 'suppressed',
      })),
    });
    harness.agent.suspend();
  }
  const sum = (key: 'expected' | 'successes' | 'falsePositives' | 'misses' | 'unanswered' | 'suppressed' | 'starts' | 'bytes' | 'mockTokens' | 'staleBlocked' | 'violations') =>
    results.reduce((total, row) => total + row[key], 0);
  const delays = results.flatMap((row) => row.effectiveDelaysMs);
  return {
    mode, expected: sum('expected'), successes: sum('successes'), successRate: sum('successes') / sum('expected'),
    falsePositives: sum('falsePositives'), misses: sum('misses'), unanswered: sum('unanswered'), suppressed: sum('suppressed'),
    calls: sum('starts'), contextBytes: sum('bytes'), mockTokens: sum('mockTokens'), staleBlocked: sum('staleBlocked'),
    violations: sum('violations'), p50Ms: percentile(delays, 0.5), p95Ms: percentile(delays, 0.95), results,
  };
}

export async function runIntegratedBenchmark() {
  const variants = [];
  for (const mode of modes) variants.push(await replay(mode));
  return { source: 'fixture', metric: 'authorized-response-coverage', costs: 'unavailable · no paid provider', variants };
}
