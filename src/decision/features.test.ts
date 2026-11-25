import { describe, expect, it } from 'vitest';
import { DecisionFeatureExtractor } from './features';

const WIDTH = 16;
const HEIGHT = 16;

function sample(): Uint8ClampedArray {
  return new Uint8ClampedArray(WIDTH * HEIGHT * 4);
}

function paint(value: Uint8ClampedArray, x: number, y: number, level: number): void {
  const index = (y * WIDTH + x) * 4;
  value[index] = level;
  value[index + 1] = level;
  value[index + 2] = level;
  value[index + 3] = 255;
}

const extractor = new DecisionFeatureExtractor({
  sampleWidth: WIDTH,
  sampleHeight: HEIGHT,
  blockWidth: 8,
  blockHeight: 8,
  blockThreshold: 2.5,
  minChangedBlocks: 1,
});

describe('decision features', () => {
  it('reports global, local, and ROI change from only the current and baseline samples', () => {
    const baseline = sample();
    const current = sample();
    paint(current, 2, 2, 255);
    paint(current, 3, 2, 255);
    const features = extractor.analyze(baseline, current, { x: 0, y: 0, width: 8, height: 8 });
    expect(features.globalPercent).toBeGreaterThan(0);
    expect(features.localPercent).toBeGreaterThan(0);
    expect(features.changedBlocks).toBe(1);
    expect(features.roiPercent).toBeGreaterThan(0);
  });

  it('returns a null ROI value when the task has no ROI', () => {
    expect(extractor.analyze(sample(), sample(), null).roiPercent).toBeNull();
  });

  it('rejects an invalid ROI or mismatched sample dimensions', () => {
    expect(() => extractor.analyze(sample(), sample(), { x: 14, y: 0, width: 4, height: 4 })).toThrow(RangeError);
    expect(() => extractor.analyze(sample(), new Uint8ClampedArray(4), null)).toThrow();
  });
});
