import type { PixelRegion } from '../core/context-buffer';
import type { PixelSample } from '../core/sampling';
import { BlockChangeDetector } from '../core/local-change';
import type { BlockChangeSummary } from '../core/local-change';
import { meanRgbDifference } from '../core/sampling';

export interface DecisionFeatures {
  readonly globalPercent: number;
  readonly localPercent: number;
  readonly changedBlocks: number;
  readonly totalBlocks: number;
  readonly roiPercent: number | null;
}

export interface DecisionFeatureConfig {
  readonly sampleWidth: number;
  readonly sampleHeight: number;
  readonly blockWidth: number;
  readonly blockHeight: number;
  readonly blockThreshold: number;
  readonly minChangedBlocks: number;
}

/**
 * Cheap per-frame features. It reads only the previous accepted sample and the
 * current sample. The ROI comes from the task definition, not from an event label.
 */
export class DecisionFeatureExtractor {
  private readonly detector: BlockChangeDetector;

  constructor(private readonly config: DecisionFeatureConfig) {
    this.detector = new BlockChangeDetector({
      sampleWidth: config.sampleWidth,
      sampleHeight: config.sampleHeight,
      blockWidth: config.blockWidth,
      blockHeight: config.blockHeight,
      threshold: config.blockThreshold,
      minChangedBlocks: config.minChangedBlocks,
    });
  }

  analyze(baseline: PixelSample, current: PixelSample, roi: PixelRegion | null): DecisionFeatures {
    const globalPercent = meanRgbDifference(baseline, current);
    const local: BlockChangeSummary = this.detector.measure(baseline, current);
    return {
      globalPercent,
      localPercent: local.maxDifference,
      changedBlocks: local.changedBlocks,
      totalBlocks: local.totalBlocks,
      roiPercent: roi ? this.regionDifference(baseline, current, roi) : null,
    };
  }

  private regionDifference(baseline: PixelSample, current: PixelSample, region: PixelRegion): number {
    const { sampleWidth, sampleHeight } = this.config;
    if (!Number.isSafeInteger(region.x) || !Number.isSafeInteger(region.y)
      || !Number.isSafeInteger(region.width) || !Number.isSafeInteger(region.height)
      || region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1
      || region.x + region.width > sampleWidth || region.y + region.height > sampleHeight) {
      throw new RangeError('Task ROI must be a valid region inside the sample.');
    }
    let total = 0;
    for (let y = region.y; y < region.y + region.height; y += 1) {
      let index = (y * sampleWidth + region.x) * 4;
      for (let x = 0; x < region.width; x += 1) {
        total += Math.abs(current[index] - baseline[index]);
        total += Math.abs(current[index + 1] - baseline[index + 1]);
        total += Math.abs(current[index + 2] - baseline[index + 2]);
        index += 4;
      }
    }
    return (100 * total) / (region.width * region.height * 3 * 255);
  }
}
