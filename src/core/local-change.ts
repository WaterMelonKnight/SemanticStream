import type { PixelSample, SamplingContext, SamplingPolicy } from './sampling';
import { AdaptiveSamplingPolicy } from './sampling';

export type AdaptiveStrategy = 'global' | 'local' | 'hybrid' | 'task';

export interface LocalChangeConfig {
  readonly sampleWidth: number;
  readonly sampleHeight: number;
  readonly blockWidth: number;
  readonly blockHeight: number;
  readonly threshold: number;
  readonly minChangedBlocks: number;
}

export interface BlockChangeSummary {
  readonly totalBlocks: number;
  readonly changedBlocks: number;
  readonly maxDifference: number;
}

function validateDimension(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer.`);
  }
}

function validateThreshold(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError('Local change threshold must be in the range 0–100.');
  }
}

/**
 * Compares matching RGBA samples block by block. Each block difference is
 * normalized to 0–100% using the same RGB-only definition as meanRgbDifference.
 * The detector only sees the baseline and current samples; it has no event or
 * future-frame information.
 */
export class BlockChangeDetector {
  private blockWidth: number;
  private blockHeight: number;
  private threshold: number;
  private minChangedBlocks: number;

  constructor(private readonly config: LocalChangeConfig) {
    validateDimension(config.sampleWidth, 'Sample width');
    validateDimension(config.sampleHeight, 'Sample height');
    validateDimension(config.blockWidth, 'Block width');
    validateDimension(config.blockHeight, 'Block height');
    validateThreshold(config.threshold);
    validateDimension(config.minChangedBlocks, 'Minimum changed blocks');
    this.blockWidth = config.blockWidth;
    this.blockHeight = config.blockHeight;
    this.threshold = config.threshold;
    this.minChangedBlocks = config.minChangedBlocks;
    if (this.minChangedBlocks > this.totalBlockCount()) {
      throw new RangeError('Minimum changed blocks cannot exceed the number of blocks.');
    }
  }

  get minimumChangedBlocks(): number {
    return this.minChangedBlocks;
  }

  get blockSize(): { readonly width: number; readonly height: number } {
    return { width: this.blockWidth, height: this.blockHeight };
  }

  setThreshold(threshold: number): void {
    validateThreshold(threshold);
    this.threshold = threshold;
  }

  setBlockSize(blockWidth: number, blockHeight: number): void {
    validateDimension(blockWidth, 'Block width');
    validateDimension(blockHeight, 'Block height');
    const nextTotal = this.totalBlockCount(blockWidth, blockHeight);
    if (this.minChangedBlocks > nextTotal) {
      throw new RangeError('Minimum changed blocks cannot exceed the number of blocks.');
    }
    this.blockWidth = blockWidth;
    this.blockHeight = blockHeight;
  }

  measure(baseline: PixelSample, current: PixelSample): BlockChangeSummary {
    const pixelCount = this.config.sampleWidth * this.config.sampleHeight;
    if (current.length !== pixelCount * 4 || baseline.length !== current.length) {
      throw new RangeError('Pixel samples must match the configured RGBA dimensions.');
    }

    let totalBlocks = 0;
    let changedBlocks = 0;
    let maxDifference = 0;

    for (let blockY = 0; blockY < this.config.sampleHeight; blockY += this.blockHeight) {
      const blockPixelHeight = Math.min(this.blockHeight, this.config.sampleHeight - blockY);
      for (let blockX = 0; blockX < this.config.sampleWidth; blockX += this.blockWidth) {
        const blockPixelWidth = Math.min(this.blockWidth, this.config.sampleWidth - blockX);
        let channelDifference = 0;

        for (let y = 0; y < blockPixelHeight; y += 1) {
          let index = ((blockY + y) * this.config.sampleWidth + blockX) * 4;
          for (let x = 0; x < blockPixelWidth; x += 1) {
            channelDifference += Math.abs(current[index] - baseline[index]);
            channelDifference += Math.abs(current[index + 1] - baseline[index + 1]);
            channelDifference += Math.abs(current[index + 2] - baseline[index + 2]);
            index += 4;
          }
        }

        const difference = (100 * channelDifference) / (blockPixelWidth * blockPixelHeight * 3 * 255);
        if (difference >= this.threshold) changedBlocks += 1;
        if (difference > maxDifference) maxDifference = difference;
        totalBlocks += 1;
      }
    }

    return { totalBlocks, changedBlocks, maxDifference };
  }

  private totalBlockCount(blockWidth = this.blockWidth, blockHeight = this.blockHeight): number {
    return Math.ceil(this.config.sampleWidth / blockWidth) * Math.ceil(this.config.sampleHeight / blockHeight);
  }
}

export class LocalSamplingPolicy implements SamplingPolicy<PixelSample> {
  private readonly detector: BlockChangeDetector;

  constructor(config: LocalChangeConfig) {
    this.detector = new BlockChangeDetector(config);
  }

  get minimumChangedBlocks(): number {
    return this.detector.minimumChangedBlocks;
  }

  setThreshold(threshold: number): void {
    this.detector.setThreshold(threshold);
  }

  setBlockSize(blockWidth: number, blockHeight: number): void {
    this.detector.setBlockSize(blockWidth, blockHeight);
  }

  wantsFrame({ lastDelivery, sample }: SamplingContext<PixelSample>): boolean {
    const summary = this.detector.measure(lastDelivery.sample, sample);
    return summary.changedBlocks >= this.detector.minimumChangedBlocks;
  }
}

/**
 * Selects the adaptive decision rule without replacing the Sampler or resetting
 * either branch's history. Hybrid means "global change OR local blocked change".
 */
export class AdaptiveStrategyPolicy implements SamplingPolicy<PixelSample> {
  private strategy: AdaptiveStrategy;
  private readonly globalPolicy: AdaptiveSamplingPolicy;
  private readonly localPolicy: LocalSamplingPolicy;
  private readonly taskGate?: () => boolean;

  constructor(options: {
    readonly strategy: AdaptiveStrategy;
    readonly globalThreshold: number;
    readonly local: LocalChangeConfig;
    readonly taskGate?: () => boolean;
  }) {
    this.strategy = options.strategy;
    this.globalPolicy = new AdaptiveSamplingPolicy(options.globalThreshold);
    this.localPolicy = new LocalSamplingPolicy(options.local);
    this.taskGate = options.taskGate;
  }

  get activeStrategy(): AdaptiveStrategy {
    return this.strategy;
  }

  setStrategy(strategy: AdaptiveStrategy): void {
    this.strategy = strategy;
  }

  setGlobalThreshold(threshold: number): void {
    this.globalPolicy.setThreshold(threshold);
  }

  setLocalThreshold(threshold: number): void {
    this.localPolicy.setThreshold(threshold);
  }

  setBlockSize(blockWidth: number, blockHeight: number): void {
    this.localPolicy.setBlockSize(blockWidth, blockHeight);
  }

  wantsFrame(context: SamplingContext<PixelSample>): boolean {
    switch (this.strategy) {
      case 'global':
        return this.globalPolicy.wantsFrame(context);
      case 'local':
        return this.localPolicy.wantsFrame(context);
      case 'hybrid':
        return this.globalPolicy.wantsFrame(context) || this.localPolicy.wantsFrame(context);
      case 'task':
        return this.taskGate?.() ?? false;
    }
  }
}
