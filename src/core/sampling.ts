export type PixelSample = Uint8ClampedArray;

export type ChangeDetector<Sample> = (baseline: Sample, current: Sample) => number;

export const meanRgbDifference: ChangeDetector<PixelSample> = (baseline, current) => {
  if (current.length === 0 || current.length % 4 !== 0 || current.length !== baseline.length) {
    throw new RangeError('Pixel samples must have the same nonempty RGBA layout.');
  }

  let total = 0;
  for (let index = 0; index < current.length; index += 4) {
    total += Math.abs(current[index] - baseline[index]);
    total += Math.abs(current[index + 1] - baseline[index + 1]);
    total += Math.abs(current[index + 2] - baseline[index + 2]);
  }
  const channelCount = (current.length / 4) * 3;
  return (100 * total) / (channelCount * 255);
};

export interface SamplingContext<Sample> {
  readonly timestampMs: number;
  readonly firstTimestampMs: number;
  readonly sample: Sample;
  readonly lastDelivery: {
    readonly timestampMs: number;
    readonly sample: Sample;
  };
}

export interface SamplingPolicy<Sample> {
  wantsFrame(context: SamplingContext<Sample>): boolean;
}

export class FixedSamplingPolicy implements SamplingPolicy<unknown> {
  constructor(private readonly intervalMs: number) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new RangeError('Fixed sampling interval must be positive and finite.');
    }
  }

  wantsFrame({ timestampMs, firstTimestampMs, lastDelivery }: SamplingContext<unknown>): boolean {
    const deliveredAt = lastDelivery.timestampMs;
    const slot = Math.floor((deliveredAt - firstTimestampMs) / this.intervalMs);
    const slotStart = firstTimestampMs + slot * this.intervalMs;
    let nextSlotStart = firstTimestampMs + (slot + 1) * this.intervalMs;

    // Fractional timestamps can round across a slot boundary during subtraction.
    if (deliveredAt < slotStart) {
      nextSlotStart = slotStart;
    } else if (deliveredAt >= nextSlotStart) {
      nextSlotStart = firstTimestampMs + (slot + 2) * this.intervalMs;
    }
    return timestampMs >= nextSlotStart;
  }
}

export class AdaptiveSamplingPolicy implements SamplingPolicy<PixelSample> {
  private threshold: number;

  constructor(threshold: number, private readonly detector: ChangeDetector<PixelSample> = meanRgbDifference) {
    this.threshold = AdaptiveSamplingPolicy.validateThreshold(threshold);
  }

  setThreshold(threshold: number): void {
    this.threshold = AdaptiveSamplingPolicy.validateThreshold(threshold);
  }

  wantsFrame({ lastDelivery, sample }: SamplingContext<PixelSample>): boolean {
    return this.detector(lastDelivery.sample, sample) >= this.threshold;
  }

  private static validateThreshold(threshold: number): number {
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
      throw new RangeError('Change threshold must be in the range 0–100.');
    }
    return threshold;
  }
}
