import { expect, it } from 'vitest';
import { ReplayClock } from '../benchmark/runtime-clock';
import { SAMPLE_HEIGHT, SAMPLE_WIDTH } from '../core/sample';
import type { FrameListener } from '../core/stream';
import type { InferenceProvider, InferenceTask } from '../inference/types';
import { costView } from '../observability/cost';
import type { ObjectDetectorProvider } from '../perception/provider';
import type { WorkerDetection } from '../perception/types';
import type { AgentProvider } from './provider';
import { AgentSession } from './session';

function manualProvider(location: 'mock' | 'gateway' | 'browser' = 'mock') {
  const calls: { task: InferenceTask; signal: AbortSignal; callbacks: Parameters<InferenceProvider['start']>[2] }[] = [];
  const binding: AgentProvider = {
    adapter: { start(task, signal, callbacks) { calls.push({ task, signal, callbacks }); } },
    limits: {
      slots: 1, queue: 4, totalTokens: 1_000, tokensPerTask: 30,
      transport: { windowMs: 5_000, maxFrames: 20, maxBytes: 8_000 },
    },
    deadlineMs: 8_000, source: 'fixture',
    capabilities: {
      modelId: 'controlled', executionLocation: location, supportsText: true, supportsVision: false,
      supportsStreaming: true, supportsCancellation: true, maxConcurrency: 1, readiness: 'ready', usageReporting: 'simulated',
    },
  };
  return { calls, binding };
}

async function fixture(binding: AgentProvider) {
  const clock = new ReplayClock();
  const agent = new AgentSession<number>({
    runtimeInstanceId: 'review', clock, provider: binding,
    frames: {
      sample: (value) => new Uint8ClampedArray(SAMPLE_WIDTH * SAMPLE_HEIGHT * 4).fill(value),
      detection: () => ({
        pixels: new ArrayBuffer(0),
        transform: { sourceWidth: 100, sourceHeight: 100, modelWidth: 100, modelHeight: 100, scale: 1, offsetX: 0, offsetY: 0 },
      }),
    },
    tracking: { tracker: { confirmHits: 1, lostAfterMs: 300, maxAssociationGapMs: 1_500, expireAfterMs: 3_000 } },
  });
  let listener: FrameListener<number> | undefined;
  await agent.useSource({ start(fn) { listener = fn; }, stop() { listener = undefined; } }, 'demo');
  let detections: WorkerDetection[] = [];
  const detector: ObjectDetectorProvider = {
    id: 'fixture', version: '1',
    async load() { return { modelBytes: 0, loadMs: 0 }; },
    async detect(request) {
      return {
        type: 'detections', sessionId: request.sessionId, requestId: request.requestId, frameSequence: request.frameSequence,
        inferenceMs: 0, detections,
      };
    },
    dispose() {},
  };
  await agent.enableDetector(detector, {
    id: 'fixture', version: '1', modelUrl: '', wasmUrl: '', maxResults: 5, scoreThreshold: 0.35,
  }, 'fixture');
  agent.setTask({ type: 'object', category: 'person', movement: false });
  let seq = 0;
  return {
    agent, clock,
    async frame(at: number, visible: boolean) {
      clock.advance(at);
      detections = visible ? [{ categoryId: 1, categoryName: 'person', score: 0.9, box: { x: 10, y: 10, height: 20, width: 20 } }] : [];
      seq += 1;
      listener?.({ sequence: seq, timestampMs: at, payload: seq % 2 ? 220 : 20 });
      await Promise.resolve();
    },
  };
}

it('invalidates APPEARED on LOST before a replacement gets a slot, then settles the old receipt once', async () => {
  const { calls, binding } = manualProvider();
  const { agent, frame } = await fixture(binding);
  await frame(0, true);
  const appeared = calls[0];
  appeared.callbacks.partial({ index: 0, text: 'appearance' });
  await frame(500, false);
  const oldId = appeared.task.id;
  expect(appeared.signal.aborted).toBe(true);
  expect(calls).toHaveLength(1);
  expect(agent.snapshot().runtime).toMatchObject({
    attempts: [{ id: oldId, outcome: 'invalidated' }], queued: [{ id: oldId + 1 }],
    outputs: [{ taskId: oldId, text: 'appearance', state: 'stopped' }], budget: { reservedTokens: 30 },
  });
  appeared.callbacks.partial({ index: 1, text: ' obsolete' });
  appeared.callbacks.terminal({ status: 'completed', tokens: 12 });
  appeared.callbacks.terminal({ status: 'completed', tokens: 30 });
  expect(calls[1].task.event.label).toContain('OBJECT_TEMPORARILY_LOST');
  expect(agent.snapshot().runtime.budget).toMatchObject({ settledTokens: 12, reservedTokens: 30 });
  expect(agent.snapshot().measurements.find(({ id }) => id === oldId)).toMatchObject({ stale: 1, outcome: 'invalidated' });
});

