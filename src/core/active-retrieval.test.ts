import { describe, expect, it } from 'vitest';
import { ActiveRetrievalService } from './active-retrieval';
import type { ActiveRetrievalConfig } from './active-retrieval';
import { ContextBuffer } from './context-buffer';
import type { BufferedFrameInput } from './context-buffer';

const WIDTH = 2;
const HEIGHT = 2;
const BYTES = WIDTH * HEIGHT * 4;

function pixels(value: number): Uint8ClampedArray {
  const result = new Uint8ClampedArray(BYTES);
  for (let index = 0; index < result.length; index += 4) {
    result[index] = value;
    result[index + 1] = value;
    result[index + 2] = value;
    result[index + 3] = 255;
  }
  return result;
}

function frame(sequence: number, timestampMs: number): BufferedFrameInput {
  return { sequence, timestampMs, mediaTimeMs: timestampMs, width: WIDTH, height: HEIGHT, pixels: pixels(sequence) };
}

function config(overrides: Partial<ActiveRetrievalConfig> = {}): ActiveRetrievalConfig {
  return {
    sessionId: 'session-a',
    realtime: { windowMs: 5_000, maxFrames: 20, maxBytes: 1_000_000 },
    retrieval: { windowMs: 5_000, maxFrames: 2, maxBytes: 1_000 },
    total: { windowMs: 5_000, maxFrames: 3, maxBytes: 2_000 },
    ...overrides,
  };
}

function setup(): {
  buffer: ContextBuffer;
  service: ActiveRetrievalService;
  clock: { now: number };
} {
  const buffer = new ContextBuffer({ sessionId: 'session-a', maxAgeMs: 10_000, maxBytes: 10_000, maxFrames: 3 });
  const clock = { now: 0 };
  const service = new ActiveRetrievalService(buffer, config(), () => clock.now);
  buffer.offer(frame(1, 0));
  buffer.offer(frame(2, 1_000));
  buffer.offer(frame(3, 2_000));
  return { buffer, service, clock };
}

