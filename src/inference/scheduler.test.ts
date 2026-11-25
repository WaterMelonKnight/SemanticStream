import { describe, expect, it } from 'vitest';
import { ReplayClock } from '../benchmark/runtime-clock';
import { InferenceScheduler } from './scheduler';
import type { RuntimeLimits } from './scheduler';
import type { Evidence, InferenceProvider, InferenceRequest, InferenceTask } from './types';

type Callbacks = Parameters<InferenceProvider['start']>[2];

function setup(options: Partial<RuntimeLimits> = {}) {
  const clock = new ReplayClock();
  const calls = new Map<number, { task: InferenceTask; signal: AbortSignal; callbacks: Callbacks }>();
  const runtime = new InferenceScheduler({
    start(task, signal, callbacks) { calls.set(task.id, { task, signal, callbacks }); },
  }, clock, {
    slots: 2, queue: 3, totalTokens: 100, tokensPerTask: 10,
    transport: { maxFrames: 20, maxBytes: 300_000, windowMs: 100 }, ...options,
  }, 'context-aware');
  const ingest = (request: Partial<InferenceRequest> = {}, evidence?: Evidence) => runtime.ingest({
    source: 'user', label: 'Input', capturedAtMs: clock.now(), reason: 'Test',
  }, { channel: 'observation', ttlMs: 1_000, priority: 1, ...request }, evidence)!;
  const call = (id: number) => calls.get(id)!;
  const partial = (id: number, index = 0, text = 'partial') => call(id).callbacks.partial({ index, text });
  const complete = (id: number, tokens: number | null = 1) => call(id).callbacks.terminal({ status: 'completed', tokens });
  return { runtime, clock, ingest, call, calls, partial, complete };
}

