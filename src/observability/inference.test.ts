import { expect, it } from 'vitest';
import { ReplayClock } from '../benchmark/runtime-clock';
import { InferenceScheduler } from '../inference/scheduler';
import type { InferenceProvider } from '../inference/types';
import { observeInference } from './inference';
import { TelemetryHub } from './telemetry';

it('captures a stale-session terminal before the scheduler journal overwrites it', () => {
  const clock = new ReplayClock();
  let callbacks: Parameters<InferenceProvider['start']>[2] | undefined;
  const runtime = new InferenceScheduler({ start(_task, _signal, cb) { callbacks = cb; } }, clock, {
    slots: 1, queue: 2, tokensPerTask: 10, totalTokens: 100,
    transport: { windowMs: 5_000, maxFrames: 10, maxBytes: 2_000 },
  }, 'context-aware', 2);
  const sink = new TelemetryHub();
  observeInference(runtime, sink, 'fixture', 'instance');
  runtime.ingest({ source: 'semantic', capturedAtMs: 0, label: 'private instruction', reason: 'test',
    origin: { runtimeInstanceId: 'instance', sessionId: 'old', eventId: 'old-event', sourceGeneration: 1,
      interactionVersion: 1, taskRevision: 1, producedAtMs: 0 },
  }, { channel: 'observation', priority: 1, ttlMs: 1_000 });
  runtime.newSession();
  callbacks?.terminal({ status: 'completed', tokens: 2, providerRequestId: 'receipt' });
  for (let index = 0; index < 4; index += 1) {
    runtime.ingest({ source: 'pixels', capturedAtMs: 0, label: 'other', reason: 'test' });
  }
  expect(runtime.snapshot().records.some((row) => row.kind === 'upstream')).toBe(false);
  expect(sink.snapshot().events).toContainEqual(expect.objectContaining({
    name: 'terminal', critical: true, sessionId: 'old', eventId: 'old-event', taskId: 1, providerRequestId: 'receipt',
  }));
  expect(sink.exportJson()).not.toContain('private instruction');
});
