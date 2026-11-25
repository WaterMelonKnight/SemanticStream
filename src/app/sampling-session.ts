import { BudgetController } from '../core/budget';
import type { FrameDecision, MetricsSnapshot } from '../core/metrics';
import { RollingRate } from '../core/rate';
import { AdaptiveSamplingPolicy, FixedSamplingPolicy } from '../core/sampling';
import type { PixelSample, SamplingPolicy } from '../core/sampling';
import { Sampler } from '../core/sampler';
import type { StreamFrame } from '../core/stream';
import { BoundedTimeline } from '../core/timeline';
import { ThumbnailReader } from '../visual/canvas';
import { MockAgent } from '../visual/mock-agent';
import type { VisualFrame } from '../visual/source';

export const BUDGET_WINDOW_MS = 5_000;
export const DELIVERY_TIMING = { minimumIntervalMs: 125, maximumSilenceMs: 1_500 };
export const TIMELINE_CAPACITY = 150;
export const RATE_WINDOW_MS = 2_000;

export type SamplingMode = 'adaptive' | 'fixed';

export interface TimelineEntry {
  readonly sequence: number;
  readonly timestampMs: number;
  readonly mediaTimeMs: number | null;
  readonly adaptive: FrameDecision;
  readonly fixed: FrameDecision;
}

export interface SessionSettings {
  readonly threshold: number;
  readonly budget: number;
}

export interface SessionRates {
  readonly input: number;
  readonly adaptiveSent: number;
  readonly fixedSent: number;
}

export interface SessionSnapshot {
  readonly adaptive: MetricsSnapshot;
  readonly fixed: MetricsSnapshot;
  readonly rates: SessionRates;
}

export type SessionDecisions = Readonly<Record<SamplingMode, FrameDecision>>;

/**
 * One comparison session owns both samplers, both sink views, and bounded
 * diagnostics. A new session is created after a source switch or seek.
 */
export class SamplingSession {
  readonly timeline = new BoundedTimeline<TimelineEntry>(TIMELINE_CAPACITY);
  private readonly thumbnail = new ThumbnailReader();
  private readonly inputRate = new RollingRate(RATE_WINDOW_MS, 600);
  private readonly adaptiveSendRate = new RollingRate(RATE_WINDOW_MS, 200);
  private readonly fixedSendRate = new RollingRate(RATE_WINDOW_MS, 200);
  private readonly agents: Record<SamplingMode, MockAgent>;
  private readonly adaptivePolicy: AdaptiveSamplingPolicy;
  private readonly adaptiveBudget: BudgetController;
  private readonly fixedBudget: BudgetController;
  private readonly samplers: Record<SamplingMode, Sampler<VisualFrame, PixelSample>>;

  constructor(
    adaptiveCanvas: HTMLCanvasElement,
    fixedCanvas: HTMLCanvasElement,
    settings: SessionSettings,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.agents = {
      adaptive: new MockAgent(adaptiveCanvas),
      fixed: new MockAgent(fixedCanvas),
    };
    this.adaptivePolicy = new AdaptiveSamplingPolicy(settings.threshold);
    this.adaptiveBudget = new BudgetController(BUDGET_WINDOW_MS, settings.budget);
    this.fixedBudget = new BudgetController(BUDGET_WINDOW_MS, settings.budget);
    const fixedPolicy: SamplingPolicy<PixelSample> = new FixedSamplingPolicy(250);
    this.samplers = {
      adaptive: new Sampler(this.adaptivePolicy, this.adaptiveBudget, DELIVERY_TIMING, this.agents.adaptive),
      fixed: new Sampler(fixedPolicy, this.fixedBudget, DELIVERY_TIMING, this.agents.fixed),
    };
  }

  process(frame: StreamFrame<VisualFrame>): SessionDecisions {
    const pixels = this.thumbnail.read(frame.payload.canvas);
    const preparationMs = Math.max(0, this.now() - frame.timestampMs);
    const adaptive = this.samplers.adaptive.process(frame, pixels, preparationMs);
    const fixed = this.samplers.fixed.process(frame, pixels, preparationMs);

    this.inputRate.record(frame.timestampMs);
    if (adaptive === 'sent') this.adaptiveSendRate.record(frame.timestampMs);
    if (fixed === 'sent') this.fixedSendRate.record(frame.timestampMs);
    this.timeline.push({
      sequence: frame.sequence,
      timestampMs: frame.timestampMs,
      mediaTimeMs: frame.payload.mediaTimeMs,
      adaptive,
      fixed,
    });
    return { adaptive, fixed };
  }

  setThreshold(threshold: number): void {
    this.adaptivePolicy.setThreshold(threshold);
  }

  setBudget(frameLimit: number): void {
    this.adaptiveBudget.setLimit(frameLimit);
    this.fixedBudget.setLimit(frameLimit);
  }

  latest(mode: SamplingMode) {
    return this.agents[mode].latest();
  }

  snapshot(): SessionSnapshot {
    const nowMs = this.now();
    return {
      adaptive: this.samplers.adaptive.snapshot(),
      fixed: this.samplers.fixed.snapshot(),
      rates: {
        input: this.inputRate.perSecond(nowMs),
        adaptiveSent: this.adaptiveSendRate.perSecond(nowMs),
        fixedSent: this.fixedSendRate.perSecond(nowMs),
      },
    };
  }
}
