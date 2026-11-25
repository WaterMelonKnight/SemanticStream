import { describe, expect, it } from 'vitest';
import { ResourceAdmissionController } from './resource-admission';
import type { ResourceAdmissionConfig } from './resource-admission';

function config(overrides: Partial<ResourceAdmissionConfig> = {}): ResourceAdmissionConfig {
  return {
    realtime: { windowMs: 5_000, maxFrames: 2, maxBytes: 1_000 },
    retrieval: { windowMs: 5_000, maxFrames: 2, maxBytes: 1_000 },
    total: { windowMs: 5_000, maxFrames: 3, maxBytes: 1_500 },
    ...overrides,
  };
}

describe('unified resource admission', () => {
  it('charges real-time and retrieval exactly once into their sub-budgets and total', () => {
    const admission = new ResourceAdmissionController(config());
    expect(admission.reserveRealtime(0, 100)?.commit(0)).toBe(true);
    expect(admission.reserveRetrieval(0, 1, 100)?.commit(0)).toBe(true);
    const snapshot = admission.snapshot(0);
    expect(snapshot.realtime).toMatchObject({ usedFrames: 1, usedBytes: 100, reservedFrames: 0 });
    expect(snapshot.retrieval).toMatchObject({ usedFrames: 1, usedBytes: 100, reservedFrames: 0 });
    expect(snapshot.total).toMatchObject({ usedFrames: 2, usedBytes: 200, reservedFrames: 0 });
  });

  it('requires both sub-budget frames and combined bytes', () => {
    const admission = new ResourceAdmissionController(config());
    admission.reserveRealtime(0, 900)?.commit(0);
    expect(admission.reserveRealtime(0, 101)).toBeNull();
    expect(admission.reserveRetrieval(0, 1, 601)).toBeNull();
    expect(admission.snapshot(0).retrieval.reservedFrames).toBe(0);
    expect(admission.reserveRetrieval(0, 1, 600)?.commit(0)).toBe(true);
    expect(admission.reserveRealtime(0, 1)).toBeNull();
  });

  it('expires entries exactly at a fractional rolling deadline', () => {
    const admission = new ResourceAdmissionController(config());
    admission.reserveRealtime(100.2, 100)?.commit(100.2);
    admission.reserveRealtime(100.2, 100)?.commit(100.2);
    admission.reserveRetrieval(100.2, 1, 100)?.commit(100.2);
    expect(admission.reserveRealtime(5_100.199, 100)).toBeNull();
    expect(admission.reserveRealtime(5_100.2, 100)?.release()).toBe(true);
    expect(admission.reserveRetrieval(5_100.2, 1, 100)?.release()).toBe(true);
  });

  it('cannot reserve the same combined slot from concurrent tasks', async () => {
    const admission = new ResourceAdmissionController(config({
      total: { windowMs: 5_000, maxFrames: 1, maxBytes: 1_500 },
    }));
    const [first, second] = await Promise.all([
      Promise.resolve().then(() => admission.reserveRealtime(0, 100)),
      Promise.resolve().then(() => admission.reserveRetrieval(0, 1, 100)),
    ]);
    expect(admission.snapshot(10_000).total).toMatchObject({ usedFrames: 0, reservedFrames: 1 });
    expect(second).toBeNull();
    expect(first?.commit(10_000)).toBe(true);
    expect(first?.commit(NaN)).toBe(false);
    expect(first?.release()).toBe(false);
    expect(admission.snapshot(14_999).total.usedFrames).toBe(1);
    const next = admission.reserveRetrieval(15_000, 1, 100);
    expect(next?.release()).toBe(true);
    expect(next?.release()).toBe(false);
    expect(next?.commit(15_000)).toBe(false);
    expect(admission.snapshot(15_000).total).toMatchObject({ usedFrames: 0, reservedFrames: 0 });
  });

  it('rejects mismatched rolling windows', () => {
    expect(() => new ResourceAdmissionController(config({
      total: { windowMs: 4_000, maxFrames: 3, maxBytes: 1_500 },
    }))).toThrow(RangeError);
  });

  it('keeps outstanding spend when the current limit drops sharply', () => {
    const admission = new ResourceAdmissionController(config({
      realtime: { windowMs: 5_000, maxFrames: 9, maxBytes: 1_000 },
      total: { windowMs: 5_000, maxFrames: 9, maxBytes: 1_000 },
    }));
    for (let t = 0; t < 8; t += 1) admission.reserveRealtime(t, 100)?.commit(t);
    const inProgress = admission.reserveRealtime(8, 100);
    admission.setRealtimeFrameLimit(1);
    admission.setTotalFrameLimit(1);
    expect(inProgress?.commit(9)).toBe(true);
    expect(admission.snapshot(9).total.usedFrames).toBe(9);
    expect(admission.reserveRealtime(9, 100)).toBeNull();
    admission.setRealtimeFrameLimit(10);
    admission.setTotalFrameLimit(10);
    expect(admission.reserveRealtime(9, 100)?.commit(9)).toBe(true);
    expect(admission.snapshot(9).total.usedFrames).toBe(10);
  });

  it('rejects invalid or backwards accounting time without settling the hold', () => {
    const admission = new ResourceAdmissionController(config());
    const hold = admission.reserveRealtime(100, 100);
    expect(() => hold?.commit(99)).toThrow(RangeError);
    expect(() => hold?.commit(NaN)).toThrow(RangeError);
    expect(() => admission.snapshot(99)).toThrow(RangeError);
    expect(hold?.commit(100)).toBe(true);
    expect(admission.snapshot(100).total.usedFrames).toBe(1);
  });
});
