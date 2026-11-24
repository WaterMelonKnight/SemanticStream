import { describe, expect, it } from 'vitest';
import { meanRgbDifference } from './sampling';

describe('mean RGB change', () => {
  it('normalizes color changes and ignores differences in alpha', () => {
    const black = new Uint8ClampedArray([0, 0, 0, 255]);
    expect(meanRgbDifference(black, new Uint8ClampedArray([0, 0, 0, 0]))).toBe(0);
    expect(meanRgbDifference(black, new Uint8ClampedArray([255, 255, 255, 1]))).toBe(100);
    expect(meanRgbDifference(
      new Uint8ClampedArray([0, 0, 0, 1, 0, 0, 0, 1]),
      new Uint8ClampedArray([255, 0, 0, 1, 0, 255, 0, 1]),
    )).toBeCloseTo(100 / 3);
  });

  it('rejects empty, mismatched, and partial RGBA samples', () => {
    const empty = new Uint8ClampedArray(0);
    const onePixel = new Uint8ClampedArray(4);
    const partial = new Uint8ClampedArray(3);
    expect(() => meanRgbDifference(empty, empty)).toThrow(RangeError);
    expect(() => meanRgbDifference(onePixel, new Uint8ClampedArray(8))).toThrow(RangeError);
    expect(() => meanRgbDifference(partial, partial)).toThrow(RangeError);
  });
});
