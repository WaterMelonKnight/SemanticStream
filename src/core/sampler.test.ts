import { describe, expect, it } from 'vitest';
import { BudgetController } from './budget';
import { Sampler } from './sampler';
import { AdaptiveSamplingPolicy, FixedSamplingPolicy } from './sampling';
import type { StreamFrame } from './stream';

const timing = { minimumIntervalMs: 125, maximumSilenceMs: 1_500 };
const acceptingSink = { accept: () => true };

function gray(value: number): Uint8ClampedArray {
  return new Uint8ClampedArray([value, value, value, 255]);
}

function frame(timestampMs: number, sequence = 1): StreamFrame<null> {
  return { sequence, timestampMs, payload: null };
}

describe('stream sampler', () => {
  it('uses slots anchored to the first input and skips missed slots', () => {
    const sampler = new Sampler(new FixedSamplingPolicy(250), new BudgetController(5_000, 20), timing, acceptingSink);
    const timestamps = [130, 379, 390, 450, 630, 1_320, 1_330, 1_380, 1_455];

    expect(timestamps.map((time) => sampler.process(frame(time), 'log message'))).toEqual([
      'sent', 'policy', 'sent', 'policy', 'sent', 'sent', 'policy', 'interval', 'sent',
    ]);
  });

  it('accumulates adaptive changes against the last delivery and applies threshold changes', () => {
    const policy = new AdaptiveSamplingPolicy(3);
    const sampler = new Sampler(policy, new BudgetController(5_000, 20), timing, acceptingSink);
    expect(sampler.process(frame(0), gray(0))).toBe('sent');
    expect(sampler.process(frame(200), gray(5))).toBe('policy');
    expect(sampler.process(frame(400), gray(10))).toBe('sent');
    expect(sampler.process(frame(600), gray(15))).toBe('policy');
    policy.setThreshold(1.5);
    expect(sampler.process(frame(700), gray(15))).toBe('sent');
  });

  it('refreshes during a still scene at the silence boundary when capacity permits', () => {
    const sampler = new Sampler(new AdaptiveSamplingPolicy(1.5), new BudgetController(5_000, 20), timing, acceptingSink);
    const pixels = gray(0);
    expect(sampler.process(frame(0), pixels)).toBe('sent');
    expect(sampler.process(frame(1_499), pixels)).toBe('policy');
    expect(sampler.process(frame(1_500), pixels)).toBe('sent');
    expect(sampler.process(frame(2_999), pixels)).toBe('policy');
    expect(sampler.process(frame(3_000), pixels)).toBe('sent');
  });

  it('enforces minimum spacing and the budget even for overdue silence refreshes', () => {
    const sampler = new Sampler(
      new AdaptiveSamplingPolicy(1.5),
      new BudgetController(5_000, 1),
      { minimumIntervalMs: 200, maximumSilenceMs: 100 },
      acceptingSink,
    );
    const pixels = gray(0);
    expect(sampler.process(frame(0), pixels)).toBe('sent');
    expect(sampler.process(frame(199), pixels)).toBe('interval');
    expect(sampler.process(frame(200), pixels)).toBe('budget');
    expect(sampler.process(frame(4_999), pixels)).toBe('budget');
    expect(sampler.process(frame(5_000), pixels)).toBe('sent');
  });

  it('keeps both budget and baseline available when the sink declines a frame', () => {
    const accepted: number[] = [];
    const sink = {
      accept: ({ sequence }: StreamFrame<null>) => {
        if (sequence === 2 || sequence === 4) return false;
        accepted.push(sequence);
        return true;
      },
    };
    const sampler = new Sampler(new AdaptiveSamplingPolicy(2), new BudgetController(5_000, 2), timing, sink);
    expect(sampler.process(frame(0, 1), gray(0))).toBe('sent');
    expect(sampler.process(frame(250, 2), gray(100))).toBe('backpressure');
    expect(sampler.process(frame(500, 3), gray(100))).toBe('sent');
    expect(sampler.process(frame(750, 4), gray(200))).toBe('budget');
    expect(sampler.process(frame(5_000, 5), gray(200))).toBe('sent');
    expect(accepted).toEqual([1, 3, 5]);
  });

  it('retries an initially busy sink with the next frame', () => {
    const sink = { accept: ({ sequence }: StreamFrame<null>) => sequence > 1 };
    const sampler = new Sampler(new FixedSamplingPolicy(250), new BudgetController(5_000, 1), timing, sink);
    expect(sampler.process(frame(0, 1), gray(0))).toBe('backpressure');
    expect(sampler.process(frame(20, 2), gray(0))).toBe('sent');
    expect(sampler.process(frame(300, 3), gray(0))).toBe('budget');
  });

  it('records accepted frames, omissions, and measured processing latency', () => {
    let clock = 0;
    const sampler = new Sampler(
      new FixedSamplingPolicy(250),
      new BudgetController(5_000, 20),
      timing,
      acceptingSink,
      () => { clock += 2; return clock; },
    );
    expect(sampler.snapshot()).toEqual({ inputs: 0, sent: 0, filteredPercent: 0, meanProcessingMs: 0 });
    sampler.process(frame(0), gray(0), 0.5);
    sampler.process(frame(100), gray(0), 1.5);
    expect(sampler.snapshot()).toEqual({ inputs: 2, sent: 1, filteredPercent: 50, meanProcessingMs: 3 });
  });

  it('rejects backwards and nonfinite frame timestamps without counting them', () => {
    const sampler = new Sampler(new FixedSamplingPolicy(250), new BudgetController(5_000, 20), timing, acceptingSink);
    sampler.process(frame(100), gray(0));
    expect(() => sampler.process(frame(99), gray(0))).toThrow(RangeError);
    expect(() => sampler.process(frame(NaN), gray(0))).toThrow(RangeError);
    expect(sampler.snapshot().inputs).toBe(1);
    expect(sampler.process(frame(350), gray(0))).toBe('sent');
  });

  it('allows a fair online comparison on the same sequence and rolling cap', () => {
    const fixed = new Sampler(new FixedSamplingPolicy(250), new BudgetController(5_000, 20), timing, acceptingSink);
    const adaptive = new Sampler(new AdaptiveSamplingPolicy(1.5), new BudgetController(5_000, 20), timing, acceptingSink);
    for (let sequence = 1; sequence <= 161; sequence += 1) {
      const input = frame((sequence - 1) * 50, sequence);
      const pixels = gray(sequence < 81 ? 0 : 255);
      fixed.process(input, pixels);
      adaptive.process(input, pixels);
    }
    expect(fixed.snapshot()).toMatchObject({ inputs: 161, sent: 33 });
    expect(adaptive.snapshot()).toMatchObject({ inputs: 161, sent: 6 });
  });
});