describe('duplex inference scheduler', () => {
  it('keeps ordinary input independent and transfers visible ownership on a newer valid partial', () => {
    const { runtime, ingest, partial, complete, call } = setup();
    const old = ingest();
    partial(old);
    const next = ingest();
    partial(old, 1, ' continues');
    expect(call(old).signal.aborted).toBe(false);
    partial(next, 1, 'out-of-order');
    partial(next);
    complete(next);
    partial(old, 2, 'late');
    complete(old);
    expect(runtime.snapshot().outputs).toEqual([
      { taskId: old, channel: 'observation', state: 'superseded', text: 'partial continues' },
      { taskId: next, channel: 'observation', state: 'completed', text: 'partial' },
    ]);
    expect(runtime.snapshot().records.filter(({ kind }) => kind === 'blocked')).toHaveLength(2);
  });

  it('retains slot and token holds after interruption and across a source reset until reliable terminal', () => {
    const { runtime, ingest, call, partial, complete } = setup({ slots: 1 });
    const old = ingest();
    partial(old);
    runtime.interrupt();
    runtime.newSession();
    const next = ingest();
    partial(old, 1, 'must stay hidden');
    expect(call(old).signal.aborted).toBe(true);
    expect(runtime.snapshot().attempts).toMatchObject([{ id: old, outcome: 'cancelled' }]);
    expect(runtime.snapshot().queued).toMatchObject([{ id: next }]);
    expect(runtime.snapshot().budget.reservedTokens).toBe(10);
    complete(old, null);
    complete(old, 77);
    partial(old, 2);
    partial(next);
    expect(runtime.snapshot().outputs).toMatchObject([
      { taskId: old, state: 'superseded', text: 'partial' },
      { taskId: next, state: 'streaming' },
    ]);
    expect(runtime.snapshot().budget).toMatchObject({ reservedTokens: 10, provisionalTokens: 10, settledTokens: 0 });
  });

  it('expires queued and running work and only starts the highest-priority eligible replacement after terminal', () => {
    const { runtime, clock, ingest, call, partial, calls, complete } = setup({ slots: 1, queue: 2 });
    const active = ingest({ ttlMs: 20 });
    const low = ingest({ ttlMs: 50 });
    const next = ingest({ ttlMs: 150, priority: 2 });
    const critical = ingest({ ttlMs: 100, priority: 10 });
    clock.advance(20);
    partial(active);
    expect(runtime.snapshot().records).toContainEqual(expect.objectContaining({ kind: 'blocked' }));
    expect(call(active).signal.aborted).toBe(true);
    expect(calls.size).toBe(1);
    expect(runtime.snapshot().records).toContainEqual(expect.objectContaining({
      outcome: 'invalidated', task: expect.objectContaining({ id: low }),
    }));
    clock.advance(30);
    complete(active);
    expect(call(critical).task.id).toBe(critical);
    expect(calls.has(next)).toBe(false);
    clock.advance(150);
    complete(critical);
    expect(calls.has(next)).toBe(false);
    expect(runtime.snapshot().attempts).toHaveLength(0);
  });

  it('requires dependency success and rejects new work behind a retired dependency', () => {
    const { runtime, ingest, calls, complete } = setup();
    const parent = ingest();
    const child = ingest({ dependsOn: parent, channel: 'response' });
    expect(calls.has(child)).toBe(false);
    complete(parent);
    expect(calls.has(child)).toBe(true);
    const replacement = ingest({ supersede: true, channel: 'response' });
    const rejected = ingest({ dependsOn: child });
    expect(runtime.snapshot().records).toContainEqual(expect.objectContaining({
      reason: 'Dependency unavailable', task: expect.objectContaining({ id: rejected }),
    }));
    expect(calls.has(replacement)).toBe(true);
  });

  it('captures bounded immutable evidence and clears its scope on reset', () => {
    const { runtime, ingest, call, clock } = setup();
    const sample = { source: 'fixture', sequence: 1, capturedAtMs: 0, mediaType: 'text/plain', data: 'owned' };
    const first = ingest({}, sample);
    sample.data = 'mutated';
    for (let sequence = 2; sequence <= 6; sequence += 1) {
      runtime.ingest({ source: 'pixels', label: 'frame', reason: 'test', capturedAtMs: 0 }, undefined,
        { ...sample, sequence });
    }
    const second = ingest({}, { ...sample, sequence: 7, data: 'x'.repeat(32_769) });
    expect(call(first).task.context.evidence.map(({ data }) => data)).toEqual(['owned']);
    const context = call(second).task.context;
    expect(context.evidence.map(({ sequence }) => sequence)).toEqual([4, 5, 6]);
    expect(Object.isFrozen(context) && Object.isFrozen(context.evidence) && Object.isFrozen(context.evidence[0])).toBe(true);
    expect(context.version).toBeGreaterThan(call(first).task.contextVersion);
    runtime.newSession();
    clock.advance(10);
    call(first).callbacks.terminal({ status: 'cancelled', tokens: 0 });
    expect(call(ingest()).task.context.evidence).toEqual([]);
  });

  it('expires rolling bytes and keeps unknown tokens inside the cumulative cap', () => {
    const { runtime, clock, ingest, complete, calls } = setup({
      slots: 1, totalTokens: 20, transport: { maxFrames: 1, maxBytes: 100, windowMs: 100 },
    });
    complete(ingest(), null);
    const rollingDenied = ingest();
    expect(calls.has(rollingDenied)).toBe(false);
    clock.advance(100);
    complete(ingest(), null);
    clock.advance(200);
    const tokensDenied = ingest();
    expect(calls.has(tokensDenied)).toBe(false);
    expect(runtime.snapshot().budget).toMatchObject({ provisionalTokens: 20, sentBytes: 10, rolling: { frames: 0 } });
    expect(runtime.snapshot().records.filter(({ kind }) => kind === 'end').map(({ reason }) => reason)).toEqual([
      'Upstream completed', 'Rolling request/byte budget exhausted', 'Upstream completed', 'Cumulative token budget exhausted',
    ]);
  });

  it('keeps ambiguous start failure accounted until the adapter can attest termination', () => {
    const clock = new ReplayClock();
    let end: Callbacks['terminal'] | undefined;
    const runtime = new InferenceScheduler({
      start(_task, _signal, callbacks) {
        end = callbacks.terminal;
        throw Error('Transport threw after dispatch');
      },
    }, clock, {
      slots: 1, queue: 1, totalTokens: 100, tokensPerTask: 10,
      transport: { maxFrames: 20, maxBytes: 10_000, windowMs: 100 },
    }, 'fifo');
    runtime.ingest({ source: 'user', label: 'Test', reason: '', capturedAtMs: 0 },
      { channel: 'response', priority: 1, ttlMs: 100 });
    expect(runtime.snapshot().attempts).toMatchObject([{ outcome: 'failed' }]);
    end?.({ status: 'failed', tokens: null });
    expect(runtime.snapshot().attempts).toHaveLength(0);
    expect(runtime.snapshot().budget.provisionalTokens).toBe(10);
  });
});
