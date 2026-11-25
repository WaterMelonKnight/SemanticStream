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
    expect(admission.canSend(0, 100)).toBe(true);
    admission.record(0, 100);
    expect(admission.canRetrieve(0, 1, 100)).toBe(true);
    admission.recordRetrieval(0, 1, 100);

    const snapshot = admission.snapshot(0);
    expect(snapshot.realtime).toMatchObject({ usedFrames: 1, usedBytes: 100, maxFrames: 2 });
    expect(snapshot.retrieval).toMatchObject({ usedFrames: 1, usedBytes: 100, maxFrames: 2 });
    expect(snapshot.total).toMatchObject({ usedFrames: 2, usedBytes: 200, maxFrames: 3 });
  });

  it('requires both the sub-budget and the total budget to admit work', () => {
    const admission = new ResourceAdmissionController(config());
    admission.record(0, 100);
    admission.record(0, 100);
    expect(admission.canSend(0, 100)).toBe(false);

    admission.recordRetrieval(0, 1, 100);
    expect(admission.snapshot(0).total.usedFrames).toBe(3);
    expect(admission.canRetrieve(0, 1, 100)).toBe(false);
    expect(admission.canSend(0, 100)).toBe(false);
  });

  it('expires entries exactly at the rolling window boundary', () => {
    const admission = new ResourceAdmissionController(config());
    admission.record(0, 100);
    admission.record(0, 100);
    admission.recordRetrieval(0, 1, 100);
    expect(admission.canSend(4_999, 100)).toBe(false);
    expect(admission.canSend(5_000, 100)).toBe(true);
    expect(admission.canRetrieve(5_000, 1, 100)).toBe(true);
  });

  it('updates the real-time and total limits without losing recent usage', () => {
    const admission = new ResourceAdmissionController(config());
    admission.record(0, 100);
    admission.record(0, 100);
    admission.setTotalFrameLimit(2);
    expect(admission.snapshot(0).total.maxFrames).toBe(2);
    expect(admission.canSend(0, 100)).toBe(false);
    admission.setRealtimeFrameLimit(3);
    expect(admission.snapshot(0).realtime.maxFrames).toBe(3);
    expect(admission.canSend(0, 100)).toBe(false);
  });

  it('rejects mismatched rolling windows', () => {
    expect(() => new ResourceAdmissionController(config({
      total: { windowMs: 4_000, maxFrames: 3, maxBytes: 1_500 },
    }))).toThrow(RangeError);
  });
});
