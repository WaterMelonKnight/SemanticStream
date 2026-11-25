import { describe, expect, it } from 'vitest';
import { RollingRate } from './rate';

describe('rolling rate meter', () => {
  it('counts events in the trailing window and expires old samples', () => {
    const rate = new RollingRate(2_000, 10);
    rate.record(0);
    rate.record(500);
    rate.record(1_000);
    expect(rate.perSecond(1_000)).toBe(3);

    rate.record(2_000);
    expect(rate.perSecond(2_000)).toBe(2);
    expect(rate.perSecond(2_500)).toBe(1.5);
    expect(rate.perSecond(3_000)).toBe(1);
    expect(rate.perSecond(3_100)).toBe(0.5);
  });

  it('caps retained samples and clears on demand', () => {
    const rate = new RollingRate(10_000, 2);
    rate.record(0);
    rate.record(100);
    rate.record(200);
    expect(rate.perSecond(10_000)).toBe((2 * 1_000) / 10_000);
    rate.clear();
    expect(rate.perSecond(10_000)).toBe(0);
  });

  it('validates its configuration and timestamps', () => {
    expect(() => new RollingRate(0, 3)).toThrow(RangeError);
    expect(() => new RollingRate(1_000, 0)).toThrow(RangeError);
    const rate = new RollingRate(1_000, 3);
    expect(() => rate.record(Infinity)).toThrow(RangeError);
    expect(rate.perSecond(NaN)).toBe(0);
  });
});