describe('active retrieval protocol', () => {
  it('returns frame metadata, copies, and a session-scoped response', () => {
    const { service } = setup();
    const result = service.getFrameBySequence('session-a', 2);
    expect(result.status).toBe('available');
    expect(result.sessionId).toBe('session-a');
    expect(result.frame?.pixels[0]).toBe(2);
    expect(result.bytes).toBe(BYTES);
    expect(result.availableRange).toEqual({ startMs: 0, endMs: 2_000 });
    expect(result.requestId).toBe('retrieval-1');

    result.frame!.pixels[0] = 99;
    expect(service.getFrameBySequence('session-a', 2).frame?.pixels[0]).toBe(2);
  });

  it('enforces a retrieval budget and includes real-time sends in the total budget', () => {
    const { service } = setup();
    service.admission.reserveRealtime(0, BYTES)?.commit(0);
    expect(service.getLatestFrame('session-a').status).toBe('available');
    expect(service.getLatestFrame('session-a').status).toBe('available');

    const denied = service.getLatestFrame('session-a');
    expect(denied.status).toBe('budget-denied');
    expect(denied.bytes).toBe(0);
    const stats = service.stats();
    expect(stats.retrievedFrames).toBe(2);
    expect(stats.budget.retrieval.usedFrames).toBe(2);
    expect(stats.budget.realtime).toMatchObject({ usedFrames: 1, usedBytes: BYTES, maxFrames: 20 });
    expect(stats.budget.total.usedFrames).toBe(3);
    expect(stats.budgetDenied).toBe(1);
  });

  it('returns evicted, not-yet-captured, nonexistent, and wrong-session statuses', () => {
    const { buffer, service } = setup();
    buffer.offer(frame(4, 3_000));
    buffer.offer(frame(5, 4_000));
    buffer.offer(frame(6, 5_000));

    expect(service.getFrameBySequence('session-a', 1).status).toBe('evicted');
    expect(service.getFrameBySequence('session-a', 7).status).toBe('not-yet-captured');
    expect(service.getFrameAtTimestamp('session-a', -1).status).toBe('nonexistent');
    expect(service.getLatestFrame('session-b').status).toBe('wrong-session');
    expect(service.getFramesBetween('session-a', 0, 1_000).status).toBe('evicted');
    expect(service.getFramesBetween('session-a', 9_000, 10_000).status).toBe('not-yet-captured');
  });

  it('retrieves bounded ranges and crops regions through the same budget', () => {
    const { service, clock } = setup();
    const range = service.getFramesBetween('session-a', 0, 2_000, { maxFrames: 2 });
    expect(range.status).toBe('available');
    expect(range.frames).toHaveLength(2);
    expect(range.truncated).toBe(true);

    clock.now = 6_000;
    const region = service.getRegion('session-a', { sequence: 3 }, { x: 0, y: 0, width: 1, height: 1 });
    expect(region.status).toBe('available');
    expect(region.image?.byteSize).toBe(4);
    expect(region.bytes).toBe(4);
    expect(region.latencyMs).toBe(0);
  });

  it('bounds the request log and reports cumulative counts', () => {
    const buffer = new ContextBuffer({ sessionId: 'session-a', maxAgeMs: 10_000, maxBytes: 10_000, maxFrames: 3 });
    const clock = { now: 0 };
    const service = new ActiveRetrievalService(buffer, config({ logCapacity: 2 }), () => clock.now);
    buffer.offer(frame(1, 0));
    service.getLatestFrame('session-a');
    service.getLatestFrame('session-a');
    service.getLatestFrame('session-a');
    expect(service.stats().log).toHaveLength(2);
    expect(service.stats().requests).toBe(3);
    expect(service.stats().retrievedFrames).toBe(2);
  });

  it('updates the combined total limit when the real-time budget changes', () => {
    const { service } = setup();
    service.setTotalFrameLimit(1);
    expect(service.stats().budget.total.maxFrames).toBe(1);
    expect(service.getLatestFrame('session-a').status).toBe('available');
    expect(service.getLatestFrame('session-a').status).toBe('budget-denied');
  });

  it('disposes the buffer and rejects future requests', () => {
    const { service, buffer } = setup();
    service.dispose();
    expect(service.getLatestFrame('session-a').status).toBe('disposed');
    expect(buffer.stats().disposed).toBe(true);
    expect(service.stats().log).toHaveLength(0);
  });
});

it('settles a historical delivery at completion and returns its committed usage', () => {
  const buffer = new ContextBuffer({ sessionId: 'session-a', maxAgeMs: 10_000, maxBytes: 10_000, maxFrames: 3 });
  buffer.offer(frame(1, 10));
  const times = [4_990, 5_001];
  const service = new ActiveRetrievalService(buffer, config(), () => times.shift()!);
  const response = service.getLatestFrame('session-a');
  expect(response).toMatchObject({
    requestedAtMs: 4_990, completedAtMs: 5_001, deliveredAtMs: 5_001, latencyMs: 11,
    frame: { timestampMs: 10 }, budget: { retrieval: { usedFrames: 1 } },
  });
  expect(service.admission.snapshot(10_000).total.usedFrames).toBe(1);
  expect(service.admission.snapshot(10_001).total.usedFrames).toBe(0);
});

it('spends nothing when the retrieval clock moves backwards before completion', () => {
  const buffer = new ContextBuffer({ sessionId: 'session-a', maxAgeMs: 10_000, maxBytes: 10_000, maxFrames: 3 });
  buffer.offer(frame(1, 0));
  const times = [100, 99];
  const service = new ActiveRetrievalService(buffer, config(), () => times.shift()!);
  expect(() => service.getLatestFrame('session-a')).toThrow(RangeError);
  expect(service.admission.snapshot(100).total).toMatchObject({ usedFrames: 0, reservedFrames: 0 });
});
