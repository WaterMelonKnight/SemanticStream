import { describe, expect, it } from 'vitest';
import { AdaptiveStrategyPolicy, BlockChangeDetector, LocalSamplingPolicy } from './local-change';
import type { LocalChangeConfig } from './local-change';
import type { PixelSample, SamplingContext } from './sampling';

const WIDTH = 16;
const HEIGHT = 16;
const config: LocalChangeConfig = {
  sampleWidth: WIDTH,
  sampleHeight: HEIGHT,
  blockWidth: 8,
  blockHeight: 8,
  threshold: 2.5,
  minChangedBlocks: 1,
};

function sample(): PixelSample {
  return new Uint8ClampedArray(WIDTH * HEIGHT * 4);
}

function context(baseline: PixelSample, current: PixelSample): SamplingContext<PixelSample> {
  return {
    timestampMs: 1_000,
    firstTimestampMs: 0,
    sample: current,
    lastDelivery: { timestampMs: 0, sample: baseline },
  };
}

function paint(sampleValue: PixelSample, x: number, y: number, value: number): void {
  const index = (y * WIDTH + x) * 4;
  sampleValue[index] = value;
  sampleValue[index + 1] = value;
  sampleValue[index + 2] = value;
  sampleValue[index + 3] = 255;
}

describe('block-local change detector', () => {
  it('normalizes per-block RGB differences and counts changed blocks', () => {
    const baseline = sample();
    const current = sample();
    paint(current, 1, 1, 255);
    paint(current, 2, 1, 255);

    const detector = new BlockChangeDetector(config);
    const summary = detector.measure(baseline, current);
    expect(summary.totalBlocks).toBe(4);
    expect(summary.changedBlocks).toBe(1);
    expect(summary.maxDifference).toBeCloseTo((100 * 2) / (8 * 8), 5);
  });

  it('ignores alpha while still requiring matching RGBA layouts', () => {
    const baseline = sample();
    const current = sample();
    current[3] = 255;
    expect(new BlockChangeDetector(config).measure(baseline, current).changedBlocks).toBe(0);

    expect(() => new BlockChangeDetector(config).measure(baseline, new Uint8ClampedArray(4))).toThrow(RangeError);
  });

  it('validates configuration and block-size changes', () => {
    expect(() => new BlockChangeDetector({ ...config, threshold: 101 })).toThrow(RangeError);
    expect(() => new BlockChangeDetector({ ...config, blockWidth: 0 })).toThrow(RangeError);
    expect(() => new BlockChangeDetector({ ...config, minChangedBlocks: 9 })).toThrow(RangeError);

    const detector = new BlockChangeDetector(config);
    detector.setThreshold(10);
    detector.setBlockSize(4, 4);
    expect(detector.blockSize).toEqual({ width: 4, height: 4 });
    const coarse = new BlockChangeDetector({ ...config, minChangedBlocks: 4 });
    expect(() => coarse.setBlockSize(16, 16)).toThrow(RangeError);
  });

  it('detects a small local change that the global baseline misses', () => {
    const baseline = sample();
    const current = sample();
    paint(current, 1, 1, 255);
    paint(current, 2, 1, 255);
    const local = new LocalSamplingPolicy(config);
    expect(local.wantsFrame(context(baseline, current))).toBe(true);

    const global = new AdaptiveStrategyPolicy({
      strategy: 'global',
      globalThreshold: 1.5,
      local: config,
    });
    expect(global.wantsFrame(context(baseline, current))).toBe(false);
  });

  it('switches between global, local, and hybrid rules without a new sampler', () => {
    const baseline = sample();
    const current = sample();
    paint(current, 1, 1, 255);
    paint(current, 2, 1, 255);
    const policy = new AdaptiveStrategyPolicy({
      strategy: 'global',
      globalThreshold: 1.5,
      local: config,
    });
    const input = context(baseline, current);
    expect(policy.wantsFrame(input)).toBe(false);

    policy.setStrategy('local');
    expect(policy.wantsFrame(input)).toBe(true);

    policy.setStrategy('hybrid');
    expect(policy.wantsFrame(input)).toBe(true);
    policy.setGlobalThreshold(100);
    expect(policy.wantsFrame(input)).toBe(true);
    policy.setStrategy('global');
    expect(policy.wantsFrame(input)).toBe(false);
  });

  it('uses only the external task gate when the task strategy is selected', () => {
    let allowed = false;
    const policy = new AdaptiveStrategyPolicy({
      strategy: 'task',
      globalThreshold: 1.5,
      local: config,
      taskGate: () => allowed,
    });
    const baseline = sample();
    const current = sample();
    paint(current, 1, 1, 255);
    expect(policy.wantsFrame(context(baseline, current))).toBe(false);
    allowed = true;
    expect(policy.wantsFrame(context(baseline, current))).toBe(true);
  });

  it('applies block-size changes to the next local decision', () => {
    const baseline = sample();
    const current = sample();
    paint(current, 1, 1, 255);
    paint(current, 2, 1, 255);
    const policy = new AdaptiveStrategyPolicy({
      strategy: 'local',
      globalThreshold: 1.5,
      local: config,
    });
    expect(policy.wantsFrame(context(baseline, current))).toBe(true);

    policy.setBlockSize(16, 16);
    expect(policy.wantsFrame(context(baseline, current))).toBe(false);
  });
});