it('replaces LOST with REAPPEARED at equal priority and suppresses a late partial after takeover', async () => {
  const { calls, binding } = manualProvider();
  const { agent, frame } = await fixture(binding);
  await frame(0, true);
  calls[0].callbacks.terminal({ status: 'completed', tokens: 2 });
  await frame(500, false);
  const lost = calls[1];
  lost.callbacks.partial({ index: 0, text: 'lost' });
  await frame(800, true);
  expect(lost.signal.aborted).toBe(true);
  expect(calls).toHaveLength(2);
  lost.callbacks.terminal({ status: 'completed', tokens: null });
  expect(calls[2].task.event.label).toContain('OBJECT_REAPPEARED');
  expect(calls[2].task.priority).toBe(lost.task.priority);
  calls[2].callbacks.partial({ index: 0, text: 'reappeared' });
  lost.callbacks.partial({ index: 1, text: ' late loss' });
  expect(agent.snapshot().runtime.outputs).toMatchObject([
    { text: 'lost', state: 'superseded' }, { text: 'reappeared', state: 'streaming' },
  ]);
  expect(agent.snapshot().runtime.budget).toMatchObject({ provisionalTokens: 30, reservedTokens: 30, settledTokens: 2 });
});

it('stops an obsolete stream on expiry even though policy does not request a replacement', async () => {
  const { calls, binding } = manualProvider();
  const { agent, frame } = await fixture(binding);
  await frame(0, true);
  await frame(3_100, false);
  expect(agent.snapshot().decisions.at(-1)).toMatchObject({ label: 'OBJECT_EXPIRED · person', action: 'WAIT' });
  expect(calls[0].signal.aborted).toBe(true);
  expect(agent.snapshot().runtime.attempts).toMatchObject([{ outcome: 'invalidated' }]);
  expect(agent.snapshot().runtime.queued).toEqual([]);
});

it('keeps a valid long observation streaming past freshness and rejects stale work that is still queued', async () => {
  const { calls, binding } = manualProvider();
  const { agent, frame, clock } = await fixture(binding);
  await frame(0, true);
  const current = calls[0];
  clock.advance(3_000);
  current.callbacks.partial({ index: 0, text: 'still current' });
  expect(current.signal.aborted).toBe(false);
  expect(agent.snapshot().runtime.outputs).toMatchObject([{ text: 'still current' }]);
  current.callbacks.terminal({ status: 'completed', tokens: 2 });

  agent.interrupt();
  agent.ask('A separate manual question');
  await frame(3_400, false);
  await frame(3_700, true);
  expect(agent.snapshot().runtime.queued).toHaveLength(1);
  clock.advance(6_300);
  calls[1].callbacks.terminal({ status: 'completed', tokens: 2 });
  expect(calls).toHaveLength(2);
  expect(agent.snapshot().runtime.records.at(-1)).toMatchObject({
    outcome: 'invalidated', reason: 'Event is no longer relevant at dispatch',
  });
});

it('keeps a single browser execution slot when switching away and reusing the same adapter', async () => {
  const browser = manualProvider('browser');
  const mock = manualProvider();
  const { agent } = await fixture(browser.binding);
  agent.ask('Call on the local instance');
  const previous = browser.calls[0];
  agent.setProvider(mock.binding);
  expect(previous.signal.aborted).toBe(true);
  agent.setProvider({ ...browser.binding, capabilities: { ...browser.binding.capabilities } });
  agent.ask('Try the same instance again');
  expect(browser.calls).toHaveLength(1);
  expect(agent.snapshot().runtime.budget.reservedTokens).toBe(30);
  previous.callbacks.terminal({ status: 'completed', tokens: 3 });
  expect(browser.calls).toHaveLength(2);
  expect(agent.snapshot().runtime.budget.settledTokens).toBe(3);
});

it('reconnects with a new Gateway adapter while late settlement retains the original scope', async () => {
  const mock = manualProvider();
  const first = manualProvider('gateway');
  const next = manualProvider('gateway');
  const { agent } = await fixture(mock.binding);
  const cost = costView({
    slots: 1, limitNanoUsd: 1_000, costPerRequestNanoUsd: 10, settledNanoUsd: 0, reservedNanoUsd: 0,
    provisionalNanoUsd: 0, accepted: 0, requestLimit: 10, held: 0, quarantined: 0, blocked: false,
  });
  agent.setProvider(first.binding);
  agent.setGatewayCost(cost);
  agent.ask('Before disconnect');
  const old = first.calls[0];
  old.callbacks.partial({ index: 0, text: 'old session' });
  agent.setProvider(mock.binding);
  expect(old.signal.aborted).toBe(true);
  expect(() => agent.setProvider({ ...next.binding, limits: { ...next.binding.limits, totalTokens: 2_000 } }))
    .toThrow('still hold slots');
  agent.setProvider(next.binding);
  agent.setGatewayCost(cost);
  agent.ask('After reconnect');
  expect(next.calls).toHaveLength(0);
  expect(agent.snapshot().runtime).toMatchObject({
    attempts: [{ id: old.task.id, outcome: 'invalidated' }], budget: { reservedTokens: 30 },
  });
  old.callbacks.partial({ index: 1, text: ' late' });
  old.callbacks.terminal({ status: 'completed', tokens: 9, providerRequestId: 'old-terminal' });
  old.callbacks.terminal({ status: 'completed', tokens: 9 });
  expect(next.calls).toHaveLength(1);
  expect(agent.snapshot().runtime.budget).toMatchObject({ settledTokens: 9, reservedTokens: 30 });
  expect(agent.snapshot().runtime.outputs).toMatchObject([{ text: 'old session', state: 'superseded' }]);
  expect(agent.telemetry.snapshot().events.filter((event) => event.name === 'terminal')).toMatchObject([
    { sessionId: old.task.event.origin?.sessionId, providerRequestId: 'old-terminal' },
  ]);
});
