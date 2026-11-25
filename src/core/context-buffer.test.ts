import { describe, expect, it } from 'vitest';
import { ContextBuffer } from './context-buffer';
import type { BufferedFrameInput, ContextBufferConfig } from './context-buffer';

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

function config(overrides: Partial<ContextBufferConfig> = {}): ContextBufferConfig {
  return {
    sessionId: 'session-a',
    maxAgeMs: 10_000,
    maxBytes: 10_000,
    maxFrames: 10,
    ...overrides,
  };
}

function frame(sequence: number, timestampMs: number, value = sequence): BufferedFrameInput {
  return {
    sequence,
    timestampMs,
    mediaTimeMs: timestampMs,
    width: WIDTH,
    height: HEIGHT,
    pixels: pixels(value),
  };
}

describe('bounded context buffer', () => {
  it('stores owned frame copies and returns another copy on retrieval', () => {
    const buffer = new ContextBuffer(config());
    const input = frame(1, 0, 10);
    expect(buffer.offer(input)).toBe(true);
    input.pixels[0] = 255;

    const first = buffer.getFrameBySequence('session-a', 1);
    expect(first.status).toBe('available');
    expect(first.frame?.pixels[0]).toBe(10);
    first.frame!.pixels[0] = 200;

    const second = buffer.getFrameBySequence('session-a', 1);
    expect(second.frame?.pixels[0]).toBe(10);
  });

  it('enforces the frame, age, and byte caps with separate eviction reasons', () => {
    const frameBuffer = new ContextBuffer(config({ maxFrames: 2 }));
    for (let index = 1; index <= 3; index += 1) frameBuffer.offer(frame(index, index * 10));
    expect(frameBuffer.stats()).toMatchObject({
      frameCount: 2,
      evictedByReason: { age: 0, frames: 1, bytes: 0 },
    });
    expect(frameBuffer.getFrameBySequence('session-a', 1).status).toBe('evicted');
    expect(frameBuffer.getFrameBySequence('session-a', 2).status).toBe('available');

    const ageBuffer = new ContextBuffer(config({ maxAgeMs: 1_000 }));
    ageBuffer.offer(frame(1, 0));
    ageBuffer.offer(frame(2, 1_100));
    ageBuffer.offer(frame(3, 2_000));
    expect(ageBuffer.stats()).toMatchObject({
      frameCount: 2,
      evictedByReason: { age: 1, frames: 0, bytes: 0 },
    });

    const byteBuffer = new ContextBuffer(config({ maxBytes: BYTES + 1 }));
    byteBuffer.offer(frame(1, 0));
    byteBuffer.offer(frame(2, 10));
    expect(byteBuffer.stats()).toMatchObject({
      frameCount: 1,
      evictedByReason: { age: 0, frames: 0, bytes: 1 },
    });
  });

  it('distinguishes available, evicted, not-yet-captured, and nonexistent data', () => {
    const buffer = new ContextBuffer(config({ maxFrames: 2 }));
    expect(buffer.getLatestFrame('session-a').status).toBe('not-yet-captured');
    buffer.offer(frame(10, 1_000));
    buffer.offer(frame(11, 2_000));
    buffer.offer(frame(12, 3_000));

    expect(buffer.getLatestFrame('session-a').status).toBe('available');
    expect(buffer.getFrameBySequence('session-a', 9).status).toBe('nonexistent');
    expect(buffer.getFrameBySequence('session-a', 10).status).toBe('evicted');
    expect(buffer.getFrameBySequence('session-a', 13).status).toBe('not-yet-captured');
    expect(buffer.getFrameBySequence('session-other', 12).status).toBe('wrong-session');
    expect(buffer.getFrameAtTimestamp('session-a', 2_950, 100).status).toBe('available');
    expect(buffer.getFrameAtTimestamp('session-a', 2_950, 10).status).toBe('evicted');
    expect(buffer.getFrameAtTimestamp('session-a', 500).status).toBe('nonexistent');
    expect(buffer.getFrameAtTimestamp('session-a', 4_000).status).toBe('not-yet-captured');
  });

  it('returns bounded ranges with missing-range information', () => {
    const buffer = new ContextBuffer(config({ maxFrames: 2 }));
    buffer.offer(frame(10, 1_000));
    buffer.offer(frame(11, 2_000));
    buffer.offer(frame(12, 3_000));

    const available = buffer.getFramesBetween('session-a', 2_000, 3_000);
    expect(available.status).toBe('available');
    expect(available.frames).toHaveLength(2);

    const partial = buffer.getFramesBetween('session-a', 500, 3_000);
    expect(partial.status).toBe('partial');
    expect(partial.frames).toHaveLength(2);
    expect(partial.missing).toEqual([
      { reason: 'before-capture', range: { startMs: 500, endMs: 1_000 } },
      { reason: 'evicted', range: { startMs: 1_000, endMs: 2_000 } },
    ]);

    const truncated = buffer.getFramesBetween('session-a', 2_000, 3_000, { maxFrames: 1 });
    expect(truncated.truncated).toBe(true);
    expect(truncated.frames).toHaveLength(1);

    expect(buffer.getFramesBetween('session-a', 3_000, 2_000).status).toBe('invalid-range');
    expect(buffer.getFramesBetween('session-a', 10_000, 11_000).status).toBe('not-yet-captured');
    expect(buffer.getFramesBetween('session-a', 0, 500).status).toBe('nonexistent');
  });

  it('crops a region without sharing the source pixel array', () => {
    const buffer = new ContextBuffer(config());
    const input = frame(1, 0, 1);
    for (const [index, value] of [[0, 7], [4, 8], [8, 9], [12, 10]] as const) {
      input.pixels[index] = value;
      input.pixels[index + 1] = value;
      input.pixels[index + 2] = value;
    }
    buffer.offer(input);

    const result = buffer.getRegion('session-a', { sequence: 1 }, { x: 1, y: 0, width: 1, height: 2 });
    expect(result.status).toBe('available');
    expect(result.image).toMatchObject({ width: 1, height: 2, byteSize: 8 });
    expect([...result.image!.pixels]).toEqual([8, 8, 8, 255, 10, 10, 10, 255]);
    result.image!.pixels[0] = 0;
    expect(buffer.getRegion('session-a', { sequence: 1 }, { x: 1, y: 0, width: 1, height: 2 }).image?.pixels[0]).toBe(8);
  });

  it('rejects invalid regions, disposed use, and backwards timestamps', () => {
    const buffer = new ContextBuffer(config());
    buffer.offer(frame(1, 1_000));
    expect(buffer.getRegion('session-a', { sequence: 1 }, { x: 1, y: 1, width: 2, height: 1 }).status).toBe('region-invalid');
    expect(() => buffer.offer(frame(2, 900))).toThrow(RangeError);
    expect(() => buffer.offer({ ...frame(2, 1_100), pixels: new Uint8ClampedArray(4) })).toThrow(RangeError);

    buffer.dispose();
    expect(buffer.getLatestFrame('session-a').status).toBe('disposed');
    expect(() => buffer.offer(frame(2, 1_200))).toThrow();
    expect(buffer.stats().frameCount).toBe(0);
  });

  it('isolates sessions by session id', () => {
    const first = new ContextBuffer(config({ sessionId: 'one' }));
    first.offer(frame(1, 1_000));
    expect(first.getFrameBySequence('two', 1).status).toBe('wrong-session');
    const second = new ContextBuffer(config({ sessionId: 'two' }));
    expect(second.getLatestFrame('two').status).toBe('not-yet-captured');
    expect(second.getLatestFrame('one').status).toBe('wrong-session');
  });
});
